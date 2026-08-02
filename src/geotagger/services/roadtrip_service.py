"""Road-trip corridor: the photos that already sit near a drawn route, plus a
predicted position on that route for the untagged photos taken in the time gaps
between them.

The idea: on a road trip you tag a handful of stops, and everything shot between
two stops was taken somewhere on the road connecting them. Interpolating by
timestamp *along the route's arc length* (rather than along a straight line
between the two tagged photos) puts a photo shot halfway through a two-hour leg
roughly halfway along the road, which is usually within a few miles of the truth.

Framework-free; blocking. Called from the executor by api/roadtrip.py.
"""

import bisect

from geotagger import index, serializers
from geotagger.geometry import (distance_to_route, local_scale, planar_distance,
                                point_along_route, route_cumulative_lengths)

# How far beyond the corridor's own first/last tagged photo an untagged photo can
# still be picked up. Inside the span a photo is bracketed by two anchors; outside
# it can only be extrapolated from one, so the window is deliberately modest.
DEFAULT_EDGE_WINDOW = 3600

# Predictions never claim better than this, no matter how tight the bracketing —
# the anchors themselves are photo geotags, not survey marks.
MIN_ACCURACY_M = 100.0

# Sanity clamp on the speed derived from the anchors (m/s). 55 m/s ≈ 123 mph:
# enough for a fast highway leg, low enough that two anchors a second apart at
# opposite ends of the route don't fling extrapolations off the map.
MAX_SPEED_MPS = 55.0

# Upper bound on returned candidates, so a route drawn across a decade of photos
# can't build a hundred-thousand-entry response.
MAX_CANDIDATES = 3000


# How far apart two consecutive geotagged photos have to be before they count as
# two stops on the trip rather than one. Roughly "a different town".
DEFAULT_CLUSTER_METERS = 2000.0


def suggest_route(start_id: int, end_id: int,
                  cluster_m: float = DEFAULT_CLUSTER_METERS) -> dict:
    """Waypoints for the drive between two photos.

    A straight line between them is the floor. Where other photos were already
    geotagged during the same window they're clustered in *time* order — walk
    the trip forward, and start a new cluster whenever the next photo is more
    than `cluster_m` from where the current one is centred — so the clusters
    come out as the stops in the order you drove them, and the line bends
    through them instead of cutting across the map.
    """
    a = index.get_photo(start_id)
    b = index.get_photo(end_id)
    if not a or not b:
        raise ValueError("Photo not found")
    for r in (a, b):
        if r["lat"] is None:
            raise ValueError(f"{r['filename']} has no location — pick a geotagged photo")
        if not r["photo_datetime"] or r["photo_datetime"] <= 0:
            raise ValueError(f"{r['filename']} has no timestamp — pick a dated photo")

    # Whichever was shot first is the start, so it doesn't matter which end of
    # the trip the user right-clicked first.
    if a["photo_datetime"] > b["photo_datetime"]:
        a, b = b, a
    from_ts, to_ts = a["photo_datetime"], b["photo_datetime"]

    between = [r for r in index.get_photos_by_time_range(from_ts, to_ts, has_geotag=True)
               if r["lat"] is not None and r["id"] not in (a["id"], b["id"])]

    scale = local_scale([[a["lat"], a["lng"]], [b["lat"], b["lng"]]]
                        + [[r["lat"], r["lng"]] for r in between])

    clusters: list[dict] = []
    for r in between:
        cur = clusters[-1] if clusters else None
        if cur and planar_distance(cur["lat"], cur["lng"], r["lat"], r["lng"], scale) <= cluster_m:
            # Running centroid, so a cluster drifts with the photos in it rather
            # than being pinned to whichever photo happened to open it.
            cur["n"] += 1
            cur["lat"] += (r["lat"] - cur["lat"]) / cur["n"]
            cur["lng"] += (r["lng"] - cur["lng"]) / cur["n"]
            cur["to_ts"] = r["photo_datetime"]
        else:
            clusters.append({"lat": r["lat"], "lng": r["lng"], "n": 1,
                             "from_ts": r["photo_datetime"], "to_ts": r["photo_datetime"]})

    points = [[a["lat"], a["lng"]]]
    for c in clusters:
        # Drop a waypoint that would sit on top of the previous one — it adds a
        # vertex to drag without moving the line anywhere.
        if planar_distance(points[-1][0], points[-1][1], c["lat"], c["lng"], scale) > cluster_m / 2:
            points.append([c["lat"], c["lng"]])
    if len(points) < 2 or planar_distance(points[-1][0], points[-1][1], b["lat"], b["lng"], scale) > 1.0:
        points.append([b["lat"], b["lng"]])

    return {
        "points": points,
        "from_ts": from_ts,
        "to_ts": to_ts,
        "start": serializers.photo_to_dict(a),
        "end": serializers.photo_to_dict(b),
        "cluster_count": len(clusters),
        "between_count": len(between),
        "clusters": [{"lat": c["lat"], "lng": c["lng"], "count": c["n"],
                      "from_ts": c["from_ts"], "to_ts": c["to_ts"]} for c in clusters],
    }


def _confidence(gap_sec: float, accuracy_m: float) -> str:
    """Coarse trust label for a prediction. Driven by both how long the leg was
    (a 6-hour gap hides a lunch stop and a detour) and how far the car moved
    across it (a 3-hour gap that covered 2 km is a parked car — still tight)."""
    if gap_sec <= 1800 and accuracy_m <= 2000:
        return "high"
    if gap_sec <= 7200 and accuracy_m <= 20000:
        return "medium"
    return "low"


def photos_along_route(
    points: list[list[float]],
    radius_m: float,
    from_ts: int | None = None,
    to_ts: int | None = None,
    edge_window: int = DEFAULT_EDGE_WINDOW,
) -> dict:
    """Photos within `radius_m` of the polyline `points` ([[lat, lng], …]), plus
    untagged photos timestamped between them with a predicted position.

    `from_ts`/`to_ts` (unix seconds) narrow the anchors to the timeframe the page
    is looking at — the same route drawn over a road trip taken twice would
    otherwise mix both trips' photos into one nonsensical timeline.
    """
    if len(points) < 2:
        raise ValueError("A route needs at least two points")
    if radius_m <= 0:
        raise ValueError("radius_m must be positive")

    scale = local_scale(points)
    cum = route_cumulative_lengths(points, scale)
    route_len = cum[-1]

    # R*Tree bbox prefilter on the route grown by the corridor width, then the
    # exact point-to-polyline distance in Python — same prefilter/post-filter
    # shape as the circular area query in api/photos.py.
    lats = [p[0] for p in points]
    lngs = [p[1] for p in points]
    d_lat = radius_m / scale[0]
    d_lng = radius_m / scale[1]
    rows = index.get_photos_in_bbox(min(lats) - d_lat, max(lats) + d_lat,
                                    min(lngs) - d_lng, max(lngs) + d_lng)

    on_route: list[tuple] = []      # (row, arc length of its nearest route point)
    for r in rows:
        dist, s = distance_to_route(r["lat"], r["lng"], points, cum, scale)
        if dist <= radius_m:
            on_route.append((r, s))

    # Anchors: the corridor photos that can pin a moment in time to a place on
    # the route. Timeframe filter applies here (and so, transitively, to which
    # untagged photos get considered at all).
    anchors = []
    for r, s in on_route:
        ts = r["photo_datetime"]
        if not ts or ts <= 0:
            continue
        if from_ts is not None and ts < from_ts:
            continue
        if to_ts is not None and ts > to_ts:
            continue
        anchors.append((ts, s, r))
    anchors.sort(key=lambda a: (a[0], a[1]))

    route_photos = [serializers.photo_to_dict(r) for r, _ in on_route
                    if _in_window(r, from_ts, to_ts)]

    result = {
        "route_length_m": route_len,
        "radius_m": radius_m,
        "anchor_count": len(anchors),
        "photos": route_photos,
        "candidates": [],
        "truncated": False,
    }
    if not anchors:
        return result

    times = [a[0] for a in anchors]
    arcs = [a[1] for a in anchors]

    # One speed for the whole route, from the anchors that bracket it. Per-leg
    # speed is what the interpolation itself already encodes; this is only used
    # to extrapolate off the ends, where there's no second anchor to divide by.
    span_sec = times[-1] - times[0]
    speed = min(abs(arcs[-1] - arcs[0]) / span_sec, MAX_SPEED_MPS) if span_sec > 0 else 0.0

    untagged = index.get_photos_by_time_range(
        times[0] - edge_window, times[-1] + edge_window, has_geotag=False)

    candidates = []
    for r in untagged:
        ts = r["photo_datetime"]
        if not ts or ts <= 0:
            continue
        pred = _predict(ts, times, arcs, speed, points, cum, route_len)
        if pred is None:
            continue
        entry = serializers.photo_to_dict(r)
        entry["predicted"] = pred
        candidates.append(entry)
        if len(candidates) >= MAX_CANDIDATES:
            result["truncated"] = True
            break

    result["candidates"] = candidates
    return result


def _in_window(row, from_ts: int | None, to_ts: int | None) -> bool:
    """Timeframe test for a corridor photo. Photos with no usable timestamp pass
    only when no timeframe was asked for — they can't be placed on the trip's
    timeline, but they are genuinely inside the corridor."""
    ts = row["photo_datetime"]
    if not ts or ts <= 0:
        return from_ts is None and to_ts is None
    if from_ts is not None and ts < from_ts:
        return False
    if to_ts is not None and ts > to_ts:
        return False
    return True


def _predict(ts: int, times: list[int], arcs: list[float], speed: float,
             points, cum: list[float], route_len: float) -> dict | None:
    """Where on the route a photo taken at `ts` most likely was.

    Bracketed by two anchors: split the leg's arc length by the time fraction.
    Off the end: walk on from the last anchor at the trip's average speed. The
    reported accuracy is how far the answer could plausibly be off — half the
    leg for an interpolation, the whole extrapolated distance for the ends.
    """
    idx = bisect.bisect_left(times, ts)
    prev_i = idx - 1 if idx > 0 else None
    next_i = idx if idx < len(times) else None

    if prev_i is not None and next_i is not None:
        t0, t1 = times[prev_i], times[next_i]
        s0, s1 = arcs[prev_i], arcs[next_i]
        gap = t1 - t0
        f = (ts - t0) / gap if gap > 0 else 0.0
        s = s0 + f * (s1 - s0)
        accuracy = max(MIN_ACCURACY_M, abs(s1 - s0) / 2.0)
        method = "interpolated"
    else:
        i = prev_i if prev_i is not None else next_i
        if i is None:
            return None
        dt = ts - times[i]                       # signed: negative before the trip
        travelled = speed * dt
        s = arcs[i] + travelled
        gap = abs(dt)
        accuracy = max(MIN_ACCURACY_M, abs(travelled))
        method = "extrapolated"

    s = max(0.0, min(route_len, s))
    lat, lng = point_along_route(s, points, cum)
    return {
        "lat": lat,
        "lng": lng,
        "accuracy_m": round(accuracy, 1),
        "gap_sec": int(gap),
        "route_offset_m": round(s, 1),
        "method": method,
        "confidence": _confidence(gap, accuracy),
    }
