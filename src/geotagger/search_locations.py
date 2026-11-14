"""Local search suggestions and saved-place spatial predicates."""

import json
import math

from geotagger.place_bounds import parse_bounds

FIELDS = ("loc_sublocation", "loc_city", "loc_county", "loc_state", "loc_country")


def suggestions(db, query: str, limit: int = 20) -> list[dict]:
    """Saved places and photo-metadata locations matching every query token.

    Each match carries `bounds` = [south, west, north, east] (or None when no
    coordinates are known) so the geocode page's "jump to location" box can pan
    the map offline instead of asking an online geocoder."""
    tokens = query.casefold().replace(",", " ").split()
    matches = []
    for row in db.execute("SELECT id, name, type, bounds FROM places ORDER BY name"):
        if all(token in row["name"].casefold() for token in tokens):
            box = place_bbox(row["type"], row["bounds"])
            matches.append({"kind": "place", "id": row["id"], "label": row["name"],
                            "bounds": [box[0], box[2], box[1], box[3]] if box else None})
    # Each level retains its parent context, so Washington County, Texas and
    # Washington County, Oregon are separate choices with exact predicates.
    # MIN/MAX ride along in the same GROUP BY (NULL coords are ignored), so the
    # extent costs no extra query.
    for i, field in enumerate(FIELDS):
        columns = FIELDS[i:]
        select = ", ".join(f"COALESCE({c}, '') AS {c}" for c in columns)
        rows = db.execute(f"SELECT {select}, COUNT(*) AS count, "
                          f"MIN(lat) AS s, MIN(lng) AS w, MAX(lat) AS n, MAX(lng) AS e "
                          f"FROM photos "
                          f"WHERE {field} IS NOT NULL AND {field} != '' "
                          f"GROUP BY {', '.join(columns)}")
        for row in rows:
            values = {c: row[c] for c in columns}
            label = ", ".join(v for v in values.values() if v)
            if all(token in label.casefold() for token in tokens):
                matches.append({"kind": "metadata", "label": label,
                                "fields": values, "count": row["count"],
                                "level": field.removeprefix("loc_"),
                                "bounds": ([row["s"], row["w"], row["n"], row["e"]]
                                           if row["s"] is not None else None)})
    matches.sort(key=lambda m: (m["kind"] != "place", -m.get("count", 0), m["label"].casefold()))
    return matches[:limit]


def parse_fields(value: str | None) -> dict:
    if value is None:
        return {}
    fields = json.loads(value)
    if not isinstance(fields, dict) or not fields or any(
        k not in FIELDS or not isinstance(v, str) for k, v in fields.items()
    ) or not any(fields.values()):
        raise ValueError("Invalid location selection")
    return fields


def place_distance(lat, lng, kind, raw):
    """Meters outside a saved area (zero inside); rectangles use local distance.

    Registered as the `search_place_distance` SQLite UDF, so it must never raise:
    an exception inside a UDF surfaces as sqlite3.OperationalError and 500s the
    whole query (audit A5). Unusable bounds return NULL, which `<= ?` / `= 0`
    read as "not inside"."""
    if lat is None or lng is None:
        return None
    b = parse_bounds(kind, raw)
    if b is None:
        return None
    if kind == "circle":
        p1, p2 = math.radians(lat), math.radians(b["lat"])
        a = math.sin((p1 - p2) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng - b["lng"]) / 2) ** 2
        return max(0, 6371000 * 2 * math.asin(math.sqrt(min(1, a))) - b["radius"])
    west, east = b["west"], b["east"]
    if east < west:
        east += 360
    center = (west + east) / 2
    lng = center + (lng - center + 180) % 360 - 180
    near_lat = max(b["south"], min(b["north"], lat))
    near_lng = max(west, min(east, lng))
    return math.hypot((lat - near_lat) * 111195,
                      (lng - near_lng) * 111195 * math.cos(math.radians(near_lat)))


def place_bbox(kind, raw) -> tuple[float, float, float, float] | None:
    """(min_lat, max_lat, min_lng, max_lng) enclosing a saved place, for an
    R*Tree prefilter, or None for unusable bounds. A circle's box overshoots its
    corners by ~27% of area, so callers pair this with place_distance() == 0 for
    the exact test."""
    b = parse_bounds(kind, raw)
    if b is None:
        return None
    if kind == "circle":
        lat_off = b["radius"] / 111320
        lng_off = b["radius"] / (111320 * max(1e-6, math.cos(math.radians(b["lat"]))))
        return (b["lat"] - lat_off, b["lat"] + lat_off,
                b["lng"] - lng_off, b["lng"] + lng_off)
    return (b["south"], b["north"], b["west"], b["east"])
