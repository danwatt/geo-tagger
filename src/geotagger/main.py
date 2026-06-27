import asyncio
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from geotagger.exiftool_session import lifespan as _et_lifespan, exiftool_status
from geotagger import index, scanner, sidecar, thumbnails, faces
from geotagger.exiftool_session import get_et, get_et_lock
from geotagger.config import FACE_SUGGEST_SCAN_CAP

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Thread pool for blocking I/O operations (thumbnail generation, etc.)
# This will be initialized with the configured number of workers
_executor = None

def set_executor_workers(max_workers: int = 4):
    """Initialize the thread pool executor with the specified number of workers."""
    global _executor
    _executor = ThreadPoolExecutor(max_workers=max_workers)

_WEB_DIR = Path(__file__).parent / "web"


def _scan_directory(root: Path, show_progress: bool = True, generate_thumbnails: bool = True) -> tuple[int, int, list[str]]:
    """Scan a single directory and return (count, skipped, warnings)."""
    import sys
    import threading
    from concurrent.futures import ThreadPoolExecutor, as_completed

    warnings = scanner.detect_sidecar_collisions(root)
    count = 0
    skipped = 0
    total_processed = 0
    thumbs_generated = 0
    thumbs_cached = 0
    lock = threading.Lock()

    # Track what each worker is processing
    worker_status = {}  # worker_id -> (filename, stage)

    # Collect all files first so we can process them with a thread pool
    files_to_process = []
    for p, media_type in scanner.iter_media(root):
        try:
            stat = p.stat()
            sc = sidecar.sidecar_path(p)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            sc_path_str = str(sc) if sc.exists() else None
            files_to_process.append((p, media_type, stat, sc_path_str, sc_mtime))
        except Exception as e:
            warnings.append(f"Error reading {p.name}: {e}")

    def update_display():
        """Update the progress display with all worker statuses."""
        if not show_progress:
            return

        # Move cursor up to overwrite previous output (max_workers + 1 lines)
        max_workers = len(worker_status)
        if max_workers > 0:
            sys.stdout.write(f"\033[{max_workers + 1}A")  # Move up
            sys.stdout.write("\r")  # Start of line

        # Print overall progress
        msg = f"  Progress: {total_processed}/{len(files_to_process)} files"
        if generate_thumbnails:
            msg += f" ({thumbs_generated} thumbs generated, {thumbs_cached} cached)"
        else:
            msg += f" ({count} indexed, {skipped} skipped)"
        print(msg.ljust(100))

        # Print each worker's status
        for worker_id in sorted(worker_status.keys()):
            filename, stage = worker_status[worker_id]
            status = f"    Worker {worker_id}: {stage} - {filename}"
            if len(status) > 100:
                status = status[:97] + "..."
            print(status.ljust(100))

    def process_file(file_info):
        """Process a single file: index and generate thumbnail."""
        import threading
        worker_id = threading.get_ident() % 1000  # Use last 3 digits of thread ID

        p, media_type, stat, sc_path_str, sc_mtime = file_info

        was_indexed = False
        was_skipped = False
        thumb_generated = False
        thumb_cached = False
        error_msg = None

        try:
            # Update status: indexing
            with lock:
                worker_status[worker_id] = (p.name, "Indexing")
                update_display()

            if index.is_fresh(str(p), stat.st_mtime, sc_path_str, sc_mtime):
                was_skipped = True
            else:
                meta = sidecar.read_metadata(p)
                index.upsert_photo(
                    path=str(p), filename=p.name, dir_=str(p.parent),
                    ext=p.suffix.lower(), media_type=media_type,
                    mtime=stat.st_mtime, size=stat.st_size,
                    lat=meta["lat"], lng=meta["lng"], geotag_source=meta["geotag_source"],
                    sidecar_path=sc_path_str, sidecar_mtime=sc_mtime,
                    camera=meta["camera"], photo_datetime=meta["photo_datetime"],
                    gps_accuracy=meta["gps_accuracy"],
                )
                was_indexed = True

            # Generate thumbnail if requested
            if generate_thumbnails:
                try:
                    # Update status: checking thumbnail
                    with lock:
                        worker_status[worker_id] = (p.name, "Checking thumbnail")
                        update_display()

                    if not thumbnails.thumbnail_exists(p, stat.st_mtime, stat.st_size):
                        # Update status: generating thumbnail
                        with lock:
                            worker_status[worker_id] = (p.name, "Generating thumbnail")
                            update_display()

                        thumbnails.get_thumbnail(p, stat.st_mtime, stat.st_size)
                        thumb_generated = True
                    else:
                        thumb_cached = True
                except Exception as e:
                    error_msg = f"Error generating thumbnail for {p.name}: {e}"

        except Exception as e:
            error_msg = f"Error processing {p.name}: {e}"

        return was_indexed, was_skipped, thumb_generated, thumb_cached, error_msg, worker_id

    # Process files with a thread pool
    max_workers = int(os.environ.get("GEOTAGGER_WORKERS", "4"))

    # Initialize display
    if show_progress:
        print()  # Initial progress line
        for i in range(max_workers):
            print(f"    Worker {i}: Idle".ljust(100))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_file, f): f for f in files_to_process}

        for future in as_completed(futures):
            was_indexed, was_skipped, thumb_gen, thumb_cach, error, worker_id = future.result()

            with lock:
                if was_indexed:
                    count += 1
                if was_skipped:
                    skipped += 1
                if thumb_gen:
                    thumbs_generated += 1
                if thumb_cach:
                    thumbs_cached += 1
                if error:
                    warnings.append(error)

                total_processed += 1

                # Remove this worker from status (it's now idle)
                if worker_id in worker_status:
                    del worker_status[worker_id]

                update_display()

    # Clear worker lines and print final stats
    if show_progress:
        sys.stdout.write(f"\033[{max_workers + 1}A")  # Move up
        sys.stdout.write("\r")  # Start of line
        msg = f"  Completed: {total_processed} files processed ({count} indexed, {skipped} skipped)"
        if generate_thumbnails:
            msg += f", {thumbs_generated} thumbnails generated, {thumbs_cached} cached"
        print(msg.ljust(100))
        # Clear worker status lines
        for i in range(max_workers):
            print(" ".ljust(100))

    return count, skipped, warnings


@asynccontextmanager
async def lifespan(app):
    # Initialize thread pool
    max_workers = int(os.environ.get("GEOTAGGER_WORKERS", "4"))
    set_executor_workers(max_workers)

    async with _et_lifespan(app):
        no_scan = os.environ.get("GEOTAGGER_NO_SCAN") == "1"

        # Check for pre-configured scan directories
        scan_dirs_env = os.environ.get("GEOTAGGER_SCAN_DIRS")
        if scan_dirs_env:
            scan_dirs = [Path(d.strip()) for d in scan_dirs_env.split("\n") if d.strip()]
            try:
                # Initialize DB and thumbnails once (not tied to a specific root)
                index.init_db()
                thumbnails.init_thumbs()
                faces.init_faces()

                if no_scan:
                    print(f"Skipping scan (--no-scan), using existing database")
                else:
                    print(f"Initialized cache with {len(scan_dirs)} scan directories")

                    # Scan all directories
                    for scan_dir in scan_dirs:
                        print(f"Scanning {scan_dir}...")
                        count, skipped, warnings = _scan_directory(scan_dir)
                        if warnings:
                            print(f"  Warnings: {len(warnings)}")
                            for w in warnings[:5]:  # Show first 5 warnings
                                print(f"    {w}")

                    # Save the list of scanned directories
                    index.save_last_scan_roots([str(d) for d in scan_dirs])
            except Exception as e:
                print(f"Auto-scan failed: {e}")
        else:
            # Legacy: Auto-reconnect to the last scanned directory
            last_root = index.get_last_scan_root()
            if last_root:
                root = Path(last_root)
                try:
                    index.init_db(root)
                    thumbnails.init_thumbs(root)
                    faces.init_faces(root)
                    if no_scan:
                        print(f"Skipping scan (--no-scan), loaded index from {root}")
                    else:
                        print(f"Auto-loaded index from {root}")
                except Exception as e:
                    print(f"Auto-load failed: {e}")
        yield

app = FastAPI(title="Geo-Tagger", lifespan=lifespan)

# ── Models ────────────────────────────────────────────────────────────────────

class GeotagRequest(BaseModel):
    ids: list[int]
    lat: float
    lng: float

class RemoveGeotagRequest(BaseModel):
    ids: list[int]

class CreatePlaceRequest(BaseModel):
    name: str
    type: str  # "rectangle" or "circle"
    bounds: str  # JSON string with bounds data

# ── API routes ────────────────────────────────────────────────────────────────

@app.get("/api/status")
async def api_status():
    try:
        db = index.get_db()
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    except Exception as e:
        total = f"error: {e}"
    return {**exiftool_status(), "db_total": total}


@app.get("/api/debug")
async def api_debug():
    try:
        db = index.get_db()
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        sample = db.execute("SELECT id, filename, camera FROM photos LIMIT 5").fetchall()
        return {"total": total, "sample": [dict(r) for r in sample]}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/stats/months")
async def api_stats_months():
    """Get photo counts grouped by year/month with geotagged breakdown."""
    try:
        db = index.get_db()
        # Get monthly counts with geotagged breakdown
        rows = db.execute("""
            SELECT
                strftime('%Y', photo_datetime, 'unixepoch') as year,
                strftime('%m', photo_datetime, 'unixepoch') as month,
                COUNT(*) as total,
                SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) as geotagged,
                SUM(CASE WHEN lat IS NULL THEN 1 ELSE 0 END) as not_geotagged
            FROM photos
            WHERE photo_datetime IS NOT NULL AND photo_datetime > 0
            GROUP BY year, month
            ORDER BY year DESC, month DESC
        """).fetchall()

        return {
            "months": [
                {
                    "year": int(r["year"]),
                    "month": int(r["month"]),
                    "total": r["total"],
                    "geotagged": r["geotagged"],
                    "not_geotagged": r["not_geotagged"]
                }
                for r in rows
            ]
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/stats/bounds")
async def api_stats_bounds():
    """Get the bounding box of all geotagged photos."""
    try:
        db = index.get_db()
        row = db.execute("""
            SELECT MIN(lat) as min_lat, MAX(lat) as max_lat,
                   MIN(lng) as min_lng, MAX(lng) as max_lng
            FROM photos WHERE lat IS NOT NULL
        """).fetchone()
        if not row or row["min_lat"] is None:
            return {"has_data": False}
        return {
            "has_data": True,
            "min_lat": row["min_lat"],
            "max_lat": row["max_lat"],
            "min_lng": row["min_lng"],
            "max_lng": row["max_lng"],
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/stats/dates")
async def api_stats_dates(year: int | None = Query(None), month: int | None = Query(None)):
    """Get photo counts grouped by date, optionally filtered by year/month."""
    try:
        db = index.get_db()

        # Build query based on filters
        where_clause = "WHERE photo_datetime IS NOT NULL AND photo_datetime > 0"
        params = []

        if year is not None and month is not None:
            # Filter to specific month
            where_clause += " AND strftime('%Y', photo_datetime, 'unixepoch') = ? AND strftime('%m', photo_datetime, 'unixepoch') = ?"
            params = [str(year), f"{month:02d}"]

        # Get daily counts
        rows = db.execute(f"""
            SELECT
                DATE(photo_datetime, 'unixepoch') as date,
                COUNT(*) as count
            FROM photos
            {where_clause}
            GROUP BY date
            ORDER BY date
        """, params).fetchall()

        return {
            "dates": [
                {"date": r["date"], "count": r["count"]}
                for r in rows
            ]
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/photos")
async def api_photos(
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    bbox: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
):
    """Get photos, optionally filtered by date range (YYYY-MM-DD format)."""
    rows = index.get_photos(geotagged=geotagged, bbox=bbox, date_from=date_from, date_to=date_to)
    return [
        {
            "id": r["id"], "filename": r["filename"], "media_type": r["media_type"],
            "lat": r["lat"], "lng": r["lng"], "geotag_source": r["geotag_source"],
            "camera": r["camera"], "photo_datetime": r["photo_datetime"],
            "gps_accuracy": r["gps_accuracy"] if r["gps_accuracy"] and r["gps_accuracy"] > 0 else None,
        }
        for r in rows
    ]


@app.get("/api/photos/by-area")
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
    result = [
        {
            "id": r["id"], "filename": r["filename"], "media_type": r["media_type"],
            "lat": r["lat"], "lng": r["lng"], "geotag_source": r["geotag_source"],
            "camera": r["camera"], "photo_datetime": r["photo_datetime"],
            "gps_accuracy": r["gps_accuracy"] if r["gps_accuracy"] and r["gps_accuracy"] > 0 else None,
        }
        for r in photos_in_area
    ]
    logger.info(f"  Response build: {(time.time() - t7)*1000:.2f}ms")
    logger.info(f"TOTAL: {(time.time() - t_start)*1000:.2f}ms, returning {len(result)} photos")

    return result


@app.get("/api/thumbnail/{photo_id}")
async def api_thumbnail(photo_id: int):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    try:
        # Run blocking I/O in thread pool
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(
            _executor,
            thumbnails.get_thumbnail,
            Path(row["path"]),
            row["mtime"],
            row["size"]
        )
        return Response(content=data, media_type="image/jpeg")
    except Exception as e:
        import traceback
        print(f"Error generating thumbnail for {photo_id} ({row['path']}): {e}")
        traceback.print_exc()
        raise HTTPException(500, str(e))


@app.get("/api/preview/{photo_id}")
async def api_preview(photo_id: int):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    try:
        # Run blocking I/O in thread pool
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(
            _executor,
            thumbnails.get_preview,
            Path(row["path"]),
            row["mtime"],
            row["size"]
        )
        return Response(content=data, media_type="image/jpeg")
    except Exception as e:
        raise HTTPException(500, str(e))


def _get_photo_metadata(path: str) -> dict:
    """Get photo metadata from ExifTool (thread-safe)."""
    try:
        et = get_et()
        lock = get_et_lock()
        with lock:
            meta = et.get_tags([path], tags=[
                "EXIF:Make", "EXIF:Model", "EXIF:DateTimeOriginal",
                "EXIF:ImageWidth", "EXIF:ImageHeight",
                "Composite:ImageSize",
            ])
        return meta[0] if meta else {}
    except Exception:
        return {}


@app.get("/api/photo/{photo_id}")
async def api_photo(photo_id: int):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    # Fetch extra metadata from exiftool in thread pool
    loop = asyncio.get_event_loop()
    extra = await loop.run_in_executor(_executor, _get_photo_metadata, row["path"])

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
    }


@app.post("/api/geotag")
async def api_geotag(req: GeotagRequest):
    results = []
    for photo_id in req.ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(row["path"])
        sc = sidecar.write_gps(p, req.lat, req.lng)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.update_geotag(photo_id, req.lat, req.lng, "sidecar", str(sc), sc_mtime)
        results.append({
            "id": photo_id, "lat": req.lat, "lng": req.lng,
            "geotag_source": "sidecar", "sidecar_path": str(sc),
        })
    return results


@app.get("/api/guess/{photo_id}")
async def api_guess(photo_id: int, window: int = 900):
    """Return a guessed lat/lng from nearby-in-time geotagged photos (±window seconds)."""
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    if row["lat"] is not None:
        raise HTTPException(400, "Photo already has a geotag")
    ts = row["photo_datetime"]
    if not ts or ts <= 0:
        raise HTTPException(400, "Photo has no timestamp — cannot guess location")

    db = index.get_db()
    nearby = db.execute("""
        SELECT id, lat, lng, filename, photo_datetime FROM photos
        WHERE lat IS NOT NULL
          AND photo_datetime > 0
          AND photo_datetime BETWEEN ? AND ?
          AND id != ?
        ORDER BY ABS(photo_datetime - ?) ASC
        LIMIT 50
    """, (ts - window, ts + window, photo_id, ts)).fetchall()

    if not nearby:
        raise HTTPException(404, detail="No geotagged photos found within 15 minutes")

    weights = [1.0 / (abs(r["photo_datetime"] - ts) + 1) for r in nearby]
    total_w = sum(weights)
    avg_lat = sum(r["lat"] * w for r, w in zip(nearby, weights)) / total_w
    avg_lng = sum(r["lng"] * w for r, w in zip(nearby, weights)) / total_w
    return {
        "lat": avg_lat,
        "lng": avg_lng,
        "source_count": len(nearby),
        "window_sec": window,
        "sources": [{"id": r["id"], "filename": r["filename"],
                     "lat": r["lat"], "lng": r["lng"],
                     "delta_sec": abs(r["photo_datetime"] - ts),
                     "is_before": r["photo_datetime"] < ts} for r in nearby],
    }


@app.post("/api/geotag/remove")
async def api_geotag_remove(req: RemoveGeotagRequest):
    results = []
    for photo_id in req.ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(row["path"])
        sc = sidecar.remove_gps(p)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.update_geotag(photo_id, None, None, "none", str(sc), sc_mtime)
        results.append({"id": photo_id, "geotag_source": "none"})
    return results


@app.get("/api/places")
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


@app.post("/api/places")
async def api_create_place(req: CreatePlaceRequest):
    """Create a new place."""
    place_id = index.create_place(req.name, req.type, req.bounds)
    return {"id": place_id, "name": req.name, "type": req.type, "bounds": req.bounds}


@app.delete("/api/places/{place_id}")
async def api_delete_place(place_id: int):
    """Delete a place."""
    index.delete_place(place_id)
    return {"success": True}


class UpdatePlaceRequest(BaseModel):
    bounds: str


@app.patch("/api/places/{place_id}")
async def api_update_place(place_id: int, req: UpdatePlaceRequest):
    """Update a place's bounds."""
    index.update_place(place_id, req.bounds)
    return {"success": True}


class UpdateTimesRequest(BaseModel):
    updates: dict[int, int]  # photo_id -> offset in seconds


@app.post("/api/photos/update-times")
async def api_update_times(req: UpdateTimesRequest):
    """Batch update photo timestamps by applying offsets."""
    loop = asyncio.get_running_loop()
    updated = await loop.run_in_executor(_executor, _update_photo_times, req.updates)
    return {"updated": updated}


def _update_photo_times(updates: dict[int, int]) -> int:
    """Apply time offsets to photos and write to sidecars."""
    from geotagger.sidecar import write_datetime

    updated = 0
    for photo_id, offset_seconds in updates.items():
        photo = index.get_photo(photo_id)
        if not photo:
            continue

        # Calculate new timestamp
        original_dt = photo["photo_datetime"]
        if not original_dt or original_dt == 0:
            continue

        new_dt = original_dt + offset_seconds

        # Write to sidecar
        photo_path = Path(photo["path"])
        write_datetime(photo_path, new_dt)

        # Update database
        db = index.get_db()
        db.execute("UPDATE photos SET photo_datetime=? WHERE id=?", (new_dt, photo_id))
        db.commit()

        updated += 1

    return updated


# ── Faces & persons ───────────────────────────────────────────────────────────

class CreatePersonRequest(BaseModel):
    name: str

class UpdatePersonRequest(BaseModel):
    birth_date: str | None = None  # ISO YYYY-MM-DD, or null to clear

class AssignFaceRequest(BaseModel):
    person_id: int | None = None  # None clears the assignment
    name: str | None = None       # convenience: create/lookup a person by name

class BulkAssignRequest(BaseModel):
    face_ids: list[int]
    person_id: int | None = None
    name: str | None = None
    clear: bool = False           # set True to unassign the faces

class IgnoreFacesRequest(BaseModel):
    face_ids: list[int]
    ignored: bool = True          # False restores faces to the unlabeled queue

class ScanFacesRequest(BaseModel):
    limit: int = 50  # photos processed per call; repeat to continue


@app.get("/api/persons")
async def api_get_persons():
    return [
        {"id": p["id"], "name": p["name"], "face_count": p["face_count"],
         "birth_date": p["birth_date"], "created_at": p["created_at"]}
        for p in index.get_persons()
    ]


@app.patch("/api/persons/{person_id}")
async def api_update_person(person_id: int, req: UpdatePersonRequest):
    """Set or clear a person's birth date (ISO YYYY-MM-DD) for age-aware suggestions."""
    birth = req.birth_date.strip() if req.birth_date else None
    if birth:
        try:
            from datetime import datetime
            datetime.strptime(birth, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "birth_date must be in YYYY-MM-DD format")
    index.set_person_birth_date(person_id, birth)
    return {"id": person_id, "birth_date": birth}


@app.post("/api/persons")
async def api_create_person(req: CreatePersonRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    person_id = index.get_or_create_person(name)
    return {"id": person_id, "name": name}


@app.delete("/api/persons/{person_id}")
async def api_delete_person(person_id: int):
    index.delete_person(person_id)
    return {"success": True}


def _face_item(r) -> dict:
    """Build the JSON-safe face dict (without a suggestion) from a DB row."""
    return {
        "id": r["id"],
        "photo_id": r["photo_id"],
        "filename": r["filename"],
        "bbox": [float(v) for v in r["bbox"].split(",")],
        "det_score": r["det_score"],
        "person_id": r["person_id"],
        "person_name": r["person_name"],
        "ignored": bool(r["ignored"]),
        "photo_datetime": r["photo_datetime"],
        "suggestion": None,
    }


def _person_name(person_id: int) -> str | None:
    row = index.get_db().execute("SELECT name FROM persons WHERE id=?", (person_id,)).fetchone()
    return row["name"] if row else None


@app.get("/api/faces")
async def api_list_faces(
    scope: str = Query("unlabeled", pattern="^(unlabeled|person|ignored|suggested|all)$"),
    person_id: int | None = Query(None),
    limit: int = Query(500, ge=1, le=2000),
):
    """List faces. scope=unlabeled attaches a recognition suggestion to each face;
    scope=suggested returns only unlabeled faces whose *best* guess is `person_id`,
    ranked by confidence — for quickly approving one person's guesses in bulk."""
    if scope == "suggested":
        if not person_id:
            raise HTTPException(400, "person_id is required for scope=suggested")
        gallery = faces.build_gallery()
        name = _person_name(person_id)
        scored = []
        if len(gallery) > 0:
            for r in index.list_faces("unlabeled", None, FACE_SUGGEST_SCAN_CAP):
                match = faces.suggest_person(faces.decode_embedding(r["embedding"]),
                                             r["photo_datetime"], gallery)
                if match and match[0] == person_id:
                    scored.append((r, match[1]))
        scored.sort(key=lambda t: t[1], reverse=True)
        out = []
        for r, score in scored[:limit]:
            item = _face_item(r)
            item["suggestion"] = {"person_id": person_id, "person_name": name,
                                  "score": round(score, 4)}
            out.append(item)
        return {"faces": out, "total": len(scored), "returned": len(out)}

    rows = index.list_faces(scope=scope, person_id=person_id, limit=limit)
    gallery = faces.build_gallery() if scope == "unlabeled" else None
    out = []
    for r in rows:
        item = _face_item(r)
        if gallery is not None and len(gallery) > 0:
            match = faces.suggest_person(faces.decode_embedding(r["embedding"]),
                                         r["photo_datetime"], gallery)
            if match:
                pid, score = match
                item["suggestion"] = {"person_id": pid, "person_name": _person_name(pid),
                                      "score": round(score, 4)}
        out.append(item)
    return {
        "faces": out,
        "total": index.count_faces(scope=scope, person_id=person_id),
        "returned": len(out),
    }


@app.get("/api/faces/{face_id}/crop")
async def api_face_crop(face_id: int):
    row = index.get_face_with_photo(face_id)
    if not row:
        raise HTTPException(404)
    bbox = tuple(float(v) for v in row["bbox"].split(","))
    try:
        loop = asyncio.get_running_loop()
        data = await loop.run_in_executor(
            _executor, thumbnails.get_face_crop,
            Path(row["path"]), row["mtime"], row["size"], bbox,
        )
        return Response(content=data, media_type="image/jpeg")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/faces/assign")
async def api_bulk_assign(req: BulkAssignRequest):
    person_id = None if req.clear else req.person_id
    if person_id is None and not req.clear and req.name and req.name.strip():
        person_id = index.get_or_create_person(req.name.strip())
    index.assign_faces(req.face_ids, person_id)
    return {"assigned": len(req.face_ids), "person_id": person_id}


@app.post("/api/faces/ignore")
async def api_ignore_faces(req: IgnoreFacesRequest):
    """Hide faces from the unlabeled queue (background strangers, false detections),
    or restore them with ignored=false."""
    index.set_faces_ignored(req.face_ids, req.ignored)
    return {"updated": len(req.face_ids), "ignored": req.ignored}


@app.get("/api/photos/{photo_id}/faces")
async def api_photo_faces(photo_id: int):
    """List faces in a photo with assigned person and a recognition suggestion."""
    photo = index.get_photo(photo_id)
    if not photo:
        raise HTTPException(404)
    photo_dt = photo["photo_datetime"]
    gallery = faces.build_gallery()
    rows = index.get_faces_for_photo(photo_id)
    out = []
    for r in rows:
        item = {
            "id": r["id"],
            "bbox": [float(v) for v in r["bbox"].split(",")],
            "det_score": r["det_score"],
            "person_id": r["person_id"],
            "person_name": r["person_name"],
            "suggestion": None,
        }
        # Only suggest for not-yet-assigned faces.
        if r["person_id"] is None and len(gallery) > 0:
            vec = faces.decode_embedding(r["embedding"])
            match = faces.suggest_person(vec, photo_dt, gallery)
            if match:
                pid, score = match
                person = index.get_db().execute(
                    "SELECT name FROM persons WHERE id=?", (pid,)
                ).fetchone()
                item["suggestion"] = {
                    "person_id": pid,
                    "person_name": person["name"] if person else None,
                    "score": round(score, 4),
                }
        out.append(item)
    return out


@app.post("/api/faces/{face_id}/assign")
async def api_assign_face(face_id: int, req: AssignFaceRequest):
    if not index.get_face(face_id):
        raise HTTPException(404)
    person_id = req.person_id
    if person_id is None and req.name and req.name.strip():
        person_id = index.get_or_create_person(req.name.strip())
    index.assign_face(face_id, person_id)
    return {"face_id": face_id, "person_id": person_id}


def _scan_faces_batch(photo_ids: list[int]) -> dict:
    """Run detection over a list of photo ids (blocking; called in executor)."""
    processed = 0
    total_faces = 0
    errors = []
    for pid in photo_ids:
        row = index.get_photo(pid)
        if not row:
            continue
        try:
            total_faces += faces.detect_and_store(row)
            processed += 1
        except Exception as e:
            errors.append(f"{row['filename']}: {e}")
    return {"processed": processed, "faces_found": total_faces, "errors": errors}


@app.post("/api/faces/scan")
async def api_faces_scan(req: ScanFacesRequest):
    """Detect faces for up to `limit` not-yet-scanned photos. Repeat to continue."""
    pending = index.get_unscanned_photo_ids()
    batch = pending[: max(1, req.limit)]
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(_executor, _scan_faces_batch, batch)
    result["remaining"] = len(pending) - result["processed"]
    return result


@app.get("/api/faces/scan/status")
async def api_faces_scan_status():
    remaining = len(index.get_unscanned_photo_ids())
    return {
        "remaining_photos": remaining,
        "total_faces": index.count_faces("all"),
        "unlabeled_faces": index.count_faces("unlabeled"),
        "ignored_faces": index.count_faces("ignored"),
    }


# ── Static files (must be last) ───────────────────────────────────────────────
app.mount("/", StaticFiles(directory=str(_WEB_DIR), html=True), name="web")
