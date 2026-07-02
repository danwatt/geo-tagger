"""Life Contexts CRUD (time/place polygons used for guessing + filtering)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geotagger import index, contexts, serializers

router = APIRouter()


class CreateContextRequest(BaseModel):
    name: str
    polygon: list[list[float]]      # [[lat, lng], ...]
    start_date: str | None = None   # ISO YYYY-MM-DD, optional
    end_date: str | None = None
    person_ids: list[int] | None = None

class UpdateContextRequest(BaseModel):
    name: str | None = None
    polygon: list[list[float]] | None = None
    start_date: str | None = None
    end_date: str | None = None
    person_ids: list[int] | None = None


def _validate_polygon(polygon: list[list[float]]):
    if len(polygon) < 3:
        raise HTTPException(400, "Polygon must have at least 3 vertices")
    for pt in polygon:
        if len(pt) != 2:
            raise HTTPException(400, "Each polygon point must be [lat, lng]")
        lat = pt[0]
        pt[1] = contexts.normalize_lng(pt[1])
        if not (-90 <= lat <= 90):
            raise HTTPException(400, f"Latitude {lat} out of range -90..90")

@router.get("/api/contexts")
async def api_get_contexts():
    contexts = index.get_contexts()
    result = []
    for c in contexts:
        persons = index.get_context_persons(c["id"])
        result.append(serializers.context_row_to_dict(c, persons))
    return result


@router.post("/api/contexts")
async def api_create_context(req: CreateContextRequest):
    import json as _json
    from datetime import datetime as _dt
    _validate_polygon(req.polygon)
    start_ts = end_ts = None
    if req.start_date:
        try:
            start_ts = contexts.date_to_ts_start(req.start_date)
        except ValueError:
            raise HTTPException(400, "start_date must be YYYY-MM-DD")
    if req.end_date:
        try:
            end_ts = contexts.date_to_ts_end(req.end_date)
        except ValueError:
            raise HTTPException(400, "end_date must be YYYY-MM-DD")
    if start_ts is not None and end_ts is not None and start_ts > end_ts:
        raise HTTPException(400, "start_date must be <= end_date")
    from geotagger.contexts import polygon_bbox
    min_lat, max_lat, min_lng, max_lng = polygon_bbox(req.polygon)
    context_id = index.create_context(
        req.name.strip(), _json.dumps(req.polygon),
        start_ts, end_ts, min_lat, max_lat, min_lng, max_lng
    )
    if req.person_ids:
        index.set_context_persons(context_id, req.person_ids)
    c = index.get_context(context_id)
    persons = index.get_context_persons(context_id)
    return serializers.context_row_to_dict(c, persons)


@router.patch("/api/contexts/{context_id}")
async def api_update_context(context_id: int, req: UpdateContextRequest):
    import json as _json
    c = index.get_context(context_id)
    if not c:
        raise HTTPException(404, "Context not found")
    fields = req.model_fields_set
    updates: dict = {}
    if "name" in fields:
        name = (req.name or "").strip()
        if not name:
            raise HTTPException(400, "Name cannot be empty")
        updates["name"] = name
    if "polygon" in fields and req.polygon is not None:
        _validate_polygon(req.polygon)
        from geotagger.contexts import polygon_bbox
        min_lat, max_lat, min_lng, max_lng = polygon_bbox(req.polygon)
        updates["polygon"] = _json.dumps(req.polygon)
        updates["min_lat"] = min_lat
        updates["max_lat"] = max_lat
        updates["min_lng"] = min_lng
        updates["max_lng"] = max_lng
    if "start_date" in fields:
        if req.start_date:
            try:
                updates["start_ts"] = contexts.date_to_ts_start(req.start_date)
            except ValueError:
                raise HTTPException(400, "start_date must be YYYY-MM-DD")
        else:
            updates["start_ts"] = None
    if "end_date" in fields:
        if req.end_date:
            try:
                updates["end_ts"] = contexts.date_to_ts_end(req.end_date)
            except ValueError:
                raise HTTPException(400, "end_date must be YYYY-MM-DD")
        else:
            updates["end_ts"] = None
    # Validate start <= end using merged values
    new_start = updates.get("start_ts", c["start_ts"])
    new_end = updates.get("end_ts", c["end_ts"])
    if new_start is not None and new_end is not None and new_start > new_end:
        raise HTTPException(400, "start_date must be <= end_date")
    if updates:
        index.update_context(context_id, **updates)
    if "person_ids" in fields:
        index.set_context_persons(context_id, req.person_ids or [])
    c = index.get_context(context_id)
    persons = index.get_context_persons(context_id)
    return serializers.context_row_to_dict(c, persons)


@router.delete("/api/contexts/{context_id}")
async def api_delete_context(context_id: int):
    index.delete_context(context_id)
    return {"success": True}

