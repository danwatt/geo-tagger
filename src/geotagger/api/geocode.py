"""Reverse-geocoding: status, GeoNames viewport query, backfill and sidecar export."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from geotagger import census_places, index, geocode, osm_places
from geotagger.geometry import normalize_lng_bbox
from geotagger.executor import get_executor
from geotagger.services import geocode_service

router = APIRouter()

# Lookups merge whichever datasets are installed, so any one of them is enough.
_NO_DATASETS_MSG = ("No geocode data installed — run scripts/get_geonames.py, "
                    "scripts/get_census_places.py and/or scripts/build_osm_places.py")


class GeocodeBackfillRequest(BaseModel):
    limit: int = Field(1000, ge=1, le=100_000)  # photos geocoded per call; repeat until remaining == 0


class BackfillResponse(BaseModel):
    processed: int
    matched: int
    available: bool
    remaining: int


# ── Response models (the Geo Data page's generated types) ──
# extra="allow" throughout: these dicts come straight from the dataset modules,
# and a field one of them grows should reach the pages without a model change.

class ResolvedLocation(BaseModel):
    """geocode.lookup()'s answer — what a photo at that coordinate would store."""
    model_config = ConfigDict(extra="allow")
    city: str | None = None
    sublocation: str | None = None
    postal_code: str | None = None
    state: str | None = None
    county: str | None = None
    country: str | None = None
    country_code: str | None = None


class GeoNamesPlace(BaseModel):
    model_config = ConfigDict(extra="allow")
    city: str | None = None
    state: str | None = None
    county: str | None = None
    country: str | None = None
    country_code: str | None = None
    lat: float
    lng: float
    population: int


class GeoNamesPlacesResponse(BaseModel):
    places: list[GeoNamesPlace]
    total: int
    truncated: bool


class VoronoiCell(GeoNamesPlace):
    # Rings of [lat, lng]. A population-weighted cell is grid-traced and can come
    # back as several disjoint rings; `polygon` is the largest of them.
    polygon: list[list[float]]
    polygons: list[list[list[float]]]


class VoronoiResponse(BaseModel):
    cells: list[VoronoiCell]
    total: int
    truncated: bool


class GeoJsonGeometry(BaseModel):
    type: str
    coordinates: list[Any]   # MultiPolygon nesting; handed to Leaflet as-is


class GeoJsonFeature(BaseModel):
    type: str
    # Per-dataset fields (OSM: name/category/…, Census: name/kind/…, ZCTA: zip/city/…).
    properties: dict[str, Any]
    geometry: GeoJsonGeometry


class FeatureCollection(BaseModel):
    """A GeoJSON FeatureCollection plus total/truncated alongside the standard keys."""
    type: str
    features: list[GeoJsonFeature]
    total: int
    truncated: bool


class OsmSource(BaseModel):
    model_config = ConfigDict(extra="allow")
    city: str | None = None
    sublocation: str | None = None
    category: str | None = None
    place_id: int | None = None


class CensusSource(BaseModel):
    model_config = ConfigDict(extra="allow")
    city: str | None = None
    kind: str | None = None
    state: str | None = None


class ZctaSource(BaseModel):
    model_config = ConfigDict(extra="allow")
    postal_code: str | None = None
    postal_city: str | None = None
    state: str | None = None


class ProbeSources(BaseModel):
    """Each source's own answer for the probed point (None where it has none)."""
    osm: OsmSource | None = None
    census: CensusSource | None = None
    zcta: ZctaSource | None = None
    geonames: ResolvedLocation | None = None


class ProbeResponse(BaseModel):
    lat: float
    lng: float
    location: ResolvedLocation | None = None
    sources: ProbeSources


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    """-> (min_lat, max_lat, min_lng, max_lng), with longitude unwrapped back into
    [-180, 180]. map.getBounds() (Leaflet) returns raw longitudes outside that
    range once the map has been panned all the way around the globe — see
    geometry.normalize_lng_bbox."""
    try:
        min_lng, min_lat, max_lng, max_lat = map(float, bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be minLng,minLat,maxLng,maxLat")
    min_lng, max_lng = normalize_lng_bbox(min_lng, max_lng)
    return min_lat, max_lat, min_lng, max_lng


@router.get("/api/geocode/status")
async def api_geocode_status():
    """Geocoder availability plus how many photos are geocoded vs. pending.
    `available` is GeoNames alone (it gates the GeoNames map layers);
    `any_available` is whether geocoding can run at all (audit G7)."""
    return {
        **geocode.status(),
        "any_available": geocode.any_available(),
        "osm": osm_places.status(),
        "census": census_places.status(),
        "geocoded": index.count_geocoded_photos(),
        "pending": index.count_photos_needing_geocode(),
    }


@router.get("/api/geocode/places", response_model=GeoNamesPlacesResponse)
async def api_geocode_places(bbox: str = Query(...), limit: int = Query(3000, ge=1, le=10000)):
    """GeoNames places within a viewport bbox — backs the Places DB map, which
    plots the raw reverse-geocode reference data (not photos) so the user can
    verify what place names a coordinate would resolve to."""
    min_lat, max_lat, min_lng, max_lng = _parse_bbox(bbox)
    if not geocode.is_available():
        raise HTTPException(503, "GeoNames data not installed — run scripts/get_geonames.py")
    places, total = geocode.cities_in_bbox(min_lat, max_lat, min_lng, max_lng, limit=limit)
    return {"places": places, "total": total, "truncated": total > len(places)}


@router.get("/api/geocode/voronoi", response_model=VoronoiResponse)
async def api_geocode_voronoi(bbox: str = Query(...), limit: int = Query(4000, ge=1, le=8000)):
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


@router.get("/api/geocode/osm-places", response_model=FeatureCollection)
async def api_geocode_osm_places(bbox: str = Query(...), limit: int = Query(4000, ge=1, le=8000),
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


@router.get("/api/geocode/census-places", response_model=FeatureCollection)
async def api_geocode_census_places(bbox: str = Query(...), limit: int = Query(4000, ge=1, le=8000)):
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


@router.get("/api/geocode/zctas", response_model=FeatureCollection)
async def api_geocode_zctas(bbox: str = Query(...), limit: int = Query(4000, ge=1, le=8000)):
    """ZIP code areas overlapping a viewport bbox, as a GeoJSON FeatureCollection —
    backs the Places DB map's ZIP overlay. Each feature carries the ZIP plus its
    crosswalk city, i.e. the mailing city a photo inside it can fall back to.
    503 if the census DB hasn't been built, or was built without the ZCTA layer."""
    min_lat, max_lat, min_lng, max_lng = _parse_bbox(bbox)
    if not census_places.is_available():
        raise HTTPException(503, "Census places DB not built — run scripts/get_census_places.py")
    loop = asyncio.get_running_loop()
    zctas, total = await loop.run_in_executor(
        get_executor(), census_places.zctas_in_bbox, min_lat, max_lat, min_lng, max_lng, limit
    )
    if not zctas and not total and not census_places.status()["zctas"]:
        raise HTTPException(503, "Census DB has no ZIP areas — rebuild it with "
                                 "scripts/get_census_places.py (without --no-zip-codes)")
    return {
        "type": "FeatureCollection",
        "features": [census_places.zcta_to_geojson_feature(z) for z in zctas],
        "total": total,
        "truncated": total > len(zctas),
    }


def _probe(lat: float, lng: float) -> dict:
    """Blocking half of the point probe: the resolved location plus what each source
    said on its own, so the UI can show *which* of the three produced the city."""
    return {
        "location": geocode.lookup(lat, lng),
        "sources": {
            "osm": osm_places.lookup(lat, lng),
            "census": census_places.lookup(lat, lng),
            "zcta": census_places.postal_lookup(lat, lng),
            "geonames": geocode._raw_lookup(lat, lng),
        },
    }


@router.get("/api/geocode/lookup", response_model=ProbeResponse)
async def api_geocode_lookup(lat: float = Query(...), lng: float = Query(...)):
    """Reverse-geocode a single coordinate exactly as a photo taken there would be —
    returns the {city, sublocation, postal_code, state, county, country, country_code}
    that would be persisted on that photo, plus each source's own answer under
    `sources` (OSM containment, Census place containment, ZCTA/ZIP containment,
    GeoNames nearest-point). Backs the Places
    DB map's click-to-probe: click a point and see what location the geocoder would
    save, and why. 503 only if none of the datasets is installed."""
    if not geocode.any_available():
        raise HTTPException(503, _NO_DATASETS_MSG)
    loop = asyncio.get_running_loop()
    probe = await loop.run_in_executor(get_executor(), _probe, lat, lng)
    return {"lat": lat, "lng": lng, **probe}


@router.post("/api/geocode/backfill", response_model=BackfillResponse)
async def api_geocode_backfill(req: GeocodeBackfillRequest):
    """Reverse-geocode up to `limit` photos that have coordinates but no location.
    Repeat until `remaining` is 0. Returns 503 if no geocoding dataset (OSM, Census
    or GeoNames) is installed."""
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(get_executor(), geocode_service.geocode_pending, max(1, req.limit))
    if not result.get("available"):
        raise HTTPException(503, _NO_DATASETS_MSG)
    return result


class ExportSidecarsResponse(BaseModel):
    processed: int
    written: int
    failed: int
    errors_sample: list[str]
    cursor: int      # pass back as after_id
    remaining: int


class ExportSidecarsRequest(BaseModel):
    # Photos written per call (each is one ExifTool write); repeat until remaining == 0.
    limit: int = Field(200, ge=1, le=2000)
    # The run's cursor: 0 to start, then the previous response's `cursor`.
    after_id: int = Field(0, ge=0)


@router.post("/api/geocode/export-sidecars", response_model=ExportSidecarsResponse)
async def api_geocode_export_sidecars(req: ExportSidecarsRequest | None = None):
    """Write up to `limit` geotagged photos' GPS coordinates (plus resolved place
    names, where available) into their XMP sidecars — only photos whose sidecar
    doesn't already hold their current values. Client loop: pass `after_id` =
    the previous response's `cursor` and repeat until `remaining` is 0. Returns
    {processed, written, failed, errors_sample, cursor, remaining}. A bodyless
    POST runs one default-sized batch from the start."""
    req = req or ExportSidecarsRequest()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_executor(), geocode_service.export_to_sidecars, req.limit, req.after_id)
