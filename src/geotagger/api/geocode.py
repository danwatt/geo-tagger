"""Reverse-geocoding: status, GeoNames viewport query, backfill, sidecar export,
and the next geotag-group picker."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from geotagger import index, geocode, serializers
from geotagger.executor import get_executor
from geotagger.services import geocode_service

router = APIRouter()


class GeocodeBackfillRequest(BaseModel):
    limit: int = 1000  # photos geocoded per call; repeat until remaining == 0


@router.get("/api/geocode/status")
async def api_geocode_status():
    """Geocoder availability plus how many photos are geocoded vs. pending."""
    return {
        **geocode.status(),
        "geocoded": index.count_geocoded_photos(),
        "pending": index.count_photos_needing_geocode(),
    }


@router.get("/api/geocode/places")
async def api_geocode_places(bbox: str = Query(...), limit: int = Query(3000, le=10000)):
    """GeoNames places within a viewport bbox — backs the Places DB map, which
    plots the raw reverse-geocode reference data (not photos) so the user can
    verify what place names a coordinate would resolve to."""
    try:
        min_lng, min_lat, max_lng, max_lat = map(float, bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be minLng,minLat,maxLng,maxLat")
    if not geocode.is_available():
        raise HTTPException(503, "GeoNames data not installed — run scripts/get_geonames.py")
    places, total = geocode.cities_in_bbox(min_lat, max_lat, min_lng, max_lng, limit=limit)
    return {"places": places, "total": total, "truncated": total > len(places)}


@router.get("/api/geocode/voronoi")
async def api_geocode_voronoi(bbox: str = Query(...), limit: int = Query(4000, le=8000)):
    """Voronoi cells for GeoNames places in a viewport bbox — for each place,
    the exact area a coordinate must fall in to reverse-geocode to it. Backs
    the Places DB map's cell overlay, shown once zoomed in far enough."""
    try:
        min_lng, min_lat, max_lng, max_lat = map(float, bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be minLng,minLat,maxLng,maxLat")
    if not geocode.is_available():
        raise HTTPException(503, "GeoNames data not installed — run scripts/get_geonames.py")
    loop = asyncio.get_running_loop()
    cells, total = await loop.run_in_executor(
        get_executor(), geocode.voronoi_cells, min_lat, max_lat, min_lng, max_lng, limit
    )
    return {"cells": cells, "total": total, "truncated": total > len(cells)}


@router.post("/api/geocode/backfill")
async def api_geocode_backfill(req: GeocodeBackfillRequest):
    """Reverse-geocode up to `limit` photos that have coordinates but no location.
    Repeat until `remaining` is 0. Returns 503 if the GeoNames data isn't installed."""
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(get_executor(), geocode_service.geocode_pending, max(1, req.limit))
    if not result.get("available"):
        raise HTTPException(503, "GeoNames data not installed — run scripts/get_geonames.py")
    return result


@router.post("/api/geocode/export-sidecars")
async def api_geocode_export_sidecars():
    """Write resolved place names into the XMP sidecars of all geocoded photos."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(get_executor(), geocode_service.export_locations_to_sidecars)


@router.get("/api/geocode/next-group")
async def api_geocode_next_group(
    start_year: int = Query(2000),
    after_ts: int = Query(None),
    group_window_days: int = Query(1),
    context_window_days: int = Query(1)
):
    from geotagger import geotag_groups

    loop = asyncio.get_running_loop()
    groups = await loop.run_in_executor(
        get_executor(),
        geotag_groups.get_next_geotag_group,
        start_year,
        after_ts,
        group_window_days,
        context_window_days
    )

    if not groups:
        return None

    return {
        "before": [serializers.photo_geocode_dict(p) for p in groups["before"]],
        "to_tag": [serializers.photo_geocode_dict(p) for p in groups["to_tag"]],
        "after": [serializers.photo_geocode_dict(p) for p in groups["after"]],
    }


