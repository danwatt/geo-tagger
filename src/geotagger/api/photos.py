"""Photo listing/filtering, area search, thumbnail/preview/detail, and batch
timestamp correction."""

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, field_validator

from geotagger import index, thumbnails, serializers
from geotagger.executor import get_executor
from geotagger.services import photos_service, zip_service
from geotagger.timeutil import has_date

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/photos")
async def api_photos(
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    bbox: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    undated: bool = Query(False),
    dir: str | None = Query(None, description="exact directory match (folder batches)"),
    ids: str | None = Query(None, description="comma-separated photo ids — an explicit "
                             "selection (e.g. handed off from Search), overrides every other filter"),
):
    """Get photos, optionally filtered by date range, by exact directory, by an
    explicit id list, or (undated=true) photos with no timestamp at all — the
    latter mutually exclusive with date_from/date_to, which are meaningless
    without a photo_datetime."""
    id_list: list[int] | None = None
    if ids is not None:
        try:
            id_list = [int(x) for x in ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "ids must be a comma-separated list of integers")
    # Deliberately unpaged: the map frontend loads the full filtered set in one
    # request by design. A malformed bbox/date is a client error (400), never a
    # silently-dropped filter that returns the whole library.
    try:
        rows = index.get_photos(
            geotagged=geotagged, bbox=bbox,
            date_from=date_from, date_to=date_to, undated=undated, dir=dir, ids=id_list,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return [serializers.photo_to_dict(r) for r in rows]


@router.get("/api/photos/dirs")
async def api_photo_dirs(limit: int = Query(500, ge=1, le=5000)):
    """Directories in the library, most-untagged first. Feeds the Geocode folder
    picker, which loads one of them through /api/photos?dir=."""
    loop = asyncio.get_running_loop()
    rows = await loop.run_in_executor(get_executor(), index.get_dir_counts, limit)
    return [{"dir": r["dir"], "total": r["total"], "untagged": r["untagged"]} for r in rows]


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
                     if has_date(r["photo_datetime"])]

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

    # Undated first as one block (same order as index.get_photos): `or 0` alone
    # would slot undated photos between the 1969 and 1970 ones.
    photos_in_area.sort(key=lambda r: (has_date(r["photo_datetime"]),
                                       r["photo_datetime"] or 0, r["filename"]))
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


@router.get("/api/photos/by-location")
async def api_photos_by_location(
    location_fields: str = Query(...),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    window: int = Query(900, ge=0),
    limit: int = Query(1_000_000, ge=1, le=5_000_000,
                       description="max recorded-location matches considered"),
    response: Response = None,
):
    """Recorded location matches plus temporally adjacent geotag candidates.

    The map loads every photo recorded in the chosen location in one shot, so the
    default cap is far above any real library (it only exists to stop a runaway
    value, not to page). If the cap is hit the response still carries what fit and
    sets an ``X-Truncated: true`` header (the body stays a plain list so the
    frontend is unchanged)."""
    from geotagger.search_locations import parse_fields

    try:
        parse_fields(location_fields)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid location selection")
    try:
        # limit+1 so "exactly at the cap" is distinguishable from "over it".
        rows = index.search_photos(location_fields=location_fields, limit=limit + 1)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if len(rows) > limit:
        rows = rows[:limit]
        response.headers["X-Truncated"] = "true"
    located = [r for r in rows if r["lat"] is not None and r["lng"] is not None]
    return [serializers.photo_to_dict(r)
            for r in _augment_and_filter(located, geotagged, window)]


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
        # From the DB, not a live EXIF re-read: it already reflects any sidecar
        # correction (Time Sync offset, or an assigned approximate date), and
        # date_precision keeps an approximate date from claiming a day it doesn't have.
        "datetime": serializers.format_photo_datetime(row["photo_datetime"], row["date_precision"]),
        "date_precision": row["date_precision"],
        "dimensions": extra.get("Composite:ImageSize"),
        "gps_accuracy": row["gps_accuracy"] if row["gps_accuracy"] and row["gps_accuracy"] > 0 else None,
        "geocode_ignored": bool(row["geocode_ignored"]),
        "location": {
            "city": row["loc_city"],
            "sublocation": row["loc_sublocation"],
            "postal_code": row["loc_postal_code"],
            "state": row["loc_state"],
            "county": row["loc_county"],
            "country": row["loc_country"],
            "country_code": row["loc_country_code"],
        } if row["loc_country_code"] else None,
    }


class TimeUpdate(BaseModel):
    id: int
    expected: int  # the photo_datetime the client believes the photo has now
    target: int    # the photo_datetime it should have afterwards


class UpdateTimesRequest(BaseModel):
    updates: list[TimeUpdate]


@router.post("/api/photos/update-times")
async def api_update_times(req: UpdateTimesRequest):
    """Set photo timestamps to absolute targets (the Time Sync save). Idempotent:
    re-sending the same body after a partial failure only applies what's left.
    Same {results, written, failed, not_found} reply and status rules as
    /api/geotag, plus 409 when every refusal was a conflict (the photos' dates
    changed since the client loaded them)."""
    from geotagger.api.geotag import _batch_response
    loop = asyncio.get_running_loop()
    try:
        out = await loop.run_in_executor(
            get_executor(), photos_service.update_photo_times,
            [u.model_dump() for u in req.updates],
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    if (req.updates and not out["written"] and out["failed"]
            and all(f.get("conflict") for f in out["failed"])):
        return JSONResponse(out, status_code=409)
    return _batch_response([u.id for u in req.updates], out)


def _validate_year_month(year: int, month: int | None):
    import datetime as _datetime
    current_year = _datetime.date.today().year
    if not (1826 <= year <= current_year):  # 1826: first known photograph
        raise HTTPException(400, "year out of range")
    if month is not None and not (1 <= month <= 12):
        raise HTTPException(400, "month must be 1-12")


class AssignDateRequest(BaseModel):
    photo_ids: list[int]
    year: int
    month: int | None = None  # None = year precision, else month precision


@router.post("/api/photos/assign-date")
async def api_assign_date(req: AssignDateRequest):
    """Assign an approximate (year or month precision) date to a folder/selection
    of photos with no reliable EXIF date — see Search page's "Assign date…"."""
    _validate_year_month(req.year, req.month)
    if not req.photo_ids:
        raise HTTPException(400, "no photos selected")

    loop = asyncio.get_running_loop()
    updated = await loop.run_in_executor(
        get_executor(), photos_service.assign_approximate_dates,
        req.photo_ids, req.year, req.month,
    )
    return {"updated": updated}


class GuessDatesRequest(BaseModel):
    photo_ids: list[int]


@router.post("/api/photos/guess-dates")
async def api_guess_dates(req: GuessDatesRequest):
    """Best-effort date guess per photo (from filename/folder — see date_guess.py)
    for the Search page's "Guess dates…" staging panel. Doesn't write anything;
    the user reviews these before committing via /api/photos/commit-guessed-dates."""
    if not req.photo_ids:
        raise HTTPException(400, "no photos selected")
    loop = asyncio.get_running_loop()
    guesses = await loop.run_in_executor(get_executor(), photos_service.guess_dates, req.photo_ids)
    return {"guesses": guesses}


class DateGuessEntry(BaseModel):
    photo_id: int
    year: int
    month: int | None = None
    day: int | None = None
    precision: str | None = None  # None = exact day, else 'month'/'year'


class CommitGuessedDatesRequest(BaseModel):
    entries: list[DateGuessEntry]


@router.post("/api/photos/commit-guessed-dates")
async def api_commit_guessed_dates(req: CommitGuessedDatesRequest):
    """Write a batch of staged, user-reviewed date guesses. Returns ``previous``
    snapshots (opaque to the client) — pass the whole thing back to
    /api/photos/undo-date-commit to revert this exact batch."""
    if not req.entries:
        raise HTTPException(400, "no entries to commit")
    for e in req.entries:
        if e.precision not in (None, "month", "year"):
            raise HTTPException(400, "precision must be null, 'month', or 'year'")
        _validate_year_month(e.year, e.month)
        if e.precision is None and (e.month is None or e.day is None):
            raise HTTPException(400, "an exact (non-approximate) entry needs both month and day")

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        get_executor(), photos_service.commit_guessed_dates,
        [e.model_dump() for e in req.entries],
    )
    return result


# What ExifTool prints for XMP:DateTimeOriginal: 'YYYY:MM:DD HH:MM:SS', and for
# sidecars from other tools possibly truncated, with sub-seconds, or with a zone.
_RAW_DATETIME_RE = re.compile(
    r"\d{4}(:\d{2}(:\d{2}( \d{2}:\d{2}(:\d{2}(\.\d+)?)?)?)?)?(Z|[+-]\d{2}:\d{2})?")


class DateSnapshot(BaseModel):
    """One photo's pre-commit state, as returned in commit-guessed-dates'
    ``previous``. The client only stores and returns these, but they are still
    client input on the way back: raw_datetime becomes an ExifTool argument, so
    it is checked against the shape of a date rather than trusted."""
    photo_id: int
    raw_datetime: str | None = None
    photo_datetime: int | None = None
    date_precision: Literal["month", "year"] | None = None

    @field_validator("raw_datetime")
    @classmethod
    def _raw_datetime_is_a_date(cls, v: str | None) -> str | None:
        # fullmatch, not a `pattern=` constraint or match()+'$': '$' also matches
        # before a trailing newline, which is exactly what must not get through.
        if v is not None and not _RAW_DATETIME_RE.fullmatch(v):
            raise ValueError("raw_datetime is not an EXIF date string")
        return v


class UndoDateCommitRequest(BaseModel):
    previous: list[DateSnapshot]  # snapshots from a commit-guessed-dates response


@router.post("/api/photos/undo-date-commit")
async def api_undo_date_commit(req: UndoDateCommitRequest):
    """Revert exactly the batch a prior /api/photos/commit-guessed-dates call made."""
    if not req.previous:
        raise HTTPException(400, "nothing to undo")
    loop = asyncio.get_running_loop()
    reverted = await loop.run_in_executor(get_executor(), photos_service.undo_date_commit,
        [s.model_dump() for s in req.previous])
    return {"reverted": reverted}


class DownloadZipRequest(BaseModel):
    photo_ids: list[int]


class _TempFileResponse(FileResponse):
    """FileResponse that deletes its file when the response ends for any reason.
    A BackgroundTask only runs after a *completed* send; a client that cancels
    the download mid-stream would leak a multi-GB temp archive."""

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            zip_service.remove_quietly(self.path)


async def _read_zip_ids(request: Request) -> list[int]:
    """Photo ids from either a JSON body ({"photo_ids": [...]}) or a plain HTML
    form post (``photo_ids`` = comma-separated ints). The form path exists so the
    browser can stream the archive straight to disk via a navigation download
    (no fetch/blob in the tab). Parsed by hand: FastAPI's form support needs
    python-multipart, which isn't a dependency."""
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    body = await request.body()
    try:
        if ctype == "application/x-www-form-urlencoded":
            from urllib.parse import parse_qs
            fields = parse_qs(body.decode("utf-8"), keep_blank_values=True)
            raw = ",".join(fields.get("photo_ids", []))
            return [int(x) for x in raw.split(",") if x.strip()]
        return DownloadZipRequest.model_validate_json(body).photo_ids
    except (ValueError, UnicodeDecodeError):  # pydantic's ValidationError is a ValueError
        raise HTTPException(400, "photo_ids must be a list of integer photo ids")


@router.post("/api/photos/download-zip")
async def api_download_zip(request: Request, check: bool = Query(False)):
    """Bundle the selected photos' original files (full quality, RAW included
    as-is) into a ZIP archive for download.

    The archive is built into a temp file and sent with a Content-Length — never
    held in memory. Selections with no existing files are 404, selections over
    GEOTAGGER_ZIP_MAX_BYTES are 413. ``?check=1`` runs just that validation and
    returns the counts, so the page can surface an error before it commits to a
    navigation download (which would otherwise replace the page with the error
    JSON). Files missing from an otherwise valid selection are skipped; their
    count is reported (``skipped`` / ``X-Skipped-Files``)."""
    ids = await _read_zip_ids(request)
    if not ids:
        raise HTTPException(400, "photo_ids must not be empty")
    loop = asyncio.get_running_loop()
    executor = get_executor()
    try:
        plan = await loop.run_in_executor(executor, zip_service.plan_zip, ids)
    except zip_service.ZipSelectionError as e:
        raise HTTPException(404 if e.kind == "none_found" else 413, str(e))
    if check:
        return {"count": len(plan.members), "total_bytes": plan.total_bytes, "skipped": plan.skipped}
    path = await loop.run_in_executor(executor, zip_service.build_zip, plan)
    return _TempFileResponse(
        path, media_type="application/zip",
        filename=f"photos-{len(ids)}.zip",  # sets Content-Disposition: attachment
        headers={"X-Skipped-Files": str(plan.skipped)},
    )
