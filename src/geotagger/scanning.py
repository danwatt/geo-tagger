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


# ── Batched index writes ──
# One transaction per scanned file meant one COMMIT (and, before
# synchronous=NORMAL, one fsync) per file. Rows are instead collected on the
# scan's main thread and written in short units. The row bound caps the lock
# hold: a unit holds index.transaction()'s global write lock, so a web request
# that writes (a geotag, a face label) waits out the whole flush — 200 upserts
# are a few tens of ms — and readers on the shared connection see the unit's
# rows before they're committed. The time bound keeps rows behind slow files
# (big videos) from sitting unwritten, invisible to the grid, for long. Rows
# wait in plain memory, not under the lock, so only the flush itself blocks.
_SCAN_BATCH_ROWS = 200
_SCAN_BATCH_SECONDS = 1.0


class _UpsertBatch:
    """Pending index.upsert_photo kwargs, flushed as one write unit. Only ever
    touched from the scan's main thread, so it needs no lock of its own."""

    def __init__(self) -> None:
        self._rows: list[dict] = []
        self._last_flush = time.monotonic()

    def add(self, row: dict) -> None:
        self._rows.append(row)

    def due(self) -> bool:
        return bool(self._rows) and (
            len(self._rows) >= _SCAN_BATCH_ROWS
            or time.monotonic() - self._last_flush >= _SCAN_BATCH_SECONDS)

    def wait_timeout(self) -> float | None:
        """How long the result loop may block before a time-based flush is due
        (None = nothing pending, block until the next file finishes)."""
        if not self._rows:
            return None
        return max(0.0, _SCAN_BATCH_SECONDS - (time.monotonic() - self._last_flush))

    def flush(self) -> list[str]:
        """Write the pending rows; return one warning per row that didn't make
        it. Never raises (Exception) — a failed batch is reported, not fatal, as
        a failed per-file upsert always was."""
        rows, self._rows = self._rows, []
        self._last_flush = time.monotonic()
        if not rows:
            return []
        failed: dict[int, str] = {}  # row position -> warning
        try:
            with index.transaction():
                for i, row in enumerate(rows):
                    try:
                        # Nested unit = SAVEPOINT: a bad row is rolled back alone
                        # and its batch neighbours still commit.
                        with index.transaction():
                            index.upsert_photo(**row)
                    except Exception as e:
                        failed[i] = f"Error processing {row['filename']}: {e}"
        except Exception as e:
            # The COMMIT itself failed (disk full, I/O error): the whole unit was
            # rolled back, so every row not already reported is lost too.
            for i, row in enumerate(rows):
                failed.setdefault(i, f"Error processing {row['filename']}: {e}")
        return list(failed.values())


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
    from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

    def cancelled() -> bool:
        return cancel is not None and cancel.is_set()

    # total stays 0 until the file walk below finishes (the UI shows "counting files").
    _update_scan_state(root=str(root), processed=0, total=0, indexed=0, skipped=0)

    warnings: list[str] = []
    count = 0
    skipped = 0
    total_processed = 0
    thumbs_generated = 0
    thumbs_cached = 0
    lock = threading.Lock()
    # Workers never touch the DB: freshness is decided up front (fresh_flags,
    # below) and the rows they produce are written by this thread in batches
    # (_UpsertBatch). That also retires the old per-worker db_lock, which kept
    # one worker's read off the shared connection while another's write was
    # mid-statement. No transaction is ever open across the ExifTool read /
    # checksum / thumbnail.
    batch = _UpsertBatch()

    # Track what each worker is processing
    worker_status = {}  # worker_id -> (filename, stage)

    # ONE walk (it prunes the cache dir) feeds both the collision check and the
    # work list; these used to be two rglob passes over the whole tree.
    # Collect all files first so we can process them with a thread pool
    files_to_process = []
    media: list[tuple[Path, str]] = []
    read_errors: list[str] = []
    for p, media_type, xmp_names in scanner.walk_media(root, cancel=cancel):
        if cancelled():
            break
        media.append((p, media_type))
        try:
            # Path.stat(), not the walk's DirEntry.stat(): on NTFS the directory
            # listing can carry a stale mtime/size for a recently written file, and
            # the freshness check compares against these values.
            stat = p.stat()
            sc = sidecar.sidecar_path(p)
            sc_mtime = None
            # The directory listing already says which .xmp names exist, so most
            # files (no sidecar) cost no sidecar stat at all.
            if sc.name.casefold() in xmp_names:
                try:
                    sc_mtime = sc.stat().st_mtime
                except OSError:  # vanished / dangling link: same as "no sidecar"
                    sc_mtime = None
            # Filename only — the sidecar always sits next to the image (same `dir`).
            sc_path_str = sc.name if sc_mtime is not None else None
            files_to_process.append((p, media_type, stat, sc_path_str, sc_mtime))
        except Exception as e:
            read_errors.append(f"Error reading {p.name}: {e}")
    warnings.extend(scanner.find_sidecar_collisions(media))
    warnings.extend(read_errors)

    _update_scan_state(total=len(files_to_process))

    # One batched lookup for the whole tree instead of a point SELECT per file
    # in the workers. Same inputs and rule as index.is_fresh. The rows are read
    # now rather than as each file comes up, which only matters for a row a web
    # request rewrites mid-scan; its sidecar stat above is equally old, so
    # comparing the two snapshots is at least consistent.
    if not cancelled():
        flags = index.fresh_flags([(str(p.parent), p.name, stat.st_mtime, sc_path_str, sc_mtime)
                                   for p, _, stat, sc_path_str, sc_mtime in files_to_process])
    else:
        flags = [False] * len(files_to_process)
    files_to_process = [(*f, fresh) for f, fresh in zip(files_to_process, flags)]

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

        p, media_type, stat, sc_path_str, sc_mtime, fresh = file_info

        if cancelled():  # queued before cancel was set; skip without touching anything
            return None

        row = None  # upsert_photo kwargs, written by the main thread's batch
        was_skipped = False
        thumb_generated = False
        thumb_cached = False
        error_msg = None

        try:
            # Update status: indexing
            with lock:
                worker_status[worker_id] = (p.name, "Indexing")
                update_display()

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
                row = dict(
                    filename=p.name, dir_=str(p.parent),
                    ext=p.suffix.lower(), media_type=media_type,
                    mtime=stat.st_mtime, size=stat.st_size,
                    lat=meta["lat"], lng=meta["lng"], geotag_source=meta["geotag_source"],
                    sidecar_path=sc_path_str, sidecar_mtime=sc_mtime,
                    camera=meta["camera"], photo_datetime=meta["photo_datetime"],
                    gps_accuracy=meta["gps_accuracy"], orientation=meta["orientation"],
                    checksum=checksum,
                )

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

        # A failure after the metadata read (thumbnail) still keeps the row, as
        # it did when the worker wrote it before thumbnailing.
        return row, was_skipped, thumb_generated, thumb_cached, error_msg, worker_id

    # Process files with a thread pool
    max_workers = config.WORKERS

    # Initialize display
    if show_progress:
        print()  # Initial progress line
        for i in range(max_workers):
            print(f"    Worker {i}: Idle".ljust(100))

    def flush_batch() -> None:
        nonlocal count
        failures = batch.flush()
        if failures:
            with lock:
                # Counted as indexed when the worker finished; a row that didn't
                # land wasn't.
                count -= len(failures)
                warnings.extend(failures)
                _update_scan_state(indexed=count)

    def handle_result(future) -> None:
        nonlocal count, skipped, thumbs_generated, thumbs_cached, total_processed
        if future.cancelled():
            return
        result = future.result()
        if result is None:  # skipped due to cancel: not "processed"
            return
        row, was_skipped, thumb_gen, thumb_cach, error, worker_id = result
        if row is not None:
            batch.add(row)

        with lock:
            if row is not None:
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

    # try/finally: the last partial batch is written however the loop ends —
    # all files done, cancelled (running tasks' rows still arrive below), or an
    # exception out of the loop itself.
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            not_done = {executor.submit(process_file, f) for f in files_to_process}
            try:
                while not_done:
                    # wait(), not as_completed(): it also wakes when a pending
                    # batch's time bound expires with no file finished since.
                    done, not_done = wait(not_done, timeout=batch.wait_timeout(),
                                          return_when=FIRST_COMPLETED)
                    if cancelled():
                        # Drop everything not yet started; running tasks finish,
                        # and their rows still arrive (and are written) here.
                        # Cancelled futures count as done, so the next wait()
                        # returns them.
                        for f in not_done:
                            f.cancel()
                    for future in done:
                        handle_result(future)
                        # Per result, not per wait(): one wake-up can return
                        # many finished files, and the row bound is the lock-
                        # hold bound.
                        if batch.due():
                            flush_batch()
                    if batch.due():  # time bound expired with nothing finished
                        flush_batch()
            except BaseException:
                # Otherwise the executor's exit would still work through every
                # queued file before the exception could surface.
                for f in not_done:
                    f.cancel()
                raise
    finally:
        flush_batch()

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
