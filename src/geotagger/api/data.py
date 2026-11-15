"""Data Management page: status + start/poll endpoints for the GeoNames,
GeoFabrik/OSM and US Census offline dataset downloads. Actual work runs on the
background-jobs executor (executor.get_jobs_executor, not the request executor —
audit A7) via services/data_service.py's jobs; routes just start a
job and report its polled state (no request stays open for the download)."""

import asyncio
import json
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from pydantic import BaseModel, Field

from geotagger import config, index
from geotagger.executor import get_executor, get_jobs_executor
from geotagger.geometry import normalize_lng_bbox
from geotagger.services import backup_service, data_service, semantic_service, streets_service

router = APIRouter()


class OsmDownloadRequest(BaseModel):
    regions: list[str]  # composite GeoFabrik region keys, e.g. ["us_texas", "europe_germany"]
    force: bool = False  # discard cached .osm.pbf for these regions and re-download


class ForceRequest(BaseModel):
    force: bool = False  # re-download even if already present on disk


class StreetSearchRequest(BaseModel):
    bbox: str            # "minLng,minLat,maxLng,maxLat" — the map viewport
    query: str           # case-insensitive substring of a street's name or ref
    limit: int | None = Field(None, ge=1, le=100_000)
    include_paths: bool = False  # also match footway/path/cycleway/track


@router.get("/api/data/status")
async def api_data_status():
    return {
        "geonames": data_service.geonames_status(),
        "osm": data_service.osm_status(),
        "census": data_service.census_status(),
        "face_model": data_service.face_model_status(),
        "semantic_model": semantic_service.model_status(),
    }


@router.get("/api/data/downloads")
async def api_data_downloads(dataset: str | None = None):
    """Download history (dataset_downloads table) — a future update-check
    feature's raw material: url, size, record count, and when, per download."""
    return {"downloads": [dict(r) for r in index.get_dataset_downloads(dataset)]}


@router.post("/api/data/geonames/download")
async def api_data_geonames_download(req: ForceRequest = ForceRequest()):
    started = data_service.start_geonames_download(get_jobs_executor(), req.force)
    if not started:
        raise HTTPException(409, "GeoNames download already in progress")
    return {"started": True}


@router.get("/api/data/geonames/download/status")
async def api_data_geonames_download_status():
    return data_service.geonames_job_status()


@router.post("/api/data/osm/download")
async def api_data_osm_download(req: OsmDownloadRequest):
    try:
        started = data_service.start_osm_download(get_jobs_executor(), req.regions, req.force)
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
    started = data_service.start_census_download(get_jobs_executor(), req.force)
    if not started:
        raise HTTPException(409, "Census places download already in progress")
    return {"started": True}


@router.get("/api/data/census/download/status")
async def api_data_census_download_status():
    return data_service.census_job_status()


# ── Street search (reads the cached .osm.pbf extracts directly, no DB) ──

@router.get("/api/data/streets/status")
async def api_data_streets_status():
    """Which raw GeoFabrik extracts are still cached — the street search only works
    while they are, since nothing about streets is ingested into a database."""
    return streets_service.streets_status()


@router.post("/api/data/streets/search")
async def api_data_streets_search(req: StreetSearchRequest):
    try:
        min_lng, min_lat, max_lng, max_lat = map(float, req.bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be minLng,minLat,maxLng,maxLat")
    # Leaflet returns unwrapped longitudes once the map has been panned around the
    # globe — see geometry.normalize_lng_bbox.
    min_lng, max_lng = normalize_lng_bbox(min_lng, max_lng)
    try:
        started = streets_service.start_search(
            get_jobs_executor(), min_lat, max_lat, min_lng, max_lng,
            req.query, req.limit, req.include_paths,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not started:
        raise HTTPException(409, "A street search is already running")
    return {"started": True}


@router.get("/api/data/streets/search/status")
async def api_data_streets_search_status():
    return streets_service.search_job_status()


@router.post("/api/data/face-model/download")
async def api_data_face_model_download(req: ForceRequest = ForceRequest()):
    started = data_service.start_face_model_download(get_jobs_executor(), req.force)
    if not started:
        raise HTTPException(409, "Face model download already in progress")
    return {"started": True}


@router.get("/api/data/face-model/download/status")
async def api_data_face_model_download_status():
    return data_service.face_model_job_status()


# ── Backup (user data export) ──

@router.get("/api/data/backup")
async def api_data_backup():
    """Download a compact JSON backup of the user-authored data (places,
    people/families, face labels, settings) — see backup_service for exactly
    what's included/excluded and why."""
    loop = asyncio.get_running_loop()
    backup = await loop.run_in_executor(get_executor(), backup_service.build_backup)
    body = json.dumps(backup, indent=2).encode("utf-8")
    filename = f"geotagger-backup-{time.strftime('%Y%m%d-%H%M%S')}.json"
    return Response(
        content=body, media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _read_capped_body(request: Request, max_bytes: int) -> bytes:
    """The raw request body, refusing (413) past ``max_bytes`` — checked against
    Content-Length up front and again while streaming, since the header may be
    absent (chunked upload) or wrong."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(413, f"Backup larger than {max_bytes // 2**20} MB "
                                 "(GEOTAGGER_BACKUP_RESTORE_MAX_MB)")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(413, f"Backup larger than {max_bytes // 2**20} MB "
                                     "(GEOTAGGER_BACKUP_RESTORE_MAX_MB)")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/api/data/backup/restore")
async def api_data_backup_restore(request: Request, dry_run: bool = True,
                                  overwrite: bool = False):
    """Re-attach a backup (the JSON /api/data/backup downloads, as the raw request
    body) to the current library. dry_run defaults to TRUE so a stray call changes
    nothing: it returns the same report the real run would. Additive only;
    conflicting values are skipped unless overwrite=true. See
    backup_service.restore_backup."""
    try:
        body = await _read_capped_body(request, config.BACKUP_RESTORE_MAX_MB * 2**20)
        if not body:
            raise HTTPException(400, "Empty body: POST the backup JSON file")
        loop = asyncio.get_running_loop()
        # Parsing a large backup is CPU work too, so it rides the executor with the restore.
        return await loop.run_in_executor(get_executor(), lambda: backup_service.restore_backup(
            backup_service.parse_backup(body), dry_run=dry_run, overwrite=overwrite))
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))
