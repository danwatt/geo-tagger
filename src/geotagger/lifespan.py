"""App lifespan: initialize the request executor and ExifTool session, then set up
the index/thumbnails/faces caches and (unless --no-scan) scan the configured
directories in a background thread so the server accepts requests immediately."""

import asyncio
import os
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from geotagger import index, thumbnails, faces, semantic, config, scanning
from geotagger.exiftool_session import lifespan as _et_lifespan
from geotagger.executor import init_executor


def _auto_vacuum():
    """Reclaim DB free-list space if it's grown large (see index.vacuum_if_needed).
    Best-effort: a VACUUM failure (e.g. no free disk space for the rewrite)
    shouldn't block startup."""
    if not config.AUTO_VACUUM:
        return
    try:
        result = index.vacuum_if_needed(config.AUTO_VACUUM_THRESHOLD, config.AUTO_VACUUM_PAGE_SIZE)
        if result["vacuumed"]:
            resize_note = f", page_size→{result['page_size']}" if result.get("resized") else ""
            print(f"Vacuumed database: {result['freelist_count']}/{result['page_count']} "
                  f"free pages ({result['free_ratio']:.0%}) reclaimed in {result['seconds']:.1f}s"
                  f"{resize_note}")
    except Exception as e:
        print(f"Auto-vacuum skipped: {e}")


def _init_caches(root: Path) -> None:
    """Open the DB and every per-root cache under `root`. The single place that
    knows the init order, so a new subsystem can't be wired into only one of the
    startup branches (scan-dirs vs. legacy last-root)."""
    index.init_db(root)
    config.apply_all_overrides(index.get_all_settings())
    _auto_vacuum()
    thumbnails.init_thumbs(root)
    faces.init_faces(root)
    semantic.init_semantic(root)


def _primary_root() -> Path | None:
    """The scan root whose cache_dir doubles as the default location for
    downloaded tools/ and data/ (see config.resolve_data_paths) — the first
    --scan-dir this run, or the legacy last-scanned root, before any scan has
    actually happened."""
    scan_dirs_env = os.environ.get("GEOTAGGER_SCAN_DIRS")
    if scan_dirs_env:
        scan_dirs = [d.strip() for d in scan_dirs_env.split("\n") if d.strip()]
        if scan_dirs:
            return Path(scan_dirs[0])
        return None
    last_root = index.get_last_scan_root()
    return Path(last_root) if last_root else None


@asynccontextmanager
async def lifespan(app):
    # Initialize thread pool
    max_workers = int(os.environ.get("GEOTAGGER_WORKERS", "4"))
    init_executor(max_workers)

    # Resolve tools/data default location (alongside the primary root's cache_dir)
    # before ExifTool starts, so it looks in the right place for the bundled binary.
    config.resolve_data_paths(_primary_root())

    # Idle state (also clears anything left over from a previous app instance).
    scanning.reset_scan_state()
    scan_cancel = threading.Event()
    scan_thread: threading.Thread | None = None

    async with _et_lifespan(app):
        no_scan = os.environ.get("GEOTAGGER_NO_SCAN") == "1"

        # Check for pre-configured scan directories
        scan_dirs_env = os.environ.get("GEOTAGGER_SCAN_DIRS")
        if scan_dirs_env:
            scan_dirs = [Path(d.strip()) for d in scan_dirs_env.split("\n") if d.strip()]
            try:
                # If GEOTAGGER_CACHE_DIR isn't set, the cache lives under the first
                # scan directory (matching the single-root fallback below).
                _init_caches(scan_dirs[0])
            except Exception as e:
                print(f"FATAL: startup initialization failed: {e}", file=sys.stderr)
                raise

            if no_scan:
                print("Skipping scan (--no-scan), using existing database")
            else:
                print(f"Initialized cache with {len(scan_dirs)} scan directories")
                # A dedicated thread, NOT the shared request executor: a scan can
                # run for minutes and must not occupy request workers. It uses the
                # shared ExifTool session, so shutdown (below) joins it before the
                # ExifTool context exits.
                scan_thread = threading.Thread(
                    target=scanning.run_scan, args=(scan_dirs, scan_cancel),
                    name="startup-scan", daemon=True)
                scan_thread.start()
        else:
            # Legacy: Auto-reconnect to the last scanned directory
            last_root = index.get_last_scan_root()
            if last_root:
                root = Path(last_root)
                try:
                    _init_caches(root)
                    if no_scan:
                        print(f"Skipping scan (--no-scan), loaded index from {root}")
                    else:
                        print(f"Auto-loaded index from {root}")
                except Exception as e:
                    print(f"FATAL: failed to load previous scan directory {root}: {e}", file=sys.stderr)
                    raise
        try:
            yield
        finally:
            if scan_thread is not None:
                scan_cancel.set()
                # Off the event loop: the join can take as long as the slowest
                # in-flight file task.
                await asyncio.to_thread(scan_thread.join)
