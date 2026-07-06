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


def export_locations_to_sidecars() -> dict:
    """Write resolved place names into the XMP sidecar of every geocoded photo.
    Blocking; runs in the executor. Acquires the ExifTool lock per file so it
    doesn't starve thumbnail/preview requests for the whole run."""
    rows = index.get_photos_with_location()
    lock = get_et_lock()
    db = index.get_db()
    written = errors = 0
    err_samples: list[str] = []
    for r in rows:
        loc = {"city": r["loc_city"], "state": r["loc_state"],
               "country": r["loc_country"], "country_code": r["loc_country_code"]}
        try:
            p = Path(index.photo_path(r))
            with lock:
                sc = sidecar.write_location(p, loc)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            # Keep sidecar tracking current so the next scan doesn't re-index this row.
            db.execute("UPDATE photos SET sidecar_path=?, sidecar_mtime=? WHERE id=?",
                       (sc.name, sc_mtime, r["id"]))
            db.commit()
            written += 1
        except Exception as e:
            errors += 1
            if len(err_samples) < 5:
                err_samples.append(f"{r['filename']}: {e}")
    return {"written": written, "errors": errors, "error_samples": err_samples}
