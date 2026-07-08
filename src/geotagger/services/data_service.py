"""Data Management page: downloading the offline reference datasets (GeoNames,
GeoFabrik/OSM) the app's reverse geocoding depends on. Framework-free (no
FastAPI imports) — the api/data.py router calls in here and pushes the actual
work to the shared executor, per CLAUDE.md's routes-stay-thin convention.

Both downloads are one-shot, multi-minute admin actions kicked off from the UI,
not per-request runtime calls — same network-access footprint as the existing
scripts/get_geonames.py and scripts/build_osm_places.py, just wired to a button
instead of a terminal. Each has its own module-singleton job state (`_job`
dict + lock), following the get_/init_ singleton shape used elsewhere
(index.get_db(), faces.py's model): `start_*_job()` populates it, `*_job_status()`
reads it, guarded by a lock since the job itself runs on an executor thread
while the event loop polls it concurrently.
"""

import io
import logging
import threading
import time
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

from geotagger import config
from geotagger.osm_builder import build_or_append

logger = logging.getLogger(__name__)

GEONAMES_BASE = "https://download.geonames.org/export/dump"
GEONAMES_FILES = [
    ("cities500.txt", f"{GEONAMES_BASE}/cities500.zip", True),
    ("admin1CodesASCII.txt", f"{GEONAMES_BASE}/admin1CodesASCII.txt", False),
    ("admin2Codes.txt", f"{GEONAMES_BASE}/admin2Codes.txt", False),
    ("countryInfo.txt", f"{GEONAMES_BASE}/countryInfo.txt", False),
]

GEOFABRIK_US_BASE = "https://download.geofabrik.de/north-america/us"
# (slug, display name) — matches GeoFabrik's north-america/us extract naming.
GEOFABRIK_US_STATES = [
    ("alabama", "Alabama"), ("alaska", "Alaska"), ("arizona", "Arizona"),
    ("arkansas", "Arkansas"), ("california", "California"), ("colorado", "Colorado"),
    ("connecticut", "Connecticut"), ("delaware", "Delaware"),
    ("district-of-columbia", "District of Columbia"), ("florida", "Florida"),
    ("georgia", "Georgia"), ("hawaii", "Hawaii"), ("idaho", "Idaho"),
    ("illinois", "Illinois"), ("indiana", "Indiana"), ("iowa", "Iowa"),
    ("kansas", "Kansas"), ("kentucky", "Kentucky"), ("louisiana", "Louisiana"),
    ("maine", "Maine"), ("maryland", "Maryland"), ("massachusetts", "Massachusetts"),
    ("michigan", "Michigan"), ("minnesota", "Minnesota"), ("mississippi", "Mississippi"),
    ("missouri", "Missouri"), ("montana", "Montana"), ("nebraska", "Nebraska"),
    ("nevada", "Nevada"), ("new-hampshire", "New Hampshire"), ("new-jersey", "New Jersey"),
    ("new-mexico", "New Mexico"), ("new-york", "New York"), ("north-carolina", "North Carolina"),
    ("north-dakota", "North Dakota"), ("ohio", "Ohio"), ("oklahoma", "Oklahoma"),
    ("oregon", "Oregon"), ("pennsylvania", "Pennsylvania"), ("rhode-island", "Rhode Island"),
    ("south-carolina", "South Carolina"), ("south-dakota", "South Dakota"),
    ("tennessee", "Tennessee"), ("texas", "Texas"), ("utah", "Utah"), ("vermont", "Vermont"),
    ("virginia", "Virginia"), ("washington", "Washington"), ("west-virginia", "West Virginia"),
    ("wisconsin", "Wisconsin"), ("wyoming", "Wyoming"),
]
_GEOFABRIK_SLUGS = {slug for slug, _ in GEOFABRIK_US_STATES}


def _pbf_cache_dir() -> Path:
    return config.OSM_DB_PATH.parent / "pbf-cache"


# ── GeoNames download job ──
_geonames_lock = threading.Lock()
_geonames_job: dict = {"running": False, "done": False, "error": None, "message": ""}


def geonames_status() -> dict:
    """Which GeoNames files are present, for the Data Management page."""
    files = []
    for name, _url, _is_zip in GEONAMES_FILES:
        path = config.GEONAMES_DIR / name
        files.append({"name": name, "present": path.exists(),
                       "size": path.stat().st_size if path.exists() else 0})
    return {"dir": str(config.GEONAMES_DIR), "files": files,
            "available": all(f["present"] for f in files)}


def geonames_job_status() -> dict:
    with _geonames_lock:
        return dict(_geonames_job)


def _run_geonames_download():
    try:
        config.GEONAMES_DIR.mkdir(parents=True, exist_ok=True)
        for name, url, is_zip in GEONAMES_FILES:
            dest = config.GEONAMES_DIR / name
            if dest.exists():
                with _geonames_lock:
                    _geonames_job["message"] = f"{name} already present — skipping"
                continue
            with _geonames_lock:
                _geonames_job["message"] = f"Downloading {name}…"
            req = Request(url, headers={"User-Agent": "geo-tagger-data-mgmt/1.0"})
            with urlopen(req, timeout=120) as r:
                data = r.read()
            if is_zip:
                with zipfile.ZipFile(io.BytesIO(data)) as zf:
                    member = next(n for n in zf.namelist()
                                  if n.endswith(".txt") and "readme" not in n.lower())
                    dest.write_bytes(zf.read(member))
            else:
                dest.write_bytes(data)
            with _geonames_lock:
                _geonames_job["message"] = f"Saved {name} ({len(data):,} bytes)"
        with _geonames_lock:
            _geonames_job["message"] = "GeoNames data ready."
            _geonames_job["done"] = True
    except Exception as e:  # noqa: BLE001 — surfaced to the UI via job status
        logger.exception("GeoNames download failed")
        with _geonames_lock:
            _geonames_job["error"] = str(e)
    finally:
        with _geonames_lock:
            _geonames_job["running"] = False


def start_geonames_download(executor) -> bool:
    """Kick off the download on the shared executor. Returns False if already running."""
    with _geonames_lock:
        if _geonames_job["running"]:
            return False
        _geonames_job.update(running=True, done=False, error=None, message="Starting…")
    executor.submit(_run_geonames_download)
    return True


# ── GeoFabrik/OSM download + merge job ──
_osm_lock = threading.Lock()
_osm_job: dict = {"running": False, "done": False, "error": None, "message": "", "result": None}


def _ingested_region_files() -> list[str]:
    """Filenames (e.g. "texas-latest.osm.pbf") already merged into the OSM places
    DB, read straight from its meta table — a short-lived connection, since the
    long-lived one in osm_places.py doesn't expose this."""
    if not config.OSM_DB_PATH.exists():
        return []
    import json
    import sqlite3
    try:
        conn = sqlite3.connect(f"file:{config.OSM_DB_PATH.as_posix()}?mode=ro", uri=True)
        row = conn.execute("SELECT value FROM meta WHERE key='regions'").fetchone()
        conn.close()
        return [r["file"] for r in json.loads(row[0])] if row else []
    except Exception:
        return []


def osm_status() -> dict:
    """OSM places DB presence + region list, for the Data Management page."""
    from geotagger import osm_places
    st = osm_places.status()
    ingested = _ingested_region_files()
    return {**st, "db_path": str(config.OSM_DB_PATH), "states": GEOFABRIK_US_STATES,
            "ingested_slugs": [f.replace("-latest.osm.pbf", "") for f in ingested]}


def osm_job_status() -> dict:
    with _osm_lock:
        return dict(_osm_job)


def _download_pbf(slug: str, dest: Path, progress_cb) -> None:
    url = f"{GEOFABRIK_US_BASE}/{slug}-latest.osm.pbf"
    progress_cb(f"Downloading {slug}…")
    req = Request(url, headers={"User-Agent": "geo-tagger-data-mgmt/1.0"})
    with urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        total = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            total += len(chunk)
            progress_cb(f"Downloading {slug}… {total / 1e6:.0f} MB")
    progress_cb(f"Downloaded {slug} ({dest.stat().st_size / 1e6:.0f} MB)")


def _run_osm_download_and_merge(slugs: list[str]):
    def progress(message: str):
        with _osm_lock:
            _osm_job["message"] = message

    try:
        cache_dir = _pbf_cache_dir()
        cache_dir.mkdir(parents=True, exist_ok=True)
        pbf_paths = []
        for slug in slugs:
            dest = cache_dir / f"{slug}-latest.osm.pbf"
            if not dest.exists():
                _download_pbf(slug, dest, progress)
            else:
                progress(f"{slug}: using cached download ({dest.stat().st_size / 1e6:.0f} MB)")
            pbf_paths.append(dest)

        summary = build_or_append(config.OSM_DB_PATH, pbf_paths, append=True, progress_cb=progress)
        with _osm_lock:
            _osm_job["result"] = summary
            _osm_job["message"] = f"Done. {summary['total_places']:,} total places in the OSM places DB."
            _osm_job["done"] = True
    except Exception as e:  # noqa: BLE001 — surfaced to the UI via job status
        logger.exception("GeoFabrik download/merge failed")
        with _osm_lock:
            _osm_job["error"] = str(e)
    finally:
        with _osm_lock:
            _osm_job["running"] = False


def start_osm_download(executor, slugs: list[str]) -> bool:
    """Kick off download+merge of the given GeoFabrik US state slugs on the shared
    executor. Returns False if a job is already running. Raises ValueError for an
    unknown slug or empty selection."""
    if not slugs:
        raise ValueError("No states selected")
    unknown = [s for s in slugs if s not in _GEOFABRIK_SLUGS]
    if unknown:
        raise ValueError(f"Unknown state(s): {', '.join(unknown)}")
    with _osm_lock:
        if _osm_job["running"]:
            return False
        _osm_job.update(running=True, done=False, error=None, message="Starting…", result=None)
    executor.submit(_run_osm_download_and_merge, slugs)
    return True
