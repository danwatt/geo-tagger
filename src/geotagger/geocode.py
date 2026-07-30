"""Offline reverse geocoding from GeoNames data.

Maps a coordinate to the nearest populated place (GeoNames cities500) and
resolves that place's administrative hierarchy into human names:

    {city, state, county, country, country_code}

Lookup is a nearest-neighbour search over a KD-tree built on unit-sphere XYZ
vectors, so it's globally correct (no longitude-wrap or latitude-scaling bugs)
and runs in microseconds. By default the winner among the k nearest is then
population-weighted (config.GEOCODE_POP_WEIGHT) so an obscure GNIS subdivision
doesn't beat a real town it happens to sit slightly closer than. Results are
cached by quantized coordinate (see config.GEOCODE_PRECISION) via the index
module, so nearby photos share one lookup.

The data is downloaded with `scripts/get_geonames.py`. If it's missing, every
lookup returns None and `status()` reports it — the rest of the app keeps working.
"""

import logging
import math
import threading
from pathlib import Path

from geotagger import config
from geotagger.config import GEOCODE_PRECISION

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


def _cities_file() -> Path:
    return config.GEONAMES_DIR / "cities500.txt"


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
        _error = (f"GeoNames data not found in {config.GEONAMES_DIR}. "
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
        logger.info("Reverse geocoder ready: %d cities from %s", len(_names), config.GEONAMES_DIR)
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never crash startup
        _state = "unavailable"
        _error = f"Failed to load GeoNames data: {e}"
        logger.exception("Reverse geocoder failed to load")


def _load_admin1():
    path = config.GEONAMES_DIR / "admin1CodesASCII.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                _admin1_names[parts[0]] = parts[1]


def _load_admin2():
    path = config.GEONAMES_DIR / "admin2Codes.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                _admin2_names[parts[0]] = parts[1]


def _load_countries():
    path = config.GEONAMES_DIR / "countryInfo.txt"
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


_EARTH_RADIUS_KM = 6371.0


def _chord_to_km(chord: float) -> float:
    """Unit-sphere chord length (what the KD-tree returns) -> great-circle km."""
    return 2 * _EARTH_RADIUS_KM * math.asin(min(1.0, chord / 2))


def _pick_weighted(dists: list[float], idxs: list[int]) -> int:
    """Choose among k nearest candidates (parallel chord distances / row indices,
    nearest first) by `km / (1 + log10(population))`, so a much larger place can
    win a near-tie in distance — see config.GEOCODE_POP_WEIGHT for why.

    Two guards keep this from rewriting labels it has no business rewriting:
    candidates further than config.GEOCODE_POP_WEIGHT_MAX_KM past the nearest one
    are dropped before scoring (no drifting to a distant city in sparse rural
    areas), and a survivor must beat the nearest place's own score by
    config.GEOCODE_POP_WEIGHT_MARGIN to win (no flipping on near-ties).

    Returns a row index into _names/_populations.
    """
    # cKDTree pads a k larger than the point count with inf distances and
    # out-of-range indices; drop those before doing any arithmetic.
    pairs = [(_chord_to_km(d), i) for d, i in zip(dists, idxs)
             if math.isfinite(d) and 0 <= i < len(_names)]
    if not pairs:
        return int(idxs[0])

    def score(km: float, i: int) -> float:
        pop = int(_populations[i]) if _populations is not None else 0
        return km / (1 + math.log10(max(pop, 1)))

    nearest_km, nearest_i = pairs[0]
    reach = nearest_km + config.GEOCODE_POP_WEIGHT_MAX_KM
    # Anything that wins must clear this, so the nearest place keeps the label by
    # default — including when it's already the best-scoring candidate.
    threshold = score(nearest_km, nearest_i) * (1.0 - config.GEOCODE_POP_WEIGHT_MARGIN)
    best_i = nearest_i
    best_score = threshold
    for km, i in pairs[1:]:
        if km > reach:
            continue
        s = score(km, i)
        if s < best_score:
            best_score, best_i = s, i
    return best_i


def _raw_lookup(lat: float, lng: float) -> dict | None:
    """Nearest-city lookup without the cache. None if data unavailable.

    "Nearest" is population-weighted when config.GEOCODE_POP_WEIGHT is on (see
    _pick_weighted); otherwise it's the plain nearest point.
    """
    _ensure_loaded()
    if _state != "ready" or _tree is None:
        return None
    lat_r = math.radians(lat)
    lng_r = math.radians(lng)
    cos_lat = math.cos(lat_r)
    point = [cos_lat * math.cos(lng_r), cos_lat * math.sin(lng_r), math.sin(lat_r)]
    if not config.GEOCODE_POP_WEIGHT:
        _, idx = _tree.query(point)
        return _place_dict(int(idx))
    k = max(1, min(config.GEOCODE_CANDIDATES, len(_names)))
    dists, idxs = _tree.query(point, k=k)
    if k == 1:  # scipy returns scalars, not arrays, for k=1
        return _place_dict(int(idxs))
    return _place_dict(_pick_weighted([float(d) for d in dists], [int(i) for i in idxs]))


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


def _label_grid(lat_grid, lng_grid):
    """Vectorized twin of _pick_weighted: resolve a whole array of coordinates to
    winning GeoNames row indices in one KD-tree query. Same scoring, same reach
    cap, same margin — kept in lockstep with _pick_weighted so the map's
    boundaries describe the lookup that actually runs, not a lookalike.

    ``lat_grid``/``lng_grid`` are flat float arrays of equal length; returns an
    int array of row indices into _names/_populations.
    """
    import numpy as np

    lat_r = np.radians(lat_grid)
    lng_r = np.radians(lng_grid)
    cos_lat = np.cos(lat_r)
    pts = np.column_stack((cos_lat * np.cos(lng_r), cos_lat * np.sin(lng_r), np.sin(lat_r)))

    k = max(1, min(config.GEOCODE_CANDIDATES, len(_names)))
    dists, idxs = _tree.query(pts, k=k)
    # k=1 collapses scipy's (N, k) result to (N,); reshape so the rest is uniform.
    dists = np.reshape(dists, (len(lat_grid), k))
    idxs = np.reshape(idxs, (len(lat_grid), k))
    nearest = idxs[:, 0]
    if k == 1:
        return nearest

    km = 2 * _EARTH_RADIUS_KM * np.arcsin(np.clip(dists / 2, 0.0, 1.0))
    pops = np.maximum(_populations[idxs], 1)
    score = km / (1 + np.log10(pops))

    threshold = score[:, 0] * (1.0 - config.GEOCODE_POP_WEIGHT_MARGIN)
    within_reach = km <= (km[:, 0:1] + config.GEOCODE_POP_WEIGHT_MAX_KM)
    # Only the challengers compete; the nearest place holds the label unless one
    # of them clears the margin (mirrors _pick_weighted's seeded best_score).
    challenger = np.where(within_reach, score, np.inf)
    challenger[:, 0] = np.inf
    best_j = np.argmin(challenger, axis=1)
    rows = np.arange(len(lat_grid))
    best_score = challenger[rows, best_j]
    return np.where(best_score < threshold, idxs[rows, best_j], nearest)


def _trace_mask_rings(mask) -> list[list[tuple[int, int]]]:
    """Outline a boolean grid region as closed rings of integer lattice corners.

    Emits every cell edge that borders a non-region cell, directed so the region
    stays on a consistent side, then chains those edges head-to-tail into rings.
    Shared edges between two region cells are never emitted, so the walk closes
    exactly — no marching-squares interpolation and no dependency beyond numpy.
    Returns rings as [(row, col), …] lattice coordinates, where (row, col) is the
    corner at grid index (row, col); a region with holes or disjoint blobs yields
    one ring each.
    """
    import numpy as np

    ny, nx = mask.shape
    padded = np.zeros((ny + 2, nx + 2), dtype=bool)
    padded[1:-1, 1:-1] = mask
    inner = padded[1:-1, 1:-1]

    # (start, end) corner pairs per boundary edge, in grid-index space where row
    # increases "up" (see _weighted_cells' lat mapping) — so this order walks the
    # region's outer boundary counter-clockwise.
    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}
    def add(starts, ends):
        for s, e in zip(starts, ends):
            edges.setdefault(s, []).append(e)

    rr, cc = np.nonzero(inner & ~padded[2:, 1:-1])    # nothing above -> top edge
    add(list(zip(rr + 1, cc + 1)), list(zip(rr + 1, cc)))
    rr, cc = np.nonzero(inner & ~padded[:-2, 1:-1])   # nothing below -> bottom edge
    add(list(zip(rr, cc)), list(zip(rr, cc + 1)))
    rr, cc = np.nonzero(inner & ~padded[1:-1, 2:])    # nothing right -> right edge
    add(list(zip(rr, cc + 1)), list(zip(rr + 1, cc + 1)))
    rr, cc = np.nonzero(inner & ~padded[1:-1, :-2])   # nothing left -> left edge
    add(list(zip(rr + 1, cc)), list(zip(rr, cc)))

    rings: list[list[tuple[int, int]]] = []
    while edges:
        start = next(iter(edges))
        ring = [start]
        node = start
        while True:
            outgoing = edges.get(node)
            if not outgoing:
                break  # shouldn't happen for a closed boundary; bail rather than loop
            nxt = outgoing.pop()
            if not outgoing:
                del edges[node]
            if nxt == start:
                break
            ring.append(nxt)
            node = nxt
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def _drop_collinear(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Collapse straight runs in a closed ring (the long axis-aligned stretches a
    traced grid boundary is mostly made of) down to their endpoints."""
    n = len(ring)
    if n < 3:
        return ring
    out = []
    for i in range(n):
        prev = ring[i - 1]
        curr = ring[i]
        nxt = ring[(i + 1) % n]
        cross = ((curr[0] - prev[0]) * (nxt[1] - curr[1])
                 - (curr[1] - prev[1]) * (nxt[0] - curr[0]))
        if abs(cross) > 1e-12:
            out.append(curr)
    return out if len(out) >= 3 else ring


def _simplify_ring(ring: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker on a closed ring, run on the open chain between the
    ring's first point and its most distant point so both halves keep their shape.
    Cuts the staircase a grid trace produces down to a fraction of the vertices
    (the payload is one polygon per visible place, so this matters)."""
    if len(ring) < 4 or tolerance <= 0:
        return ring

    def rdp(points):
        if len(points) < 3:
            return points
        (x0, y0), (x1, y1) = points[0], points[-1]
        dx, dy = x1 - x0, y1 - y0
        seg = math.hypot(dx, dy)
        worst, worst_i = -1.0, 0
        for i in range(1, len(points) - 1):
            x, y = points[i]
            if seg == 0:
                d = math.hypot(x - x0, y - y0)
            else:
                d = abs(dy * (x - x0) - dx * (y - y0)) / seg
            if d > worst:
                worst, worst_i = d, i
        if worst <= tolerance:
            return [points[0], points[-1]]
        left = rdp(points[:worst_i + 1])
        right = rdp(points[worst_i:])
        return left[:-1] + right

    # Split at the vertex furthest from the ring's first point so RDP can't
    # shortcut across the whole shape.
    x0, y0 = ring[0]
    split = max(range(len(ring)), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    first = rdp(ring[:split + 1])
    second = rdp(ring[split:] + [ring[0]])
    simplified = first[:-1] + second[:-1]
    return simplified if len(simplified) >= 3 else ring


def _weighted_cells(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                     in_view_idxs) -> dict[int, list[list[list[float]]]]:
    """Region outlines for the population-weighted lookup, as {row index: [ring, …]}
    with each ring a list of [lat, lng].

    The weighted boundary between two places is an Apollonius arc, further clipped
    by the margin and reach guards — there's no cheap exact diagram, so this labels
    a config.GEOCODE_BOUNDARY_GRID grid over the viewport with the real lookup
    (_label_grid) and traces the region of each in-view place. Boundary error is
    therefore about one grid step of the viewport.
    """
    import numpy as np

    long_edge = max(16, config.GEOCODE_BOUNDARY_GRID)
    lat_span = max(max_lat - min_lat, 1e-9)
    lng_span = max(max_lng - min_lng, 1e-9)
    if lat_span >= lng_span:
        ny, nx = long_edge, max(16, round(long_edge * lng_span / lat_span))
    else:
        nx, ny = long_edge, max(16, round(long_edge * lat_span / lng_span))

    # Row r / column c covers [min + r*step, min + (r+1)*step]; sample its center.
    lat_step = lat_span / ny
    lng_step = lng_span / nx
    lat_centers = min_lat + (np.arange(ny) + 0.5) * lat_step
    lng_centers = min_lng + (np.arange(nx) + 0.5) * lng_step
    grid_lat, grid_lng = np.meshgrid(lat_centers, lng_centers, indexing="ij")

    labels = _label_grid(grid_lat.ravel(), grid_lng.ravel())

    # Group the grid cells by winning site once, so each region is traced out of a
    # mask its own size instead of a full-grid mask per site — a dense viewport can
    # hold ~100 places, and that difference is most of the runtime.
    order = np.argsort(labels, kind="stable")
    sorted_labels = labels[order]

    # A grid step is the resolution floor of the trace, so simplifying at half of
    # one only removes the staircase, not real shape.
    tolerance = 0.5 * min(lat_step, lng_step)
    out: dict[int, list[list[list[float]]]] = {}
    for site in in_view_idxs:
        site = int(site)
        lo, hi = np.searchsorted(sorted_labels, [site, site + 1])
        if lo == hi:
            continue  # a place the weighting never wins anywhere in this viewport
        flat = order[lo:hi]
        rows, cols = flat // nx, flat % nx
        r0, c0 = int(rows.min()), int(cols.min())
        submask = np.zeros((int(rows.max()) - r0 + 1, int(cols.max()) - c0 + 1), dtype=bool)
        submask[rows - r0, cols - c0] = True
        rings = []
        for ring in _trace_mask_rings(submask):
            coords = [(min_lat + (r + r0) * lat_step, min_lng + (c + c0) * lng_step)
                      for r, c in ring]
            coords = _simplify_ring(_drop_collinear(coords), tolerance)
            if len(coords) >= 3:
                rings.append([[round(la, 6), round(ln, 6)] for la, ln in coords])
        if rings:
            out[site] = rings
    return out


def voronoi_cells(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                   limit: int = 4000) -> tuple[list[dict], int]:
    """Place-boundary cells for the GeoNames places behind reverse geocoding — the
    cell around each place is the area a coordinate must fall in for _raw_lookup to
    resolve to that place, so the Places DB map can show where the boundary between
    two places actually falls.

    Two ways of computing it, matching the two lookup modes:

    * config.GEOCODE_POP_WEIGHT **off** — plain nearest-point lookup, so the cells
      are an exact Voronoi diagram (below).
    * config.GEOCODE_POP_WEIGHT **on** — boundaries are population-weighted arcs
      trimmed by the margin/reach guards, so the cells are traced from a grid
      labelled with the real lookup instead (see _weighted_cells), accurate to
      about one grid step of the viewport.

    The exact path is computed as a planar Voronoi diagram on points projected to a local
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
    cities_in_bbox) plus "polygons": a list of rings, each a list of [lat, lng]
    pairs (a weighted region can be pinched into more than one piece), and
    "polygon": the largest of those rings, for callers that want just one.
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

    if config.GEOCODE_POP_WEIGHT:
        in_view_idxs = np.nonzero(in_view)[0]
        if len(in_view_idxs) > limit:
            # Same "keep what's nearest the center" cap as the exact path, except
            # here every candidate is already in view, so it caps the cells drawn.
            center_lat = (min_lat + max_lat) / 2.0
            center_lng = (min_lng + max_lng) / 2.0
            d2 = (_lats[in_view_idxs] - center_lat) ** 2 + (_lngs[in_view_idxs] - center_lng) ** 2
            in_view_idxs = in_view_idxs[np.argsort(d2)[:limit]]
        rings_by_site = _weighted_cells(min_lat, max_lat, min_lng, max_lng, in_view_idxs)
        cells = []
        for site, rings in rings_by_site.items():
            d = _place_dict(site)
            d["lat"] = float(_lats[site])
            d["lng"] = float(_lngs[site])
            d["population"] = int(_populations[site])
            d["polygons"] = rings
            d["polygon"] = max(rings, key=len)
            cells.append(d)
        return cells, total

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
        d["polygons"] = [d["polygon"]]  # exact cells are always a single ring
        cells.append(d)
    return cells, total


def _merged_lookup(lat: float, lng: float) -> dict | None:
    """Combine the polygon-containment sources (city + sub-location) with the
    GeoNames nearest-point lookup (state/county/country).

    City resolution, in order — every step is skipped if its data isn't installed:

    1. **OSM** city boundary containing the point. The authority wherever it has one.
    2. **US Census** place containing the point (see census_places) — incorporated
       places *and* CDPs, so unincorporated suburbia that OSM carries no boundary
       for still gets a real containment answer.
    3. **ZCTA** postal city (census_places.postal_lookup) — the ZIP's USPS mailing
       city. Weaker than a place boundary (a mailing address is not a jurisdiction,
       and rural ZIPs are named for whichever small post office serves them), but
       still containment, so it outranks the estimate below when
       config.ZCTA_CITY_FALLBACK allows it.
    4. **GeoNames** nearest populated place (_raw_lookup) — a distance estimate, not
       containment, so it runs last and only when config.OSM_CITY_FALLBACK_GEONAMES
       allows it (or when OSM isn't installed at all, so the app still geocodes out
       of the box).

    The ZIP code itself is returned as `postal_code` whenever the ZCTA layer resolves
    one, independent of which step won the city. Sub-location is OSM-only (None
    without OSM) — the Census files have no parks/campuses/venues to draw one from."""
    from geotagger import census_places, osm_places
    osm = osm_places.lookup(lat, lng)          # {city, sublocation} or None
    gn = _raw_lookup(lat, lng) or {}           # state/county/country/cc (+ its own city)
    census = census_places.lookup(lat, lng)    # {city, kind, …} or None
    postal = census_places.postal_lookup(lat, lng)  # {postal_code, postal_city, …} or None
    if osm is None and not gn and census is None and postal is None:
        return None

    if osm and osm.get("city"):
        city = osm["city"]
    elif census and census.get("city"):
        city = census["city"]                  # containment beats the distance estimate
    elif postal and postal.get("postal_city") and config.ZCTA_CITY_FALLBACK:
        city = postal["postal_city"]           # mailing city: weaker, still containment
    elif osm_places.is_available() and not config.OSM_CITY_FALLBACK_GEONAMES:
        city = None                            # polygons are the authority; point in none
    else:
        city = gn.get("city")                  # OSM absent, or fallback enabled
    return {
        "city": city,
        "sublocation": osm.get("sublocation") if osm else None,
        "postal_code": postal.get("postal_code") if postal else None,
        "state": gn.get("state"),
        "county": gn.get("county"),
        "country": gn.get("country"),
        "country_code": gn.get("country_code"),
    }


def lookup(lat: float | None, lng: float | None, use_cache: bool = True) -> dict | None:
    """Reverse-geocode a coordinate to
    {city, sublocation, postal_code, state, county, country, country_code}.

    City comes from OSM polygon containment, then US Census place containment, then
    the ZCTA mailing city, then the GeoNames nearest-point estimate; sub-location is OSM-only and
    state/county/country always come from GeoNames (see _merged_lookup). Caches by quantized coordinate so nearby
    photos reuse one result — note the quantization grid (config.GEOCODE_PRECISION,
    ~11 m) is coarser than a small building, so two photos in adjacent buildings
    can share a bucket. Returns None when neither source resolves anything. Cache
    access degrades silently if the DB isn't initialized (e.g. raw CLI use)."""
    if lat is None or lng is None:
        return None
    qlat, qlng = quantize(lat, lng)
    if use_cache:
        try:
            from geotagger import index
            cached = index.get_cached_geocode(qlat, qlng)
            if cached is not None:
                return cached
        except Exception:
            pass
    result = _merged_lookup(lat, lng)
    if use_cache and result is not None:
        try:
            from geotagger import index
            index.put_cached_geocode(qlat, qlng, result)
        except Exception:
            pass
    return result
