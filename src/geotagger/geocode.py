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
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from geotagger import config
from geotagger.config import GEOCODE_PRECISION

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _Tables:
    """Everything one GeoNames load produced, published as a single object.

    Readers take one reference to it (_tables()) and use only that for the whole
    lookup, so a reset() or reload on another thread can never hand them the new
    KD-tree with the old name list (row indices would point at the wrong places,
    or past the end)."""
    tree: object                    # scipy.spatial.cKDTree over city XYZ
    names: list[str]                # parallel to the KD-tree points
    ccs: list[str]
    admin1: list[str]
    admin2: list[str]
    lats: object                    # numpy arrays, parallel to names — for bbox queries
    lngs: object
    populations: object
    admin1_names: dict[str, str]    # "<cc>.<a1>"      -> state/province name
    admin2_names: dict[str, str]    # "<cc>.<a1>.<a2>" -> county/district name
    country_names: dict[str, str]   # cc               -> country name


# Load state machine: "unloaded" -> "ready" | "unavailable", and back to
# "unloaded" on reset(). _lock guards the state below and is only ever held for
# assignments and a few stat() calls; _load_lock serializes the parse itself
# (seconds, for cities500), so reset() never waits on a load in progress.
_lock = threading.Lock()
_load_lock = threading.Lock()
_state = "unloaded"
_error: str | None = None
_data: _Tables | None = None
# Bumped by reset(): a load that started under an older generation read files that
# may since have been replaced, so it parses again instead of publishing.
_generation = 0
_sig: tuple | None = None          # file signature the published state was loaded from
_loading_sig: tuple | None = None  # ... and the one a load in progress started from


def _cities_file() -> Path:
    return config.GEONAMES_DIR / "cities500.txt"


def _geonames_files() -> list[Path]:
    return [_cities_file(), config.GEONAMES_DIR / "admin1CodesASCII.txt",
            config.GEONAMES_DIR / "admin2Codes.txt", config.GEONAMES_DIR / "countryInfo.txt"]


def _signature() -> tuple:
    """(size, mtime) per GeoNames file, None for a missing one. Every downloader
    swaps in a whole new file, so changed data always changes this."""
    sig = []
    for path in _geonames_files():
        try:
            st = path.stat()
            sig.append((st.st_size, st.st_mtime_ns))
        except OSError:
            sig.append(None)
    return tuple(sig)


def is_available() -> bool:
    """True if the GeoNames data has been downloaded."""
    return _cities_file().exists()


def status() -> dict:
    """Health/diagnostics for the status endpoints. Re-checks the dataset files
    first (check_datasets), so an install made by any means shows up here at once.
    Doesn't force the load itself — that's seconds of parsing — so straight after
    an install or reset the state reads "unloaded" until the next lookup."""
    check_datasets()
    with _lock:
        state, error, data = _state, _error, _data
    return {
        "available": is_available(),
        "state": state,
        "error": error,
        "cities": len(data.names) if data is not None else 0,
    }


def _parse() -> _Tables:
    """Read the GeoNames files and build the KD-tree. Pure: touches no module
    state, so it runs outside _lock and can be thrown away if reset() lands
    mid-parse."""
    import numpy as np
    from scipy.spatial import cKDTree

    names: list[str] = []
    ccs: list[str] = []
    admin1: list[str] = []
    admin2: list[str] = []
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
            names.append(p[1])
            ccs.append(p[8])
            admin1.append(p[10])
            admin2.append(p[11] if len(p) > 11 else "")
            try:
                pops.append(int(p[14]) if len(p) > 14 and p[14] else 0)
            except ValueError:
                pops.append(0)

    lat_a = np.asarray(lats)
    lng_a = np.asarray(lngs)
    # Unit-sphere XYZ so nearest-neighbour by Euclidean (chord) distance
    # matches nearest-by-great-circle and is correct near poles/antimeridian.
    lat_r = np.radians(lat_a)
    lng_r = np.radians(lng_a)
    cos_lat = np.cos(lat_r)
    xyz = np.column_stack((cos_lat * np.cos(lng_r),
                           cos_lat * np.sin(lng_r),
                           np.sin(lat_r)))
    return _Tables(
        tree=cKDTree(xyz), names=names, ccs=ccs, admin1=admin1, admin2=admin2,
        lats=lat_a, lngs=lng_a, populations=np.asarray(pops, dtype=np.int64),
        admin1_names=_load_admin1(), admin2_names=_load_admin2(),
        country_names=_load_countries(),
    )


def _load():
    """Load the GeoNames tables and publish them. Idempotent; call via
    _ensure_loaded() so concurrent first lookups parse once, not once each.

    The parse runs outside _lock and is published in one assignment under it,
    so a lookup sees either no tables or a complete set. If reset() ran while
    parsing (the files may have been replaced under us), the result is dropped
    and the files parsed again."""
    global _state, _error, _data, _sig, _loading_sig
    while True:
        with _lock:
            if _state != "unloaded":
                return
            gen = _generation
            # Stat'd under the lock, so refresh_if_changed() either sees this load
            # (and can invalidate it) or runs wholly before it starts.
            sig = _loading_sig = _signature()
        data: _Tables | None = None
        error: str | None = None
        if sig[0] is None:
            error = (f"GeoNames data not found in {config.GEONAMES_DIR}. "
                     "Run: uv run python scripts/get_geonames.py")
        else:
            try:
                data = _parse()
            except Exception as e:  # noqa: BLE001 — degrade gracefully, never crash startup
                error = f"Failed to load GeoNames data: {e}"
                logger.exception("Reverse geocoder failed to load")
        with _lock:
            _loading_sig = None
            if gen != _generation:
                continue
            _data, _sig, _error = data, sig, error
            _state = "ready" if data is not None else "unavailable"
        if data is not None:
            logger.info("Reverse geocoder ready: %d cities from %s", len(data.names), config.GEONAMES_DIR)
        else:
            logger.warning(error)
        return


def _load_admin1() -> dict[str, str]:
    out: dict[str, str] = {}
    path = config.GEONAMES_DIR / "admin1CodesASCII.txt"
    if not path.exists():
        return out
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                out[parts[0]] = parts[1]
    return out


def _load_admin2() -> dict[str, str]:
    out: dict[str, str] = {}
    path = config.GEONAMES_DIR / "admin2Codes.txt"
    if not path.exists():
        return out
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                out[parts[0]] = parts[1]
    return out


def _load_countries() -> dict[str, str]:
    out: dict[str, str] = {}
    path = config.GEONAMES_DIR / "countryInfo.txt"
    if not path.exists():
        return out
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            # ISO(0)  ISO3(1)  ISO-Numeric(2)  fips(3)  Country(4) ...
            if len(parts) >= 5 and parts[0]:
                out[parts[0]] = parts[4]
    return out


def _ensure_loaded():
    if _state == "unloaded":
        with _load_lock:
            _load()


def _tables() -> _Tables | None:
    """The loaded tables (loading them first if needed), or None if GeoNames is
    unavailable. Callers use only the returned object — see _Tables. Loops because
    a reset() can land between the load and this read; that must mean "load the
    new files", never "GeoNames is missing" for this lookup."""
    while True:
        _ensure_loaded()
        with _lock:
            if _state != "unloaded":
                return _data


def reset():
    """Drop the loaded tables and forget the load state (including a latched
    "unavailable"), so the next lookup parses whatever is on disk. Mirrors
    osm_places/census_places.reset(). Cheap: the reload is lazy, on the next
    lookup, and a lookup already holding the old tables finishes on them.

    The old tables are dropped, not kept serving until the new ones are parsed:
    the caller is about to move the cache version on (datasets_changed), and an
    answer from old tables must not be cached under the new version."""
    global _state, _error, _data, _sig, _generation
    with _lock:
        _generation += 1
        _state = "unloaded"
        _error = None
        _data = None
        _sig = None


def refresh_if_changed() -> bool:
    """reset() if the GeoNames files on disk differ from the ones the current
    state (ready, or latched unavailable) was loaded from — a first install, a
    re-download, a removal. Returns True if it reset. A few stat() calls; reloads
    nothing itself."""
    global _generation
    with _lock:
        if _state == "unloaded":
            # Nothing published to invalidate, but a load in progress may be parsing
            # files that have since been replaced: make it start over.
            if _loading_sig is not None and _signature() != _loading_sig:
                _generation += 1
            return False
        if _signature() == _sig:
            return False
    reset()
    return True


def quantize(lat: float, lng: float) -> tuple[int, int]:
    """Snap a coordinate to the geocode grid as integer keys (round(coord * 10**precision))."""
    scale = 10 ** GEOCODE_PRECISION
    return round(lat * scale), round(lng * scale)


def _place_dict(t: _Tables, i: int) -> dict:
    """Resolve GeoNames row i's admin codes into the {city, state, county,
    country, country_code} shape shared by lookup() and cities_in_bbox()."""
    cc = t.ccs[i]
    a1 = t.admin1[i]
    a2 = t.admin2[i]
    state = t.admin1_names.get(f"{cc}.{a1}") if a1 else None
    county = t.admin2_names.get(f"{cc}.{a1}.{a2}") if (a1 and a2) else None
    return {
        "city": t.names[i] or None,
        "state": state,
        "county": county,
        "country": t.country_names.get(cc),
        "country_code": cc or None,
    }


_EARTH_RADIUS_KM = 6371.0


def _chord_to_km(chord: float) -> float:
    """Unit-sphere chord length (what the KD-tree returns) -> great-circle km."""
    return 2 * _EARTH_RADIUS_KM * math.asin(min(1.0, chord / 2))


def _pick_weighted(t: _Tables, dists: list[float], idxs: list[int]) -> int:
    """Choose among k nearest candidates (parallel chord distances / row indices,
    nearest first) by `km / (1 + log10(population))`, so a much larger place can
    win a near-tie in distance — see config.GEOCODE_POP_WEIGHT for why.

    Two guards keep this from rewriting labels it has no business rewriting:
    candidates further than config.GEOCODE_POP_WEIGHT_MAX_KM past the nearest one
    are dropped before scoring (no drifting to a distant city in sparse rural
    areas), and a survivor must beat the nearest place's own score by
    config.GEOCODE_POP_WEIGHT_MARGIN to win (no flipping on near-ties).

    Returns a row index into t.names/t.populations.
    """
    # cKDTree pads a k larger than the point count with inf distances and
    # out-of-range indices; drop those before doing any arithmetic.
    pairs = [(_chord_to_km(d), i) for d, i in zip(dists, idxs)
             if math.isfinite(d) and 0 <= i < len(t.names)]
    if not pairs:
        return int(idxs[0])

    def score(km: float, i: int) -> float:
        pop = int(t.populations[i])
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
    t = _tables()
    if t is None:
        return None
    lat_r = math.radians(lat)
    lng_r = math.radians(lng)
    cos_lat = math.cos(lat_r)
    point = [cos_lat * math.cos(lng_r), cos_lat * math.sin(lng_r), math.sin(lat_r)]
    if not config.GEOCODE_POP_WEIGHT:
        _, idx = t.tree.query(point)
        return _place_dict(t, int(idx))
    k = max(1, min(config.GEOCODE_CANDIDATES, len(t.names)))
    dists, idxs = t.tree.query(point, k=k)
    if k == 1:  # scipy returns scalars, not arrays, for k=1
        return _place_dict(t, int(idxs))
    return _place_dict(t, _pick_weighted(t, [float(d) for d in dists], [int(i) for i in idxs]))


def cities_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                    limit: int = 3000) -> tuple[list[dict], int]:
    """GeoNames places within a lat/lng box — lets the UI show the raw
    reverse-geocode reference data (city/state/county/country + population)
    for inspection, rather than a lookup for a single point.

    Returns (places, total_matched). When total_matched exceeds limit, the
    returned places are the largest by population so the capped view still
    shows the most recognizable places first.
    """
    t = _tables()
    if t is None:
        return [], 0
    import numpy as np

    mask = (t.lats >= min_lat) & (t.lats <= max_lat) & (t.lngs >= min_lng) & (t.lngs <= max_lng)
    idxs = np.nonzero(mask)[0]
    total = int(len(idxs))
    if total > limit:
        idxs = idxs[np.argsort(-t.populations[idxs])][:limit]
    places = []
    for i in idxs:
        i = int(i)
        d = _place_dict(t, i)
        d["lat"] = float(t.lats[i])
        d["lng"] = float(t.lngs[i])
        d["population"] = int(t.populations[i])
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


def _label_grid(t: _Tables, lat_grid, lng_grid):
    """Vectorized twin of _pick_weighted: resolve a whole array of coordinates to
    winning GeoNames row indices in one KD-tree query. Same scoring, same reach
    cap, same margin — kept in lockstep with _pick_weighted so the map's
    boundaries describe the lookup that actually runs, not a lookalike.

    ``lat_grid``/``lng_grid`` are flat float arrays of equal length; returns an
    int array of row indices into t.names/t.populations.
    """
    import numpy as np

    lat_r = np.radians(lat_grid)
    lng_r = np.radians(lng_grid)
    cos_lat = np.cos(lat_r)
    pts = np.column_stack((cos_lat * np.cos(lng_r), cos_lat * np.sin(lng_r), np.sin(lat_r)))

    k = max(1, min(config.GEOCODE_CANDIDATES, len(t.names)))
    dists, idxs = t.tree.query(pts, k=k)
    # k=1 collapses scipy's (N, k) result to (N,); reshape so the rest is uniform.
    dists = np.reshape(dists, (len(lat_grid), k))
    idxs = np.reshape(idxs, (len(lat_grid), k))
    nearest = idxs[:, 0]
    if k == 1:
        return nearest

    km = 2 * _EARTH_RADIUS_KM * np.arcsin(np.clip(dists / 2, 0.0, 1.0))
    pops = np.maximum(t.populations[idxs], 1)
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


def _weighted_cells(t: _Tables, min_lat: float, max_lat: float, min_lng: float, max_lng: float,
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

    labels = _label_grid(t, grid_lat.ravel(), grid_lng.ravel())

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
    t = _tables()
    if t is None:
        return [], 0
    import numpy as np
    from scipy.spatial import Voronoi, QhullError

    in_view = (t.lats >= min_lat) & (t.lats <= max_lat) & (t.lngs >= min_lng) & (t.lngs <= max_lng)
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
            d2 = (t.lats[in_view_idxs] - center_lat) ** 2 + (t.lngs[in_view_idxs] - center_lng) ** 2
            in_view_idxs = in_view_idxs[np.argsort(d2)[:limit]]
        rings_by_site = _weighted_cells(t, min_lat, max_lat, min_lng, max_lng, in_view_idxs)
        cells = []
        for site, rings in rings_by_site.items():
            d = _place_dict(t, site)
            d["lat"] = float(t.lats[site])
            d["lng"] = float(t.lngs[site])
            d["population"] = int(t.populations[site])
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

    mask = (t.lats >= pad_min_lat) & (t.lats <= pad_max_lat) & (t.lngs >= pad_min_lng) & (t.lngs <= pad_max_lng)
    idxs = np.nonzero(mask)[0]
    if len(idxs) > limit:
        # Prioritize sites nearest the viewport center, so the in-view sites
        # (what we actually return cells for) are the ones kept.
        center_lat = (min_lat + max_lat) / 2.0
        center_lng = (min_lng + max_lng) / 2.0
        d2 = (t.lats[idxs] - center_lat) ** 2 + (t.lngs[idxs] - center_lng) ** 2
        idxs = idxs[np.argsort(d2)[:limit]]

    # Dedupe exact-duplicate coordinates (rare data glitches) — Voronoi()
    # raises on degenerate/coincident generators.
    lat_lng = np.column_stack((t.lats[idxs], t.lngs[idxs]))
    _, first = np.unique(np.round(lat_lng, 7), axis=0, return_index=True)
    idxs = idxs[np.sort(first)]
    if len(idxs) < 3:
        return [], total

    cos_lat = max(math.cos(math.radians((min_lat + max_lat) / 2.0)), 1e-6)
    pts = np.column_stack((t.lngs[idxs] * cos_lat, t.lats[idxs]))
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
        lat, lng = float(t.lats[orig_idx]), float(t.lngs[orig_idx])
        if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
            continue  # only return cells for sites the viewport actually contains
        region = regions[i]
        if len(region) < 3:
            continue
        poly = [(float(vertices[v][1]), float(vertices[v][0]) / cos_lat) for v in region]
        poly = _clip_polygon_to_bbox(poly, pad_min_lat, pad_max_lat, pad_min_lng, pad_max_lng)
        if len(poly) < 3:
            continue
        d = _place_dict(t, orig_idx)
        d["lat"] = lat
        d["lng"] = lng
        d["population"] = int(t.populations[orig_idx])
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


# ── Cache versioning (audit G2) ──
# geocode_cache rows are stamped with the version of the datasets that produced
# them, and a read only accepts a row with the current version. A dataset change
# therefore retires the whole cache at once: stale rows are ignored and lazily
# overwritten, never served. A version instead of a bare DELETE also covers
# (a) a lookup in flight across the change, whose late write carries the old
# version and is ignored, and (b) datasets rebuilt by the CLI scripts while the
# app was stopped: the version is derived from the files themselves, so the
# next start notices without being told.
#
# Bump when the merge logic changes answers for unchanged data.
_CACHE_LOGIC_VERSION = 1
_version_lock = threading.Lock()
_cache_version: str | None = None


def _dataset_files() -> list[Path]:
    """Every file whose contents can change a lookup()'s answer."""
    return [config.OSM_DB_PATH, config.CENSUS_DB_PATH, *_geonames_files()]


def _compute_cache_version() -> str:
    """Fingerprint of the installed datasets: (path, size, mtime) per file, so an
    install, rebuild, merge or removal of any of them changes it. Every builder
    and downloader swaps in a new file, so changed data always has a new mtime."""
    import hashlib
    parts: list[str] = [f"logic={_CACHE_LOGIC_VERSION}"]
    for path in _dataset_files():
        try:
            st = path.stat()
            parts.append(f"{path}|{st.st_size}|{st.st_mtime_ns}")
        except OSError:
            parts.append(f"{path}|absent")
    return hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()[:16]


def cache_version() -> str:
    """Current dataset version for geocode_cache rows. Computed once, since
    stat'ing six files per lookup would cost more than the lookup; recomputed by
    datasets_changed()."""
    global _cache_version
    if _cache_version is None:
        with _version_lock:
            if _cache_version is None:
                _cache_version = _compute_cache_version()
    return _cache_version


def datasets_changed(version: str | None = None) -> dict:
    """Call after any job that may have changed a geocoding dataset (OSM merge,
    Census build, GeoNames download), whether or not it succeeded: a failed
    GeoNames download can still have replaced some of its files. The caller must
    already have made the new data visible to lookups (osm_places.replace_db,
    census_places.reset(), geocode.refresh_if_changed()), so any lookup that reads
    the new version also reads the new data. A no-op when no file actually changed.
    `version` is a fingerprint the caller computed before making the data visible
    (see check_datasets); by default it is computed here.

    When one did: deletes cache rows of other versions and re-queues photos whose
    earlier lookup found no city (geocoded_at -> NULL), so the next scan/backfill
    retries exactly the answers a new dataset can fill in. Photos that already have
    a city keep it: re-resolving those is the explicit whole-library
    scripts/regeocode.py, not something a download should do on its own."""
    global _cache_version
    with _version_lock:
        old = _cache_version
        new = version or _compute_cache_version()
        _cache_version = new
    if old == new:
        return {"changed": False, "purged": 0, "requeued": 0}
    from geotagger import index
    try:
        with index.transaction():
            purged = index.purge_geocode_cache(keep_version=new)
            requeued = index.requeue_cityless_geocodes()
    except RuntimeError:
        # Main DB not initialized (raw CLI use): nothing cached to retire.
        return {"changed": True, "purged": 0, "requeued": 0}
    logger.info("Geocoding datasets changed: purged %d cached lookups, re-queued %d "
                "photos with no city", purged, requeued)
    return {"changed": True, "purged": purged, "requeued": requeued}


# ── Out-of-band dataset changes (audit G3) ──
# In-app jobs make new data visible themselves (replace_db / reset) and then call
# datasets_changed(). Files that change any other way — a CLI script run while the
# app is up, files copied in by hand — would otherwise go unnoticed until restart:
# each source latches "unavailable" (or keeps its loaded data) and the cache
# version stays pinned. check_datasets() closes that gap for all three sources at
# the cost of ~10 stat() calls, so lookups run it every
# config.DATASET_RECHECK_SECONDS and the status endpoints on every call.
_check_lock = threading.Lock()      # one check at a time (see check_datasets)
_jobs_lock = threading.Lock()
_jobs_active = 0                    # in-app dataset jobs running (dataset_job)
_last_check = 0.0                   # time.monotonic() of the last throttled check


@contextmanager
def dataset_job():
    """Held by an in-app dataset job for its whole run. check_datasets() stands
    down meanwhile: the job swaps its files in one at a time (GeoNames has four)
    and settles everything itself when it ends, so checking halfway would only
    load, and version, a mix of old and new files."""
    global _jobs_active
    with _jobs_lock:
        _jobs_active += 1
    try:
        yield
    finally:
        with _jobs_lock:
            _jobs_active -= 1


def check_datasets() -> bool:
    """Pick up dataset files installed, replaced or removed by anything other than
    an in-app job. Each source that loaded (or latched "unavailable" on) files
    which have since changed is reset, so its next lookup reads what is on disk;
    then the cache version moves if any file changed. Returns True if it did.

    The version is fingerprinted *before* the sources are reset. If a file changes
    again in between, the sources may serve data newer than the version — those
    answers are cached under the older version and purged on the next check, which
    sees the newer file. The reverse order could publish a version newer than the
    data still loaded, and caching old answers under it would never be undone."""
    with _jobs_lock:
        if _jobs_active:
            return False
    # Concurrent checks could publish their fingerprints out of order (an older
    # one last); skipping is fine, the running check covers this caller too.
    if not _check_lock.acquire(blocking=False):
        return False
    try:
        from geotagger import census_places, osm_places
        cache_version()   # pin first, so a never-computed version isn't "a change"
        version = _compute_cache_version()
        osm_places.refresh_if_changed()
        census_places.refresh_if_changed()
        refresh_if_changed()
        return datasets_changed(version)["changed"]
    finally:
        _check_lock.release()


def _maybe_check_datasets():
    """check_datasets() at most once per config.DATASET_RECHECK_SECONDS. Never
    raises: a lookup must not fail because the check did."""
    global _last_check
    now = time.monotonic()
    if now - _last_check < config.DATASET_RECHECK_SECONDS:
        return
    _last_check = now   # unlocked: a racing duplicate is skipped by _check_lock
    try:
        check_datasets()
    except Exception:  # noqa: BLE001
        logger.exception("Geocoding dataset re-check failed")


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
    _maybe_check_datasets()
    # Read once, before the lookup: if the datasets change mid-lookup, this result
    # is written under the old version and never served.
    version = cache_version() if use_cache else None
    if version is not None:
        try:
            from geotagger import index
            cached = index.get_cached_geocode(qlat, qlng, version=version)
            if cached is not None:
                return cached
        except Exception:
            pass
    result = _merged_lookup(lat, lng)
    if version is not None and result is not None:
        try:
            from geotagger import index
            index.put_cached_geocode(qlat, qlng, result, version=version)
        except Exception:
            pass
    return result
