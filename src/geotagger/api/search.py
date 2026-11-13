"""Flexible multi-criteria photo search: date range, location, and people
(including "photos with two+ people together")."""

import asyncio

from fastapi import APIRouter, HTTPException, Query

from geotagger import index, serializers
from geotagger.search_locations import parse_fields, suggestions
from geotagger.executor import get_executor
from geotagger.services import faces_service, semantic_service
from geotagger.services.semantic_service import SemanticUnavailable

router = APIRouter()


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


@router.get("/api/search/locations")
async def api_search_locations(q: str = Query("", max_length=200)):
    return {"locations": suggestions(index.get_db(), q)}


@router.get("/api/search/cameras")
async def api_search_cameras():
    return {"cameras": index.get_distinct_cameras()}


def _parse_person_ids(person_ids: str) -> list[int]:
    try:
        return [int(x) for x in person_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(400, "person_ids must be a comma-separated list of integers")


@router.get("/api/search")
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
    limit: int = Query(2000, ge=1, le=20000),
):
    """Search photos by any combination of date range, location, people, camera,
    folder, GPS accuracy, and whether a face was detected. All supplied criteria
    combine with AND; person_mode controls whether multiple people must appear in
    the *same* photo ('all') or any one of them does ('any').

    With `text` (or `similar_to`), the other filters pick the candidate set and the
    semantic model ranks it: results below the score threshold are dropped and each
    photo carries a `score`."""
    _validate_location(place_id, location_fields, nearby_m)
    pids: list[int] | None = _parse_person_ids(person_ids) if person_ids else None
    text = (text or "").strip() or None
    if text and similar_to:
        raise HTTPException(400, "Use either text or similar_to, not both")
    ranked = bool(text or similar_to)
    if sort == "relevance" and not ranked:
        raise HTTPException(400, "Relevance sort needs a text description")
    sort = sort or ("relevance" if ranked else "date_asc")

    def run():
        rows = index.search_photos(
            date_from=date_from, date_to=date_to, undated=undated, bbox=bbox, location=location,
            person_ids=pids, person_mode=person_mode, geotagged=geotagged,
            # Ranking needs the whole filtered set: the caller's limit applies after
            # scoring, otherwise a date-ordered cut would drop the best matches.
            limit=20000 if ranked else limit,
            place_id=place_id, nearby_m=nearby_m, location_fields=location_fields,
            camera=camera, dir=dir, has_faces=has_faces, gps_accuracy=gps_accuracy,
            sort="date_asc" if sort == "relevance" else sort,
        )
        if not ranked:
            return [serializers.photo_to_dict(r) for r in rows]
        by_id = {r["id"]: r for r in rows}
        hits = (semantic_service.search_text(text, list(by_id)) if text
                else semantic_service.similar_to(similar_to, list(by_id)))
        if sort != "relevance":
            # Keep the score filter but honour the requested ordering.
            keep = {pid: s for pid, s in hits}
            ordered = [(r["id"], keep[r["id"]]) for r in rows if r["id"] in keep]
        else:
            ordered = hits
        out = []
        for pid, score in ordered[:limit]:
            d = serializers.photo_to_dict(by_id[pid])
            d["score"] = round(score, 3)
            out.append(d)
        return out

    loop = asyncio.get_running_loop()
    try:
        photos = await loop.run_in_executor(get_executor(), run)
    except SemanticUnavailable as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"photos": photos, "total": len(photos)}


@router.get("/api/search/untagged-faces")
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
):
    """Photos where the searched people appear via an untagged near-match face —
    the inverse of /api/search, which only ever finds already-tagged people."""
    _validate_location(place_id, location_fields, nearby_m)
    pids = _parse_person_ids(person_ids)
    if not pids:
        raise HTTPException(400, "person_ids is required")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        get_executor(),
        faces_service.find_untagged_face_photos,
        pids, date_from, date_to, bbox, location, geotagged, threshold, limit,
        place_id, nearby_m, location_fields,
    )
    return result
