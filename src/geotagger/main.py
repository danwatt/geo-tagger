import asyncio
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
from geotagger import index, scanner, sidecar, thumbnails
from geotagger.exiftool_session import get_et, get_et_lock

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
        # Check for pre-configured scan directories
        scan_dirs_env = os.environ.get("GEOTAGGER_SCAN_DIRS")
        if scan_dirs_env:
            scan_dirs = [Path(d.strip()) for d in scan_dirs_env.split("\n") if d.strip()]
            try:
                # Initialize DB and thumbnails once (not tied to a specific root)
                index.init_db()
                thumbnails.init_thumbs()
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


@app.get("/api/photos")
async def api_photos(
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    bbox: str | None = Query(None),
):
    rows = index.get_photos(geotagged=geotagged, bbox=bbox)
    return [
        {
            "id": r["id"], "filename": r["filename"], "media_type": r["media_type"],
            "lat": r["lat"], "lng": r["lng"], "geotag_source": r["geotag_source"],
            "camera": r["camera"], "photo_datetime": r["photo_datetime"],
            "gps_accuracy": r["gps_accuracy"] if r["gps_accuracy"] and r["gps_accuracy"] > 0 else None,
        }
        for r in rows
    ]


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


# ── Static files (must be last) ───────────────────────────────────────────────
app.mount("/", StaticFiles(directory=str(_WEB_DIR), html=True), name="web")
