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


def guess_dates(photo_ids: list[int]) -> list[dict]:
    """Best-effort date guess (from filename or folder — see date_guess.py) for
    each photo, alongside its current date, so the Search page can stage guesses
    for review before committing any of them. A photo with no guess is still
    included (guess: None) so the caller can show it as skipped."""
    from geotagger import date_guess, serializers

    out = []
    for photo_id in photo_ids:
        photo = index.get_photo(photo_id)
        if not photo:
            continue
        out.append({
            "photo_id": photo_id,
            "filename": photo["filename"],
            "current_datetime": serializers.format_photo_datetime(
                photo["photo_datetime"], photo["date_precision"]),
            "guess": date_guess.guess_date(photo["filename"], photo["dir"]),
        })
    return out


def commit_guessed_dates(entries: list[dict]) -> dict:
    """Write a batch of staged date guesses (each {photo_id, year, month, day,
    precision}, as reviewed/edited by the user on the Search page). Snapshots
    each photo's exact prior sidecar tag + DB state first, so the caller can
    hand the returned ``previous`` list straight to undo_date_commit."""
    from geotagger import sidecar

    previous = []
    updated = 0
    for e in entries:
        photo = index.get_photo(e["photo_id"])
        if not photo:
            continue
        photo_path = Path(index.photo_path(photo))
        previous.append({
            "photo_id": photo["id"],
            "raw_datetime": sidecar.read_sidecar_datetime_raw(photo_path),
            "photo_datetime": photo["photo_datetime"],
            "date_precision": photo["date_precision"],
        })

        precision = e.get("precision")
        if precision == "year":
            sc, new_dt = sidecar.write_approximate_date(photo_path, e["year"], None)
        elif precision == "month":
            sc, new_dt = sidecar.write_approximate_date(photo_path, e["year"], e["month"])
        else:
            sc, new_dt = sidecar.write_guessed_date(photo_path, e["year"], e["month"], e["day"])
            precision = None
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.assign_approximate_date(photo["id"], new_dt, precision, sc.name, sc_mtime)
        updated += 1

    if updated:
        index.bump_faces_generation()
    return {"updated": updated, "previous": previous}


def undo_date_commit(previous: list[dict]) -> int:
    """Revert a commit_guessed_dates batch using its returned ``previous``
    snapshots — restores each sidecar's raw DateTimeOriginal tag (or clears it,
    for a photo that had no override before) and the DB row alongside it, so a
    rescan can't later re-derive a stale value from a half-reverted sidecar."""
    from geotagger import sidecar

    reverted = 0
    for snap in previous:
        photo = index.get_photo(snap["photo_id"])
        if not photo:
            continue
        photo_path = Path(index.photo_path(photo))
        sc = sidecar.write_datetime_raw(photo_path, snap["raw_datetime"])
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.assign_approximate_date(snap["photo_id"], snap["photo_datetime"],
                                      snap["date_precision"], sc.name, sc_mtime)
        reverted += 1

    if reverted:
        index.bump_faces_generation()
    return reverted


def assign_approximate_dates(photo_ids: list[int], year: int, month: int | None) -> int:
    """Assign a year- or month-precision date to a folder/selection of undated
    (or otherwise wrong-dated) photos, writing the sidecar and flagging
    date_precision so consumers (histogram, age-aware face matching) know not
    to trust the day/month-within-year this synthesizes."""
    from geotagger.sidecar import write_approximate_date

    precision = "month" if month else "year"
    updated = 0
    for photo_id in photo_ids:
        photo = index.get_photo(photo_id)
        if not photo:
            continue

        photo_path = Path(index.photo_path(photo))
        sc, new_dt = write_approximate_date(photo_path, year, month)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None

        index.assign_approximate_date(photo_id, new_dt, precision, sc.name, sc_mtime)
        updated += 1

    if updated:
        index.bump_faces_generation()  # photo times feed age-aware suggestion scores
    return updated
