"""Semantic ("describe the photo") search: indexing loop, status, model download, and
"More like this". Text queries themselves go through /api/search's `text` param (see
api/search.py) so they combine with every other filter."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from geotagger import index, serializers
from geotagger.executor import get_executor, get_jobs_executor
from geotagger.services import semantic_service
from geotagger.scan_failures import BatchAborted
from geotagger.services.semantic_service import SemanticUnavailable

router = APIRouter()


class SemanticScanRequest(BaseModel):
    limit: int = Field(32, ge=1, le=1000)
    # Override the consecutive-failure guard for this one batch (see api/faces.py).
    allow_failures: bool = False


class ForceRequest(BaseModel):
    force: bool = False


# ── Indexing ──

@router.post("/api/semantic/scan")
async def api_semantic_scan(req: SemanticScanRequest = SemanticScanRequest()):
    """Embed up to `limit` not-yet-indexed photos. Repeat until `remaining` is 0.
    409 when the model isn't downloaded; 503 (detail {code, message, errors}) when
    the batch aborted without marking the failing photos (see api/faces.py)."""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            get_executor(), semantic_service.scan, req.limit, req.allow_failures)
    except SemanticUnavailable as e:
        raise HTTPException(409, str(e))
    except BatchAborted as e:
        raise HTTPException(503, e.as_detail())


@router.post("/api/semantic/retry-failed")
async def api_semantic_retry_failed():
    """Queue the photos whose file couldn't be read (stored as a NULL vector) for
    indexing again."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(get_executor(), semantic_service.retry_failed)


@router.get("/api/semantic/status")
async def api_semantic_status():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(get_executor(), semantic_service.status)


# ── Model download (Data Management page) ──

@router.get("/api/data/semantic-model")
async def api_data_semantic_model():
    return semantic_service.model_status()


@router.post("/api/data/semantic-model/download")
async def api_data_semantic_model_download(req: ForceRequest = ForceRequest()):
    if not semantic_service.start_model_download(get_jobs_executor(), req.force):
        raise HTTPException(409, "Text search model download already in progress")
    return {"started": True}


@router.get("/api/data/semantic-model/download/status")
async def api_data_semantic_model_download_status():
    return semantic_service.model_job_status()


# ── More like this ──

@router.get("/api/photos/{photo_id}/similar")
async def api_photo_similar(photo_id: int, limit: int = Query(60, ge=1, le=2000)):
    """Photos visually similar to `photo_id`, best first, each with a `score`."""
    if not index.get_photo(photo_id):
        raise HTTPException(404, "Photo not found")
    loop = asyncio.get_running_loop()
    try:
        hits = await loop.run_in_executor(get_executor(), semantic_service.similar_to, photo_id, None)
    except ValueError as e:
        raise HTTPException(400, str(e))
    hits = hits[:limit]
    rows = {r["id"]: r for r in index.get_photos(ids=[pid for pid, _ in hits])}
    photos = []
    for pid, score in hits:
        if pid in rows:
            d = serializers.photo_to_dict(rows[pid])
            d["score"] = round(score, 3)
            photos.append(d)
    return {"photos": photos, "total": len(photos)}
