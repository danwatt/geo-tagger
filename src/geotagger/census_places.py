"""Offline polygon reverse geocoding from US Census place boundaries.

Answers "what US Census place is this coordinate inside?" — every incorporated
place plus every census designated place (CDP):

    {city, geoid, kind, place_id}

Same shape as osm_places.py (R*Tree bbox prefilter + exact point-in-polygon over
a read-only SQLite DB, shared across executor threads under a lock), and the same
stored ring format, so the containment test is reused rather than reimplemented.

This sits between the two existing sources in geocode._merged_lookup: OSM city
boundaries are still the authority, but where OSM has nothing — unincorporated
suburbia, which OSM simply doesn't carry a boundary for — a Census CDP polygon is
a far better answer than the GeoNames nearest-point guess that used to run next.
Sub-locations stay OSM-only; the Census place file has no parks/campuses/venues.

The DB is built by scripts/get_census_places.py (or the Data Management page). If
it hasn't been built, every lookup returns None and status() reports it, leaving
the OSM -> GeoNames chain exactly as it was.
"""

import json
import logging
import sqlite3
import threading

from geotagger import config
from geotagger.db_timing import TimedConnection
from geotagger.osm_places import point_in_multipolygon, polygons_to_geojson_coords

logger = logging.getLogger(__name__)

# Load state machine mirrors osm_places.py: "unloaded" -> "ready" | "unavailable".
_lock = threading.Lock()
_state = "unloaded"
_error: str | None = None
_conn: sqlite3.Connection | None = None


def is_available() -> bool:
    """True if the census places DB has been built."""
    return config.CENSUS_DB_PATH.exists()


def status() -> dict:
    """Health/diagnostics for the status endpoints. Triggers the lazy DB load (a
    cheap open + COUNT) so the first call already reports real numbers."""
    _ensure_loaded()
    st = {"available": is_available(), "state": _state, "error": _error,
          "places": 0, "by_kind": {}, "source": None}
    if _state == "ready" and _conn is not None:
        try:
            st["places"] = _conn.execute("SELECT COUNT(*) FROM places").fetchone()[0]
            st["by_kind"] = {
                (r["kind"] or "other"): r["n"] for r in _conn.execute(
                    "SELECT kind, COUNT(*) AS n FROM places GROUP BY kind ORDER BY n DESC"
                ).fetchall()
            }
            row = _conn.execute("SELECT value FROM meta WHERE key='source'").fetchone()
            st["source"] = row[0] if row else None
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
        _error = (f"Census places DB not found at {config.CENSUS_DB_PATH}. "
                  "Build it: uv run python scripts/get_census_places.py")
        logger.info(_error)
        return
    try:
        uri = f"file:{config.CENSUS_DB_PATH.as_posix()}?mode=ro"
        _conn = sqlite3.connect(uri, uri=True, check_same_thread=False, factory=TimedConnection)
        _conn.row_factory = sqlite3.Row
        n = _conn.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        _state = "ready"
        logger.info("Census places ready: %d polygons from %s", n, config.CENSUS_DB_PATH)
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never crash startup
        _state = "unavailable"
        _error = f"Failed to open census places DB: {e}"
        logger.exception("Census places failed to load")


def _ensure_loaded():
    if _state == "unloaded":
        with _lock:
            _load()


def reset():
    """Drop the open handle and go back to "unloaded", so the next lookup reopens
    whatever is on disk. Needed before a (re)build replaces the file — Windows
    won't let it be replaced while this connection holds it open."""
    global _state, _error, _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
        _conn = None
        _state = "unloaded"
        _error = None


def _containing_rows(lat: float, lng: float) -> list[sqlite3.Row]:
    """All place rows whose polygon actually contains the point. R*Tree bbox
    prefilter (cheap, indexed) then exact point-in-polygon on the survivors."""
    _ensure_loaded()
    if _state != "ready" or _conn is None:
        return []
    with _lock:
        candidates = _conn.execute(
            """SELECT p.id, p.geoid, p.name, p.name_lsad, p.kind, p.state_name, p.area, p.rings
               FROM places_spatial s JOIN places p ON p.id = s.id
               WHERE s.min_lat <= ? AND s.max_lat >= ?
                 AND s.min_lng <= ? AND s.max_lng >= ?""",
            (lat, lat, lng, lng),
        ).fetchall()
    return [r for r in candidates
            if point_in_multipolygon(lat, lng, json.loads(r["rings"]))]


def lookup(lat: float | None, lng: float | None) -> dict | None:
    """Resolve a coordinate to {city, geoid, kind, place_id, state}, or None if the
    DB is unavailable or the point is inside no place.

    Census places don't nest (they're a partition of named populated area within a
    state), but a coordinate can still land in two polygons where boundaries were
    generalized to 1:500,000 and now overlap slightly — so the smallest containing
    polygon wins, same tiebreak osm_places uses."""
    if lat is None or lng is None:
        return None
    hits = _containing_rows(lat, lng)
    if not hits:
        return None
    row = min(hits, key=lambda r: r["area"])
    return {
        "city": row["name"],
        "geoid": row["geoid"],
        "kind": row["kind"],
        "place_id": row["id"],
        "state": row["state_name"],
    }


def places_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                   limit: int = 4000) -> tuple[list[dict], int]:
    """Census place polygons overlapping a viewport bbox — backs the Places DB map's
    census overlay, so the boundaries the lookup uses can be seen directly.

    Returns (places, total_matched). When total exceeds limit, the returned places
    are the largest by area, so a capped view still shows the prominent boundaries.
    Each place dict carries name/kind/geoid/area + `polygons` in the stored ring
    format ([[outer,[holes]], ...], ring = [[lat,lng],...])."""
    _ensure_loaded()
    if _state != "ready" or _conn is None:
        return [], 0
    with _lock:
        total = _conn.execute(
            """SELECT COUNT(*) FROM places_spatial s
               WHERE s.min_lat <= ? AND s.max_lat >= ? AND s.min_lng <= ? AND s.max_lng >= ?""",
            (max_lat, min_lat, max_lng, min_lng),
        ).fetchone()[0]
        rows = _conn.execute(
            """SELECT p.id, p.geoid, p.name, p.name_lsad, p.kind, p.state_name, p.area, p.rings
               FROM places_spatial s JOIN places p ON p.id = s.id
               WHERE s.min_lat <= ? AND s.max_lat >= ? AND s.min_lng <= ? AND s.max_lng >= ?
               ORDER BY p.area DESC LIMIT ?""",
            (max_lat, min_lat, max_lng, min_lng, limit),
        ).fetchall()
    places = [
        {
            "id": r["id"],
            "geoid": r["geoid"],
            "name": r["name"],
            "name_lsad": r["name_lsad"],
            "kind": r["kind"],
            "state": r["state_name"],
            "area": r["area"],
            "polygons": json.loads(r["rings"]),
        }
        for r in rows
    ]
    return places, total


def place_to_geojson_feature(place: dict) -> dict:
    """A places_in_bbox() place dict -> a GeoJSON Feature (MultiPolygon geometry + the
    non-geometry fields as properties), for handing straight to Leaflet's L.geoJSON()."""
    return {
        "type": "Feature",
        "properties": {
            "id": place["id"],
            "geoid": place["geoid"],
            "name": place["name"],
            "name_lsad": place["name_lsad"],
            "kind": place["kind"],
            "state": place["state"],
            "area": place["area"],
        },
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": polygons_to_geojson_coords(place["polygons"]),
        },
    }
