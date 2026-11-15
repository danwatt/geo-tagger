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
    the result in the DB (not sidecars). Blocking; runs in the executor.
    Runs with any one dataset installed (OSM, Census or GeoNames): lookup() merges
    whichever are present, so gating on GeoNames alone left OSM- or Census-only
    installs never geocoding (audit G7)."""
    if not geocode.any_available():
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


def export_to_sidecars(limit: int | None = None, after_id: int = 0) -> dict:
    """Write up to `limit` geotagged photos' GPS coordinates (plus resolved place
    names, where available) into their XMP sidecars — the on-demand catch-up for
    photos geotagged/geocoded DB-only (see config.WRITE_XMP_ON_GEOTAG). One batch
    of the client-loop convention (A7): only photos not yet exported with their
    current values are picked (index.get_photos_to_export), so re-running after a
    finished export, or after a restart mid-run, only does what's left.

    `after_id` is the run's cursor: the batch takes photos with id > after_id and
    returns `cursor` (the last id it looked at) for the next call. Failed photos
    stay "to export" but fall behind the cursor, so a run always finishes — the
    next run (cursor 0) retries them. `remaining` counts what is left ahead of
    the cursor. Blocking; runs in the executor. Acquires the ExifTool lock per
    file so it doesn't starve thumbnail/preview requests."""
    rows = index.get_photos_to_export(after_id, limit)
    lock = get_et_lock()
    written = failed = 0
    err_samples: list[str] = []
    cursor = after_id
    for r in rows:
        cursor = r["id"]
        loc = {"city": r["loc_city"], "state": r["loc_state"],
               "country": r["loc_country"], "country_code": r["loc_country_code"]}
        # Any resolved field is worth exporting: an OSM-only install yields a city
        # with no country, which used to be skipped wholesale (audit G7). A photo
        # with nothing resolved (not geocoded yet, or no match) passes None so its
        # sidecar's existing place tags are left alone; otherwise the DB answer is
        # authoritative and a missing field clears that tag (see _location_args).
        if not any(loc.values()):
            loc = None
        try:
            p = Path(index.photo_path(r))
            with lock:
                sidecar.write_gps(p, r["lat"], r["lng"], location=loc,
                                  gps_accuracy=sidecar.known_accuracy(r["gps_accuracy"]))
            sc_name, sc_mtime = sidecar.sidecar_tracking(p)
            # Per file and after the ExifTool write, so the DB write lock is never
            # held across ExifTool.
            index.mark_photo_exported(r["id"], sc_name, sc_mtime, r["values_sig"])
            written += 1
        except Exception as e:
            failed += 1
            if len(err_samples) < 5:
                err_samples.append(f"{r['filename']}: {e}")
    return {"processed": len(rows), "written": written, "failed": failed,
            "errors_sample": err_samples, "cursor": cursor,
            "remaining": index.count_photos_to_export(cursor)}
