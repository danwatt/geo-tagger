"""Flexible multi-criteria photo search: date range, location, and people
(including "photos with two+ people together")."""

import asyncio
import functools

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from geotagger import config, index
from geotagger.search_locations import parse_fields, suggestions
from geotagger.executor import get_executor
from geotagger.services import faces_service, search_service
from geotagger.services.semantic_service import SemanticUnavailable

router = APIRouter()


# ── Response models (the Search page's generated TypeScript types) ──

class PhotoPlace(BaseModel):
    city: str | None = None
    sublocation: str | None = None
    state: str | None = None
    country: str | None = None


class SearchPhoto(BaseModel):
    """serializers.photo_to_dict, plus `score` on ranked (text / similar_to)
    results. extra="allow": other legacy pages read this shape too."""
    model_config = ConfigDict(extra="allow")
    id: int
    filename: str
    media_type: str | None = None
    lat: float | None = None
    lng: float | None = None
    geotag_source: str | None = None
    camera: str | None = None
    photo_datetime: int | None = None
    gps_accuracy: float | None = None
    geocode_ignored: bool = False
    date_precision: str | None = None
    dir: str | None = None
    location: PhotoPlace | None = None
    score: float | None = None


class SearchHistogram(BaseModel):
    """search_service.timeline_histogram: bucket i starts at min + i * bucket_secs."""
    min: int
    max: int
    bucket_secs: int
    counts: list[int]


class SearchPage(BaseModel):
    photos: list[SearchPhoto]
    total: int
    offset: int
    limit: int
    next_offset: int | None = None
    truncated: bool
    histogram: SearchHistogram | None = None


class SearchIds(BaseModel):
    """ids_only=true: every match, unpaged, in result order."""
    ids: list[int]
    datetimes: list[int | None]
    total: int


class LocationSuggestion(BaseModel):
    """search_locations.suggestions: a saved place (id) or a photo-metadata
    location (fields/count/level). bounds = [south, west, north, east]."""
    model_config = ConfigDict(extra="allow")
    kind: Literal["place", "metadata"]
    label: str
    id: int | None = None
    fields: dict[str, str] | None = None
    count: int | None = None
    level: str | None = None
    bounds: list[float] | None = None


class LocationsResponse(BaseModel):
    locations: list[LocationSuggestion]


class CamerasResponse(BaseModel):
    cameras: list[str]


def _validate_location(place_id, location_fields, nearby_m):
    try:
        parse_fields(location_fields)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid location selection")
    if place_id is not None and not index.get_db().execute(
        "SELECT 1 FROM places WHERE id = ?", (place_id,)
    ).fetchone():
        raise HTTPException(404, "Saved place no longer exists; choose another location")
    if nearby_m and place_id is None:
        raise HTTPException(400, "Nearby distance requires a saved place")


@router.get("/api/search/locations", response_model=LocationsResponse)
async def api_search_locations(q: str = Query("", max_length=200)):
    return {"locations": suggestions(index.get_db(), q)}


@router.get("/api/search/cameras", response_model=CamerasResponse)
async def api_search_cameras():
    return {"cameras": index.get_distinct_cameras()}


def _parse_person_ids(person_ids: str) -> list[int]:
    try:
        return [int(x) for x in person_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(400, "person_ids must be a comma-separated list of integers")


# exclude_unset: a plain search's photos carry no `score` key at all (only ranked
# results do), as before the model existed.
@router.get("/api/search", response_model=SearchPage | SearchIds, response_model_exclude_unset=True)
async def api_search(
    date_from: str | None = Query(None, description="YYYY-MM-DD, inclusive"),
    date_to: str | None = Query(None, description="YYYY-MM-DD, inclusive"),
    undated: bool = Query(False, description="Only photos with no timestamp at all; "
                          "mutually exclusive with date_from/date_to"),
    bbox: str | None = Query(None, description="minLng,minLat,maxLng,maxLat"),
    location: str | None = Query(None, description="Free-text match against city/sublocation/state/county/country"),
    person_ids: str | None = Query(None, description="Comma-separated person ids"),
    place_id: int | None = Query(None, ge=1),
    nearby_m: float = Query(0, ge=0, le=100000),
    location_fields: str | None = Query(None),
    person_mode: str = Query("all", pattern="^(all|any)$",
                             description="'all' = every listed person appears together; 'any' = at least one"),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    camera: str | None = Query(None),
    dir: str | None = Query(None, description="exact directory match (folder facet)"),
    has_faces: str = Query("all", pattern="^(all|yes|no)$"),
    gps_accuracy: str = Query("all", pattern="^(all|precise|imprecise)$"),
    sort: str | None = Query(None, pattern="^(date_asc|date_desc|filename|camera|relevance)$",
                             description="default: relevance with text/similar_to, else date_asc"),
    text: str | None = Query(None, max_length=300,
                             description="Describe the photo; ranks results by visual similarity"),
    similar_to: int | None = Query(None, ge=1, description="Photo id; ranks by similarity to it"),
    limit: int | None = Query(None, ge=1, le=20000,
                              description="page size; default config.SEARCH_PAGE_SIZE"),
    offset: int = Query(0, ge=0, le=10_000_000, description="first match to return"),
    ids_only: bool = Query(False, description="every match's id + photo_datetime, "
                           "unpaged, instead of a page of photos"),
):
    """Search photos by any combination of date range, location, people, camera,
    folder, GPS accuracy, and whether a face was detected. All supplied criteria
    combine with AND; person_mode controls whether multiple people must appear in
    the *same* photo ('all') or any one of them does ('any').

    With `text` (or `similar_to`), the other filters pick the candidate set and the
    semantic model ranks it: results below the score threshold are dropped and each
    photo carries a `score`.

    Paged: `offset`/`limit` slice a stable ordering. `total` is the true match
    count, `truncated` says this page holds fewer than all of them, `next_offset`
    (null on the last page) is where "Load more" continues, and `histogram` buckets
    the whole result set for the timeline. `ids_only=true` returns
    {ids, datetimes, total} for every match instead (Select all across pages)."""
    _validate_location(place_id, location_fields, nearby_m)
    pids: list[int] | None = _parse_person_ids(person_ids) if person_ids else None
    text = (text or "").strip() or None
    if text and similar_to:
        raise HTTPException(400, "Use either text or similar_to, not both")
    ranked = bool(text or similar_to)
    if sort == "relevance" and not ranked:
        raise HTTPException(400, "Relevance sort needs a text description")
    sort = sort or ("relevance" if ranked else "date_asc")
    filters = dict(
        date_from=date_from, date_to=date_to, undated=undated, bbox=bbox, location=location,
        person_ids=pids, person_mode=person_mode, geotagged=geotagged,
        place_id=place_id, nearby_m=nearby_m, location_fields=location_fields,
        camera=camera, dir=dir, has_faces=has_faces, gps_accuracy=gps_accuracy,
    )
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(get_executor(), functools.partial(
            search_service.run_search, filters, sort=sort, text=text, similar_to=similar_to,
            limit=limit or config.SEARCH_PAGE_SIZE, offset=offset, ids_only=ids_only))
    except SemanticUnavailable as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


class TaggedFace(BaseModel):
    person_id: int
    person_name: str | None = None
    face_id: int


class ProposedFace(BaseModel):
    person_id: int
    person_name: str | None = None
    face_id: int
    score: float
    bbox: list[float] | None = None


class UntaggedCandidate(BaseModel):
    photo: SearchPhoto
    tagged: list[TaggedFace]
    proposed: list[ProposedFace]


class UntaggedFacesResponse(BaseModel):
    mode: Literal["single", "together"]
    threshold: float
    total: int
    candidates: list[UntaggedCandidate]
    offset: int
    limit: int
    next_offset: int | None = None
    truncated: bool
    warnings: list[str] = []


@router.get("/api/search/untagged-faces", response_model=UntaggedFacesResponse,
            response_model_exclude_unset=True)
async def api_search_untagged_faces(
    person_ids: str = Query(...),
    date_from: str | None = Query(None), date_to: str | None = Query(None),
    bbox: str | None = Query(None), location: str | None = Query(None),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    threshold: float | None = Query(None, ge=0.0, le=1.0),
    place_id: int | None = Query(None, ge=1),
    nearby_m: float = Query(0, ge=0, le=100000),
    location_fields: str | None = Query(None),
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0, le=10_000_000),
):
    """Photos where the searched people appear via an untagged near-match face —
    the inverse of /api/search, which only ever finds already-tagged people.
    Paged like /api/search: `total` counts every candidate, `offset`/`next_offset`
    walk them best-first, `truncated` flags a partial response."""
    _validate_location(place_id, location_fields, nearby_m)
    pids = _parse_person_ids(person_ids)
    if not pids:
        raise HTTPException(400, "person_ids is required")
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            get_executor(),
            faces_service.find_untagged_face_photos,
            pids, date_from, date_to, bbox, location, geotagged, threshold, limit,
            place_id, nearby_m, location_fields, offset,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return result
