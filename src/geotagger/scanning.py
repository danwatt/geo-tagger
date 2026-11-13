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
        "running": False, "root": None,
        # None | "counting" (walking the tree) | "indexing" | "geocoding" | "pruning"
        "phase": None,
        "processed": 0, "total": 0, "indexed": 0, "skipped": 0,
        # Files not re-read because they failed before and haven't changed.
        "known_failed": 0,
        "warnings": 0,
        # Rows in the persisted scan_errors table (files that couldn't be
        # indexed); kept here so polling never needs a COUNT query.
        "errors": 0,
        "error": None, "summary": None,
        "started_at": None, "finished_at": None,
    }


_scan_state: dict = _blank_state()

# Every warning of the most recent run, for GET /api/scan/errors (the console
# shows only the first few per root). Bounded: a run where every file fails —
# e.g. ExifTool missing — would otherwise hold one string per library file.
_MAX_KEPT_WARNINGS = 5000
_last_warnings: list[str] = []


class ScanAlreadyRunning(RuntimeError):
    """A second scan was requested while one is in progress."""


def reset_scan_state() -> None:
    """Back to 'idle, never scanned' (app startup, and between tests)."""
    global _scan_state, _last_warnings
    with _scan_lock:
        _scan_state = _blank_state()
        _last_warnings = []


def get_scan_status() -> dict:
    """A copy of the scan state. Pure in-memory, so the route that serves it needs
    no DB query and is safe to poll every couple of seconds."""
    with _scan_lock:
        return dict(_scan_state)


def get_last_warnings() -> list[str]:
    with _scan_lock:
        return list(_last_warnings)


def _update_scan_state(**fields) -> None:
    with _scan_lock:
        _scan_state.update(fields)


def refresh_error_count() -> None:
    """Re-read the persisted error count into the state (DB must be open)."""
    _update_scan_state(errors=index.count_scan_errors())


def _claim_scan() -> None:
    """Mark a scan as running, atomically with the check that none is — the one
    guard against two scans at once (two walks racing on the same rows, and a
    prune deciding from a footprint the other scan is still changing)."""
    global _last_warnings
    with _scan_lock:
        if _scan_state["running"]:
            raise ScanAlreadyRunning("A library scan is already running")
        _scan_state.update(running=True, root=None, phase=None, processed=0, total=0,
                           indexed=0, skipped=0, known_failed=0, warnings=0, error=None,
                           summary=None, started_at=time.time(), finished_at=None)
        _last_warnings = []


def start_background_scan(scan_dirs: list[Path], cancel: threading.Event,
                          name: str = "scan") -> threading.Thread:
    """Run a scan in a new dedicated thread and return it (the caller joins it
    at shutdown after setting `cancel`). Raises ScanAlreadyRunning — before
    starting anything — if a scan is in progress, so a route can answer 409.

    A dedicated thread, NOT the shared request executor: a scan can run for
    minutes to hours and must not occupy request workers. Daemon so a hung file
    can't keep the process alive after a hard Ctrl-C; the lifespan still joins it."""
    _claim_scan()
    t = threading.Thread(target=_run_claimed_scan, args=(scan_dirs, cancel), name=name, daemon=True)
    try:
        t.start()
    except BaseException:
        _update_scan_state(running=False)
        raise
    return t


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

    def flush(self) -> tuple[list[dict], dict[int, str]]:
        """Write the pending rows; return (the rows, {position: warning} for
        each row that didn't make it). Never raises (Exception) — a failed batch
        is reported, not fatal, as a failed per-file upsert always was. (A file
        whose row didn't land has no row afterwards; the prune step reads that
        from the DB, not from here.)"""
        rows, self._rows = self._rows, []
        self._last_flush = time.monotonic()
        if not rows:
            return [], {}
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
        return rows, failed


class ScanFootprint:
    """What one root's scan saw, for the post-run prune (_prune_vanished).

    Filled in by scan_directory. `complete` turns True only when that scan ran to
    the end uncancelled and without raising; anything else — including a
    substituted scan_directory that never touches it — leaves it False, and a
    root that isn't complete is never pruned."""

    def __init__(self, root: Path) -> None:
        self.root = str(root)
        # dir -> {filename: size} for every media file the walk listed, keyed
        # exactly as upsert_photo stores dir/filename (str(p.parent), p.name).
        # size is None when the stat failed.
        self.seen: dict[str, dict[str, int | None]] = {}
        self.unreadable: list[str] = []  # directories the walk couldn't list
        self.media_count = 0
        self.complete = False


def run_scan(scan_dirs: list[Path], cancel: threading.Event | None = None) -> None:
    """Scan each directory in order, persist the scanned roots, then prune rows
    for files that vanished from them (relink moves, delete the gone). Runs in
    the calling thread (start_background_scan is the threaded entry point). It
    never raises for a scan failure — that is printed to stderr and recorded in
    the scan state for the UI banner — but raises ScanAlreadyRunning, without
    doing anything, if another scan is in progress. A cancelled run (shutdown)
    neither saves the roots nor prunes, since the scan is incomplete."""
    _claim_scan()
    _run_claimed_scan(scan_dirs, cancel)


def _run_claimed_scan(scan_dirs: list[Path], cancel: threading.Event | None) -> None:
    """run_scan's body; the caller has already _claim_scan()ed."""
    t_start = time.time()
    error = None
    # Across all roots (unlike the per-root counters): per-file failures don't
    # fail the scan, so without this a run where every file errored — e.g.
    # ExifTool missing — would look like a clean finish to the UI.
    warning_count = 0
    totals = {"processed": 0, "indexed": 0, "skipped": 0, "known_failed": 0}

    def keep_warnings(ws: list[str]) -> None:
        with _scan_lock:
            room = _MAX_KEPT_WARNINGS - len(_last_warnings)
            if room > 0:
                _last_warnings.extend(ws[:room])

    try:
        # Taken before anything is inserted: ids above it are this run's new rows,
        # the only relink targets for a vanished one (see index.max_photo_id). The
        # connection object too — a backup restore mid-run swaps the DB, and the
        # snapshot (and the walk's diff against it) would then describe another one.
        max_id = index.max_photo_id()
        scan_db = index.get_db()
        footprints: list[ScanFootprint] = []
        for scan_dir in scan_dirs:
            if cancel is not None and cancel.is_set():
                break
            print(f"Scanning {scan_dir}...")
            footprint = ScanFootprint(scan_dir)
            footprints.append(footprint)
            # Looked up on the module at call time (not bound at import) so tests
            # can substitute scan_directory.
            count, skipped, warnings = scan_directory(scan_dir, cancel=cancel, footprint=footprint)
            totals["indexed"] += count
            totals["skipped"] += skipped
            s = get_scan_status()
            if s["root"] == str(scan_dir):  # the per-root counters are this root's
                totals["processed"] += s["processed"]
                totals["known_failed"] += s["known_failed"]
            if warnings:
                warning_count += len(warnings)
                _update_scan_state(warnings=warning_count)
                keep_warnings(warnings)
                # The console shows a sample; the full list is one request away
                # (and the files that couldn't be indexed persist in the DB).
                shown = warnings[:5]
                print(f"  Warnings: {len(warnings)}"
                      + (f" (first {len(shown)} below; all at GET /api/scan/errors)"
                         if len(warnings) > len(shown) else ""))
                for w in shown:
                    print(f"    {w}")
        if cancel is None or not cancel.is_set():
            index.save_last_scan_roots([str(d) for d in scan_dirs])
            # After ALL roots, not per root: a file moved from one scanned root
            # to another is inserted by the later root's scan, and per-root
            # pruning would already have deleted its old row.
            if index.get_db() is scan_db:
                _update_scan_state(phase="pruning", root=None)
                prune_warnings = _prune_vanished(footprints, max_id)
                _prune_scan_errors(footprints)
                if prune_warnings:
                    warning_count += len(prune_warnings)
                    _update_scan_state(warnings=warning_count)
                    keep_warnings(prune_warnings)
            else:
                print("  Not pruning: the database was replaced during the scan.")
    except Exception as e:
        error = str(e) or type(e).__name__
        print(f"ERROR: background scan failed: {e}", file=sys.stderr)
    finally:
        try:
            errors = index.count_scan_errors()
        except Exception:
            errors = get_scan_status()["errors"]
        cancelled = cancel is not None and cancel.is_set()
        summary = (f"{'Cancelled' if cancelled else 'Failed' if error else 'Finished'} in "
                   f"{time.time() - t_start:.0f}s: {totals['processed']} file(s) processed, "
                   f"{totals['indexed']} indexed, {totals['skipped']} unchanged, "
                   f"{warning_count} warning(s), {errors} file(s) could not be indexed")
        if totals["known_failed"]:
            summary += f" ({totals['known_failed']} unchanged since a previous failure, not retried)"
        print(f"Scan {summary[0].lower()}{summary[1:]}")
        if errors:
            print("  Files that could not be indexed are listed at GET /api/scan/errors "
                  "(and from the scan banner in the UI).")
        _update_scan_state(running=False, root=None, phase=None, error=error, errors=errors,
                           summary=summary, finished_at=time.time())


def _failure_is_transient(e: BaseException) -> bool:
    """Whether a failed metadata read may say nothing about the file itself, so
    it must be retried even if the file is unchanged. Opt-in the other way
    round: only failures known to come from the file's bytes are permanent —
    ExifTool rejecting it or returning unusable output, our parsing of that
    output, and a timeout (a file that hangs ExifTool tends to hang it every
    time, and each retry costs the whole watchdog deadline). Anything else —
    a locked file, a dropped drive, ExifTool dying — is retried."""
    from exiftool.exceptions import ExifToolExecuteException
    from geotagger import exiftool_session
    # ExifTool missing/not started: every file fails, and none of them is bad.
    if not exiftool_session.exiftool_status()["ok"]:
        return True
    return not isinstance(e, (exiftool_session.ExifToolTimeout, ExifToolExecuteException,
                              ValueError, TypeError))


def scan_directory(root: Path, show_progress: bool = True, generate_thumbnails: bool = True,
                   cancel: threading.Event | None = None,
                   footprint: ScanFootprint | None = None) -> tuple[int, int, list[str]]:
    """Scan a single directory and return (count, skipped, warnings).

    `cancel`, if set mid-scan, stops further files from being picked up (tasks
    already running finish); the partial counts are returned as usual.

    `footprint`, if given, records what the walk saw (for run_scan's prune) and
    is marked complete only if the scan wasn't cancelled. scan_directory itself
    never deletes anything."""
    from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

    def cancelled() -> bool:
        return cancel is not None and cancel.is_set()

    # total stays 0 until the file walk below finishes (the UI shows "counting files").
    _update_scan_state(root=str(root), phase="counting", processed=0, total=0, indexed=0,
                       skipped=0, known_failed=0)
    # Persisted per-file failures (see the scan_errors table): new/repeated
    # ones to record and recovered/known ones to clear, written by this thread
    # alongside the row batches — never one write per file.
    new_errors: list[tuple[str, str, str, str, float | None, int | None]] = []
    cleared_errors: list[tuple[str, str]] = []
    known_errors: dict = {}

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
    unreadable = footprint.unreadable if footprint is not None else None
    for p, media_type, xmp_names in scanner.walk_media(root, cancel=cancel, unreadable=unreadable):
        if cancelled():
            break
        media.append((p, media_type))
        try:
            # Path.stat(), not the walk's DirEntry.stat(): on NTFS the directory
            # listing can carry a stale mtime/size for a recently written file, and
            # the freshness check compares against these values.
            stat = p.stat()
            # The directory listing already says which .xmp names exist, so most
            # files (no sidecar) cost no sidecar stat at all. sidecar_tracking is
            # the same helper every sidecar writer records the row with, so the
            # freshness check compares like with like.
            if sidecar.sidecar_path(p).name.casefold() in xmp_names:
                sc_path_str, sc_mtime = sidecar.sidecar_tracking(p)
            else:
                sc_path_str, sc_mtime = None, None
            files_to_process.append((p, media_type, stat, sc_path_str, sc_mtime))
        except Exception as e:
            read_errors.append(f"Error reading {p.name}: {e}")
            # No stat to compare against, so always retried (mtime/size NULL).
            new_errors.append((str(p.parent), p.name, "stat", str(e) or type(e).__name__, None, None))
    warnings.extend(scanner.find_sidecar_collisions(media))
    warnings.extend(read_errors)
    if footprint is not None:
        # Every listed file counts as seen, including ones whose stat failed: the
        # file is there, so its row must not be pruned.
        sizes = {p: stat.st_size for p, _, stat, _, _ in files_to_process}
        for p, _ in media:
            footprint.seen.setdefault(str(p.parent), {})[p.name] = sizes.get(p)
        footprint.media_count = len(media)

    total_files = len(files_to_process)
    _update_scan_state(total=total_files, phase="indexing")

    # One batched lookup for the whole tree instead of a point SELECT per file
    # in the workers. Same inputs and rule as index.is_fresh. The rows are read
    # now rather than as each file comes up, which only matters for a row a web
    # request rewrites mid-scan; its sidecar stat above is equally old, so
    # comparing the two snapshots is at least consistent.
    if not cancelled():
        flags = index.fresh_flags([(str(p.parent), p.name, stat.st_mtime, sc_path_str, sc_mtime)
                                   for p, _, stat, sc_path_str, sc_mtime in files_to_process])
        # Also one range read per root (usually empty).
        known_errors = index.scan_errors_under_dir(str(root))
    else:
        flags = [False] * len(files_to_process)

    # Files whose metadata read failed before and that haven't changed since
    # (same mtime AND size) are not re-read: such a failure is a property of
    # the bytes (corrupt/unsupported file, an ExifTool hang), so retrying it on
    # every boot only re-spends the read — or the whole watchdog deadline — to
    # get the same error. Any change to the file retries it. Transient causes
    # are recorded without a stat (see _failure_is_transient) and so always
    # retried, and DELETE /api/scan/errors forces a retry of everything.
    known_bad = 0
    todo = []
    for f, fresh in zip(files_to_process, flags):
        p, _, stat, _, _ = f
        key = (str(p.parent), p.name)
        known = known_errors.get(key)
        if known is not None:
            if fresh:
                cleared_errors.append(key)  # indexed OK since (e.g. by a web request)
            elif (known["stage"] == "read" and known["mtime"] == stat.st_mtime
                    and known["size"] == stat.st_size):
                known_bad += 1
                continue
        todo.append((*f, fresh))
    files_to_process = todo
    # Counted as processed up front: nothing more happens to them this run.
    total_processed = known_bad
    _update_scan_state(processed=total_processed, known_failed=known_bad)

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
        msg = f"  Progress: {total_processed}/{total_files} files"
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
        failure = None  # the exception that left this file with no row

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
            failure = e

        # A failure after the metadata read (thumbnail) still keeps the row, as
        # it did when the worker wrote it before thumbnailing.
        return row, was_skipped, thumb_generated, thumb_cached, error_msg, worker_id, failure, file_info

    # Process files with a thread pool
    max_workers = config.WORKERS

    # Initialize display
    if show_progress:
        print()  # Initial progress line
        for i in range(max_workers):
            print(f"    Worker {i}: Idle".ljust(100))

    def flush_batch() -> None:
        nonlocal count
        rows, failed = batch.flush()
        if failed:
            with lock:
                # Counted as indexed when the worker finished; a row that didn't
                # land wasn't.
                count -= len(failed)
                warnings.extend(failed.values())
                _update_scan_state(indexed=count)
        for i, row in enumerate(rows):
            key = (row["dir_"], row["filename"])
            if i in failed:
                # A DB-side failure (disk full, I/O) says nothing about the
                # file: no stat, so it is always retried.
                new_errors.append((*key, "write", failed[i], None, None))
            elif key in known_errors:
                cleared_errors.append(key)
        write_errors()

    def write_errors() -> None:
        """Persist the pending error changes. Best-effort: failing to record a
        diagnostic must not fail the scan (the warning list still has it)."""
        if not (new_errors or cleared_errors):
            return
        recorded, cleared = list(new_errors), list(cleared_errors)
        new_errors.clear()
        cleared_errors.clear()
        try:
            index.clear_scan_errors(cleared)
            index.record_scan_errors(recorded)
            refresh_error_count()
        except Exception as e:
            warnings.append(f"Could not record scan errors: {e}")

    def handle_result(future) -> None:
        nonlocal count, skipped, thumbs_generated, thumbs_cached, total_processed
        if future.cancelled():
            return
        result = future.result()
        if result is None:  # skipped due to cancel: not "processed"
            return
        row, was_skipped, thumb_gen, thumb_cach, error, worker_id, failure, file_info = result
        if row is not None:
            batch.add(row)
        elif failure is not None:
            p, _, stat, _, _, _ = file_info
            msg = str(failure) or type(failure).__name__
            if _failure_is_transient(failure):
                new_errors.append((str(p.parent), p.name, "read", msg, None, None))
            else:
                new_errors.append((str(p.parent), p.name, "read", msg, stat.st_mtime, stat.st_size))

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
                        # The error bound: a run where every file fails has no
                        # rows to flush, and the banner's count should still move.
                        if batch.due() or len(new_errors) >= _SCAN_BATCH_ROWS:
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

    if footprint is not None and not cancelled():
        footprint.complete = True

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
        _update_scan_state(phase="geocoding")
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


# ── Pruning vanished files (audit S2) ──
# Rows for files that are gone used to stay forever (500 on thumbnail), and a
# moved file became a fresh row, losing its faces and any DB-only geotag. After
# a complete run, each pre-existing row under a scanned root that the walk did
# not see is either relinked to this run's new row for the same bytes (a move)
# or deleted (gone). Deleting destroys DB-only user data, so a doubt about
# whether the file is really gone resolves to "keep the row": a stale row is a
# cosmetic bug, a wrongly deleted one is not.
#
# Thumbnail cache files of deleted rows are left in place: they are keyed on a
# hash of path+mtime+size (plus orientation variants), nothing reads them once
# the row is gone, and they cost a few KB each.

# Below this many deletions in a root the fraction guard doesn't apply — small
# libraries legitimately lose most of a handful of files at once. The "walk saw
# nothing" guard still covers a root that vanished wholesale.
_PRUNE_GUARD_FLOOR = 20
# Rows per write unit. Each unit holds the global write lock (see _UpsertBatch);
# a relink is an upsert per pair, a delete is set-based and cheaper.
_RELINK_BATCH = _SCAN_BATCH_ROWS
_DELETE_BATCH = 1000


def _prune_scan_errors(footprints: list[ScanFootprint]) -> None:
    """Drop recorded scan errors for files a complete walk no longer saw. Same
    root/subdirectory guards as _prune_vanished, though nothing of value is lost
    if one goes wrongly: the file would simply be re-read and re-recorded."""
    import os
    gone: list[tuple[str, str]] = []
    for fp in footprints:
        if not fp.complete or fp.media_count == 0 or fp.root in fp.unreadable:
            continue
        guards = tuple(d if d.endswith(os.sep) else d + os.sep for d in fp.unreadable)
        for d, name in index.scan_errors_under_dir(fp.root):
            if name in fp.seen.get(d, ()):
                continue
            if guards and (d + os.sep).startswith(guards):
                continue
            gone.append((d, name))
    if gone:
        try:
            index.clear_scan_errors(gone)
        except Exception as e:
            print(f"  Could not clear scan errors of vanished files: {e}")


def _pair_moves(vanished: list, candidates: list) -> tuple[list[tuple[int, int]], int]:
    """Match vanished rows to this run's new rows by checksum. Returns
    ((old_id, new_id) pairs, number of vanished rows left unpaired although a
    same-checksum new row existed).

    A checksum shared by exactly one vanished and one new row is a move.
    Identical files (several copies of one photo) make a tie; it is broken only
    by an identical filename that is unique on both sides — a moved folder of
    duplicates keeps its names. Anything still tied is left unpaired rather than
    guessed: relinking the wrong copy would put one copy's face tags and
    DB-only geotag on another copy's path."""
    from collections import Counter, defaultdict
    by_sum_new: dict[str, list] = defaultdict(list)
    for r in candidates:
        by_sum_new[r["checksum"]].append(r)
    by_sum_old: dict[str, list] = defaultdict(list)
    for r in vanished:
        if r["checksum"] is not None:
            by_sum_old[r["checksum"]].append(r)
    pairs: list[tuple[int, int]] = []
    ambiguous = 0
    for checksum, olds in by_sum_old.items():
        news = by_sum_new.get(checksum)
        if not news:
            continue
        if len(olds) == 1 and len(news) == 1:
            pairs.append((olds[0]["id"], news[0]["id"]))
            continue
        old_names = Counter(r["filename"] for r in olds)
        new_by_name: dict[str, list] = defaultdict(list)
        for r in news:
            new_by_name[r["filename"]].append(r)
        for r in olds:
            match = new_by_name.get(r["filename"], [])
            if old_names[r["filename"]] == 1 and len(match) == 1:
                pairs.append((r["id"], match[0]["id"]))
            else:
                ambiguous += 1
    return pairs, ambiguous


def _prune_vanished(footprints: list[ScanFootprint], max_id: int) -> list[str]:
    """Relink moved files and delete vanished ones under the roots that were
    scanned completely; prints a one-line summary and returns warnings.

    A root is skipped entirely (nothing relinked or deleted under it) when its
    scan didn't complete, the root is missing or unlistable now (unplugged
    drive) or was unlistable during the walk, or the walk found no media at all.
    Within a root, a vanished row is kept when it is under a subdirectory the
    walk couldn't list, or when it might be the source of a file this run saw but
    couldn't fully index (no row, or no checksum to relink by — matched on file
    size, which a move preserves). Finally, a root whose deletions exceed
    config.SCAN_PRUNE_MAX_FRACTION of its rows keeps them all, loudly. Relinks
    are never refused: they lose nothing.

    A vanished row with an ambiguous checksum match (see _pair_moves) is deleted
    like any other unmatched row — the next run would see no new row to match
    it to anyway — and counted in a warning."""
    import os
    t0 = time.time()
    warnings: list[str] = []
    vanished: dict[int, object] = {}       # id -> row (deduped across nested roots)
    vanished_root: dict[int, str] = {}
    existing_per_root: dict[str, int] = {}
    blocked_roots: set[str] = set()        # roots where nothing may be deleted
    # Sizes of seen files that have no row, or no checksum: a vanished row of
    # that size may be one of them, moved, and must wait for a run that indexes it.
    unindexed_sizes: set[int] = set()
    new_sizes: set[int] = set()            # sizes of this run's new rows

    for fp in footprints:
        if not fp.complete:
            continue
        root = Path(fp.root)
        try:
            root_ok = root.is_dir()
        except OSError:
            root_ok = False
        reason = None
        if not root_ok:
            reason = "the folder is missing or unreadable"
        elif fp.root in fp.unreadable:
            reason = "the folder could not be listed"
        elif fp.media_count == 0:
            reason = "no media files were found (unmounted or emptied drive?)"
        if reason:
            warnings.append(f"Not pruning {fp.root}: {reason}")
            continue
        guards = tuple(d if d.endswith(os.sep) else d + os.sep for d in fp.unreadable)
        rows = index.photos_under_dir(fp.root)
        row_keys: set[tuple[str, str]] = set()
        existing = 0
        for r in rows:
            row_keys.add((r["dir"], r["filename"]))
            if r["id"] > max_id:  # inserted by this run
                new_sizes.add(r["size"])
                if r["checksum"] is None:
                    unindexed_sizes.add(r["size"])
                continue
            existing += 1
            seen_dir = fp.seen.get(r["dir"])
            if seen_dir is not None and r["filename"] in seen_dir:
                continue  # still there
            if guards and (r["dir"] + os.sep).startswith(guards):
                continue  # under a directory the walk couldn't list: unknown, keep
            if r["id"] not in vanished:
                vanished[r["id"]] = r
                vanished_root[r["id"]] = fp.root
        existing_per_root[fp.root] = existing_per_root.get(fp.root, 0) + existing
        # Seen files the index has no row for (failed metadata read or upsert).
        for d, names in fp.seen.items():
            for name, size in names.items():
                if (d, name) in row_keys:
                    continue
                if size is None:
                    # Not even a size to match on: any vanished row could be it.
                    blocked_roots.add(fp.root)
                    warnings.append(f"Not removing vanished files under {fp.root}: "
                                    f"{Path(d) / name} could not be read")
                else:
                    unindexed_sizes.add(size)

    relinked = removed = kept = ambiguous = 0
    if vanished:
        rows = list(vanished.values())

        # ── Relink moves ──
        checksums = sorted({r["checksum"] for r in rows if r["checksum"] is not None})
        candidates = index.new_photos_with_checksums(checksums, max_id)
        pairs, ambiguous = _pair_moves(rows, candidates)
        if ambiguous:
            warnings.append(f"{ambiguous} vanished file(s) match several identical new "
                            f"files; removed rather than relinked to a guess")
        for start in range(0, len(pairs), _RELINK_BATCH):
            relinked += index.relink_moved_photos(pairs[start:start + _RELINK_BATCH])
        paired = {o for o, _ in pairs}

        # ── Delete the rest ──
        delete_by_root: dict[str, list[int]] = {}
        for r in rows:
            if r["id"] in paired:
                continue
            root_str = vanished_root[r["id"]]
            # Possibly moved to a file this run couldn't index (or, for a row from
            # before checksums, can't verify): keep it for a later run to settle.
            if (root_str in blocked_roots or r["size"] in unindexed_sizes
                    or (r["checksum"] is None and r["size"] in new_sizes)):
                kept += 1
                continue
            delete_by_root.setdefault(root_str, []).append(r["id"])

        to_delete: list[int] = []
        for root_str, ids in delete_by_root.items():
            existing = existing_per_root.get(root_str, 0)
            if config.SCAN_PRUNE_MAX_FRACTION <= 0:
                kept += len(ids)  # deletes disabled; moves above still relinked
                continue
            if len(ids) > _PRUNE_GUARD_FLOOR and len(ids) > config.SCAN_PRUNE_MAX_FRACTION * existing:
                kept += len(ids)
                msg = (f"Refusing to remove {len(ids)} of {existing} indexed file(s) under "
                       f"{root_str}: more than {config.SCAN_PRUNE_MAX_FRACTION:.0%} vanished at "
                       f"once. If they really are gone, raise GEOTAGGER_SCAN_PRUNE_MAX_FRACTION "
                       f"and rescan.")
                print(f"WARNING: {msg}", file=sys.stderr)
                warnings.append(msg)
                continue
            to_delete.extend(ids)

        for start in range(0, len(to_delete), _DELETE_BATCH):
            removed += index.delete_photos(to_delete[start:start + _DELETE_BATCH])

        if relinked or removed:
            # Cached work-queue batches / hotspot clusters were built over the old
            # rows and would offer deleted ids or stale points.
            from geotagger.services import hotspots_service, work_queue_service
            hotspots_service.invalidate()
            work_queue_service.invalidate()

    msg = f"  Pruned: relinked {relinked} moved file(s), removed {removed} vanished file(s)"
    if kept:
        msg += f", kept {kept} unconfirmed"
    print(f"{msg} ({(time.time() - t0) * 1000:.0f}ms)")
    for w in warnings:
        print(f"  {w}")
    return warnings
