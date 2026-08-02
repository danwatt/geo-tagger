"""Road-trip corridor query: photos near a drawn route plus predicted positions
for the untagged photos taken between them. See services/roadtrip_service.py."""

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from geotagger.executor import get_executor
from geotagger.services import roadtrip_service

logger = logging.getLogger(__name__)
router = APIRouter()


class RouteRequest(BaseModel):
    # POST rather than GET: a traced route is an arbitrarily long vertex list.
    points: list[list[float]] = Field(..., description="[[lat, lng], …], at least two")
    radius_m: float = Field(..., gt=0, le=200000, description="corridor half-width in meters")
    from_ts: int | None = None
    to_ts: int | None = None
    edge_window: int = Field(roadtrip_service.DEFAULT_EDGE_WINDOW, ge=0, le=604800)


class SuggestRequest(BaseModel):
    start_id: int
    end_id: int
    cluster_m: float = Field(roadtrip_service.DEFAULT_CLUSTER_METERS, gt=0, le=100000)


@router.post("/api/roadtrip/suggest")
async def api_roadtrip_suggest(req: SuggestRequest):
    """Waypoints for the drive between two photos — a straight line, bent through
    clusters of whatever was already geotagged in between."""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            get_executor(), roadtrip_service.suggest_route,
            req.start_id, req.end_id, req.cluster_m,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/api/roadtrip/photos")
async def api_roadtrip_photos(req: RouteRequest):
    """Photos already geotagged inside the corridor, plus untagged photos
    timestamped between them, each with a predicted spot on the route."""
    t0 = time.time()
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            get_executor(), roadtrip_service.photos_along_route,
            req.points, req.radius_m, req.from_ts, req.to_ts, req.edge_window,
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.exception("Road-trip corridor query failed")
        raise HTTPException(500, str(e))

    logger.info(
        f"Route corridor: {len(req.points)} pts, r={req.radius_m}m → "
        f"{len(result['photos'])} tagged, {result['anchor_count']} anchors, "
        f"{len(result['candidates'])} candidates in {(time.time() - t0)*1000:.2f}ms"
    )
    return result
