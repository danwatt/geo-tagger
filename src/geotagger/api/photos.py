"""Photo listing/filtering, area search, thumbnail/preview/detail, and batch
timestamp correction."""

import asyncio
import logging
import time
from io import BytesIO
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
    undated: bool = Query(False),
):
    """Get photos, optionally filtered by date range, Life Context, or (undated=true)
    photos with no timestamp at all — mutually exclusive with date_from/date_to and
    context_id, which are meaningless without a photo_datetime.

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
            date_from=date_from, date_to=date_to, undated=undated,
        )

    return [serializers.photo_to_dict(r) for r in rows]


def _augment_and_filter(photos_in_area: list, geotagged: str, window: int) -> list:
    """Given the geotagged photos already selected for a region, add non-geotagged
    photos taken within `window` seconds of any of them, apply the geotagged
    filter, and return the list sorted by time then filename.

    Shared by the circular (by-area) and rectangular (by-bounds) region queries —
    the only difference between them is how the initial in-region set is built.
    """
    import bisect

    # Timestamps of the geotagged photos in the region, used to pull in
    # temporally-adjacent untagged photos (candidates to inherit a location).
    times_in_area = [r["photo_datetime"] for r in photos_in_area
                     if r["photo_datetime"] and r["photo_datetime"] > 0]

    if times_in_area and window > 0:
        times_sorted = sorted(times_in_area)
        # Broad time-range prefilter in SQL, then exact per-photo proximity check
        # via binary search — O(n log m) instead of O(n*m).
        nearby = index.get_photos_by_time_range(
            times_sorted[0] - window, times_sorted[-1] + window, has_geotag=False)
        for r in nearby:
            pt = r["photo_datetime"]
            idx = bisect.bisect_left(times_sorted, pt)
            if (idx < len(times_sorted) and abs(times_sorted[idx] - pt) <= window) or \
               (idx > 0 and abs(times_sorted[idx - 1] - pt) <= window):
                photos_in_area.append(r)

    if geotagged == "yes":
        photos_in_area = [r for r in photos_in_area if r["lat"] is not None]
    elif geotagged == "no":
        photos_in_area = [r for r in photos_in_area if r["lat"] is None]

    photos_in_area.sort(key=lambda r: (r["photo_datetime"] or 0, r["filename"]))
    return photos_in_area


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
    photos_in_area = [r for r in bbox_photos if haversine(lat, lng, r["lat"], r["lng"]) <= radius]
    logger.info(f"  Haversine filtering: {(time.time() - t2)*1000:.2f}ms, {len(photos_in_area)} in circle")

    # Add temporally-adjacent untagged photos, apply the geotagged filter, and sort.
    photos_in_area = _augment_and_filter(photos_in_area, geotagged, window)

    result = [serializers.photo_to_dict(r) for r in photos_in_area]
    logger.info(f"TOTAL: {(time.time() - t_start)*1000:.2f}ms, returning {len(result)} photos")
    return result


@router.get("/api/photos/by-bounds")
async def api_photos_by_bounds(
    min_lat: float = Query(...),
    max_lat: float = Query(...),
    min_lng: float = Query(...),
    max_lng: float = Query(...),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    window: int = Query(900, ge=0),
):
    """Get photos whose location falls inside a lat/lng bounding box — a saved
    place's bounds, optionally grown by a buffer (the growing is done client-side,
    so this only sees the final box). Like by-area but rectangular: R*Tree bbox
    query for the geotagged photos, then non-geotagged photos taken within `window`
    seconds of any of them are folded in as geotag candidates."""
    t_start = time.time()
    logger.info(f"Bounds query: lat=[{min_lat},{max_lat}], lng=[{min_lng},{max_lng}], filter={geotagged}")

    bbox_photos = list(index.get_photos_in_bbox(min_lat, max_lat, min_lng, max_lng))
    photos_in_area = _augment_and_filter(bbox_photos, geotagged, window)

    result = [serializers.photo_to_dict(r) for r in photos_in_area]
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
            Path(index.photo_path(row)),
            row["mtime"],
            row["size"],
            row["orientation"],
        )
        return Response(content=data, media_type=thumbnails.media_type(),
                        headers={"Cache-Control": "max-age=86400", "ETag": etag})
    except Exception as e:
        import traceback
        print(f"Error generating thumbnail for {photo_id} ({index.photo_path(row)}): {e}")
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
            Path(index.photo_path(row)),
            row["mtime"],
            row["size"],
            row["orientation"],
        )
        return Response(content=data, media_type=thumbnails.media_type(),
                        headers={"Cache-Control": "max-age=86400", "ETag": etag})
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/photo/{photo_id}/fullsize")
async def api_fullsize(photo_id: int):
    """On-the-fly full-resolution render with detected face boxes drawn on, as JPEG.

    Powers the detail pane's "View full size" button for RAW files: decodes the RAW
    at full resolution via LibRaw (see thumbnails.render_fullsize_with_faces) and
    draws each face's box + name, so the new tab shows the real pixels — not the
    downscaled preview. Heavy (full decode + draw), so it runs in the executor and is not
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
            Path(index.photo_path(row)),
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
    extra = await loop.run_in_executor(get_executor(), photos_service.get_photo_metadata, index.photo_path(row))

    return {
        "id": row["id"],
        "path": index.photo_path(row),
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


class DownloadZipRequest(BaseModel):
    photo_ids: list[int]


def _build_zip(photo_ids: list[int]) -> bytes:
    """Zip up the original (full-quality, potentially RAW) files for the given
    photo ids. Runs in the executor — reads whole files off disk. Duplicate
    filenames (e.g. same name in different directories) get a numeric suffix
    so nothing is silently overwritten inside the archive."""
    import zipfile

    buf = BytesIO()
    used_names: dict[str, int] = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for pid in photo_ids:
            row = index.get_photo(pid)
            if not row:
                continue
            src = Path(index.photo_path(row))
            if not src.is_file():
                continue
            name = row["filename"]
            if name in used_names:
                used_names[name] += 1
                stem, ext = Path(name).stem, Path(name).suffix
                name = f"{stem} ({used_names[name]}){ext}"
            else:
                used_names[name] = 0
            zf.write(src, arcname=name)
    return buf.getvalue()


@router.post("/api/photos/download-zip")
async def api_download_zip(req: DownloadZipRequest):
    """Bundle the selected photos' original files (full quality, RAW included
    as-is) into a ZIP archive for download."""
    if not req.photo_ids:
        raise HTTPException(400, "photo_ids must not be empty")
    loop = asyncio.get_running_loop()
    data = await loop.run_in_executor(get_executor(), _build_zip, req.photo_ids)
    return Response(
        content=data, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="photos-{len(req.photo_ids)}.zip"'},
    )
