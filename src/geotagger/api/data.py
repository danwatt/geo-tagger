"""Data Management page: status + start/poll endpoints for the GeoNames and
GeoFabrik/OSM offline dataset downloads. Actual work runs on the shared
executor via services/data_service.py's background jobs; routes just start a
job and report its polled state (no request stays open for the download)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geotagger.executor import get_executor
from geotagger.services import data_service

router = APIRouter()


class OsmDownloadRequest(BaseModel):
    states: list[str]  # GeoFabrik state slugs, e.g. ["texas", "california"]


@router.get("/api/data/status")
async def api_data_status():
    return {
        "geonames": data_service.geonames_status(),
        "osm": data_service.osm_status(),
    }


@router.post("/api/data/geonames/download")
async def api_data_geonames_download():
    started = data_service.start_geonames_download(get_executor())
    if not started:
        raise HTTPException(409, "GeoNames download already in progress")
    return {"started": True}


@router.get("/api/data/geonames/download/status")
async def api_data_geonames_download_status():
    return data_service.geonames_job_status()


@router.post("/api/data/osm/download")
async def api_data_osm_download(req: OsmDownloadRequest):
    try:
        started = data_service.start_osm_download(get_executor(), req.states)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not started:
        raise HTTPException(409, "OSM download/merge already in progress")
    return {"started": True}


@router.get("/api/data/osm/download/status")
async def api_data_osm_download_status():
    return data_service.osm_job_status()
