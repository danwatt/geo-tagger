"""Data Management page: the on-demand street search over the cached GeoFabrik
.osm.pbf extracts. Framework-free (no FastAPI imports) — api/data.py starts a
job here and polls it, per CLAUDE.md's routes-stay-thin convention.

Same module-singleton job shape as data_service's downloads (`_job` dict + lock,
`start_*` populates, `*_job_status` reads): a search streams a whole extract, so
it's seconds-to-a-minute of jobs-executor work rather than something a request should
hold open. See osm_streets.py for the scan itself and why streets aren't
ingested into a database at all."""

import logging
import threading

from geotagger import osm_streets
from geotagger.services import _jobs

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_job: dict = {"running": False, "queued": False, "done": False, "error": None, "message": "",
              "query": "", "result": None}


def streets_status() -> dict:
    """Which raw extracts are still cached, for the street search card. Cheap —
    a header read per file, no scan."""
    return osm_streets.status()


def search_job_status() -> dict:
    with _lock:
        return dict(_job)


def _run_search(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                query: str, limit: int | None, include_paths: bool):
    def progress(message: str):
        with _lock:
            _job["message"] = message

    try:
        result = osm_streets.search(min_lat, max_lat, min_lng, max_lng, query,
                                    limit=limit, include_paths=include_paths,
                                    progress_cb=progress)
        with _lock:
            _job["result"] = result
            if result.get("no_coverage"):
                _job["message"] = ("No cached OSM extract covers this part of the map — "
                                   "pan to a region you've downloaded, or download it above.")
            elif not result["streets"]:
                _job["message"] = (f"No street matching “{query}” in view "
                                   f"({result['seconds']}s).")
            else:
                n = len(result["streets"])
                _job["message"] = (
                    f"{n:,} matching segment{'' if n == 1 else 's'} in {result['seconds']}s"
                    + (" (limit reached — zoom in or refine the search)" if result["truncated"] else "")
                )
            _job["done"] = True
    except Exception as e:  # noqa: BLE001 — surfaced to the UI via job status
        logger.exception("Street search failed")
        with _lock:
            _job["error"] = str(e)
    finally:
        with _lock:
            _job["running"] = False


def start_search(executor, min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                 query: str, limit: int | None = None, include_paths: bool = False) -> bool:
    """Kick off a search on the jobs executor. Returns False if one is already
    running (the caller turns that into a 409). Raises ValueError for a query too
    short to be worth a full extract scan, or when the pbf cache is empty."""
    query = (query or "").strip()
    if len(query) < 2:
        raise ValueError("Search text must be at least 2 characters")
    if not osm_streets.cached_files():
        raise ValueError(
            "No raw OSM extracts are cached — street search reads the downloaded "
            ".osm.pbf files directly, and they are no longer on disk. Re-download a "
            "region above (with 'force') to restore them."
        )
    if not _jobs.accept(_lock, _job, query=query, result=None):
        return False
    _jobs.submit(executor, _lock, _job, _run_search, min_lat, max_lat, min_lng, max_lng,
                 query, limit, include_paths, start_message="Starting search…")
    return True
