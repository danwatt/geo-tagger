"""Saved places (rectangles/circles) CRUD."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, field_validator

from geotagger import index
from geotagger.executor import get_executor
from geotagger.place_bounds import PlaceType, bounds_valid, validate_bounds

router = APIRouter()


def _clean_name(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise ValueError("name must not be blank")
    return v


class CreatePlaceRequest(BaseModel):
    name: str
    type: PlaceType
    # A JSON *string* (what the page has always sent): {"lat","lng","radius"} for a
    # circle, {"south","west","north","east"} for a rectangle. Checked against the
    # shape models in place_bounds — in the route, since PATCH needs the stored type.
    bounds: str

    _name = field_validator("name")(_clean_name)


def _checked_bounds(kind: str, raw: str) -> str:
    try:
        return validate_bounds(kind, raw)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/api/places")
async def api_get_places(
    stats: bool = Query(False, description="include photo_count and last_ts per place"),
):
    """Get all saved places.

    `stats` is opt-in because it costs a spatial query per place: the Custom
    Places sidebar wants the counts, the geocode page's jump-target dropdown
    doesn't and shouldn't pay for them.
    """
    places = index.get_places()
    per_place = {}
    if stats:
        loop = asyncio.get_running_loop()
        per_place = await loop.run_in_executor(get_executor(), index.get_place_stats)

    return [
        {
            "id": p["id"],
            "name": p["name"],
            "type": p["type"],
            "bounds": p["bounds"],
            # False for a legacy/hand-edited row whose bounds don't parse: every
            # spatial read treats it as matching nothing, and the page lists it as
            # broken (deletable, redrawable) instead of failing to draw the map.
            "bounds_valid": bounds_valid(p["type"], p["bounds"]),
            "created_at": p["created_at"],
            "representative_photo_id": p["representative_photo_id"],
            **per_place.get(p["id"], {}),
        }
        for p in places
    ]


@router.post("/api/places")
async def api_create_place(req: CreatePlaceRequest):
    """Create a new place. 400 when the bounds don't describe a valid shape."""
    bounds = _checked_bounds(req.type, req.bounds)
    place_id = index.create_place(req.name, req.type, bounds)
    return {"ok": True, "id": place_id, "name": req.name, "type": req.type, "bounds": bounds}


@router.delete("/api/places/{place_id}")
async def api_delete_place(place_id: int):
    """Delete a place."""
    if not index.delete_place(place_id):
        raise HTTPException(404, "Place not found")
    # "success": legacy alias of "ok" (the A12 mutation convention), kept for scripts.
    return {"ok": True, "id": place_id, "success": True}


class UpdatePlaceRequest(BaseModel):
    bounds: str | None = None
    name: str | None = None

    _name = field_validator("name")(_clean_name)


@router.patch("/api/places/{place_id}")
async def api_update_place(place_id: int, req: UpdatePlaceRequest):
    """Update a place's bounds and/or name. New bounds are validated against the
    place's stored type (the type itself isn't editable)."""
    place = index.get_place(place_id)
    if place is None:
        raise HTTPException(404, "Place not found")
    bounds = _checked_bounds(place["type"], req.bounds) if req.bounds is not None else None
    if not index.update_place(place_id, bounds=bounds, name=req.name):
        raise HTTPException(404, "Place not found")   # deleted in between
    return {"ok": True, "id": place_id, "success": True,
            "bounds": bounds if bounds is not None else place["bounds"]}


class SetRepresentativeRequest(BaseModel):
    photo_id: int | None = None  # None clears the representative


@router.put("/api/places/{place_id}/representative")
async def api_set_place_representative(place_id: int, req: SetRepresentativeRequest):
    """Set (or clear) a place's representative photo — a plain FK to photos.id."""
    if req.photo_id is not None and index.get_photo(req.photo_id) is None:
        raise HTTPException(404, "Photo not found")
    if not index.set_place_representative(place_id, req.photo_id):
        raise HTTPException(404, "Place not found")
    return {"ok": True, "id": place_id, "success": True,
            "representative_photo_id": req.photo_id}

