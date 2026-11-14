"""Recurring drop points ("hotspots") mined from the coordinates already on the
photos: the same handful of places come up month after month, so the fastest drop
target is a list row, not a spot on the map you have to pan and zoom to find.

Consumed through /api/geotag/hotspots by the geocode page's location picker
(openLocationPicker in web/app.js), which lists them under "Hotspots" alongside
saved places and the browser's recent locations. The earlier always-on palette
(a column of rows plus matching circles on the map) was pulled in favour of that
type-to-filter modal. geotag_service.propose_locations also uses
cluster_cells/quantize/place_label directly.

Blocking (full-table GROUP BY + geocode lookups); runs in the executor.
"""

import logging
import math
import time

from geotagger import geocode, index
from geotagger.place_bounds import parse_bounds

logger = logging.getLogger(__name__)

# Coordinate quantization for the SQL pre-aggregation. 4 decimal places is ~11 m
# of latitude, which keeps the grid well under the merge radius below — the merge
# pass, not the quantization, decides what counts as one place. (It was 3 places
# / ~110 m, fine while the merge radius was 300 m; at 100 m the grid would have
# become the real cutoff and split single places on cell boundaries.)
_CELL_DECIMALS = 4

# Cells whose centres are within this get folded into one hotspot. A hotspot is
# meant to be a place you could point at — a house, a park entrance — not a
# neighbourhood, so this stays tight; drops further apart than this stay separate
# rows in the palette.
DEFAULT_MERGE_METERS = 100.0

# Rows fed into the Python merge pass. Sorted by photo count, so this keeps the
# places actually worth showing and discards the long tail of one-off drops.
# Scaled up alongside _CELL_DECIMALS: finer cells means more of them per place,
# so the old 4000 would have clipped the head much earlier than it used to.
_MAX_CELLS = 20000

# How much of a hotspot's disc has to lie inside a saved place before the hotspot
# is suppressed. The palette exists to surface recurring spots you *haven't*
# named yet — once a place covers one, the place's own entry in the Places
# dropdown is the better handle, and the palette row is a duplicate. Below 1.0
# because a place saved from a hotspot sits at the clustering centroid, which
# drifts by a few metres as new photos land there.
PLACE_COVERAGE_THRESHOLD = 0.9

_METERS_PER_DEG_LAT = 111_320.0

# (geotag generation, merge_m) -> clusters. index bumps the generation on every
# coordinate change — /api/geotag commits and scan upserts alike — so the next
# request after one rebuilds it.
_cache: dict[tuple, list[dict]] = {}


def _lng_scale(lat: float) -> float:
    """Metres per degree of longitude at `lat`. Equirectangular approximation —
    exact enough at the few-hundred-metre scale we merge at, and far cheaper than
    haversine in the O(cells x neighbours) inner loop."""
    return _METERS_PER_DEG_LAT * math.cos(math.radians(lat))


def quantize(points: list[tuple[float, float, float | None, int | None]]) -> list[dict]:
    """Aggregate raw (lat, lng, ts, photo_id) points into the cell shape
    cluster_cells expects, busiest cell first — the in-Python equivalent of the
    GROUP BY get_hotspots runs in SQL, for callers working from a row set they
    already have."""
    cells: dict[tuple[float, float], dict] = {}
    for lat, lng, ts, pid in points:
        key = (round(lat, _CELL_DECIMALS), round(lng, _CELL_DECIMALS))
        c = cells.get(key)
        if c is None:
            cells[key] = {"alat": lat, "alng": lng, "n": 1,
                          "last_ts": ts, "sample_id": pid}
            continue
        c["alat"] = (c["alat"] * c["n"] + lat) / (c["n"] + 1)
        c["alng"] = (c["alng"] * c["n"] + lng) / (c["n"] + 1)
        c["n"] += 1
        if (ts or 0) > (c["last_ts"] or 0):
            c["last_ts"], c["sample_id"] = ts, pid
    return sorted(cells.values(), key=lambda c: -c["n"])


def _wrap_lng(lng: float) -> float:
    """Longitude folded into [-180, 180)."""
    return (lng + 180.0) % 360.0 - 180.0


def meters_between(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Equirectangular distance in metres. Good to a fraction of a percent over
    the tens-of-kilometres spans the palette ranks by, and much cheaper than
    haversine in the inner loops here. The longitude gap takes the short way
    round, so 179.999 and -179.999 are metres apart, not the width of the Earth."""
    dy = (lat2 - lat1) * _METERS_PER_DEG_LAT
    dx = _wrap_lng(lng2 - lng1) * _lng_scale(lat1)
    return math.hypot(dx, dy)


class _Grid:
    """Spatial hash over clusters for "nearest cluster within the merge radius".

    Latitude is cut into bands `bucket_deg` (= radius) tall. Each band gets ONE
    longitude bucket width for every point in it — sized at the band's
    highest-|lat| edge, where a degree of longitude is shortest, so a bucket is
    never narrower than the radius anywhere in the band. (The old grid sized the
    width from each point's own latitude, so two points a few metres apart
    north-south were bucketed on different scales and their column indices
    didn't line up: a neighbour 90 m away was missed in ~a third of directions at
    Seattle's latitude — audit G5.) The width is then rounded up so a whole
    number of buckets spans 360°, which makes the column index wrap cleanly
    modulo the band's bucket count across the antimeridian.

    A query doesn't assume "±1 column": it converts its own exact longitude reach
    (radius / metres-per-degree at the query latitude — the same scale
    meters_between measures with) into a column range in each of the three bands
    it touches, since adjacent bands have different widths. That's usually 3
    columns per band, so ~9 buckets as before, and it degrades gracefully toward
    the poles (bands there have only a handful of buckets, and a query whose reach
    spans the whole band just scans all of them).

    Clusters are re-filed when a merge moves their centroid into another bucket,
    so the index never lags the coordinates it is compared against.
    """

    __slots__ = ("bucket_deg", "max_m", "_rows", "_key_of")

    def __init__(self, max_m: float):
        self.max_m = max_m
        self.bucket_deg = max_m / _METERS_PER_DEG_LAT
        # band -> (n_cols, col_width_deg, {col: [cluster, ...]}). Nested rather
        # than keyed on (band, col) tuples: a query skips an empty band with one
        # lookup and never builds key tuples in the hot loop.
        self._rows: dict[int, tuple[int, float, dict[int, list[dict]]]] = {}
        self._key_of: dict[int, tuple[int, int]] = {}    # id(cluster) -> (band, col)

    def _band_shape(self, i: int) -> tuple[int, float]:
        """(n_cols, col_width_deg) for band i. Width is sized at the band's
        highest-|lat| edge and rounded up to divide 360° evenly."""
        edge = min(max(abs(i), abs(i + 1)) * self.bucket_deg, 90.0)
        cos_edge = math.cos(math.radians(edge))
        # How many radius-wide buckets fit round the band's shortest parallel; at
        # least 1 (the bands touching a pole collapse to a single bucket).
        n_cols = max(1, int(360.0 * cos_edge / self.bucket_deg)) if cos_edge > 1e-12 else 1
        return n_cols, 360.0 / n_cols

    def _file(self, cl: dict) -> tuple[int, int]:
        i = math.floor(cl["lat"] / self.bucket_deg)
        row = self._rows.get(i)
        if row is None:
            row = self._rows[i] = (*self._band_shape(i), {})
        n_cols, width, cols = row
        j = int((_wrap_lng(cl["lng"]) + 180.0) // width) % n_cols
        cols.setdefault(j, []).append(cl)
        return i, j

    def add(self, cl: dict) -> None:
        self._key_of[id(cl)] = self._file(cl)

    def moved(self, cl: dict) -> None:
        """Re-file `cl` after its centroid changed. Most merges nudge a centroid a
        few metres inside its bucket, so check that first and skip the re-file."""
        i, j = self._key_of[id(cl)]
        n_cols, width, cols = self._rows[i]
        if (math.floor(cl["lat"] / self.bucket_deg) == i
                and int((_wrap_lng(cl["lng"]) + 180.0) // width) % n_cols == j):
            return
        cols[j].remove(cl)
        self._key_of[id(cl)] = self._file(cl)

    def nearest(self, lat: float, lng: float) -> dict | None:
        """Closest indexed cluster strictly within max_m, or None."""
        bd = self.bucket_deg
        max_m = self.max_m
        # Same metric as meters_between (scaled at the query latitude), inlined
        # and compared squared: this is the O(cells x neighbours) hot loop, and
        # the per-call cos() + hypot() roughly doubled its cost.
        lng_scale = _lng_scale(lat)
        # Longitude reach of the radius at the query latitude — exact for that
        # metric, so nothing within max_m can sit outside the columns scanned.
        reach = 360.0 if lng_scale <= 1e-6 else min(max_m / lng_scale, 360.0)
        x = _wrap_lng(lng) + 180.0
        rows = self._rows
        best, best_d2 = None, max_m * max_m
        for i in range(math.floor((lat - bd) / bd), math.floor((lat + bd) / bd) + 1):
            row = rows.get(i)
            if row is None:
                continue
            n_cols, width, cols = row
            lo = int((x - reach) // width)
            hi = int((x + reach) // width)
            if hi - lo + 1 >= n_cols:
                lo, hi = 0, n_cols - 1
            for j in range(lo, hi + 1):
                bucket = cols.get(j % n_cols)
                if not bucket:
                    continue
                for cl in bucket:
                    dy = (cl["lat"] - lat) * _METERS_PER_DEG_LAT
                    dx = ((cl["lng"] - lng + 180.0) % 360.0 - 180.0) * lng_scale
                    d2 = dx * dx + dy * dy
                    if d2 < best_d2:
                        best, best_d2 = cl, d2
        return best


def build_grid(clusters: list[dict], merge_m: float) -> _Grid:
    """Spatial index over existing clusters, for _Grid.nearest. Used to fold a
    second pass of cells onto an already-computed (and cached) clustering without
    redoing the agglomeration."""
    grid = _Grid(merge_m)
    for cl in clusters:
        grid.add(cl)
    return grid


def cluster_cells(cells: list, merge_m: float) -> list[dict]:
    """Greedily agglomerate quantized cells into hotspots.

    Each cell needs the keys `alat`, `alng`, `n`, `last_ts`, `sample_id` (the
    column names of get_hotspots' GROUP BY, and what quantize() produces), and
    the list must be sorted by `n` descending.

    Cells arrive sorted by photo count, so the busiest cell of a place seeds the
    cluster and its satellites get absorbed into it — the centroid stays anchored
    on where the user actually drops, instead of drifting toward the outliers.
    """
    grid = _Grid(merge_m)
    clusters: list[dict] = []

    for c in cells:
        lat, lng = c["alat"], c["alng"]
        n = c["n"]
        best = grid.nearest(lat, lng)

        if best is not None:
            # Photo-count-weighted centroid: a place with 200 photos shouldn't be
            # dragged half a cell by a 2-photo neighbour. The longitude is averaged
            # as an offset from the cluster's own, so a pair straddling the
            # antimeridian (179.999 / -179.999) averages to ±180, not to 0.
            total = best["count"] + n
            best["lat"] = (best["lat"] * best["count"] + lat * n) / total
            best["lng"] = _wrap_lng(best["lng"] + _wrap_lng(lng - best["lng"]) * n / total)
            best["count"] = total
            best["cells"] += 1
            if (c["last_ts"] or 0) > (best["last_ts"] or 0):
                best["last_ts"] = c["last_ts"]
                best["sample_photo_id"] = c["sample_id"]
            grid.moved(best)
            continue

        cl = {
            "lat": lat, "lng": lng, "count": n, "cells": 1,
            "last_ts": c["last_ts"], "sample_photo_id": c["sample_id"],
        }
        clusters.append(cl)
        grid.add(cl)

    return clusters


def place_label(loc: dict | None, lat: float, lng: float) -> str:
    """Human label for a hotspot: the most specific place names the geocoder gives
    for its centroid, falling back to the raw coordinate."""
    if loc:
        parts = [loc.get("sublocation"), loc.get("city"), loc.get("state")]
        text = ", ".join(p for p in parts if p)
        if text:
            return text
    return f"{lat:.5f}, {lng:.5f}"


# ── Suppressing hotspots that a saved place already covers ──

def _disc_fraction_inside(margin_m: float, radius_m: float) -> float:
    """What fraction of a disc of `radius_m` lies on the inner side of a boundary
    whose signed distance from the disc's centre is `margin_m` (positive when the
    centre is inside).

    Exact for a straight boundary — the inner area is the disc minus the circular
    segment the boundary cuts off — and close enough for a circular one at the
    ~100 m scale a hotspot spans, where a saved place's arc is nearly straight.
    """
    if radius_m <= 0:
        return 1.0 if margin_m >= 0 else 0.0
    if margin_m >= radius_m:
        return 1.0
    if margin_m <= -radius_m:
        return 0.0
    # Area of the cap cut off beyond distance h from the centre.
    h = abs(margin_m)
    cap = radius_m ** 2 * math.acos(h / radius_m) - h * math.sqrt(radius_m ** 2 - h ** 2)
    whole = math.pi * radius_m ** 2
    # Centre inside: everything but the cap poking out. Centre outside: only the
    # cap that reaches back over the boundary.
    return 1.0 - cap / whole if margin_m >= 0 else cap / whole


def _place_margin_meters(place_bounds: dict, place_type: str,
                         lat: float, lng: float) -> float | None:
    """Signed distance in metres from (lat, lng) to a saved place's boundary —
    positive inside, negative outside. None when the bounds don't parse as the
    shape they claim to be (a hand-edited row shouldn't take the palette down)."""
    try:
        if place_type == "circle":
            clat = float(place_bounds["lat"])
            clng = float(place_bounds["lng"])
            radius = float(place_bounds["radius"])
            return radius - meters_between(lat, lng, clat, clng)

        if place_type == "rectangle":
            north = float(place_bounds["north"])
            south = float(place_bounds["south"])
            east = float(place_bounds["east"])
            west = float(place_bounds["west"])
        else:
            return None
    except (KeyError, TypeError, ValueError):
        return None

    # Distance to each edge, signed so all four are positive only when inside.
    # Longitude gaps are scaled at this latitude, same approximation as the rest
    # of this module.
    lng_scale = _lng_scale(lat)
    to_north = (north - lat) * _METERS_PER_DEG_LAT
    to_south = (lat - south) * _METERS_PER_DEG_LAT
    to_east = (east - lng) * lng_scale
    to_west = (lng - west) * lng_scale
    inner = min(to_north, to_south, to_east, to_west)
    if inner >= 0:
        return inner
    # Outside: the true distance to the rectangle, not the least-negative edge.
    dy = max(south - lat, 0.0, lat - north) * _METERS_PER_DEG_LAT
    dx = max(west - lng, 0.0, lng - east) * lng_scale
    return -math.hypot(dx, dy)


def _place_inside_disc(place_bounds: dict, place_type: str,
                       lat: float, lng: float, radius_m: float,
                       threshold: float) -> bool:
    """Is the saved place itself (almost) swallowed by the hotspot's disc?

    The other direction of the same question — a 20 m pin dropped on "Grandma's"
    describes the same spot as the 100 m hotspot sitting on it, even though the
    pin is far too small to cover the hotspot.
    """
    try:
        if place_type == "circle":
            dist = meters_between(lat, lng, float(place_bounds["lat"]),
                                  float(place_bounds["lng"]))
            place_r = float(place_bounds["radius"])
            return _disc_fraction_inside(radius_m - dist, place_r) >= threshold

        if place_type == "rectangle":
            north = float(place_bounds["north"])
            south = float(place_bounds["south"])
            east = float(place_bounds["east"])
            west = float(place_bounds["west"])
        else:
            return False
    except (KeyError, TypeError, ValueError):
        return False

    # A rectangle sits inside the disc exactly when all four corners do. Stricter
    # than the "almost" the circle case allows, but exact and cheap, and a saved
    # rectangle smaller than a hotspot is the rare shape here anyway.
    return all(
        meters_between(lat, lng, clat, clng) <= radius_m
        for clat in (south, north)
        for clng in (west, east)
    )


def covered_by_place(lat: float, lng: float, radius_m: float, places: list,
                     threshold: float = PLACE_COVERAGE_THRESHOLD) -> bool:
    """Does a saved place describe the same spot as this hotspot?

    True when either shape (almost) swallows the other: a place drawn around the
    hotspot, or a smaller pin sitting inside it. Both readings mean the same
    thing in practice — you have already named this spot — and the palette is for
    the ones you haven't.

    Any single place clearing the bar is enough; overlapping places don't get to
    pool their coverage, since a hotspot straddling two named places is its own
    spot and worth keeping.
    """
    for p in places:
        # The shared validated parser (cached per distinct string): a hand-edited
        # or pre-validation row reads as "covers nothing", never an exception.
        bounds = parse_bounds(p["type"], p["bounds"])
        if bounds is None:
            continue
        margin = _place_margin_meters(bounds, p["type"], lat, lng)
        if margin is not None and _disc_fraction_inside(margin, radius_m) >= threshold:
            return True
        if _place_inside_disc(bounds, p["type"], lat, lng, radius_m, threshold):
            return True
    return False


def in_bbox(lat: float, lng: float, bbox: tuple[float, float, float, float]) -> bool:
    """Is the point inside (min_lat, max_lat, min_lng, max_lng)?

    A box whose min_lng is east of its max_lng straddles the antimeridian — what
    a map panned across the Pacific reports — so the longitude test flips to "east
    of min OR west of max" rather than a single range.
    """
    min_lat, max_lat, min_lng, max_lng = bbox
    if not (min_lat <= lat <= max_lat):
        return False
    if min_lng <= max_lng:
        return min_lng <= lng <= max_lng
    return lng >= min_lng or lng <= max_lng


def _all_clusters(merge_meters: float) -> list[dict]:
    """The full clustering of every geotagged photo, count-descending. Cached on
    the geotag generation, so any coordinate change rebuilds it on the next
    request. The stamp is read before the query: a write landing in between
    files fresh data under the old stamp, which costs one spare rebuild rather
    than serving anything stale."""
    cache_key = (index.geotag_generation(), round(merge_meters, 1))
    clusters = _cache.get(cache_key)
    if clusters is not None:
        return clusters

    t0 = time.time()
    rows = index.get_db().execute(f"""
        SELECT COUNT(*) AS n,
               AVG(lat) AS alat, AVG(lng) AS alng,
               MAX(photo_datetime) AS last_ts,
               MAX(id) AS sample_id
        FROM photos
        WHERE lat IS NOT NULL AND lng IS NOT NULL
        GROUP BY ROUND(lat, {_CELL_DECIMALS}), ROUND(lng, {_CELL_DECIMALS})
        ORDER BY n DESC
        LIMIT {_MAX_CELLS}
    """).fetchall()
    clusters = cluster_cells(rows, merge_meters)
    clusters.sort(key=lambda c: -c["count"])
    _cache.clear()   # only ever one generation is useful
    _cache[cache_key] = clusters
    logger.info(f"hotspots: {len(rows)} cells → {len(clusters)} clusters "
                f"in {(time.time() - t0) * 1000:.2f}ms")
    return clusters


def _window_counts(clusters: list[dict], merge_meters: float,
                   from_ts: int, to_ts: int) -> dict[int, dict]:
    """How much each cluster was used inside a time window, as
    id(cluster) -> {"count", "last_ts", "sample_photo_id"}.

    The clustering itself is global and cached; this folds a second, time-filtered
    pass of cells onto it through the spatial index rather than re-agglomerating.
    A cell landing further than the merge radius from every known cluster is
    dropped — that only happens for places outside the _MAX_CELLS head, which by
    construction aren't palette material anyway.
    """
    rows = index.get_db().execute(f"""
        SELECT COUNT(*) AS n,
               AVG(lat) AS alat, AVG(lng) AS alng,
               MAX(photo_datetime) AS last_ts,
               MAX(id) AS sample_id
        FROM photos
        WHERE lat IS NOT NULL AND lng IS NOT NULL
          AND photo_datetime BETWEEN ? AND ? AND {index.HAS_DATE_SQL}
        GROUP BY ROUND(lat, {_CELL_DECIMALS}), ROUND(lng, {_CELL_DECIMALS})
    """, (from_ts, to_ts)).fetchall()

    grid = build_grid(clusters, merge_meters)
    counts: dict[int, dict] = {}
    for r in rows:
        cl = grid.nearest(r["alat"], r["alng"])
        if cl is None:
            continue
        acc = counts.setdefault(id(cl), {"count": 0, "last_ts": None,
                                         "sample_photo_id": None})
        acc["count"] += r["n"]
        if (r["last_ts"] or 0) > (acc["last_ts"] or 0):
            acc["last_ts"] = r["last_ts"]
            acc["sample_photo_id"] = r["sample_id"]
    return counts


def get_hotspots(limit: int = 40, merge_meters: float = DEFAULT_MERGE_METERS,
                 sort: str = "count",
                 lat: float | None = None, lng: float | None = None,
                 from_ts: int | None = None, to_ts: int | None = None,
                 hide_named: bool = True,
                 bbox: tuple[float, float, float, float] | None = None,
                 offset: int = 0) -> dict:
    """Recurring drop points, best-first for the chosen `sort`:

    · "count"  — how often you've tagged there. The default.
    · "recent" — when you last did.
    · "near"   — distance from (`lat`, `lng`), the map's current centre. Answers
                 "what have I tagged around here?" while zoomed in somewhere.
    · "time"   — how much you tagged there between `from_ts` and `to_ts`, the
                 time span on screen widened by a month either side. Answers
                 "where was I around then?", which for a month-at-a-time workflow
                 is a far better prior than a lifetime photo count.

    `count` and `last_ts` are on every entry regardless of sort; `meters` is added
    for "near" and `window_count` for "time", so the UI can say why a row ranks
    where it does.

    With `hide_named` (the default), hotspots a saved place already covers are
    dropped — see covered_by_place. The filter runs on the ordered list *before*
    the limit slice, so suppressed entries don't eat slots, and it is applied per
    request rather than baked into the cached clustering, so naming a place takes
    effect on the next palette refresh.

    `bbox` (min_lat, max_lat, min_lng, max_lng) narrows the answer to one patch of
    the world — the map's current view, for "what's around here that I never
    named?". It runs before everything else: the limit slice is meant to be the
    best `limit` *inside* the box, not whatever survives of a global top-N, and
    filtering first also keeps the whole-library sorts off the excluded clusters.

    `offset` skips that many entries of the ordered, filtered list, so a caller
    working through a long tail can ask for the next page instead of raising
    `limit` and paying to reverse-geocode everything again. `total` is the length
    before the slice, so the caller knows when it has reached the end. Naming a
    place between pages shifts the list under the offset (that hotspot leaves it),
    which can skip a neighbour — a refresh re-syncs.

    Only the entries actually returned get reverse-geocoded — labelling the whole
    long tail would dominate the request for names nobody sees.
    """
    clusters = _all_clusters(merge_meters)
    if bbox is not None:
        clusters = [c for c in clusters if in_bbox(c["lat"], c["lng"], bbox)]
    extra: dict[int, dict] = {}   # per-cluster fields the chosen sort adds

    if sort == "recent":
        ordered = sorted(clusters, key=lambda c: -(c["last_ts"] or 0))
    elif sort == "near":
        if lat is None or lng is None:
            raise ValueError("sort=near needs lat and lng")
        dist = {id(c): meters_between(lat, lng, c["lat"], c["lng"]) for c in clusters}
        ordered = sorted(clusters, key=lambda c: dist[id(c)])
        extra = {k: {"meters": v} for k, v in dist.items()}
    elif sort == "time":
        if from_ts is None or to_ts is None:
            raise ValueError("sort=time needs from_ts and to_ts")
        counts = _window_counts(clusters, merge_meters, from_ts, to_ts)
        # Places with nothing in the window are dropped outright: an empty answer
        # is honest ("you have no history around then") and more useful than
        # padding the list with the same all-time favourites.
        ordered = sorted((c for c in clusters if id(c) in counts),
                         key=lambda c: -counts[id(c)]["count"])
        extra = {k: {"window_count": v["count"]} for k, v in counts.items()}
    else:
        ordered = clusters

    if hide_named:
        places = index.get_places()
        if places:
            before = len(ordered)
            ordered = [c for c in ordered
                       if not covered_by_place(c["lat"], c["lng"], merge_meters, places)]
            if before != len(ordered):
                logger.info(f"hotspots: {before - len(ordered)} of {before} "
                            f"suppressed by saved places")

    out = []
    start = max(0, offset)
    for c in ordered[start:start + max(1, limit)]:
        loc = geocode.lookup(c["lat"], c["lng"])   # None when no geocode data is installed
        out.append({
            "lat": c["lat"], "lng": c["lng"],
            "count": c["count"],
            "last_ts": c["last_ts"],
            "sample_photo_id": c["sample_photo_id"],
            "location": loc,
            "label": place_label(loc, c["lat"], c["lng"]),
            **extra.get(id(c), {}),
        })
    return {"hotspots": out, "total": len(ordered), "offset": start,
            "merge_meters": merge_meters}


def invalidate():
    """Drop the cached clustering. Redundant for coordinate changes made through
    index (the cache key tracks index.geotag_generation()); kept as the explicit
    hook for callers and tests that want a cold cache."""
    _cache.clear()
