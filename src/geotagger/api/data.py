"""Data Management page: status + start/poll endpoints for the GeoNames,
GeoFabrik/OSM and US Census offline dataset downloads. Actual work runs on the shared
executor via services/data_service.py's background jobs; routes just start a
job and report its polled state (no request stays open for the download)."""

from fastapi import APIRouter, HTTPException

from pydantic import BaseModel

from geotagger import index
from geotagger.executor import get_executor
from geotagger.services import data_service

router = APIRouter()


class OsmDownloadRequest(BaseModel):
    regions: list[str]  # composite GeoFabrik region keys, e.g. ["us_texas", "europe_germany"]
    force: bool = False  # discard cached .osm.pbf for these regions and re-download


class ForceRequest(BaseModel):
    force: bool = False  # re-download even if already present on disk


@router.get("/api/data/status")
async def api_data_status():
    return {
        "geonames": data_service.geonames_status(),
        "osm": data_service.osm_status(),
        "census": data_service.census_status(),
        "face_model": data_service.face_model_status(),
    }


@router.get("/api/data/downloads")
async def api_data_downloads(dataset: str | None = None):
    """Download history (dataset_downloads table) — a future update-check
    feature's raw material: url, size, record count, and when, per download."""
    return {"downloads": [dict(r) for r in index.get_dataset_downloads(dataset)]}


@router.post("/api/data/geonames/download")
async def api_data_geonames_download(req: ForceRequest = ForceRequest()):
    started = data_service.start_geonames_download(get_executor(), req.force)
    if not started:
        raise HTTPException(409, "GeoNames download already in progress")
    return {"started": True}


@router.get("/api/data/geonames/download/status")
async def api_data_geonames_download_status():
    return data_service.geonames_job_status()


@router.post("/api/data/osm/download")
async def api_data_osm_download(req: OsmDownloadRequest):
    try:
        started = data_service.start_osm_download(get_executor(), req.regions, req.force)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not started:
        raise HTTPException(409, "OSM download/merge already in progress")
    return {"started": True}


@router.get("/api/data/osm/download/status")
async def api_data_osm_download_status():
    return data_service.osm_job_status()


@router.post("/api/data/census/download")
async def api_data_census_download(req: ForceRequest = ForceRequest()):
    started = data_service.start_census_download(get_executor(), req.force)
    if not started:
        raise HTTPException(409, "Census places download already in progress")
    return {"started": True}


@router.get("/api/data/census/download/status")
async def api_data_census_download_status():
    return data_service.census_job_status()


@router.post("/api/data/face-model/download")
async def api_data_face_model_download(req: ForceRequest = ForceRequest()):
    started = data_service.start_face_model_download(get_executor(), req.force)
    if not started:
        raise HTTPException(409, "Face model download already in progress")
    return {"started": True}


@router.get("/api/data/face-model/download/status")
async def api_data_face_model_download_status():
    return data_service.face_model_job_status()
