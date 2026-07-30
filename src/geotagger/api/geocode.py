"""Reverse-geocoding: status, GeoNames viewport query, backfill, sidecar export,
and the next geotag-group picker."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from geotagger import census_places, index, geocode, osm_places, serializers
from geotagger.contexts import normalize_lng_bbox
from geotagger.executor import get_executor
from geotagger.services import geocode_service

router = APIRouter()


class GeocodeBackfillRequest(BaseModel):
    limit: int = 1000  # photos geocoded per call; repeat until remaining == 0


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    """-> (min_lat, max_lat, min_lng, max_lng), with longitude unwrapped back into
    [-180, 180]. map.getBounds() (Leaflet) returns raw longitudes outside that
    range once the map has been panned all the way around the globe — see
    contexts.normalize_lng_bbox."""
    try:
        min_lng, min_lat, max_lng, max_lat = map(float, bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be minLng,minLat,maxLng,maxLat")
    min_lng, max_lng = normalize_lng_bbox(min_lng, max_lng)
    return min_lat, max_lat, min_lng, max_lng


@router.get("/api/geocode/status")
async def api_geocode_status():
    """Geocoder availability plus how many photos are geocoded vs. pending."""
    return {
        **geocode.status(),
        "osm": osm_places.status(),
        "census": census_places.status(),
        "geocoded": index.count_geocoded_photos(),
        "pending": index.count_photos_needing_geocode(),
    }


@router.get("/api/geocode/places")
async def api_geocode_places(bbox: str = Query(...), limit: int = Query(3000, le=10000)):
    """GeoNames places within a viewport bbox — backs the Places DB map, which
    plots the raw reverse-geocode reference data (not photos) so the user can
    verify what place names a coordinate would resolve to."""
    min_lat, max_lat, min_lng, max_lng = _parse_bbox(bbox)
    if not geocode.is_available():
        raise HTTPException(503, "GeoNames data not installed — run scripts/get_geonames.py")
    places, total = geocode.cities_in_bbox(min_lat, max_lat, min_lng, max_lng, limit=limit)
    return {"places": places, "total": total, "truncated": total > len(places)}


@router.get("/api/geocode/voronoi")
async def api_geocode_voronoi(bbox: str = Query(...), limit: int = Query(4000, le=8000)):
    """Boundary cells for GeoNames places in a viewport bbox — for each place, the
    area a coordinate must fall in to reverse-geocode to it. Exact Voronoi cells
    under the plain nearest-point lookup; grid-traced outlines (accurate to about
    one grid step of the viewport) when the population weighting is on, since those
    boundaries are curved — see geocode.voronoi_cells. Backs the Places DB map's
    cell overlay, shown once zoomed in far enough."""
    min_lat, max_lat, min_lng, max_lng = _parse_bbox(bbox)
    if not geocode.is_available():
        raise HTTPException(503, "GeoNames data not installed — run scripts/get_geonames.py")
    loop = asyncio.get_running_loop()
    cells, total = await loop.run_in_executor(
        get_executor(), geocode.voronoi_cells, min_lat, max_lat, min_lng, max_lng, limit
    )
    return {"cells": cells, "total": total, "truncated": total > len(cells)}


@router.get("/api/geocode/osm-places")
async def api_geocode_osm_places(bbox: str = Query(...), limit: int = Query(4000, le=8000),
                                  buildings: bool = Query(True)):
    """OSM place polygons overlapping a viewport bbox, as a GeoJSON FeatureCollection
    — backs the Places DB map's OSM boundary overlay (cities, parks, stadiums,
    campuses, neighborhoods, named buildings), rendered via Leaflet's L.geoJSON().
    `buildings=false` excludes the building category (the map only asks for it
    past its own building-level zoom threshold — see MIN_ZOOM_FOR_BUILDINGS).
    503 if the OSM places DB hasn't been built. `total`/`truncated` are extra
    top-level fields alongside the standard `type`/`features` — GeoJSON consumers
    that only look at `features` are unaffected."""
    min_lat, max_lat, min_lng, max_lng = _parse_bbox(bbox)
    if not osm_places.is_available():
        raise HTTPException(503, "OSM places DB not built — run scripts/build_osm_places.py <region>.osm.pbf")
    loop = asyncio.get_running_loop()
    places, total = await loop.run_in_executor(
        get_executor(), osm_places.places_in_bbox, min_lat, max_lat, min_lng, max_lng, limit, buildings
    )
    return {
        "type": "FeatureCollection",
        "features": [osm_places.place_to_geojson_feature(p) for p in places],
        "total": total,
        "truncated": total > len(places),
    }


@router.get("/api/geocode/census-places")
async def api_geocode_census_places(bbox: str = Query(...), limit: int = Query(4000, le=8000)):
    """US Census place polygons overlapping a viewport bbox, as a GeoJSON
    FeatureCollection — backs the Places DB map's census overlay. These are the
    boundaries consulted after OSM and before the GeoNames distance estimate, so
    seeing them explains why an unincorporated coordinate resolves the way it does.
    503 if the census places DB hasn't been built."""
    min_lat, max_lat, min_lng, max_lng = _parse_bbox(bbox)
    if not census_places.is_available():
        raise HTTPException(503, "Census places DB not built — run scripts/get_census_places.py")
    loop = asyncio.get_running_loop()
    places, total = await loop.run_in_executor(
        get_executor(), census_places.places_in_bbox, min_lat, max_lat, min_lng, max_lng, limit
    )
    return {
        "type": "FeatureCollection",
        "features": [census_places.place_to_geojson_feature(p) for p in places],
        "total": total,
        "truncated": total > len(places),
    }


def _probe(lat: float, lng: float) -> dict:
    """Blocking half of the point probe: the resolved location plus what each source
    said on its own, so the UI can show *which* of the three produced the city."""
    return {
        "location": geocode.lookup(lat, lng),
        "sources": {
            "osm": osm_places.lookup(lat, lng),
            "census": census_places.lookup(lat, lng),
            "geonames": geocode._raw_lookup(lat, lng),
        },
    }


@router.get("/api/geocode/lookup")
async def api_geocode_lookup(lat: float = Query(...), lng: float = Query(...)):
    """Reverse-geocode a single coordinate exactly as a photo taken there would be —
    returns the {city, sublocation, state, county, country, country_code} that would
    be persisted on that photo, plus each source's own answer under `sources` (OSM
    containment, Census place containment, GeoNames nearest-point). Backs the Places
    DB map's click-to-probe: click a point and see what location the geocoder would
    save, and why. 503 only if none of the datasets is installed."""
    if not (geocode.is_available() or osm_places.is_available() or census_places.is_available()):
        raise HTTPException(503, "No geocode data installed — run scripts/get_geonames.py, "
                                 "scripts/get_census_places.py and/or scripts/build_osm_places.py")
    loop = asyncio.get_running_loop()
    probe = await loop.run_in_executor(get_executor(), _probe, lat, lng)
    return {"lat": lat, "lng": lng, **probe}


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
    """Write every geotagged photo's GPS coordinates (plus resolved place names,
    where available) into its XMP sidecar."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(get_executor(), geocode_service.export_to_sidecars)


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


