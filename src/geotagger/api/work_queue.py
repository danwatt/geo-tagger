"""The work queue: untagged photos ranked as batches, each one decision.

Read-only — nothing here writes. The batch id embeds a camera name or a
directory path, so the `next`/`batch` routes take it as `{id:path}` and the
client URL-encodes it.
"""

import asyncio

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from geotagger.executor import get_executor
from geotagger.services import work_queue_service

router = APIRouter()


# ── Response models (Home's generated types; Geocode reads more of each batch,
# so extra fields pass through) ──

class Proposal(BaseModel):
    model_config = ConfigDict(extra="allow")
    lat: float
    lng: float
    label: str


class Batch(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    kind: Literal["session", "folder"]
    title: str
    count: int
    start_ts: int | None
    end_ts: int | None
    sample_photo_ids: list[int]
    confidence: float        # share of members with a time-neighbour vote, 0..1
    proposal: Proposal | None


class WorkQueueResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    batches: list[Batch]
    total_batches: int
    batched_photos: int      # photos the listed batches cover (a union)
    total_photos: int
    tail_photos: int         # untagged photos in batches too small to list


@router.get("/api/work-queue", response_model=WorkQueueResponse)
async def api_work_queue(
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    kind: str = Query("all", pattern="^(all|session|folder)$"),
    min_size: int | None = Query(None, ge=1),
):
    """One page of the ranked queue, plus the totals Home shows above it."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_executor(), work_queue_service.get_queue, limit, offset, kind, min_size)


@router.get("/api/work-queue/next")
async def api_work_queue_next(
    skip: str = Query("", description="comma-separated batch ids to pass over"),
    kind: str = Query("all", pattern="^(all|session|folder)$"),
    min_size: int | None = Query(None, ge=1),
):
    """The first batch the client hasn't skipped. 404 when the queue is empty."""
    skipped = [s for s in skip.split(",") if s]
    loop = asyncio.get_running_loop()
    batch = await loop.run_in_executor(
        get_executor(), work_queue_service.get_next, skipped, kind, min_size)
    if batch is None:
        raise HTTPException(404, "No batches left")
    return batch


# Registered after /next so the literal path wins — {id:path} would otherwise
# swallow it.
@router.get("/api/work-queue/batch/{batch_id:path}")
async def api_work_queue_batch(batch_id: str, min_size: int | None = Query(None, ge=1)):
    """One batch plus the ids of its still-untagged members. 404 once it's done."""
    loop = asyncio.get_running_loop()
    batch = await loop.run_in_executor(
        get_executor(), work_queue_service.get_batch, batch_id, min_size)
    if batch is None:
        raise HTTPException(404, "Batch no longer exists")
    return batch
