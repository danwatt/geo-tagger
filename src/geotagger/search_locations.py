"""Local search suggestions and saved-place spatial predicates."""

import json
import math
from functools import lru_cache

FIELDS = ("loc_sublocation", "loc_city", "loc_county", "loc_state", "loc_country")


def suggestions(db, query: str, limit: int = 20) -> list[dict]:
    tokens = query.casefold().replace(",", " ").split()
    matches = []
    for row in db.execute("SELECT id, name FROM places ORDER BY name"):
        if all(token in row["name"].casefold() for token in tokens):
            matches.append({"kind": "place", "id": row["id"], "label": row["name"]})
    # Each level retains its parent context, so Washington County, Texas and
    # Washington County, Oregon are separate choices with exact predicates.
    for i, field in enumerate(FIELDS):
        columns = FIELDS[i:]
        select = ", ".join(f"COALESCE({c}, '') AS {c}" for c in columns)
        rows = db.execute(f"SELECT {select}, COUNT(*) AS count FROM photos "
                          f"WHERE {field} IS NOT NULL AND {field} != '' "
                          f"GROUP BY {', '.join(columns)}")
        for row in rows:
            values = {c: row[c] for c in columns}
            label = ", ".join(v for v in values.values() if v)
            if all(token in label.casefold() for token in tokens):
                matches.append({"kind": "metadata", "label": label,
                                "fields": values, "count": row["count"],
                                "level": field.removeprefix("loc_")})
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


@lru_cache(maxsize=128)
def _bounds(raw):
    return json.loads(raw)


def place_distance(lat, lng, kind, raw):
    """Meters outside a saved area (zero inside); rectangles use local distance."""
    if lat is None or lng is None:
        return None
    b = _bounds(raw)
    if kind == "circle":
        p1, p2 = math.radians(lat), math.radians(b["lat"])
        a = math.sin((p1 - p2) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng - b["lng"]) / 2) ** 2
        return max(0, 6371000 * 2 * math.asin(math.sqrt(min(1, a))) - b["radius"])
    if kind != "rectangle":
        return None
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
    R*Tree prefilter. A circle's box overshoots its corners by ~27% of area, so
    callers pair this with place_distance() == 0 for the exact test."""
    try:
        b = _bounds(raw)
        if kind == "circle":
            lat_off = b["radius"] / 111320
            lng_off = b["radius"] / (111320 * max(1e-6, math.cos(math.radians(b["lat"]))))
            return (b["lat"] - lat_off, b["lat"] + lat_off,
                    b["lng"] - lng_off, b["lng"] + lng_off)
        if kind == "rectangle":
            return (b["south"], b["north"], b["west"], b["east"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return None
