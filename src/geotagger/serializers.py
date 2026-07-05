"""Pure DB-row -> JSON-safe dict helpers shared across API routes. No FastAPI here,
and no writes/I/O beyond the one read in person_name_map(); safe to unit-test against
sqlite3.Row objects."""

from geotagger import index, thumbnails, contexts


def photo_to_dict(r) -> dict:
    """Grid/list shape for a photo row (carries geocode_ignored, dir, and place names —
    dir/location are only consumed by the Undated grid's location-else-directory
    grouping; every other page ignores them)."""
    return {
        "id": r["id"], "filename": r["filename"], "media_type": r["media_type"],
        "lat": r["lat"], "lng": r["lng"], "geotag_source": r["geotag_source"],
        "camera": r["camera"], "photo_datetime": r["photo_datetime"],
        "gps_accuracy": r["gps_accuracy"] if r["gps_accuracy"] and r["gps_accuracy"] > 0 else None,
        "geocode_ignored": bool(r["geocode_ignored"]),
        "dir": r["dir"] if "dir" in r.keys() else None,
        "location": row_location(r),
    }


def photo_geocode_dict(r) -> dict:
    """Geotag-group shape for a photo row (carries nested place names, no
    geocode_ignored). Distinct from photo_to_dict — don't merge the two."""
    return {
        "id": r["id"], "filename": r["filename"], "media_type": r["media_type"],
        "lat": r["lat"], "lng": r["lng"], "geotag_source": r["geotag_source"],
        "camera": r["camera"], "photo_datetime": r["photo_datetime"],
        "gps_accuracy": r["gps_accuracy"] if r["gps_accuracy"] and r["gps_accuracy"] > 0 else None,
        "location": {
            "city": r["loc_city"],
            "sublocation": r["loc_sublocation"] if "loc_sublocation" in r.keys() else None,
            "state": r["loc_state"],
            "country": r["loc_country"],
        } if r["loc_country"] else None
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
        "photo_datetime": r["photo_datetime"],
        "assigned_at": r["assigned_at"],
        "ignored_at": r["ignored_at"],
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


def context_row_to_dict(c, persons=None) -> dict:
    import json as _json
    return {
        "id": c["id"],
        "name": c["name"],
        "polygon": _json.loads(c["polygon"]),
        "start_date": contexts.ts_to_date(c["start_ts"]),
        "end_date": contexts.ts_to_date(c["end_ts"]),
        "start_ts": c["start_ts"],
        "end_ts": c["end_ts"],
        "photo_count_approx": c["photo_count_approx"] if "photo_count_approx" in c.keys() else None,
        "created_at": c["created_at"],
        "persons": [{"id": p["id"], "name": p["name"]} for p in (persons or [])],
    }


def format_crowd_group_label(ts: int) -> str:
    if not ts:
        return "Unknown date"
    from datetime import datetime, timezone
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return f"{dt.strftime('%B')} {dt.day}, {dt.year}"
