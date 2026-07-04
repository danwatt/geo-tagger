"""Photo listing/filtering, area search, thumbnail/preview/detail, and batch
timestamp correction."""

import asyncio
import logging
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from geotagger import index, thumbnails, serializers
from geotagger.executor import get_executor
from geotagger.services import photos_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/photos")
async def api_photos(
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    bbox: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    context_id: int | None = Query(None),
):
    """Get photos, optionally filtered by date range or Life Context.

    When context_id is supplied all other filtering is handled here:
      - Geotagged photos: R*Tree bbox prefilter in SQL, then exact point-in-polygon
        in Python.  Date range is also pushed into the SQL when the context has one.
      - Untagged photos: included only when the context has a date range (otherwise
        the entire untagged library would match with no constraint).
      - No-date contexts: only geotagged photos inside the polygon are returned.
    """
    if context_id is not None:
        import json as _json
        from geotagger.contexts import point_in_polygon

        ctx = index.get_context(context_id)
        if ctx is None:
            raise HTTPException(404, "Context not found")

        verts        = _json.loads(ctx["polygon"])
        min_lat      = ctx["min_lat"]
        max_lat      = ctx["max_lat"]
        min_lng      = ctx["min_lng"]
        max_lng      = ctx["max_lng"]
        start_ts     = ctx["start_ts"]
        end_ts       = ctx["end_ts"]
        has_bbox     = min_lat is not None
        has_dates    = start_ts is not None or end_ts is not None

        db = index.get_db()
        rows: list = []

        # ── Geotagged photos ──────────────────────────────────────────────────
        # Use the R*Tree spatial index for the bbox prefilter, then do exact PIP
        # in Python.  Also push the date range into SQL when available.
        if geotagged != "no" and has_bbox:
            # R*Tree stores point data as min==max, so the overlap check reduces
            # to a simple range test on each axis.
            sql = """
                SELECT photos.* FROM photos
                INNER JOIN photos_spatial ON photos.id = photos_spatial.id
                WHERE photos_spatial.max_lat >= ? AND photos_spatial.min_lat <= ?
                  AND photos_spatial.max_lng >= ? AND photos_spatial.min_lng <= ?
            """
            params: list = [min_lat, max_lat, min_lng, max_lng]
            if start_ts is not None:
                sql += " AND photos.photo_datetime >= ?"
                params.append(start_ts)
            if end_ts is not None:
                sql += " AND photos.photo_datetime <= ?"
                params.append(end_ts)
            sql += " ORDER BY photos.photo_datetime, photos.filename"

            candidates = db.execute(sql, params).fetchall()
            # Exact point-in-polygon post-filter
            rows += [r for r in candidates
                     if point_in_polygon(r["lat"], r["lng"], verts)]

        # ── Untagged photos ───────────────────────────────────────────────────
        # Only included when the context has a date range — without one there is
        # no constraint and we would return the entire untagged library.
        if geotagged != "yes" and has_dates:
            u_sql    = "SELECT * FROM photos WHERE lat IS NULL AND geocode_ignored = 0"
            u_params: list = []
            if start_ts is not None:
                u_sql += " AND photo_datetime >= ?"
                u_params.append(start_ts)
            if end_ts is not None:
                u_sql += " AND photo_datetime <= ?"
                u_params.append(end_ts)
            u_sql += " ORDER BY photo_datetime, filename"
            rows += db.execute(u_sql, u_params).fetchall()

        # Sort merged result by time then filename
        rows.sort(key=lambda r: (r["photo_datetime"] or 0, r["filename"]))

    else:
        rows = index.get_photos(
            geotagged=geotagged, bbox=bbox,
            date_from=date_from, date_to=date_to,
        )

    return [serializers.photo_to_dict(r) for r in rows]


@router.get("/api/photos/by-area")
async def api_photos_by_area(
    lat: float = Query(...),
    lng: float = Query(...),
    radius: float = Query(...),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    window: int = Query(900, ge=0),
):
    """Get photos within a circular area, plus nearby non-geotagged photos within the time window."""
    t_start = time.time()
    logger.info(f"Area query: lat={lat}, lng={lng}, radius={radius}m, filter={geotagged}")

    from math import radians, cos, sin, asin, sqrt

    def haversine(lat1, lon1, lat2, lon2):
        """Calculate distance in meters between two points."""
        R = 6371000  # Earth radius in meters
        lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
        c = 2 * asin(sqrt(a))
        return R * c

    # Calculate bounding box for the radius
    t0 = time.time()
    # Approximate: 1 degree latitude ≈ 111km
    lat_offset = radius / 111000.0
    # Longitude varies by latitude
    lng_offset = radius / (111000.0 * cos(radians(lat)))

    min_lat = lat - lat_offset
    max_lat = lat + lat_offset
    min_lng = lng - lng_offset
    max_lng = lng + lng_offset
    logger.info(f"  Bbox calculation: {(time.time() - t0)*1000:.2f}ms")

    # Use spatial index to get candidate photos in bounding box (much faster!)
    t1 = time.time()
    bbox_photos = index.get_photos_in_bbox(min_lat, max_lat, min_lng, max_lng)
    logger.info(f"  Spatial index query: {(time.time() - t1)*1000:.2f}ms, found {len(bbox_photos)} candidates")

    # Filter to exact circle using Haversine
    t2 = time.time()
    photos_in_area = []
    times_in_area = []

    for r in bbox_photos:
        dist = haversine(lat, lng, r["lat"], r["lng"])
        if dist <= radius:
            photos_in_area.append(r)
            if r["photo_datetime"] and r["photo_datetime"] > 0:
                times_in_area.append(r["photo_datetime"])
    logger.info(f"  Haversine filtering: {(time.time() - t2)*1000:.2f}ms, {len(photos_in_area)} in circle")

    # Add non-geotagged photos within 15 minutes of any photo in the area
    if times_in_area:
        import bisect

        t3 = time.time()
        time_window = window

        # Sort times for efficient binary search
        times_sorted = sorted(times_in_area)

        # Query a broader time range to get candidates
        min_time = min(times_in_area) - time_window
        max_time = max(times_in_area) + time_window

        # Efficiently query only photos in the time window that aren't geotagged
        nearby_photos = index.get_photos_by_time_range(min_time, max_time, has_geotag=False)
        logger.info(f"  Time range query: {(time.time() - t3)*1000:.2f}ms, found {len(nearby_photos)} non-geotagged in time window")

        # Check each photo to see if it's within 15min of ANY specific photo in area
        # Use binary search for O(n log m) instead of O(n*m)
        t4 = time.time()
        added = 0
        for r in nearby_photos:
            photo_time = r["photo_datetime"]
            # Find insertion point in sorted times
            idx = bisect.bisect_left(times_sorted, photo_time)

            # Check the time at idx and idx-1 (closest times on either side)
            found = False
            if idx < len(times_sorted) and abs(times_sorted[idx] - photo_time) <= time_window:
                found = True
            elif idx > 0 and abs(times_sorted[idx - 1] - photo_time) <= time_window:
                found = True

            if found:
                photos_in_area.append(r)
                added += 1

        logger.info(f"  Time proximity check (binary search): {(time.time() - t4)*1000:.2f}ms, added {added} photos")

    # Apply geotagged filter
    t5 = time.time()
    before_filter = len(photos_in_area)
    if geotagged == "yes":
        photos_in_area = [r for r in photos_in_area if r["lat"] is not None]
    elif geotagged == "no":
        photos_in_area = [r for r in photos_in_area if r["lat"] is None]
    logger.info(f"  Geotagged filter: {(time.time() - t5)*1000:.2f}ms, {before_filter} -> {len(photos_in_area)}")

    # Sort by time, then filename
    t6 = time.time()
    photos_in_area.sort(key=lambda r: (r["photo_datetime"] or 0, r["filename"]))
    logger.info(f"  Sort: {(time.time() - t6)*1000:.2f}ms")

    # Build response
    t7 = time.time()
    result = [serializers.photo_to_dict(r) for r in photos_in_area]
    logger.info(f"  Response build: {(time.time() - t7)*1000:.2f}ms")
    logger.info(f"TOTAL: {(time.time() - t_start)*1000:.2f}ms, returning {len(result)} photos")

    return result


@router.get("/api/thumbnail/{photo_id}")
async def api_thumbnail(photo_id: int, request: Request):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    etag = f'"{photo_id}-{row["mtime"]}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    try:
        # Run blocking I/O in thread pool
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(
            get_executor(),
            thumbnails.get_thumbnail,
            Path(row["path"]),
            row["mtime"],
            row["size"],
            row["orientation"],
        )
        return Response(content=data, media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=86400", "ETag": etag})
    except Exception as e:
        import traceback
        print(f"Error generating thumbnail for {photo_id} ({row['path']}): {e}")
        traceback.print_exc()
        raise HTTPException(500, str(e))


@router.get("/api/preview/{photo_id}")
async def api_preview(photo_id: int, request: Request):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    etag = f'"{photo_id}-{row["mtime"]}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    try:
        # Run blocking I/O in thread pool
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(
            get_executor(),
            thumbnails.get_preview_oriented,
            Path(row["path"]),
            row["mtime"],
            row["size"],
            row["orientation"],
        )
        return Response(content=data, media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=86400", "ETag": etag})
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/photo/{photo_id}/fullsize")
async def api_fullsize(photo_id: int):
    """On-the-fly full-resolution render with detected face boxes drawn on, as JPEG.

    Powers the detail pane's "View full size" button for RAW files: decodes the RAW
    at full resolution via LibRaw (see thumbnails.render_fullsize_with_faces) and
    draws each face's box + name, so the new tab shows the real pixels — not the
    1600px preview. Heavy (full decode + draw), so it runs in the executor and is not
    disk-cached; boxes reflect current labels, so it must not be cached either.
    """
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    faces = index.get_faces_for_photo(photo_id)
    # Extract plain tuples so no sqlite Row crosses into the worker thread.
    face_specs = [(f["bbox"], f["person_name"], bool(f["ignored"])) for f in faces]
    try:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(
            get_executor(),
            thumbnails.render_fullsize_with_faces,
            Path(row["path"]),
            row["orientation"],
            face_specs,
        )
        return Response(content=data, media_type="image/jpeg",
                        headers={"Cache-Control": "no-store"})
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/photo/{photo_id}")
async def api_photo(photo_id: int):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    # Fetch extra metadata from exiftool in thread pool
    loop = asyncio.get_event_loop()
    extra = await loop.run_in_executor(get_executor(), photos_service.get_photo_metadata, row["path"])

    return {
        "id": row["id"],
        "path": row["path"],
        "filename": row["filename"],
        "media_type": row["media_type"],
        "ext": row["ext"],
        "lat": row["lat"],
        "lng": row["lng"],
        "geotag_source": row["geotag_source"],
        "sidecar_path": row["sidecar_path"],
        "camera": f"{extra.get('EXIF:Make', '')} {extra.get('EXIF:Model', '')}".strip() or None,
        "datetime": extra.get("EXIF:DateTimeOriginal"),
        "dimensions": extra.get("Composite:ImageSize"),
        "gps_accuracy": row["gps_accuracy"] if row["gps_accuracy"] and row["gps_accuracy"] > 0 else None,
        "geocode_ignored": bool(row["geocode_ignored"]),
        "location": {
            "city": row["loc_city"],
            "sublocation": row["loc_sublocation"],
            "state": row["loc_state"],
            "county": row["loc_county"],
            "country": row["loc_country"],
            "country_code": row["loc_country_code"],
        } if row["loc_country_code"] else None,
    }


class UpdateTimesRequest(BaseModel):
    updates: dict[int, int]  # photo_id -> offset in seconds


@router.post("/api/photos/update-times")
async def api_update_times(req: UpdateTimesRequest):
    """Batch update photo timestamps by applying offsets."""
    loop = asyncio.get_running_loop()
    updated = await loop.run_in_executor(get_executor(), photos_service.update_photo_times, req.updates)
    return {"updated": updated}
