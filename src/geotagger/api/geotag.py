"""Geotag write/remove/ignore, the hotspot palette, the selection proposer, and
the time-neighbor location guesser."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from geotagger import index
from geotagger.executor import get_executor
from geotagger.services import geotag_service, hotspots_service

router = APIRouter()


class GeotagRequest(BaseModel):
    ids: list[int]
    lat: float
    lng: float
    gps_accuracy: float | None = None

class RemoveGeotagRequest(BaseModel):
    ids: list[int]

class SetGeocodeIgnoredRequest(BaseModel):
    ids: list[int]
    ignored: bool = True

class ProposeRequest(BaseModel):
    ids: list[int]
    window: int = geotag_service.DEFAULT_PROPOSE_WINDOW
    limit: int = 3


@router.post("/api/geotag")
async def api_geotag(req: GeotagRequest):
    # The whole batch runs in the executor: a commit is one ExifTool round-trip per
    # photo (plus the geocoder's one-time KD-tree load), which would otherwise stall
    # the event loop for the length of a several-hundred-photo commit.
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_executor(), geotag_service.write_geotag,
        req.ids, req.lat, req.lng, req.gps_accuracy,
    )


@router.post("/api/geotag/ignore")
async def api_geotag_ignore(req: SetGeocodeIgnoredRequest):
    """Mark (or unmark) photos as not needing geocoding, e.g. screenshots.
    DB-only — no EXIF/sidecar write. Ignored photos still appear in the grid
    but count as geotagged for the Show filter and geotagged/not-geotagged stats."""
    index.set_geocode_ignored(req.ids, req.ignored)
    return {"ids": req.ids, "geocode_ignored": req.ignored}


# ── Hotspots & proposals ──

@router.get("/api/geotag/hotspots")
async def api_geotag_hotspots(
    limit: int = Query(40, ge=1, le=200),
    merge_meters: float = Query(hotspots_service.DEFAULT_MERGE_METERS, ge=10, le=20000),
    sort: str = Query("count", pattern="^(count|recent)$"),
):
    """Recurring drop points mined from the coordinates already on the photos —
    the location palette's data. Clustered so drops a few hundred feet apart at
    the same real place count as one entry."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_executor(), hotspots_service.get_hotspots, limit, merge_meters, sort,
    )


@router.post("/api/geotag/propose")
async def api_geotag_propose(req: ProposeRequest):
    """Rank likely locations for a selection from its photos' nearest-in-time
    geotagged neighbors. POST because a selection can be hundreds of ids."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_executor(), geotag_service.propose_locations,
        req.ids, req.window, req.limit,
    )


@router.get("/api/guess/{photo_id}")
async def api_guess(photo_id: int, window: int = 900):
    """Return a guessed lat/lng from nearby-in-time geotagged photos (±window seconds).
    Falls back to the centroid of a matched Life Context when no time-neighbors exist."""
    import json as _json
    from geotagger.contexts import point_in_polygon, polygon_centroid
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    if row["lat"] is not None:
        raise HTTPException(400, "Photo already has a geotag")
    ts = row["photo_datetime"]
    if not ts or ts <= 0:
        raise HTTPException(400, "Photo has no timestamp — cannot guess location")

    # Look up matching contexts by timestamp (polygon is the answer, not a filter)
    matched_contexts = index.contexts_for_time(ts)
    ctx_payload = [{"id": c["id"], "name": c["name"], "polygon": _json.loads(c["polygon"])}
                   for c in matched_contexts]

    db = index.get_db()
    nearby = db.execute("""
        SELECT id, lat, lng, filename, photo_datetime FROM photos
        WHERE lat IS NOT NULL
          AND photo_datetime > 0
          AND photo_datetime BETWEEN ? AND ?
          AND id != ?
        ORDER BY ABS(photo_datetime - ?) ASC
        LIMIT 50
    """, (ts - window, ts + window, photo_id, ts)).fetchall()

    # When contexts exist, constrain to in-polygon neighbors only
    if nearby and matched_contexts:
        in_ctx = [r for r in nearby if any(
            point_in_polygon(r["lat"], r["lng"], _json.loads(c["polygon"]))
            for c in matched_contexts
        )]
        if in_ctx:
            nearby = in_ctx

    if nearby:
        weights = [1.0 / (abs(r["photo_datetime"] - ts) + 1) for r in nearby]
        total_w = sum(weights)
        avg_lat = sum(r["lat"] * w for r, w in zip(nearby, weights)) / total_w
        avg_lng = sum(r["lng"] * w for r, w in zip(nearby, weights)) / total_w
        return {
            "lat": avg_lat,
            "lng": avg_lng,
            "source": "time-neighbors",
            "source_count": len(nearby),
            "window_sec": window,
            "sources": [{"id": r["id"], "filename": r["filename"],
                         "lat": r["lat"], "lng": r["lng"],
                         "delta_sec": abs(r["photo_datetime"] - ts),
                         "is_before": r["photo_datetime"] < ts} for r in nearby],
            "contexts": ctx_payload,
        }

    # No usable neighbors — fall back to context centroid if a context matched
    if matched_contexts:
        # Pick the most specific (smallest-area) context
        def _area(c):
            verts = _json.loads(c["polygon"])
            lat_span = (c["max_lat"] or 0) - (c["min_lat"] or 0)
            lng_span = (c["max_lng"] or 0) - (c["min_lng"] or 0)
            return lat_span * lng_span
        best = min(matched_contexts, key=_area)
        verts = _json.loads(best["polygon"])
        clat, clng = polygon_centroid(verts)
        return {
            "lat": clat,
            "lng": clng,
            "source": "context-centroid",
            "source_count": 0,
            "window_sec": window,
            "sources": [],
            "contexts": ctx_payload,
        }

    raise HTTPException(404, detail="No geotagged photos found within the time window")


@router.post("/api/geotag/remove")
async def api_geotag_remove(req: RemoveGeotagRequest):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_executor(), geotag_service.remove_geotag, req.ids,
    )

