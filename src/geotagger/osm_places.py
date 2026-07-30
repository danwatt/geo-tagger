"""Offline polygon reverse geocoding from OpenStreetMap area boundaries.

Answers "what named place is this coordinate *inside*?" — the authoritative
city/town boundary it falls in, plus the smallest containing named feature
(park, stadium, campus, neighborhood, named building) as a **sub-location**:

    {city, sublocation, category, place_id}

This is polygon **containment**, unlike geocode.py which does nearest-**point**
GeoNames lookup. It replaces the city half of that lookup (GeoNames keeps
state/county/country); the merge lives in geocode.lookup().

Data is a standalone SQLite DB (config.OSM_DB_PATH) built offline from GeoFabrik
extracts by scripts/build_osm_places.py — a `places` table plus an R*Tree
(`places_spatial`). A lookup is an R*Tree bbox prefilter (a handful of candidate
polygons) followed by an exact point-in-polygon test, so it runs in microseconds.
The DB is opened read-only and shared across executor threads under a lock. If it
hasn't been built, every lookup returns None and status() reports it — the rest of
the app keeps working, falling back to GeoNames.
"""

import json
import logging
import sqlite3
import threading

from geotagger import config
from geotagger.contexts import point_in_polygon
from geotagger.db_timing import TimedConnection

logger = logging.getLogger(__name__)

# Load state machine mirrors geocode.py: "unloaded" -> "ready" | "unavailable".
_lock = threading.Lock()
_state = "unloaded"
_error: str | None = None
_conn: sqlite3.Connection | None = None

# Sub-location categories, most-specific-preferred order only used as a final
# tiebreak; primary selection is by smallest polygon area.
_SUB_CATEGORIES = {"neighbourhood", "park", "venue", "campus", "attraction", "building"}


def is_available() -> bool:
    """True if the OSM places DB has been built."""
    return config.OSM_DB_PATH.exists()


def status() -> dict:
    """Health/diagnostics for the status endpoints. Triggers the lazy DB load (a
    cheap open + COUNT) so callers get an accurate count/breakdown on the very
    first call, not just after the first lookup()."""
    _ensure_loaded()
    st = {"available": is_available(), "state": _state, "error": _error,
          "places": 0, "by_category": {}}
    if _state == "ready" and _conn is not None:
        try:
            st["places"] = _conn.execute("SELECT COUNT(*) FROM places").fetchone()[0]
            st["by_category"] = {
                r["category"]: r["n"] for r in _conn.execute(
                    "SELECT category, COUNT(*) AS n FROM places GROUP BY category ORDER BY n DESC"
                ).fetchall()
            }
        except Exception:
            pass
    return st


def _load():
    """Open the read-only connection. Idempotent; call via _ensure_loaded()."""
    global _state, _error, _conn
    if _state != "unloaded":
        return
    if not is_available():
        _state = "unavailable"
        _error = (f"OSM places DB not found at {config.OSM_DB_PATH}. "
                  "Build it: uv run python scripts/build_osm_places.py <region>.osm.pbf")
        logger.warning(_error)
        return
    try:
        # Read-only, shared across executor threads (guarded by _lock). The DB is
        # built with a rollback journal, so a clean single file opens read-only.
        uri = f"file:{config.OSM_DB_PATH.as_posix()}?mode=ro"
        _conn = sqlite3.connect(uri, uri=True, check_same_thread=False, factory=TimedConnection)
        _conn.row_factory = sqlite3.Row
        n = _conn.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        _state = "ready"
        logger.info("OSM places ready: %d polygons from %s", n, config.OSM_DB_PATH)
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never crash startup
        _state = "unavailable"
        _error = f"Failed to open OSM places DB: {e}"
        logger.exception("OSM places failed to load")


def _ensure_loaded():
    if _state == "unloaded":
        with _lock:
            _load()


def point_in_multipolygon(lat: float, lng: float, polygons: list) -> bool:
    """Containment test for our stored ring format: [[outer, [hole,...]], ...],
    each ring [[lat, lng], ...]. Inside iff the point is inside some polygon's
    outer ring and not inside any of that polygon's holes."""
    for outer, holes in polygons:
        if point_in_polygon(lat, lng, outer) and not any(
            point_in_polygon(lat, lng, h) for h in holes
        ):
            return True
    return False


def _containing_rows(lat: float, lng: float) -> list[sqlite3.Row]:
    """All place rows whose polygon actually contains the point. R*Tree bbox
    prefilter (cheap, indexed) then exact point-in-polygon on the survivors."""
    _ensure_loaded()
    if _state != "ready" or _conn is None:
        return []
    with _lock:
        candidates = _conn.execute(
            """SELECT p.id, p.name, p.category, p.admin_level, p.rank, p.area, p.rings
               FROM places_spatial s JOIN places p ON p.id = s.id
               WHERE s.min_lat <= ? AND s.max_lat >= ?
                 AND s.min_lng <= ? AND s.max_lng >= ?""",
            (lat, lat, lng, lng),
        ).fetchall()
    hits = []
    for r in candidates:
        if point_in_multipolygon(lat, lng, json.loads(r["rings"])):
            hits.append(r)
    return hits


def lookup(lat: float | None, lng: float | None) -> dict | None:
    """Resolve a coordinate to {city, sublocation, category, place_id} via polygon
    containment, or None if the DB is unavailable or the point is inside nothing.

    city        = smallest 'city' polygon containing the point (innermost of any
                  nested municipalities), or None if the point is in no city.
    sublocation = smallest non-city named feature containing the point, or None.
    category/place_id describe the chosen sub-location (or the city if there is no
    sub-location) so the UI can label/link it."""
    if lat is None or lng is None:
        return None
    hits = _containing_rows(lat, lng)
    if not hits:
        return None

    cities = [r for r in hits if r["category"] == "city"]
    subs = [r for r in hits if r["category"] in _SUB_CATEGORIES]
    city_row = min(cities, key=lambda r: r["area"]) if cities else None
    sub_row = min(subs, key=lambda r: r["area"]) if subs else None

    chosen = sub_row or city_row  # what category/place_id describe
    return {
        "city": city_row["name"] if city_row else None,
        "sublocation": sub_row["name"] if sub_row else None,
        "category": chosen["category"] if chosen else None,
        "place_id": chosen["id"] if chosen else None,
    }


def places_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                   limit: int = 4000, include_buildings: bool = True) -> tuple[list[dict], int]:
    """OSM place polygons overlapping a viewport bbox — backs the Places DB map's
    OSM overlay so the user can see the real city/park/venue boundaries.

    Buildings vastly outnumber every other category, so include_buildings=False
    (the map only sets it True once zoomed in past its own building-level
    threshold) excludes them at the SQL level rather than relying on the area-DESC
    LIMIT to starve them out — cheaper, and keeps the limit's headroom for the
    categories that matter at city/region zoom.

    Returns (places, total_matched). When total exceeds limit, the returned places
    are the largest by area, so the capped view still shows the most prominent
    boundaries. Each place dict carries name/category/rank/area + `polygons` in the
    stored ring format ([[outer,[holes]], ...], ring = [[lat,lng],...])."""
    _ensure_loaded()
    if _state != "ready" or _conn is None:
        return [], 0
    category_filter = "" if include_buildings else "AND p.category != 'building'"
    with _lock:
        total = _conn.execute(
            f"""SELECT COUNT(*) FROM places_spatial s JOIN places p ON p.id = s.id
               WHERE s.min_lat <= ? AND s.max_lat >= ? AND s.min_lng <= ? AND s.max_lng >= ?
               {category_filter}""",
            (max_lat, min_lat, max_lng, min_lng),
        ).fetchone()[0]
        rows = _conn.execute(
            f"""SELECT p.id, p.name, p.category, p.admin_level, p.rank, p.area, p.rings
               FROM places_spatial s JOIN places p ON p.id = s.id
               WHERE s.min_lat <= ? AND s.max_lat >= ? AND s.min_lng <= ? AND s.max_lng >= ?
               {category_filter}
               ORDER BY p.area DESC LIMIT ?""",
            (max_lat, min_lat, max_lng, min_lng, limit),
        ).fetchall()
    places = [
        {
            "id": r["id"],
            "name": r["name"],
            "category": r["category"],
            "admin_level": r["admin_level"],
            "rank": r["rank"],
            "area": r["area"],
            "polygons": json.loads(r["rings"]),
        }
        for r in rows
    ]
    return places, total


def _to_geojson_ring(ring: list) -> list:
    """[[lat,lng],...] -> GeoJSON [[lng,lat],...], closing it (repeating the first
    point as the last) if it isn't already — the GeoJSON spec requires a closed
    linear ring, which osmium's assembled areas already satisfy but isn't
    guaranteed for every ring source (e.g. hand-built test fixtures)."""
    coords = [[lng, lat] for lat, lng in ring]
    if coords and coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def polygons_to_geojson_coords(polygons: list) -> list:
    """Our stored ring format [[outer, [hole, ...]], ...] (ring = [[lat,lng],...])
    -> GeoJSON MultiPolygon coordinates: [[exterior, hole, ...], ...], with each
    ring [[lng,lat],...] (GeoJSON is lng/lat, the opposite of our stored order).

    Public because census_places stores its rings in this same format and hands them
    to the map the same way."""
    return [
        [_to_geojson_ring(outer)] + [_to_geojson_ring(hole) for hole in holes]
        for outer, holes in polygons
    ]


def place_to_geojson_feature(place: dict) -> dict:
    """A places_in_bbox() place dict -> a GeoJSON Feature (MultiPolygon geometry +
    the non-geometry fields as properties), for handing straight to Leaflet's
    L.geoJSON()."""
    return {
        "type": "Feature",
        "properties": {
            "id": place["id"],
            "name": place["name"],
            "category": place["category"],
            "admin_level": place["admin_level"],
            "rank": place["rank"],
            "area": place["area"],
        },
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": polygons_to_geojson_coords(place["polygons"]),
        },
    }
