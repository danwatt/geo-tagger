"""Blocking photo-metadata and timestamp-correction jobs (ExifTool reads, sidecar
writes). Framework-free; called from routes via run_in_executor."""

from pathlib import Path

from geotagger import index
from geotagger.exiftool_session import get_et, get_et_lock


def get_photo_metadata(path: str) -> dict:
    """Get photo metadata from ExifTool (thread-safe)."""
    try:
        et = get_et()
        lock = get_et_lock()
        with lock:
            meta = et.get_tags([path], tags=[
                "EXIF:Make", "EXIF:Model", "EXIF:DateTimeOriginal",
                "EXIF:ImageWidth", "EXIF:ImageHeight",
                "Composite:ImageSize",
            ])
        return meta[0] if meta else {}
    except Exception:
        return {}


def update_photo_times(updates: dict[int, int]) -> int:
    """Apply time offsets to photos and write to sidecars."""
    from geotagger.sidecar import write_datetime

    updated = 0
    for photo_id, offset_seconds in updates.items():
        photo = index.get_photo(photo_id)
        if not photo:
            continue

        # Calculate new timestamp
        original_dt = photo["photo_datetime"]
        if not original_dt or original_dt == 0:
            continue

        new_dt = original_dt + offset_seconds

        # Write to sidecar
        photo_path = Path(index.photo_path(photo))
        sc = write_datetime(photo_path, new_dt)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None

        # Update database. Keep sidecar tracking current so the next scan
        # doesn't consider this row stale and re-derive photo_datetime from
        # the (uncorrected) embedded EXIF, clobbering this offset.
        db = index.get_db()
        db.execute(
            "UPDATE photos SET photo_datetime=?, sidecar_path=?, sidecar_mtime=? WHERE id=?",
            (new_dt, sc.name, sc_mtime, photo_id),
        )
        db.commit()

        updated += 1

    if updated:
        index.bump_faces_generation()  # photo times feed age-aware suggestion scores
    return updated
