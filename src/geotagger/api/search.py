"""Flexible multi-criteria photo search: date range, location, and people
(including "photos with two+ people together")."""

from fastapi import APIRouter, HTTPException, Query

from geotagger import index, serializers

router = APIRouter()


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
    pids: list[int] | None = None
    if person_ids:
        try:
            pids = [int(x) for x in person_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "person_ids must be a comma-separated list of integers")

    rows = index.search_photos(
        date_from=date_from, date_to=date_to, bbox=bbox, location=location,
        person_ids=pids, person_mode=person_mode, geotagged=geotagged, limit=limit,
    )
    return {"photos": [serializers.photo_to_dict(r) for r in rows], "total": len(rows)}
