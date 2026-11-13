"""Directory scan pipeline: index files + generate thumbnails with a worker pool and
a live terminal progress display. CLI-facing, so it uses print() (not logging) and
runs its own local ThreadPoolExecutor, separate from the shared request executor."""

import sys
import threading
import time
from pathlib import Path

from geotagger import config, index, scanner, sidecar, thumbnails, geocode
from geotagger.services import geocode_service

# ── Scan state (polled by GET /api/scan/status) ──
# The startup scan runs in a background thread while requests are served, so its
# progress lives in a module singleton guarded by a lock. processed/total/indexed/
# skipped describe the directory currently being scanned (they reset per root).
_scan_lock = threading.Lock()


def _blank_state() -> dict:
    return {
        "running": False, "root": None, "processed": 0, "total": 0,
        "indexed": 0, "skipped": 0, "warnings": 0, "error": None,
        "started_at": None, "finished_at": None,
    }


_scan_state: dict = _blank_state()


def reset_scan_state() -> None:
    """Back to 'idle, never scanned' (app startup, and between tests)."""
    global _scan_state
    with _scan_lock:
        _scan_state = _blank_state()


def get_scan_status() -> dict:
    """A copy of the scan state. Pure in-memory, so the route that serves it needs
    no DB query and is safe to poll every couple of seconds."""
    with _scan_lock:
        return dict(_scan_state)


def _update_scan_state(**fields) -> None:
    with _scan_lock:
        _scan_state.update(fields)


def run_scan(scan_dirs: list[Path], cancel: threading.Event | None = None) -> None:
    """Scan each directory in order, then persist the scanned roots. Meant to run
    in a dedicated background thread: it never raises — a failure is printed to
    stderr and recorded in the scan state for the UI banner. A cancelled run
    (shutdown) does not save the roots, since the scan is incomplete."""
    _update_scan_state(running=True, root=None, processed=0, total=0, indexed=0,
                       skipped=0, warnings=0, error=None,
                       started_at=time.time(), finished_at=None)
    error = None
    # Across all roots (unlike the per-root counters): per-file failures don't
    # fail the scan, so without this a run where every file errored — e.g.
    # ExifTool missing — would look like a clean finish to the UI.
    warning_count = 0
    try:
        for scan_dir in scan_dirs:
            if cancel is not None and cancel.is_set():
                break
            print(f"Scanning {scan_dir}...")
            # Looked up on the module at call time (not bound at import) so tests
            # can substitute scan_directory.
            count, skipped, warnings = scan_directory(scan_dir, cancel=cancel)
            if warnings:
                warning_count += len(warnings)
                _update_scan_state(warnings=warning_count)
                print(f"  Warnings: {len(warnings)}")
                for w in warnings[:5]:  # Show first 5 warnings
                    print(f"    {w}")
        if cancel is None or not cancel.is_set():
            index.save_last_scan_roots([str(d) for d in scan_dirs])
    except Exception as e:
        error = str(e) or type(e).__name__
        print(f"ERROR: background scan failed: {e}", file=sys.stderr)
    finally:
        _update_scan_state(running=False, root=None, error=error, finished_at=time.time())


def scan_directory(root: Path, show_progress: bool = True, generate_thumbnails: bool = True,
                   cancel: threading.Event | None = None) -> tuple[int, int, list[str]]:
    """Scan a single directory and return (count, skipped, warnings).

    `cancel`, if set mid-scan, stops further files from being picked up (tasks
    already running finish); the partial counts are returned as usual."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def cancelled() -> bool:
        return cancel is not None and cancel.is_set()

    # total stays 0 until the file walk below finishes (the UI shows "counting files").
    _update_scan_state(root=str(root), processed=0, total=0, indexed=0, skipped=0)

    warnings = scanner.detect_sidecar_collisions(root)
    count = 0
    skipped = 0
    total_processed = 0
    thumbs_generated = 0
    thumbs_cached = 0
    lock = threading.Lock()
    # index.get_db() is ONE sqlite3 connection shared by every thread, and
    # sqlite3 connections are not safe to drive from several threads at once:
    # one worker's commit lands in the middle of another's statement and the
    # file fails with "bad parameter or other API misuse" (measured: ~5-7% of
    # files on a 4-worker scan of small JPEGs, 0 with this lock). The DB calls
    # are microseconds next to the ExifTool read, checksum and thumbnail, which
    # stay parallel, so serializing them costs nothing measurable.
    db_lock = threading.Lock()

    # Track what each worker is processing
    worker_status = {}  # worker_id -> (filename, stage)

    # Collect all files first so we can process them with a thread pool
    files_to_process = []
    for p, media_type in scanner.iter_media(root):
        if cancelled():
            break
        try:
            stat = p.stat()
            sc = sidecar.sidecar_path(p)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            # Filename only — the sidecar always sits next to the image (same `dir`).
            sc_path_str = sc.name if sc.exists() else None
            files_to_process.append((p, media_type, stat, sc_path_str, sc_mtime))
        except Exception as e:
            warnings.append(f"Error reading {p.name}: {e}")

    _update_scan_state(total=len(files_to_process))

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
        worker_id = threading.get_ident() % 1000  # Use last 3 digits of thread ID

        p, media_type, stat, sc_path_str, sc_mtime = file_info

        if cancelled():  # queued before cancel was set; skip without touching anything
            return None

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

            with db_lock:
                fresh = index.is_fresh(str(p.parent), p.name, stat.st_mtime, sc_path_str, sc_mtime)
            if fresh:
                was_skipped = True
            else:
                meta = sidecar.read_metadata(p)
                # Hash the file bytes for integrity/dedup. Non-fatal: a hash
                # failure (e.g. a transient read error) shouldn't cost us the
                # metadata index — the row is left checksum=NULL and the one-time
                # backfill can pick it up later.
                try:
                    checksum = scanner.file_checksum(p)
                except Exception as e:
                    checksum = None
                    error_msg = f"Error checksumming {p.name}: {e}"
                with db_lock:
                    index.upsert_photo(
                        filename=p.name, dir_=str(p.parent),
                        ext=p.suffix.lower(), media_type=media_type,
                        mtime=stat.st_mtime, size=stat.st_size,
                        lat=meta["lat"], lng=meta["lng"], geotag_source=meta["geotag_source"],
                        sidecar_path=sc_path_str, sidecar_mtime=sc_mtime,
                        camera=meta["camera"], photo_datetime=meta["photo_datetime"],
                        gps_accuracy=meta["gps_accuracy"], orientation=meta["orientation"],
                        checksum=checksum,
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
    max_workers = config.WORKERS

    # Initialize display
    if show_progress:
        print()  # Initial progress line
        for i in range(max_workers):
            print(f"    Worker {i}: Idle".ljust(100))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_file, f): f for f in files_to_process}

        for future in as_completed(futures):
            if cancelled():
                # Drop everything not yet started; running tasks finish on exit.
                for f in futures:
                    f.cancel()
            if future.cancelled():
                continue
            result = future.result()
            if result is None:  # skipped due to cancel: not "processed"
                continue
            was_indexed, was_skipped, thumb_gen, thumb_cach, error, worker_id = result

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
                # In-memory only — no extra DB/I/O per file.
                _update_scan_state(processed=total_processed, indexed=count, skipped=skipped)

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

    # Reverse-geocode any newly-indexed photos that have coordinates (DB only;
    # sidecars are written on demand via /api/geocode/export-sidecars).
    if geocode.is_available() and not cancelled():
        try:
            pending = index.count_photos_needing_geocode()
            if pending:
                if show_progress:
                    print(f"  Reverse geocoding {pending} photo(s)…")
                res = geocode_service.geocode_pending()
                if show_progress:
                    print(f"  Geocoded {res['matched']}/{res['processed']} photo(s).")
        except Exception as e:
            warnings.append(f"Geocoding failed: {e}")

    return count, skipped, warnings
