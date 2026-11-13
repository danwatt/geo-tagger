"""Pure DB-row -> JSON-safe dict helpers shared across API routes. No FastAPI here,
and no writes/I/O beyond the one read in person_name_map(); safe to unit-test against
sqlite3.Row objects."""

from geotagger import index, thumbnails
from geotagger.timeutil import epoch_to_wallclock, has_date


def photo_to_dict(r) -> dict:
    """Grid/list shape for a photo row (carries geocode_ignored, dir, and place names —
    dir/location are only consumed by the Undated grid's location-else-directory
    grouping; every other page ignores them)."""
    return {
        "id": r["id"], "filename": r["filename"], "media_type": r["media_type"],
        "lat": r["lat"], "lng": r["lng"], "geotag_source": r["geotag_source"],
        "camera": r["camera"] or None, "photo_datetime": r["photo_datetime"],
        "gps_accuracy": r["gps_accuracy"] if r["gps_accuracy"] and r["gps_accuracy"] > 0 else None,
        "geocode_ignored": bool(r["geocode_ignored"]),
        "date_precision": r["date_precision"] if "date_precision" in r.keys() else None,
        "dir": r["dir"] if "dir" in r.keys() else None,
        "location": row_location(r),
    }


def row_location(r) -> dict | None:
    """Place names from a photo-joined row, or None. Defensive against rows that
    don't carry the loc_* columns (only list_faces rows do)."""
    keys = r.keys()
    if "loc_country" not in keys or not r["loc_country"]:
        return None
    return {"city": r["loc_city"],
            "sublocation": r["loc_sublocation"] if "loc_sublocation" in keys else None,
            "state": r["loc_state"], "country": r["loc_country"]}


def face_item(r) -> dict:
    """Build the JSON-safe face dict (without a suggestion) from a DB row."""
    return {
        "id": r["id"],
        "photo_id": r["photo_id"],
        "filename": r["filename"],
        "bbox": thumbnails.orient_bbox(r["bbox"].split(","), r["orientation"]),
        "det_score": r["det_score"],
        "person_id": r["person_id"],
        "person_name": r["person_name"],
        "ignored": bool(r["ignored"]),
        "come_back": bool(r["come_back"]) if "come_back" in r.keys() else False,
        "photo_datetime": r["photo_datetime"],
        "assigned_at": r["assigned_at"],
        "ignored_at": r["ignored_at"],
        "come_back_at": r["come_back_at"] if "come_back_at" in r.keys() else None,
        "dir": r["dir"] if "dir" in r.keys() else None,
        "location": row_location(r),
        "suggestion": None,
        "alternatives": [],
        "negatives": [],
    }


def person_name_map() -> dict[int, str]:
    """All person ids -> names in one query, for labeling a batch of suggestions."""
    return {r["id"]: r["name"]
            for r in index.get_db().execute("SELECT id, name FROM persons").fetchall()}


def format_photo_datetime(ts: int | None, precision: str | None) -> str | None:
    """Human-readable date for a photo, honest about precision: a manually
    assigned year/month-precision date (see photos_service.assign_approximate_dates)
    never claims a specific day it doesn't have."""
    if not has_date(ts):
        return None
    # epoch_to_wallclock, not datetime.fromtimestamp: the latter raises OSError
    # on Windows for the negative (pre-1970) values an assigned 1955 date stores.
    dt = epoch_to_wallclock(ts)
    if precision == "year":
        return f"~{dt.year}"
    if precision == "month":
        return f"~{dt.strftime('%B %Y')}"
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def format_crowd_group_label(ts: int | None) -> str:
    if not has_date(ts):
        return "Unknown date"
    dt = epoch_to_wallclock(ts)  # pre-1970 safe, see format_photo_datetime
    return f"{dt.strftime('%B')} {dt.day}, {dt.year}"


def scan_error_to_dict(r) -> dict:
    """A scan_errors row; `path` joined the way the scan built dir/filename."""
    import os
    return {
        "path": os.path.join(r["dir"], r["filename"]),
        "dir": r["dir"], "filename": r["filename"],
        "stage": r["stage"], "error": r["error"],
        "first_seen": r["first_seen"], "last_seen": r["last_seen"],
        "attempts": r["attempts"],
    }
