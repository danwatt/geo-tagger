"""Flexible multi-criteria photo search: date range, location, and people
(including "photos with two+ people together")."""

import asyncio

from fastapi import APIRouter, HTTPException, Query

from geotagger import index, serializers
from geotagger.executor import get_executor
from geotagger.services import faces_service

router = APIRouter()


def _parse_person_ids(person_ids: str) -> list[int]:
    try:
        return [int(x) for x in person_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(400, "person_ids must be a comma-separated list of integers")


@router.get("/api/search")
async def api_search(
    date_from: str | None = Query(None, description="YYYY-MM-DD, inclusive"),
    date_to: str | None = Query(None, description="YYYY-MM-DD, inclusive"),
    bbox: str | None = Query(None, description="minLng,minLat,maxLng,maxLat"),
    location: str | None = Query(None, description="Free-text match against city/sublocation/state/county/country"),
    person_ids: str | None = Query(None, description="Comma-separated person ids"),
    person_mode: str = Query("all", pattern="^(all|any)$",
                             description="'all' = every listed person appears together; 'any' = at least one"),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    limit: int = Query(2000, ge=1, le=20000),
):
    """Search photos by any combination of date range, location, and people.
    All supplied criteria combine with AND; person_mode controls whether
    multiple people must appear in the *same* photo ('all') or any one of
    them does ('any')."""
    pids: list[int] | None = _parse_person_ids(person_ids) if person_ids else None

    rows = index.search_photos(
        date_from=date_from, date_to=date_to, bbox=bbox, location=location,
        person_ids=pids, person_mode=person_mode, geotagged=geotagged, limit=limit,
    )
    return {"photos": [serializers.photo_to_dict(r) for r in rows], "total": len(rows)}


@router.get("/api/search/untagged-faces")
async def api_search_untagged_faces(
    person_ids: str = Query(...),
    date_from: str | None = Query(None), date_to: str | None = Query(None),
    bbox: str | None = Query(None), location: str | None = Query(None),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    threshold: float | None = Query(None, ge=0.0, le=1.0),
    limit: int = Query(500, ge=1, le=5000),
):
    """Photos where the searched people appear via an untagged near-match face —
    the inverse of /api/search, which only ever finds already-tagged people."""
    pids = _parse_person_ids(person_ids)
    if not pids:
        raise HTTPException(400, "person_ids is required")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        get_executor(),
        faces_service.find_untagged_face_photos,
        pids, date_from, date_to, bbox, location, geotagged, threshold, limit,
    )
    return result
