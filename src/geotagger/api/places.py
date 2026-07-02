"""Saved places (rectangles/circles) CRUD."""

from fastapi import APIRouter
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
            "created_at": p["created_at"]
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
    bounds: str


@router.patch("/api/places/{place_id}")
async def api_update_place(place_id: int, req: UpdatePlaceRequest):
    """Update a place's bounds."""
    index.update_place(place_id, req.bounds)
    return {"success": True}

