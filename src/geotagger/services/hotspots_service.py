"""Recurring drop points ("hotspots") mined from the coordinates already on the
photos. Backs the geocode view's location palette: the same handful of places
come up month after month, so the fastest drop target is a list row, not a spot
on the map you have to pan and zoom to find.

Blocking (full-table GROUP BY + geocode lookups); runs in the executor.
"""

import logging
import math
import time

from geotagger import geocode, index

logger = logging.getLogger(__name__)

# Coordinate quantization for the SQL pre-aggregation. 3 decimal places is
# ~110 m of latitude — already coarse enough to fuse the drift between two drops
# a few hundred feet apart, and it collapses a 100k-row table to a few thousand
# cells before any Python touches it.
_CELL_DECIMALS = 3

# Cells whose centres are within this get folded into one hotspot. Deliberately
# larger than the cell size: a single real place (a house, a park entrance)
# routinely straddles a cell boundary, and the user's own drops for it vary by
# "100s of feet".
DEFAULT_MERGE_METERS = 300.0

# Rows fed into the Python merge pass. Sorted by photo count, so this keeps the
# places actually worth showing and discards the long tail of one-off drops.
_MAX_CELLS = 4000

_METERS_PER_DEG_LAT = 111_320.0

# (cache_key, merge_m) -> clusters. Invalidated by the geotagged-photo count, so
# any commit through /api/geotag rebuilds it on the next request.
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


def meters_between(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Equirectangular distance in metres. Good to a fraction of a percent over
    the tens-of-kilometres spans the palette ranks by, and much cheaper than
    haversine in the inner loops here."""
    dy = (lat2 - lat1) * _METERS_PER_DEG_LAT
    dx = (lng2 - lng1) * _lng_scale(lat1)
    return math.hypot(dx, dy)


def _bucket_of(lat: float, lng: float, bucket_deg: float) -> tuple[int, int]:
    """Grid cell for a coordinate. Longitude buckets are sized in
    degrees-at-this-latitude so they stay ~bucket_deg wide in metres near the
    poles instead of collapsing to slivers."""
    lng_bucket_deg = bucket_deg / max(math.cos(math.radians(lat)), 1e-6)
    return int(lat / bucket_deg), int(lng / lng_bucket_deg)


def _grid_nearest(grid: dict, lat: float, lng: float, bucket_deg: float,
                  max_m: float) -> dict | None:
    """Closest indexed cluster within `max_m`, or None. Only the 9 surrounding
    buckets are searched — with buckets sized at the search radius, nothing
    within range can live further out."""
    bi, bj = _bucket_of(lat, lng, bucket_deg)
    best, best_d = None, max_m
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            for cl in grid.get((bi + di, bj + dj), ()):
                d = meters_between(lat, lng, cl["lat"], cl["lng"])
                if d < best_d:
                    best, best_d = cl, d
    return best


def build_grid(clusters: list[dict], merge_m: float) -> tuple[dict, float]:
    """Spatial index over existing clusters, as (grid, bucket_deg) for
    _grid_nearest. Used to fold a second pass of cells onto an already-computed
    (and cached) clustering without redoing the agglomeration."""
    bucket_deg = merge_m / _METERS_PER_DEG_LAT
    grid: dict[tuple[int, int], list[dict]] = {}
    for cl in clusters:
        grid.setdefault(_bucket_of(cl["lat"], cl["lng"], bucket_deg), []).append(cl)
    return grid, bucket_deg


def cluster_cells(cells: list, merge_m: float) -> list[dict]:
    """Greedily agglomerate quantized cells into hotspots.

    Each cell needs the keys `alat`, `alng`, `n`, `last_ts`, `sample_id` (the
    column names of get_hotspots' GROUP BY, and what quantize() produces), and
    the list must be sorted by `n` descending.

    Cells arrive sorted by photo count, so the busiest cell of a place seeds the
    cluster and its satellites get absorbed into it — the centroid stays anchored
    on where the user actually drops, instead of drifting toward the outliers.
    """
    bucket_deg = merge_m / _METERS_PER_DEG_LAT
    grid: dict[tuple[int, int], list[dict]] = {}
    clusters: list[dict] = []

    for c in cells:
        lat, lng = c["alat"], c["alng"]
        n = c["n"]
        best = _grid_nearest(grid, lat, lng, bucket_deg, merge_m)

        if best is not None:
            # Photo-count-weighted centroid: a place with 200 photos shouldn't be
            # dragged half a cell by a 2-photo neighbour.
            total = best["count"] + n
            best["lat"] = (best["lat"] * best["count"] + lat * n) / total
            best["lng"] = (best["lng"] * best["count"] + lng * n) / total
            best["count"] = total
            best["cells"] += 1
            if (c["last_ts"] or 0) > (best["last_ts"] or 0):
                best["last_ts"] = c["last_ts"]
                best["sample_photo_id"] = c["sample_id"]
            continue

        cl = {
            "lat": lat, "lng": lng, "count": n, "cells": 1,
            "last_ts": c["last_ts"], "sample_photo_id": c["sample_id"],
        }
        clusters.append(cl)
        grid.setdefault(_bucket_of(lat, lng, bucket_deg), []).append(cl)

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


def _all_clusters(merge_meters: float) -> list[dict]:
    """The full clustering of every geotagged photo, count-descending. Cached on
    the geotagged-photo count, so a commit rebuilds it on the next request."""
    cache_key = (index.count_geotagged_photos(), round(merge_meters, 1))
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
          AND photo_datetime BETWEEN ? AND ?
        GROUP BY ROUND(lat, {_CELL_DECIMALS}), ROUND(lng, {_CELL_DECIMALS})
    """, (from_ts, to_ts)).fetchall()

    grid, bucket_deg = build_grid(clusters, merge_meters)
    counts: dict[int, dict] = {}
    for r in rows:
        cl = _grid_nearest(grid, r["alat"], r["alng"], bucket_deg, merge_meters)
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
                 from_ts: int | None = None, to_ts: int | None = None) -> dict:
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

    Only the `limit` entries actually returned get reverse-geocoded — labelling
    the whole long tail would dominate the request for names nobody sees.
    """
    clusters = _all_clusters(merge_meters)
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

    out = []
    for c in ordered[:max(1, limit)]:
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
    return {"hotspots": out, "total": len(ordered), "merge_meters": merge_meters}


def invalidate():
    """Drop the cached clustering. The cache key already tracks the geotagged
    photo count; this covers edits that change coordinates without changing it."""
    _cache.clear()
