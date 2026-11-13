"""Blocking reverse-geocoding batch jobs. Framework-free so both the scan path and
the API routes can call them."""

import logging
from pathlib import Path

from geotagger import index, sidecar, geocode
from geotagger.exiftool_session import get_et_lock

logger = logging.getLogger(__name__)

_WRITE_CHUNK = 300  # photos per geocode write transaction


def geocode_pending(limit: int | None = None) -> dict:
    """Reverse-geocode photos that have coordinates but no location yet, storing
    the result in the DB (not sidecars). Blocking; runs in the executor."""
    if not geocode.is_available():
        return {"processed": 0, "matched": 0, "available": False,
                "remaining": index.count_photos_needing_geocode()}
    rows = index.get_photos_needing_geocode(limit)
    processed = matched = 0
    pending: list[tuple[int, dict | None]] = []

    def flush() -> None:
        nonlocal processed, matched
        # One commit per chunk instead of per photo. Lookups (CPU/IO) happened
        # before this, so the write lock is never held across geocoding.
        index.update_photo_locations(pending)
        processed += len(pending)
        matched += sum(1 for _, loc in pending if loc)
        pending.clear()

    for r in rows:
        try:
            loc = geocode.lookup(r["lat"], r["lng"])
        except Exception:
            # One bad row mustn't lose the batch; it stays un-geocoded and is
            # retried next run.
            logger.exception("geocode lookup failed for photo %s", r["id"])
            continue
        pending.append((r["id"], loc))
        if len(pending) >= _WRITE_CHUNK:   # bounds work lost if the process dies mid-run
            flush()
    flush()
    return {"processed": processed, "matched": matched, "available": True,
            "remaining": index.count_photos_needing_geocode()}


def export_to_sidecars() -> dict:
    """Write every geotagged photo's GPS coordinates (plus resolved place names,
    where available) into its XMP sidecar — the on-demand catch-up for photos
    geotagged/geocoded DB-only (see config.WRITE_XMP_ON_GEOTAG). Blocking; runs
    in the executor. Acquires the ExifTool lock per file so it doesn't starve
    thumbnail/preview requests for the whole run."""
    rows = index.get_photos_to_export()
    lock = get_et_lock()
    written = errors = 0
    err_samples: list[str] = []
    for r in rows:
        loc = None
        if r["loc_country_code"] is not None:
            loc = {"city": r["loc_city"], "state": r["loc_state"],
                   "country": r["loc_country"], "country_code": r["loc_country_code"]}
        try:
            p = Path(index.photo_path(r))
            with lock:
                sidecar.write_gps(p, r["lat"], r["lng"], location=loc, gps_accuracy=r["gps_accuracy"])
            sc_name, sc_mtime = sidecar.sidecar_tracking(p)
            # Keep sidecar tracking (exactly as the scan computes it) + source current
            # so the next scan doesn't re-index this row.
            # Per file and after the ExifTool write, so the DB write lock is never
            # held across ExifTool.
            with index.transaction() as db:
                db.execute("UPDATE photos SET sidecar_path=?, sidecar_mtime=?, geotag_source='sidecar' WHERE id=?",
                           (sc_name, sc_mtime, r["id"]))
            written += 1
        except Exception as e:
            errors += 1
            if len(err_samples) < 5:
                err_samples.append(f"{r['filename']}: {e}")
    return {"written": written, "errors": errors, "error_samples": err_samples}
