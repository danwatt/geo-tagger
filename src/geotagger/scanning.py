"""Directory scan pipeline: index files + generate thumbnails with a worker pool and
a live terminal progress display. CLI-facing, so it uses print() (not logging) and
runs its own local ThreadPoolExecutor, separate from the shared request executor."""

import os
from pathlib import Path

from geotagger import index, scanner, sidecar, thumbnails, geocode
from geotagger.services import geocode_service


def scan_directory(root: Path, show_progress: bool = True, generate_thumbnails: bool = True) -> tuple[int, int, list[str]]:
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
                # full=True so the complete ExifTool dump is captured into
                # exif_json (searchable later), in the same read that yields the
                # promoted columns below.
                meta = sidecar.read_metadata(p, full=True)
                # Hash the file bytes for integrity/dedup. Non-fatal: a hash
                # failure (e.g. a transient read error) shouldn't cost us the
                # metadata index — the row is left checksum=NULL and the one-time
                # backfill can pick it up later.
                try:
                    checksum = scanner.file_checksum(p)
                except Exception as e:
                    checksum = None
                    error_msg = f"Error checksumming {p.name}: {e}"
                index.upsert_photo(
                    path=str(p), filename=p.name, dir_=str(p.parent),
                    ext=p.suffix.lower(), media_type=media_type,
                    mtime=stat.st_mtime, size=stat.st_size,
                    lat=meta["lat"], lng=meta["lng"], geotag_source=meta["geotag_source"],
                    sidecar_path=sc_path_str, sidecar_mtime=sc_mtime,
                    camera=meta["camera"], photo_datetime=meta["photo_datetime"],
                    gps_accuracy=meta["gps_accuracy"], orientation=meta["orientation"],
                    checksum=checksum, exif_json=meta["exif_json"],
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

    # Reverse-geocode any newly-indexed photos that have coordinates (DB only;
    # sidecars are written on demand via /api/geocode/export-sidecars).
    if geocode.is_available():
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
