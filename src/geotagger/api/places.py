"""Saved places (rectangles/circles) CRUD."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geotagger import index

router = APIRouter()


class CreatePlaceRequest(BaseModel):
    name: str
    type: str  # "rectangle" or "circle"
    bounds: str  # JSON string with bounds data


@router.get("/api/places")
async def api_get_places():
    """Get all saved places."""
    places = index.get_places()
    return [
        {
            "id": p["id"],
            "name": p["name"],
            "type": p["type"],
            "bounds": p["bounds"],
            "created_at": p["created_at"],
            "representative_photo_id": p["representative_photo_id"],
        }
        for p in places
    ]


@router.post("/api/places")
async def api_create_place(req: CreatePlaceRequest):
    """Create a new place."""
    place_id = index.create_place(req.name, req.type, req.bounds)
    return {"id": place_id, "name": req.name, "type": req.type, "bounds": req.bounds}


@router.delete("/api/places/{place_id}")
async def api_delete_place(place_id: int):
    """Delete a place."""
    index.delete_place(place_id)
    return {"success": True}


class UpdatePlaceRequest(BaseModel):
    bounds: str | None = None
    name: str | None = None


@router.patch("/api/places/{place_id}")
async def api_update_place(place_id: int, req: UpdatePlaceRequest):
    """Update a place's bounds and/or name."""
    index.update_place(place_id, bounds=req.bounds, name=req.name)
    return {"success": True}


class SetRepresentativeRequest(BaseModel):
    photo_id: int | None = None  # None clears the representative


@router.put("/api/places/{place_id}/representative")
async def api_set_place_representative(place_id: int, req: SetRepresentativeRequest):
    """Set (or clear) a place's representative photo — a plain FK to photos.id."""
    if req.photo_id is not None and index.get_photo(req.photo_id) is None:
        raise HTTPException(404, "Photo not found")
    index.set_place_representative(place_id, req.photo_id)
    return {"success": True, "representative_photo_id": req.photo_id}

