"""Blocking photo-metadata and timestamp-correction jobs (ExifTool reads, sidecar
writes). Framework-free; called from routes via run_in_executor."""

from pathlib import Path

from geotagger import index
from geotagger.exiftool_session import get_et, get_et_lock
from geotagger.timeutil import has_date


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


def _time_bounds() -> tuple[int, int]:
    """(lowest, highest) photo_datetime a correction may target: the first known
    photograph (1826, as the year pickers allow) through the end of this year."""
    from datetime import date, datetime
    from geotagger.timeutil import wallclock_to_epoch
    lo = wallclock_to_epoch(datetime(1826, 1, 1))
    hi = wallclock_to_epoch(datetime(date.today().year + 1, 1, 1)) - 1
    return lo, hi


def validate_time_updates(updates: list[dict]) -> None:
    """Raise ValueError unless every entry is {id, expected, target} with integer
    timestamps in range, and no id repeats. Run before anything is touched so a
    bad request can't half-apply. 0 is rejected for both: it means "undated", and
    clearing a date is not a time shift (the date tools set one instead)."""
    lo, hi = _time_bounds()
    seen: set[int] = set()
    for u in updates:
        pid = u.get("id")
        if pid in seen:
            raise ValueError(f"photo {pid} appears more than once")
        seen.add(pid)
        for name in ("expected", "target"):
            v = u.get(name)
            if not isinstance(v, int) or isinstance(v, bool):
                raise ValueError(f"{name} must be an integer timestamp")
            if not has_date(v):
                raise ValueError(f"{name} 0 means undated; a time shift needs a real date")
            if not lo <= v <= hi:
                raise ValueError(f"{name} is outside the supported range (1826 to this year)")


def update_photo_times(updates: list[dict]) -> dict:
    """Set photos' times to absolute targets, per photo, safe to retry.

    Each entry is {"id", "expected", "target"}: `expected` is the time the caller
    believes the photo has now, `target` the time it should have. That makes the
    request idempotent — re-sending it after a partial failure leaves photos that
    already landed alone (current == target: reported written, `unchanged`, no
    sidecar write) instead of shifting them again, which a relative offset would.
    A photo whose current time is neither is reported failed with `conflict: True`
    and not touched (something else changed it since the caller loaded it); an
    undated photo is reported failed too.

    Each photo is isolated, as geotag_service.write_geotag: sidecar first, the DB
    row only if that succeeded (so a failed write leaves the row as it was), one
    failure doesn't stop the rest. A DB failure after a good sidecar write is
    reported failed; the next scan sees the sidecar mtime mismatch and re-reads.

    Returns {"results": [{id, photo_datetime, unchanged, sidecar_path}], "written":
    [ids], "failed": [{id, error[, conflict]}], "not_found": [ids]}. Raises
    ValueError for a malformed entry, before anything is touched."""
    import logging
    from geotagger import sidecar
    from geotagger.services.geotag_service import _invalidate_caches, _short_error

    validate_time_updates(updates)
    logger = logging.getLogger(__name__)
    results: list[dict] = []
    failed: list[dict] = []
    not_found: list[int] = []
    moved = False
    try:
        for u in updates:
            photo_id, expected, target = u["id"], u["expected"], u["target"]
            photo = index.get_photo(photo_id)
            if not photo:
                not_found.append(photo_id)
                continue
            current = photo["photo_datetime"]
            if current == target:
                # Already there (a retry, or someone set it): nothing to write.
                results.append({"id": photo_id, "photo_datetime": target, "unchanged": True,
                                "sidecar_path": photo["sidecar_path"]})
                continue
            if not has_date(current):
                failed.append({"id": photo_id, "error": "photo has no date to shift"})
                continue
            if current != expected:
                failed.append({"id": photo_id, "conflict": True,
                               "error": "date changed since it was loaded; reload and retry"})
                continue
            try:
                photo_path = Path(index.photo_path(photo))
                sidecar.write_datetime(photo_path, target)
                moved = True  # the sidecar changed even if the row update below fails
                sc_name, sc_mtime = sidecar.sidecar_tracking(photo_path)
                # Keep sidecar tracking current (exactly as the scan computes it) so
                # the next scan doesn't consider this row stale and re-derive
                # photo_datetime from the (uncorrected) embedded EXIF.
                with index.transaction() as db:
                    db.execute(
                        "UPDATE photos SET photo_datetime=?, sidecar_path=?, sidecar_mtime=? WHERE id=?",
                        (target, sc_name, sc_mtime, photo_id),
                    )
            except Exception as e:
                logger.exception("Time update failed for photo %s", photo_id)
                failed.append({"id": photo_id, "error": _short_error(e)})
                continue
            results.append({"id": photo_id, "photo_datetime": target, "unchanged": False,
                            "sidecar_path": sc_name})
    finally:
        if moved:
            index.bump_faces_generation()  # photo times feed age-aware suggestion scores
            _invalidate_caches()           # hotspot recency and work-queue batches key on time
    return {"results": results, "written": [r["id"] for r in results],
            "failed": failed, "not_found": not_found}


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
            _, new_dt = sidecar.write_approximate_date(photo_path, e["year"], None)
        elif precision == "month":
            _, new_dt = sidecar.write_approximate_date(photo_path, e["year"], e["month"])
        else:
            _, new_dt = sidecar.write_guessed_date(photo_path, e["year"], e["month"], e["day"])
            precision = None
        sc_name, sc_mtime = sidecar.sidecar_tracking(photo_path)
        index.assign_approximate_date(photo["id"], new_dt, precision, sc_name, sc_mtime)
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
        sidecar.write_datetime_raw(photo_path, snap["raw_datetime"])
        sc_name, sc_mtime = sidecar.sidecar_tracking(photo_path)
        index.assign_approximate_date(snap["photo_id"], snap["photo_datetime"],
                                      snap["date_precision"], sc_name, sc_mtime)
        reverted += 1

    if reverted:
        index.bump_faces_generation()
    return reverted


def assign_approximate_dates(photo_ids: list[int], year: int, month: int | None) -> int:
    """Assign a year- or month-precision date to a folder/selection of undated
    (or otherwise wrong-dated) photos, writing the sidecar and flagging
    date_precision so consumers (histogram, age-aware face matching) know not
    to trust the day/month-within-year this synthesizes."""
    from geotagger.sidecar import sidecar_tracking, write_approximate_date

    precision = "month" if month else "year"
    updated = 0
    for photo_id in photo_ids:
        photo = index.get_photo(photo_id)
        if not photo:
            continue

        photo_path = Path(index.photo_path(photo))
        _, new_dt = write_approximate_date(photo_path, year, month)
        sc_name, sc_mtime = sidecar_tracking(photo_path)

        index.assign_approximate_date(photo_id, new_dt, precision, sc_name, sc_mtime)
        updated += 1

    if updated:
        index.bump_faces_generation()  # photo times feed age-aware suggestion scores
    return updated
