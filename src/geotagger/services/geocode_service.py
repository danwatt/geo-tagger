"""Blocking reverse-geocoding batch jobs. Framework-free so both the scan path and
the API routes can call them."""

from pathlib import Path

from geotagger import index, sidecar, geocode
from geotagger.exiftool_session import get_et_lock


def geocode_pending(limit: int | None = None) -> dict:
    """Reverse-geocode photos that have coordinates but no location yet, storing
    the result in the DB (not sidecars). Blocking; runs in the executor."""
    if not geocode.is_available():
        return {"processed": 0, "matched": 0, "available": False,
                "remaining": index.count_photos_needing_geocode()}
    rows = index.get_photos_needing_geocode(limit)
    processed = matched = 0
    for r in rows:
        loc = geocode.lookup(r["lat"], r["lng"])
        index.update_photo_location(r["id"], loc)
        processed += 1
        if loc:
            matched += 1
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
                sc = sidecar.write_gps(p, r["lat"], r["lng"], location=loc, gps_accuracy=r["gps_accuracy"])
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            # Keep sidecar tracking + source current so the next scan doesn't re-index this row.
            # Per file and after the ExifTool write, so the DB write lock is never
            # held across ExifTool.
            with index.transaction() as db:
                db.execute("UPDATE photos SET sidecar_path=?, sidecar_mtime=?, geotag_source='sidecar' WHERE id=?",
                           (sc.name, sc_mtime, r["id"]))
            written += 1
        except Exception as e:
            errors += 1
            if len(err_samples) < 5:
                err_samples.append(f"{r['filename']}: {e}")
    return {"written": written, "errors": errors, "error_samples": err_samples}
