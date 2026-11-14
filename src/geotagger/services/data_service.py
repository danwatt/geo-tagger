"""Data Management page: downloading the offline reference datasets (GeoNames,
GeoFabrik/OSM, US Census place boundaries, InsightFace model pack) the app depends
on. Framework-free (no FastAPI imports) — the api/data.py router calls in here and
pushes the actual work to the shared executor, per CLAUDE.md's routes-stay-thin
convention.

All of these downloads are one-shot, potentially multi-minute admin actions kicked
off from the UI, not per-request runtime calls — same network-access footprint
as the existing scripts/get_geonames.py, scripts/build_osm_places.py, and the
InsightFace pack's existing first-use auto-download, just wired to a button
instead of a terminal (or an unpredictable first face scan). Each has its own
module-singleton job state (`_job` dict + lock), following the get_/init_
singleton shape used elsewhere (index.get_db(), faces.py's model):
`start_*_job()` populates it, `*_job_status()` reads it, guarded by a lock
since the job itself runs on an executor thread while the event loop polls it
concurrently.

Every completed download is logged to the main DB's dataset_downloads table
(index.record_dataset_download) — url, size, record count, timestamp — so a
future "check for updates" feature has something to compare against instead of
re-downloading blind.
"""

import logging
import re
import threading
from pathlib import Path

from geotagger import config, downloads, index
from geotagger.osm_builder import build_or_append

logger = logging.getLogger(__name__)

GEONAMES_BASE = "https://download.geonames.org/export/dump"
GEONAMES_FILES = [
    ("cities500.txt", f"{GEONAMES_BASE}/cities500.zip", True),
    ("admin1CodesASCII.txt", f"{GEONAMES_BASE}/admin1CodesASCII.txt", False),
    ("admin2Codes.txt", f"{GEONAMES_BASE}/admin2Codes.txt", False),
    ("countryInfo.txt", f"{GEONAMES_BASE}/countryInfo.txt", False),
]

# GeoFabrik region groups: group key -> (label, base URL, [(slug, display name), ...]).
# A region's composite key is "<group>_<slug>" (e.g. "us_texas", "europe_germany") —
# used as the pbf cache filename prefix, the dataset_downloads.region value, and the
# id sent from the UI's checkboxes. Slugs/paths verified against GeoFabrik's actual
# download index (download.geofabrik.de/{north-america/us,north-america/canada,europe}.html).
GEOFABRIK_GROUPS: dict[str, dict] = {
    "us": {
        "label": "United States",
        "base": "https://download.geofabrik.de/north-america/us",
        "items": [
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
        ],
    },
    "canada": {
        "label": "Canada",
        "base": "https://download.geofabrik.de/north-america/canada",
        "items": [
            ("alberta", "Alberta"), ("british-columbia", "British Columbia"),
            ("manitoba", "Manitoba"), ("new-brunswick", "New Brunswick"),
            ("newfoundland-and-labrador", "Newfoundland and Labrador"),
            ("northwest-territories", "Northwest Territories"), ("nova-scotia", "Nova Scotia"),
            ("nunavut", "Nunavut"), ("ontario", "Ontario"),
            ("prince-edward-island", "Prince Edward Island"), ("quebec", "Quebec"),
            ("saskatchewan", "Saskatchewan"), ("yukon", "Yukon"),
        ],
    },
    "europe": {
        "label": "Europe",
        "base": "https://download.geofabrik.de/europe",
        "items": [
            ("albania", "Albania"), ("andorra", "Andorra"), ("austria", "Austria"),
            ("belarus", "Belarus"), ("belgium", "Belgium"), ("bosnia-herzegovina", "Bosnia-Herzegovina"),
            ("bulgaria", "Bulgaria"), ("croatia", "Croatia"), ("cyprus", "Cyprus"),
            ("czech-republic", "Czech Republic"), ("denmark", "Denmark"), ("estonia", "Estonia"),
            ("finland", "Finland"), ("france", "France"), ("georgia", "Georgia"),
            ("germany", "Germany"), ("greece", "Greece"), ("hungary", "Hungary"),
            ("iceland", "Iceland"), ("ireland-and-northern-ireland", "Ireland and Northern Ireland"),
            ("italy", "Italy"), ("kosovo", "Kosovo"), ("latvia", "Latvia"),
            ("liechtenstein", "Liechtenstein"), ("lithuania", "Lithuania"), ("luxembourg", "Luxembourg"),
            ("macedonia", "North Macedonia"), ("malta", "Malta"), ("moldova", "Moldova"),
            ("monaco", "Monaco"), ("montenegro", "Montenegro"), ("netherlands", "Netherlands"),
            ("norway", "Norway"), ("poland", "Poland"), ("portugal", "Portugal"),
            ("romania", "Romania"), ("serbia", "Serbia"), ("slovakia", "Slovakia"),
            ("slovenia", "Slovenia"), ("spain", "Spain"), ("sweden", "Sweden"),
            ("switzerland", "Switzerland"), ("turkey", "Turkey"), ("ukraine", "Ukraine"),
            ("united-kingdom", "United Kingdom"),
        ],
    },
}

# key -> (group, slug, display name, url), flattened for lookup by the composite
# key the UI sends ("us_texas", "europe_germany", ...).
_GEOFABRIK_REGIONS: dict[str, dict] = {
    f"{group}_{slug}": {
        "group": group, "slug": slug, "name": name,
        "url": f"{spec['base']}/{slug}-latest.osm.pbf",
    }
    for group, spec in GEOFABRIK_GROUPS.items()
    for slug, name in spec["items"]
}


def geofabrik_region_groups() -> list[dict]:
    """Region groups for the Data Management page's checkbox picker."""
    return [
        {"group": group, "label": spec["label"],
         "items": [{"key": f"{group}_{slug}", "name": name} for slug, name in spec["items"]]}
        for group, spec in GEOFABRIK_GROUPS.items()
    ]


def _pbf_cache_dir() -> Path:
    # Shared with osm_streets.py, which searches these same cached extracts for
    # street lines on demand — hence the single definition in config.
    return config.get_pbf_cache_dir()


def _mb_progress(done: int, total: int | None) -> str:
    if total:
        return f"{done / 1e6:,.0f} of {total / 1e6:,.0f} MB"
    return f"{done / 1e6:,.0f} MB"


def _count_lines(path: Path) -> int | None:
    try:
        with path.open(encoding="utf-8") as f:
            return sum(1 for _ in f)
    except Exception:
        return None


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


def _run_geonames_download(force: bool = False):
    try:
        config.GEONAMES_DIR.mkdir(parents=True, exist_ok=True)
        for name, url, is_zip in GEONAMES_FILES:
            dest = config.GEONAMES_DIR / name
            if dest.exists() and not force:
                with _geonames_lock:
                    _geonames_job["message"] = f"{name} already present — skipping"
                continue
            with _geonames_lock:
                _geonames_job["message"] = f"Downloading {name}…"

            def progress(done: int, total: int | None, name=name):
                with _geonames_lock:
                    _geonames_job["message"] = f"Downloading {name}… {_mb_progress(done, total)}"

            # GeoNames publishes no checksums: Content-Length guards every file, and
            # the cities zip's own CRCs are checked before its .txt is extracted.
            got = downloads.download_to(
                url, dest, progress=progress,
                transform=downloads.extract_zip_txt if is_zip else None)
            with _geonames_lock:
                _geonames_job["message"] = f"Saved {name} ({got['bytes']:,} bytes)"
            index.record_dataset_download(
                dataset="geonames", region=name, url=url,
                size_bytes=dest.stat().st_size, records_loaded=_count_lines(dest),
            )
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


def start_geonames_download(executor, force: bool = False) -> bool:
    """Kick off the download on the shared executor. Returns False if already
    running. force=True re-downloads even files already on disk (otherwise a
    per-file no-op, matching scripts/get_geonames.py's existing skip-if-present
    behavior)."""
    with _geonames_lock:
        if _geonames_job["running"]:
            return False
        _geonames_job.update(running=True, done=False, error=None, message="Starting…")
    executor.submit(_run_geonames_download, force)
    return True


# ── GeoFabrik/OSM download + merge job ──
_osm_lock = threading.Lock()
_osm_job: dict = {"running": False, "done": False, "error": None, "message": "", "result": None}


def _ingested_region_keys() -> list[str]:
    """Composite region keys (e.g. "us_texas") already merged into the OSM places
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
        files = [r["file"] for r in json.loads(row[0])] if row else []
        return [f.replace("-latest.osm.pbf", "") for f in files]
    except Exception:
        return []


def osm_status() -> dict:
    """OSM places DB presence + region list, for the Data Management page."""
    from geotagger import osm_places
    st = osm_places.status()
    return {**st, "db_path": str(config.OSM_DB_PATH), "groups": geofabrik_region_groups(),
            "ingested_keys": _ingested_region_keys()}


def osm_job_status() -> dict:
    with _osm_lock:
        return dict(_osm_job)


_MD5_RE = re.compile(r"^\s*([0-9a-fA-F]{32})\b")


def geofabrik_md5(url: str) -> str:
    """GeoFabrik publishes ``<extract url>.md5`` ("<hex>  <filename>") beside every
    extract; return the hex digest. Raises if it can't be fetched or parsed — an
    extract we can't verify isn't accepted."""
    text = downloads.fetch_text(url + ".md5")
    m = _MD5_RE.match(text)
    if not m:
        raise downloads.DownloadError(f"Unrecognized checksum file at {url}.md5")
    return m.group(1).lower()


def _download_pbf(url: str, dest: Path, label: str, progress_cb) -> None:
    """Download one extract so that `dest` only ever holds a complete, verified,
    compacted file: stream into a temp file -> check its size against
    Content-Length and its MD5 against GeoFabrik's .md5 (of the raw bytes, which
    compaction then changes) -> compact the temp file -> os.replace onto `dest`.

    The temp file sits in a ".download" subdirectory under the extract's own name:
    the cache's "*.osm.pbf" globs (street search, compact_osm_pbf.py) are not
    recursive so they never see it, and osmium still recognises the format from
    the extension (a "*.pbf.part" name would not open).

    Unlike _compact_pbf on a cached file, a compaction failure here fails the
    download: nothing else can have the temp file open, so a failure means
    something is wrong with the data, and the final name must stay empty."""
    progress_cb(f"Downloading {label}…")
    expected = geofabrik_md5(url)

    def progress(done: int, total: int | None):
        progress_cb(f"Downloading {label}… {_mb_progress(done, total)}")

    def compact(part: Path) -> None:
        progress_cb(f"Downloaded {label} ({part.stat().st_size / 1e6:.0f} MB, MD5 verified)")
        if config.OSM_COMPACT_PBF:
            from geotagger import osm_compact
            osm_compact.compact(part, progress_cb=progress_cb)

    downloads.download_to(url, dest, expected_md5=expected, transform=compact,
                          progress=progress, part=dest.parent / ".download" / dest.name)
    progress_cb(f"{label}: saved {dest.name} ({dest.stat().st_size / 1e6:.0f} MB)")


def _compact_pbf(dest: Path, progress_cb) -> None:
    """Shrink an already-cached extract in place (osm_compact.py) before it's
    merged — a raw file from before compaction existed; an already compacted one
    is a header-read no-op. Best-effort: the raw file works just as well, only
    bigger and slower, so a failure here (e.g. Windows refusing the swap while a
    street search has the file open) must not fail the whole job. Fresh downloads
    are compacted inside _download_pbf instead, before they get their final name."""
    if not config.OSM_COMPACT_PBF:
        return
    from geotagger import osm_compact
    try:
        osm_compact.compact(dest, progress_cb=progress_cb)
    except Exception:  # noqa: BLE001 — fall back to the uncompacted file
        logger.warning("Could not compact %s — keeping the full extract", dest, exc_info=True)
        progress_cb(f"{dest.name}: compaction failed, keeping the full extract")


def _run_osm_download_and_merge(keys: list[str], force: bool = False):
    def progress(message: str):
        with _osm_lock:
            _osm_job["message"] = message

    try:
        cache_dir = _pbf_cache_dir()
        cache_dir.mkdir(parents=True, exist_ok=True)
        regions = [_GEOFABRIK_REGIONS[key] for key in keys]
        pbf_paths = []
        for region in regions:
            dest = cache_dir / f"{region['group']}_{region['slug']}-latest.osm.pbf"
            if dest.exists() and force:
                progress(f"{region['name']}: forcing re-download (discarding cached file)…")
                dest.unlink()
            if dest.exists():
                # Existence is enough: _download_pbf only ever renames a complete,
                # verified (and compacted) file into place. A compacted file can't
                # be re-checked against GeoFabrik's .md5 anyway: compaction changed
                # its bytes, and "latest" moves daily.
                # The exception is a partial file left by the old, non-atomic
                # downloader. Caught with a structural walk rather than by letting
                # osmium fail on it: pyosmium leaks the handle of a reader that
                # hits a truncated file, and on Windows that lock would then block
                # the unlink and the re-download for the life of the process.
                from geotagger import osm_compact
                if not osm_compact.is_complete_pbf(dest):
                    progress(f"{region['name']}: cached file is incomplete, downloading it again…")
                    dest.unlink()
                else:
                    progress(f"{region['name']}: using cached download ({dest.stat().st_size / 1e6:.0f} MB)")
                    _compact_pbf(dest, progress)
            if not dest.exists():
                _download_pbf(region["url"], dest, region["name"], progress)
            pbf_paths.append(dest)

        summary = build_or_append(config.OSM_DB_PATH, pbf_paths, append=True, progress_cb=progress)
        by_file = {r["file"]: r["kept"] for r in summary["regions"]}
        for region, dest in zip(regions, pbf_paths):
            index.record_dataset_download(
                dataset="osm", region=f"{region['group']}_{region['slug']}", url=region["url"],
                size_bytes=dest.stat().st_size, records_loaded=by_file.get(dest.name),
            )
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


def start_osm_download(executor, keys: list[str], force: bool = False) -> bool:
    """Kick off download+merge of the given GeoFabrik region keys (e.g. "us_texas",
    "europe_germany") on the shared executor. Returns False if a job is already
    running. Raises ValueError for an unknown key or empty selection. force=True
    discards any cached .osm.pbf for the selected regions first, so a fresh copy
    is pulled from GeoFabrik instead of reusing what's on disk — the merge step
    itself always re-scans and re-applies current classify() rules regardless of
    force, so re-running without force still picks up rule changes (new
    place/category matches), just without a fresh source file."""
    if not keys:
        raise ValueError("No regions selected")
    unknown = [k for k in keys if k not in _GEOFABRIK_REGIONS]
    if unknown:
        raise ValueError(f"Unknown region(s): {', '.join(unknown)}")
    with _osm_lock:
        if _osm_job["running"]:
            return False
        _osm_job.update(running=True, done=False, error=None, message="Starting…", result=None)
    executor.submit(_run_osm_download_and_merge, keys, force)
    return True


# ── US Census places download + build job ──
_census_lock = threading.Lock()
_census_job: dict = {"running": False, "done": False, "error": None, "message": "", "result": None}


def census_status() -> dict:
    """Census DB presence + counts (places, ZCTAs, ZIP names), for the Data
    Management page."""
    from geotagger import census_builder, census_places
    st = census_places.status()
    return {**st, "db_path": str(config.CENSUS_DB_PATH),
            "year": config.CENSUS_CB_YEAR,
            "url": census_builder.cb_urls()[0][1]}


def census_job_status() -> dict:
    with _census_lock:
        return dict(_census_job)


def _run_census_download(force: bool = False):
    from geotagger import census_builder, census_places

    def progress(message: str):
        with _census_lock:
            _census_job["message"] = message

    try:
        cache_dir = config.CENSUS_DB_PATH.parent

        def fetch(name: str, downloader) -> tuple[Path, str | None]:
            """Download `name` into the cache dir unless it's already there (or force
            discards it first). Returns (path, url-or-None-if-cached)."""
            dest = cache_dir / name
            if dest.exists() and force:
                progress(f"Forcing re-download of {name} (discarding cached copy)…")
                dest.unlink()
            if dest.exists():
                # Downloads land atomically now, but an archive left truncated by
                # the old downloader would otherwise be reused forever; a CRC pass
                # over a few tens of MB is cheap insurance.
                if downloads.zip_ok(dest):
                    progress(f"Using cached {name} ({dest.stat().st_size / 1e6:.1f} MB)")
                    return dest, None
                progress(f"Cached {name} is incomplete or corrupt, downloading it again…")
                dest.unlink()
            return dest, downloader(dest)

        zip_path, url = fetch(
            "cb-place-500k.zip",
            lambda d: census_builder.download_cb_zip(d, progress_cb=progress)[1])
        zcta_path, _zcta_url = fetch(
            "cb-zcta520-500k.zip",
            lambda d: census_builder.download_zcta_zip(d, progress_cb=progress)[1])
        postal_path, _postal_url = fetch(
            "geonames-us-postal.zip",
            lambda d: census_builder.download_geonames_zip_codes(d, progress_cb=progress))

        # The build replaces the DB file, which this process may still hold open
        # read-only — drop that handle first (Windows won't allow the replace).
        census_places.reset()
        summary = census_builder.build(config.CENSUS_DB_PATH, zip_path, zcta_path,
                                       postal_path, progress_cb=progress)
        index.record_dataset_download(
            dataset="census_places", region="us", url=url,
            size_bytes=sum(p.stat().st_size for p in (zip_path, zcta_path, postal_path)),
            records_loaded=summary["total_places"] + summary["total_zctas"],
        )
        with _census_lock:
            _census_job["result"] = summary
            _census_job["message"] = (
                f"Done. {summary['total_places']:,} US Census places "
                f"(incorporated places + CDPs) and {summary['total_zctas']:,} ZIP areas ready.")
            _census_job["done"] = True
    except Exception as e:  # noqa: BLE001 — surfaced to the UI via job status
        logger.exception("Census places download/build failed")
        with _census_lock:
            _census_job["error"] = str(e)
    finally:
        with _census_lock:
            _census_job["running"] = False


def start_census_download(executor, force: bool = False) -> bool:
    """Kick off the Census download + build (place boundaries, ZCTA boundaries, and
    the GeoNames ZIP -> city crosswalk) on the shared executor. Returns False if
    already running. force=True discards the cached archives first so a fresh vintage
    is pulled (a plain re-run reuses them and just rebuilds)."""
    with _census_lock:
        if _census_job["running"]:
            return False
        _census_job.update(running=True, done=False, error=None, message="Starting…", result=None)
    executor.submit(_run_census_download, force)
    return True


# ── Face matcher model download job ──
_face_model_lock = threading.Lock()
_face_model_job: dict = {"running": False, "done": False, "error": None, "message": ""}


def face_model_status() -> dict:
    from geotagger import faces
    return faces.model_status()


def face_model_job_status() -> dict:
    with _face_model_lock:
        return dict(_face_model_job)


def _run_face_model_download(force: bool = False):
    from geotagger import faces
    import shutil
    try:
        if force:
            existing = faces.model_status()
            if existing.get("model_dir"):
                model_path = Path(existing["model_dir"]) / "models" / existing["name"]
                if model_path.is_dir():
                    with _face_model_lock:
                        _face_model_job["message"] = "Removing existing model pack…"
                    shutil.rmtree(model_path)
            faces.reset_model()
        with _face_model_lock:
            _face_model_job["message"] = "Downloading face model pack (~275 MB)…"

        def progress(message: str):
            with _face_model_lock:
                _face_model_job["message"] = message

        faces.ensure_model_downloaded(progress_cb=progress)
        status = faces.model_status()
        size_bytes = None
        if status.get("model_dir"):
            model_path = Path(status["model_dir"]) / "models" / status["name"]
            if model_path.is_dir():
                size_bytes = sum(p.stat().st_size for p in model_path.glob("*.onnx"))
        index.record_dataset_download(
            dataset="face_model", region=status.get("name"), url=None,
            size_bytes=size_bytes, records_loaded=None,
        )
        with _face_model_lock:
            _face_model_job["message"] = "Face model ready."
            _face_model_job["done"] = True
    except Exception as e:  # noqa: BLE001 — surfaced to the UI via job status
        logger.exception("Face model download failed")
        with _face_model_lock:
            _face_model_job["error"] = str(e)
    finally:
        with _face_model_lock:
            _face_model_job["running"] = False


def start_face_model_download(executor, force: bool = False) -> bool:
    """Kick off the InsightFace model pack download on the shared executor
    (idempotent — a no-op if it's already on disk, unless force=True deletes it
    first). Returns False if already running."""
    with _face_model_lock:
        if _face_model_job["running"]:
            return False
        _face_model_job.update(running=True, done=False, error=None, message="Starting…")
    executor.submit(_run_face_model_download, force)
    return True
