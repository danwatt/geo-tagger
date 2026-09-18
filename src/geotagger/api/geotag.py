"""Geotag write/remove/ignore, the hotspot palette, the selection proposer, and
the time-neighbor location guesser."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from geotagger import index
from geotagger.executor import get_executor
from geotagger.services import geotag_service, hotspots_service, work_queue_service

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
    work_queue_service.invalidate()
    return {"ids": req.ids, "geocode_ignored": req.ignored}


# ── Hotspots & proposals ──

@router.get("/api/geotag/hotspots")
async def api_geotag_hotspots(
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0, description="skip this many ranked hotspots — paging"),
    merge_meters: float = Query(hotspots_service.DEFAULT_MERGE_METERS, ge=10, le=20000),
    sort: str = Query("count", pattern="^(count|recent|near|time)$"),
    lat: float | None = Query(None, description="map centre latitude; required for sort=near"),
    lng: float | None = Query(None, description="map centre longitude; required for sort=near"),
    from_ts: int | None = Query(None, description="window start; required for sort=time"),
    to_ts: int | None = Query(None, description="window end; required for sort=time"),
    hide_named: bool = Query(True, description="drop hotspots a saved place already covers"),
    min_lat: float | None = Query(None, description="viewport filter; all four or none"),
    max_lat: float | None = Query(None),
    min_lng: float | None = Query(None),
    max_lng: float | None = Query(None),
):
    """Recurring drop points mined from the coordinates already on the photos.
    Clustered so drops a few hundred feet apart at the same real place count as
    one entry, and (by default) with the ones a saved place already covers left
    out.

    The four bounds narrow the answer to a patch of the world — what the Custom
    Places page sends to ask "what's in view here that I never named?". Give all
    four or none.

    Feeds the geocode page's location picker (the "Hotspots" section of
    openLocationPicker in web/app.js) and the Custom Places page's hotspot
    list — the places you tag at repeatedly but never bothered to save a name
    for. See services/hotspots_service.py."""
    bounds = (min_lat, max_lat, min_lng, max_lng)
    if any(v is None for v in bounds) and not all(v is None for v in bounds):
        raise HTTPException(400, "min_lat, max_lat, min_lng and max_lng go together")
    bbox = None if bounds[0] is None else bounds

    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            get_executor(), hotspots_service.get_hotspots,
            limit, merge_meters, sort, lat, lng, from_ts, to_ts, hide_named, bbox,
            offset,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


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
    """Return a guessed lat/lng from nearby-in-time geotagged photos (±window seconds)."""
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    if row["lat"] is not None:
        raise HTTPException(400, "Photo already has a geotag")
    ts = row["photo_datetime"]
    if not ts or ts <= 0:
        raise HTTPException(400, "Photo has no timestamp — cannot guess location")

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
        }

    raise HTTPException(404, detail="No geotagged photos found within the time window")


@router.post("/api/geotag/remove")
async def api_geotag_remove(req: RemoveGeotagRequest):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_executor(), geotag_service.remove_geotag, req.ids,
    )

