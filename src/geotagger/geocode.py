"""Offline reverse geocoding from GeoNames data.

Maps a coordinate to the nearest populated place (GeoNames cities500) and
resolves that place's administrative hierarchy into human names:

    {city, state, county, country, country_code}

Lookup is a nearest-neighbour search over a KD-tree built on unit-sphere XYZ
vectors, so it's globally correct (no longitude-wrap or latitude-scaling bugs)
and runs in microseconds. Results are cached by quantized coordinate (see
config.GEOCODE_PRECISION) via the index module, so nearby photos share one
lookup.

The data is downloaded with `scripts/get_geonames.py`. If it's missing, every
lookup returns None and `status()` reports it — the rest of the app keeps working.

Landmark resolution (named parks/buildings/POIs, from Overture Maps data — see
`scripts/get_overture_landmarks.py`) is a second, independently-loaded layer:
`resolve_landmark()` adds a `{landmark, landmark_type}` pair on top of the city
result in `lookup()`. It has its own load state so missing landmark data never
breaks city/state/country resolution, and vice versa.
"""

import logging
import math
import threading
from pathlib import Path

from geotagger.config import GEONAMES_DIR, GEOCODE_PRECISION, OVERTURE_DIR, LANDMARK_POI_MAX_KM

logger = logging.getLogger(__name__)

# Load state machine: "unloaded" -> "ready" | "unavailable". Guarded by _lock.
_lock = threading.Lock()
_state = "unloaded"
_error: str | None = None

_tree = None                       # scipy.spatial.cKDTree over city XYZ
_names: list[str] = []             # parallel to the KD-tree points
_ccs: list[str] = []
_admin1: list[str] = []
_admin2: list[str] = []
_lats = None                        # numpy array, parallel to _names — for bbox queries
_lngs = None
_populations = None
_admin1_names: dict[str, str] = {}  # "<cc>.<a1>"        -> state/province name
_admin2_names: dict[str, str] = {}  # "<cc>.<a1>.<a2>"   -> county/district name
_country_names: dict[str, str] = {}  # cc                -> country name

# Landmark load state — separate from the city state machine above, guarded by
# the same _lock (both loaders are one-shot, so contention is a non-issue).
_landmark_state = "unloaded"
_landmark_error: str | None = None

_building_polygons: list[dict] = []  # {"name","category","verts","bbox"}, bbox from polygon_bbox
_park_polygons: list[dict] = []      # same shape as _building_polygons
_place_tree = None                  # scipy.spatial.cKDTree over POI-point XYZ
_place_names: list[str] = []        # parallel to _place_tree
_place_categories: list[str] = []
_place_lats = None                  # numpy array, parallel to _place_names — for bbox queries
_place_lngs = None

_EARTH_RADIUS_KM = 6371.0088


def _cities_file() -> Path:
    return GEONAMES_DIR / "cities500.txt"


def is_available() -> bool:
    """True if the GeoNames data has been downloaded."""
    return _cities_file().exists()


def status() -> dict:
    """Health/diagnostics for the /api/status endpoint."""
    return {
        "available": is_available(),
        "state": _state,
        "error": _error,
        "cities": len(_names) if _state == "ready" else 0,
    }


def _load():
    """Parse the GeoNames files and build the KD-tree. Idempotent; call via
    _ensure_loaded() so it runs once under the lock."""
    global _state, _error, _tree, _lats, _lngs, _populations
    if _state != "unloaded":
        return
    if not is_available():
        _state = "unavailable"
        _error = (f"GeoNames data not found in {GEONAMES_DIR}. "
                  "Run: uv run python scripts/get_geonames.py")
        logger.warning(_error)
        return
    try:
        import numpy as np
        from scipy.spatial import cKDTree

        _load_admin1()
        _load_admin2()
        _load_countries()

        lats: list[float] = []
        lngs: list[float] = []
        pops: list[int] = []
        with _cities_file().open(encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) < 11:
                    continue
                try:
                    lat = float(p[4])
                    lng = float(p[5])
                except ValueError:
                    continue
                lats.append(lat)
                lngs.append(lng)
                _names.append(p[1])
                _ccs.append(p[8])
                _admin1.append(p[10])
                _admin2.append(p[11] if len(p) > 11 else "")
                try:
                    pops.append(int(p[14]) if len(p) > 14 and p[14] else 0)
                except ValueError:
                    pops.append(0)

        _lats = np.asarray(lats)
        _lngs = np.asarray(lngs)
        _populations = np.asarray(pops, dtype=np.int64)

        # Unit-sphere XYZ so nearest-neighbour by Euclidean (chord) distance
        # matches nearest-by-great-circle and is correct near poles/antimeridian.
        lat_r = np.radians(_lats)
        lng_r = np.radians(_lngs)
        cos_lat = np.cos(lat_r)
        xyz = np.column_stack((cos_lat * np.cos(lng_r),
                               cos_lat * np.sin(lng_r),
                               np.sin(lat_r)))
        _tree = cKDTree(xyz)
        _state = "ready"
        logger.info("Reverse geocoder ready: %d cities from %s", len(_names), GEONAMES_DIR)
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never crash startup
        _state = "unavailable"
        _error = f"Failed to load GeoNames data: {e}"
        logger.exception("Reverse geocoder failed to load")


def _load_admin1():
    path = GEONAMES_DIR / "admin1CodesASCII.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                _admin1_names[parts[0]] = parts[1]


def _load_admin2():
    path = GEONAMES_DIR / "admin2Codes.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                _admin2_names[parts[0]] = parts[1]


def _load_countries():
    path = GEONAMES_DIR / "countryInfo.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            # ISO(0)  ISO3(1)  ISO-Numeric(2)  fips(3)  Country(4) ...
            if len(parts) >= 5 and parts[0]:
                _country_names[parts[0]] = parts[4]


def _ensure_loaded():
    if _state == "unloaded":
        with _lock:
            _load()


def _landmarks_file() -> Path:
    return OVERTURE_DIR / "landmarks.jsonl"


def landmarks_available() -> bool:
    """True if the Overture landmark data has been fetched."""
    return _landmarks_file().exists()


def landmark_status() -> dict:
    """Health/diagnostics for the /api/status endpoint."""
    return {
        "available": landmarks_available(),
        "state": _landmark_state,
        "error": _landmark_error,
        "buildings": len(_building_polygons) if _landmark_state == "ready" else 0,
        "parks": len(_park_polygons) if _landmark_state == "ready" else 0,
        "places": len(_place_names) if _landmark_state == "ready" else 0,
    }


def landmarks_ready() -> bool:
    """True if landmark data exists AND actually loaded successfully — unlike
    landmarks_available(), which only checks the file is present. Routes that
    serve landmark data (rather than just reporting status) should gate on
    this, so a file that failed to parse surfaces as unavailable rather than
    silently returning an empty result."""
    _ensure_landmarks_loaded()
    return _landmark_state == "ready"


def _load_landmarks():
    """Parse landmarks.jsonl and build the polygon lists + POI KD-tree. Idempotent;
    call via _ensure_landmarks_loaded() so it runs once under the lock."""
    global _landmark_state, _landmark_error, _place_tree, _place_lats, _place_lngs
    if _landmark_state != "unloaded":
        return
    if not landmarks_available():
        _landmark_state = "unavailable"
        _landmark_error = (f"Overture landmark data not found in {OVERTURE_DIR}. "
                            "Run: uv run --group scripts python scripts/get_overture_landmarks.py")
        logger.warning(_landmark_error)
        return
    try:
        import json as _json

        import numpy as np
        from scipy.spatial import cKDTree

        from geotagger.contexts import polygon_bbox

        place_lats: list[float] = []
        place_lngs: list[float] = []
        bad_rows = 0

        with _landmarks_file().open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                # Each row is parsed in isolation so one malformed line (e.g. from
                # an interrupted fetch-script run) only drops that row, rather than
                # discarding every good row already accumulated in this pass.
                try:
                    row = _json.loads(line)
                    kind = row.get("kind")
                    if kind in ("building", "park"):
                        verts = row["polygon"]
                        if len(verts) < 3:
                            continue
                        entry = {"name": row["name"], "category": row.get("category"),
                                  "verts": verts, "bbox": polygon_bbox(verts)}
                        (_building_polygons if kind == "building" else _park_polygons).append(entry)
                    elif kind == "place":
                        lat, lng = row["point"]
                        place_lats.append(lat)
                        place_lngs.append(lng)
                        _place_names.append(row["name"])
                        _place_categories.append(row.get("category"))
                except Exception:
                    bad_rows += 1

        if bad_rows:
            logger.warning("Skipped %d malformed row(s) in %s", bad_rows, _landmarks_file())

        if place_lats:
            _place_lats = np.asarray(place_lats)
            _place_lngs = np.asarray(place_lngs)
            lat_r = np.radians(_place_lats)
            lng_r = np.radians(_place_lngs)
            cos_lat = np.cos(lat_r)
            xyz = np.column_stack((cos_lat * np.cos(lng_r),
                                   cos_lat * np.sin(lng_r),
                                   np.sin(lat_r)))
            _place_tree = cKDTree(xyz)

        _landmark_state = "ready"
        logger.info("Landmark resolver ready: %d buildings, %d parks, %d places from %s",
                    len(_building_polygons), len(_park_polygons), len(_place_names), OVERTURE_DIR)
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never crash startup
        _landmark_state = "unavailable"
        _landmark_error = f"Failed to load Overture landmark data: {e}"
        logger.exception("Landmark resolver failed to load")


def _ensure_landmarks_loaded():
    if _landmark_state == "unloaded":
        with _lock:
            _load_landmarks()


def _chord_distance_for_km(km: float) -> float:
    """Convert a great-circle distance (km) to the chord (Euclidean) distance
    between the corresponding unit-sphere XYZ points, for use as a cKDTree
    query radius/threshold."""
    central_angle = km / _EARTH_RADIUS_KM
    return 2 * math.sin(central_angle / 2)


def resolve_landmark(lat: float, lng: float) -> dict | None:
    """Resolve a coordinate to a named landmark: inside a building polygon,
    else inside a park polygon, else the nearest curated POI point within
    config.LANDMARK_POI_MAX_KM. Returns {"name", "kind", "category"} or None."""
    _ensure_landmarks_loaded()
    if _landmark_state != "ready":
        return None
    from geotagger.contexts import point_in_polygon

    for kind, polygons in (("building", _building_polygons), ("park", _park_polygons)):
        for entry in polygons:
            min_lat, max_lat, min_lng, max_lng = entry["bbox"]
            if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
                continue
            if point_in_polygon(lat, lng, entry["verts"]):
                return {"name": entry["name"], "kind": kind, "category": entry["category"]}
    if _place_tree is not None:
        lat_r = math.radians(lat)
        lng_r = math.radians(lng)
        cos_lat = math.cos(lat_r)
        point = [cos_lat * math.cos(lng_r), cos_lat * math.sin(lng_r), math.sin(lat_r)]
        dist, idx = _place_tree.query(point)
        if dist <= _chord_distance_for_km(LANDMARK_POI_MAX_KM):
            idx = int(idx)
            return {"name": _place_names[idx], "kind": "place", "category": _place_categories[idx]}
    return None


def landmarks_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                       limit: int = 2000) -> tuple[list[dict], list[dict], int]:
    """Landmark features within a lat/lng box, for the Places DB map layer.

    Returns (polygons, points, total) where polygons is a list of
    {"kind": "building"|"park", "name", "category", "polygon"} and points is a
    list of {"kind": "place", "name", "category", "lat", "lng"}."""
    _ensure_landmarks_loaded()
    polygons: list[dict] = []
    points: list[dict] = []
    if _landmark_state != "ready":
        return polygons, points, 0

    for kind, entries in (("building", _building_polygons), ("park", _park_polygons)):
        for entry in entries:
            e_min_lat, e_max_lat, e_min_lng, e_max_lng = entry["bbox"]
            if e_max_lat < min_lat or e_min_lat > max_lat or e_max_lng < min_lng or e_min_lng > max_lng:
                continue
            polygons.append({"kind": kind, "name": entry["name"], "category": entry["category"],
                              "polygon": entry["verts"]})

    if _place_lats is not None:
        import numpy as np

        mask = (_place_lats >= min_lat) & (_place_lats <= max_lat) & \
               (_place_lngs >= min_lng) & (_place_lngs <= max_lng)
        for i in np.nonzero(mask)[0]:
            i = int(i)
            points.append({"kind": "place", "name": _place_names[i], "category": _place_categories[i],
                           "lat": float(_place_lats[i]), "lng": float(_place_lngs[i])})

    total = len(polygons) + len(points)
    if total > limit:
        polygons = polygons[:limit]
        points = points[:max(0, limit - len(polygons))]
    return polygons, points, total


def quantize(lat: float, lng: float) -> tuple[int, int]:
    """Snap a coordinate to the geocode grid as integer keys (round(coord * 10**precision))."""
    scale = 10 ** GEOCODE_PRECISION
    return round(lat * scale), round(lng * scale)


def _place_dict(i: int) -> dict:
    """Resolve GeoNames row i's admin codes into the {city, state, county,
    country, country_code} shape shared by lookup() and cities_in_bbox()."""
    cc = _ccs[i]
    a1 = _admin1[i]
    a2 = _admin2[i]
    state = _admin1_names.get(f"{cc}.{a1}") if a1 else None
    county = _admin2_names.get(f"{cc}.{a1}.{a2}") if (a1 and a2) else None
    return {
        "city": _names[i] or None,
        "state": state,
        "county": county,
        "country": _country_names.get(cc),
        "country_code": cc or None,
    }


def _raw_lookup(lat: float, lng: float) -> dict | None:
    """Nearest-city lookup without the cache. None if data unavailable."""
    _ensure_loaded()
    if _state != "ready" or _tree is None:
        return None
    lat_r = math.radians(lat)
    lng_r = math.radians(lng)
    cos_lat = math.cos(lat_r)
    point = [cos_lat * math.cos(lng_r), cos_lat * math.sin(lng_r), math.sin(lat_r)]
    _, idx = _tree.query(point)
    return _place_dict(int(idx))


def cities_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                    limit: int = 3000) -> tuple[list[dict], int]:
    """GeoNames places within a lat/lng box — lets the UI show the raw
    reverse-geocode reference data (city/state/county/country + population)
    for inspection, rather than a lookup for a single point.

    Returns (places, total_matched). When total_matched exceeds limit, the
    returned places are the largest by population so the capped view still
    shows the most recognizable places first.
    """
    _ensure_loaded()
    if _state != "ready" or _lats is None:
        return [], 0
    import numpy as np

    mask = (_lats >= min_lat) & (_lats <= max_lat) & (_lngs >= min_lng) & (_lngs <= max_lng)
    idxs = np.nonzero(mask)[0]
    total = int(len(idxs))
    if total > limit:
        idxs = idxs[np.argsort(-_populations[idxs])][:limit]
    places = []
    for i in idxs:
        i = int(i)
        d = _place_dict(i)
        d["lat"] = float(_lats[i])
        d["lng"] = float(_lngs[i])
        d["population"] = int(_populations[i])
        places.append(d)
    return places, total


def _clip_polygon_to_bbox(poly: list[tuple[float, float]], min_lat: float, max_lat: float,
                           min_lng: float, max_lng: float) -> list[tuple[float, float]]:
    """Sutherland-Hodgman clip of a (lat, lng) polygon against an axis-aligned
    box, applied one half-plane at a time. The subject polygon (a Voronoi
    cell) is convex, so this always yields a correct convex result."""

    def clip_edge(points, keep, intersect):
        if not points:
            return points
        out = []
        prev = points[-1]
        prev_in = keep(prev)
        for curr in points:
            curr_in = keep(curr)
            if curr_in:
                if not prev_in:
                    out.append(intersect(prev, curr))
                out.append(curr)
            elif prev_in:
                out.append(intersect(prev, curr))
            prev, prev_in = curr, curr_in
        return out

    def lng_intersect(edge_lng):
        def fn(p0, p1):
            lat0, lng0 = p0
            lat1, lng1 = p1
            t = (edge_lng - lng0) / (lng1 - lng0)
            return (lat0 + t * (lat1 - lat0), edge_lng)
        return fn

    def lat_intersect(edge_lat):
        def fn(p0, p1):
            lat0, lng0 = p0
            lat1, lng1 = p1
            t = (edge_lat - lat0) / (lat1 - lat0)
            return (edge_lat, lng0 + t * (lng1 - lng0))
        return fn

    poly = clip_edge(poly, lambda p: p[1] >= min_lng, lng_intersect(min_lng))
    poly = clip_edge(poly, lambda p: p[1] <= max_lng, lng_intersect(max_lng))
    poly = clip_edge(poly, lambda p: p[0] >= min_lat, lat_intersect(min_lat))
    poly = clip_edge(poly, lambda p: p[0] <= max_lat, lat_intersect(max_lat))
    return poly


def _finite_voronoi_regions(vor, radius: float):
    """Turn a scipy.spatial.Voronoi's unbounded regions (the ones touching
    the convex hull of the input points) into closed polygons, by extending
    their open ridges `radius` units out along the correct bisector
    direction. Standard recipe (the regions are later clipped to a bbox
    anyway, so `radius` just needs to reach past that box).

    Returns (regions, vertices): regions is a list of vertex-index lists
    parallel to vor.points; vertices is the (possibly extended) vertex array.
    """
    import numpy as np

    new_regions = []
    new_vertices = vor.vertices.tolist()
    center = vor.points.mean(axis=0)

    ridges_by_point: dict[int, list[tuple[int, int, int]]] = {}
    for (p1, p2), (v1, v2) in zip(vor.ridge_points, vor.ridge_vertices):
        ridges_by_point.setdefault(p1, []).append((p2, v1, v2))
        ridges_by_point.setdefault(p2, []).append((p1, v1, v2))

    for p1, region_idx in enumerate(vor.point_region):
        vertices = vor.regions[region_idx]
        if all(v >= 0 for v in vertices):
            new_regions.append(vertices)
            continue

        new_region = [v for v in vertices if v >= 0]
        for p2, v1, v2 in ridges_by_point[p1]:
            if v2 < 0:
                v1, v2 = v2, v1
            if v1 >= 0:
                continue  # finite ridge, its vertex is already included above
            t = vor.points[p2] - vor.points[p1]
            t /= np.linalg.norm(t)
            n = np.array([-t[1], t[0]])
            midpoint = vor.points[[p1, p2]].mean(axis=0)
            direction = np.sign(np.dot(midpoint - center, n)) * n
            far_point = vor.vertices[v2] + direction * radius
            new_region.append(len(new_vertices))
            new_vertices.append(far_point.tolist())

        vs = np.asarray([new_vertices[v] for v in new_region])
        c = vs.mean(axis=0)
        angles = np.arctan2(vs[:, 1] - c[1], vs[:, 0] - c[0])
        new_region = list(np.array(new_region)[np.argsort(angles)])
        new_regions.append(new_region)

    return new_regions, np.asarray(new_vertices)


def voronoi_cells(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                   limit: int = 4000) -> tuple[list[dict], int]:
    """Voronoi cells for the GeoNames places behind reverse geocoding — the
    cell around each place is exactly the area where lookup()/_raw_lookup()
    would resolve to that place, so the Places DB map can show where the
    boundary between two places actually falls.

    Computed as a planar Voronoi diagram on points projected to a local
    equirectangular plane (longitude scaled by cos(latitude) so cells aren't
    stretched east-west). This is an approximation of the true spherical
    nearest-neighbour lookup the KD-tree does, but the error is negligible at
    the scale this is shown at (zoomed in far enough to see cells — a few km
    to tens of km across) — and unlike SphericalVoronoi, it doesn't blow up
    numerically when all the points are nearly coplanar in 3D, which is
    exactly what happens when they're clustered in a small viewport.

    Sites are pulled from a bbox padded beyond the requested viewport so edge
    cells have real neighbours to bound them against; unbounded regions are
    closed off (see _finite_voronoi_regions) and every cell is clipped to the
    padded bbox. Only cells whose site lies in the *unpadded* viewport are
    returned, matching what cities_in_bbox would show as markers.

    Returns (cells, total_in_viewport). Each cell is a place dict (as
    cities_in_bbox) plus "polygon": a list of [lat, lng] pairs.
    """
    _ensure_loaded()
    if _state != "ready" or _lats is None:
        return [], 0
    import numpy as np
    from scipy.spatial import Voronoi, QhullError

    in_view = (_lats >= min_lat) & (_lats <= max_lat) & (_lngs >= min_lng) & (_lngs <= max_lng)
    total = int(np.count_nonzero(in_view))
    if total == 0:
        return [], 0

    # Pad by a full viewport's worth on each side so cells for sites near the
    # edge of the viewport have real neighbours to bound them against.
    lat_pad = max(max_lat - min_lat, 0.01)
    lng_pad = max(max_lng - min_lng, 0.01)
    pad_min_lat = max(min_lat - lat_pad, -90.0)
    pad_max_lat = min(max_lat + lat_pad, 90.0)
    pad_min_lng = min_lng - lng_pad
    pad_max_lng = max_lng + lng_pad

    mask = (_lats >= pad_min_lat) & (_lats <= pad_max_lat) & (_lngs >= pad_min_lng) & (_lngs <= pad_max_lng)
    idxs = np.nonzero(mask)[0]
    if len(idxs) > limit:
        # Prioritize sites nearest the viewport center, so the in-view sites
        # (what we actually return cells for) are the ones kept.
        center_lat = (min_lat + max_lat) / 2.0
        center_lng = (min_lng + max_lng) / 2.0
        d2 = (_lats[idxs] - center_lat) ** 2 + (_lngs[idxs] - center_lng) ** 2
        idxs = idxs[np.argsort(d2)[:limit]]

    # Dedupe exact-duplicate coordinates (rare data glitches) — Voronoi()
    # raises on degenerate/coincident generators.
    lat_lng = np.column_stack((_lats[idxs], _lngs[idxs]))
    _, first = np.unique(np.round(lat_lng, 7), axis=0, return_index=True)
    idxs = idxs[np.sort(first)]
    if len(idxs) < 3:
        return [], total

    cos_lat = max(math.cos(math.radians((min_lat + max_lat) / 2.0)), 1e-6)
    pts = np.column_stack((_lngs[idxs] * cos_lat, _lats[idxs]))
    radius = 10 * max(pad_max_lat - pad_min_lat, (pad_max_lng - pad_min_lng) * cos_lat)

    try:
        vor = Voronoi(pts)
        regions, vertices = _finite_voronoi_regions(vor, radius)
    except (QhullError, ValueError):
        logger.warning("Voronoi failed for bbox (%s,%s,%s,%s)", min_lat, max_lat, min_lng, max_lng)
        return [], total

    cells = []
    for i, orig_idx in enumerate(idxs):
        orig_idx = int(orig_idx)
        lat, lng = float(_lats[orig_idx]), float(_lngs[orig_idx])
        if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
            continue  # only return cells for sites the viewport actually contains
        region = regions[i]
        if len(region) < 3:
            continue
        poly = [(float(vertices[v][1]), float(vertices[v][0]) / cos_lat) for v in region]
        poly = _clip_polygon_to_bbox(poly, pad_min_lat, pad_max_lat, pad_min_lng, pad_max_lng)
        if len(poly) < 3:
            continue
        d = _place_dict(orig_idx)
        d["lat"] = lat
        d["lng"] = lng
        d["population"] = int(_populations[orig_idx])
        d["polygon"] = [[round(la, 6), round(ln, 6)] for la, ln in poly]
        cells.append(d)
    return cells, total


def lookup(lat: float | None, lng: float | None, use_cache: bool = True) -> dict | None:
    """Reverse-geocode a coordinate to {city, state, county, country, country_code,
    landmark, landmark_type}.

    The city portion is cached by quantized coordinate so nearby photos reuse
    one result (cache access degrades silently if the DB isn't initialized,
    e.g. raw CLI use). Landmark resolution is deliberately NOT cached: it
    depends on exact point-in-polygon containment, which the quantized cache
    grid (~11m, see config.GEOCODE_PRECISION — sized for city-level fuzziness)
    is too coarse for, and it must reflect the current landmarks.jsonl even
    for coordinates that were already geocoded before that file existed.
    Returns None when neither data source yields a match."""
    if lat is None or lng is None:
        return None
    qlat, qlng = quantize(lat, lng)
    result = None
    if use_cache:
        try:
            from geotagger import index
            result = index.get_cached_geocode(qlat, qlng)
        except Exception:
            pass
    if result is None:
        result = _raw_lookup(lat, lng)
        if use_cache and result is not None:
            try:
                from geotagger import index
                index.put_cached_geocode(qlat, qlng, result)
            except Exception:
                pass
    landmark = resolve_landmark(lat, lng)
    if landmark is not None:
        result = result or {"city": None, "state": None, "county": None,
                             "country": None, "country_code": None}
        result["landmark"] = landmark["name"]
        result["landmark_type"] = landmark["kind"]
    elif result is not None:
        result.setdefault("landmark", None)
        result.setdefault("landmark_type", None)
    return result
