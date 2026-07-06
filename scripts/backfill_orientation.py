"""
Backfill EXIF orientation for indexed photos that don't have it yet
(orientation IS NULL) — rows indexed before the scanner read the tag, or whose
read failed at scan time. The scanner fills orientation itself for new/changed
files; this one-time pass is for pre-existing rows. Safe to re-run — it only
touches rows with orientation IS NULL. Files ExifTool can't read (or that time
out) default to orientation 1 so the run completes and they aren't retried
into the same hang.

Run:  uv run python scripts/backfill_orientation.py
      uv run python scripts/backfill_orientation.py --cache-dir D:/path/.geotagger
"""
import argparse
import os
import sys
import time
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index, sidecar  # noqa: E402
from geotagger.exiftool_session import (  # noqa: E402
    start_et, stop_et, restart_et, run_with_timeout,
)


def resolve_root(args) -> Path | None:
    """Pick the cache location the same way the server does."""
    if args.cache_dir:
        os.environ["GEOTAGGER_CACHE_DIR"] = str(Path(args.cache_dir).resolve())
        return None
    if os.environ.get("GEOTAGGER_CACHE_DIR"):
        return None
    last = index.get_last_scan_root() if hasattr(index, "get_last_scan_root") else None
    if not last:
        sys.exit("No cache directory found. Pass --cache-dir or run a scan first.")
    return Path(last)


def read_chunk_per_file(chunk, timeout_s: float) -> tuple[list[tuple[int, int]], int]:
    """Re-read a wedged batch one file at a time so a single hanging file can be
    timed out, logged, and skipped instead of stalling the whole run.

    Returns ``(updates, n_timeouts)`` where ``updates`` is a list of
    (orientation, photo_id) pairs ready for index.set_orientations(). A file that
    hangs past ``timeout_s`` (or otherwise fails) defaults to orientation 1 so the
    run completes and the file isn't retried into the same hang next time."""
    updates: list[tuple[int, int]] = []
    n_timeouts = 0
    for r in chunk:
        p = index.photo_path(r)
        try:
            oris = run_with_timeout(lambda: sidecar.read_orientations([p]), timeout_s)
            updates.append((oris[Path(p)], r["id"]))
        except TimeoutError:
            n_timeouts += 1
            updates.append((1, r["id"]))
            print(f"    TIMEOUT (> {timeout_s:.0f}s), skipping: {p}", file=sys.stderr)
            restart_et()  # the timeout killed the session; revive it for the next file
        except Exception as e:
            updates.append((1, r["id"]))
            print(f"    ERROR reading {p}: {e}", file=sys.stderr)
    return updates, n_timeouts


def main():
    parser = argparse.ArgumentParser(description="Backfill EXIF orientation across the library")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--limit", type=int, default=0, help="Max files to read (0 = all)")
    parser.add_argument("--batch-size", type=int, default=100,
                        help="Files per ExifTool call + per DB transaction (default 100)")
    parser.add_argument("--timeout", type=float, default=10.0,
                        help="Per-file read timeout in seconds; a file that hangs longer "
                             "is logged and skipped (default 10)")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)

    pending = index.get_photos_missing_orientation(args.limit or None)
    if not pending:
        print("Nothing to do — every indexed file already has an orientation.")
        return

    if not start_et():
        sys.exit("ExifTool unavailable — run: uv run python scripts/get_exiftool.py")

    print(f"Reading orientation for {len(pending)} file(s)…")
    t0 = time.time()
    done = errors = timeouts = 0
    dist: dict[int, int] = {}  # orientation value -> count, for a summary
    # A healthy read of a whole batch takes at most a few seconds, so give the
    # batch a generous ceiling: if it exceeds this, one of its files has wedged
    # ExifTool and we fall back to reading the batch a file at a time.
    batch_timeout = max(30.0, args.timeout)
    try:
        for start in range(0, len(pending), args.batch_size):
            chunk = pending[start:start + args.batch_size]
            paths = [index.photo_path(r) for r in chunk]
            try:
                oris = run_with_timeout(lambda: sidecar.read_orientations(paths), batch_timeout)
                updates = [(oris[Path(index.photo_path(r))], r["id"]) for r in chunk]
            except TimeoutError:
                # The batch wedged on some file. run_with_timeout killed the session;
                # bring it back and isolate the culprit(s) with a per-file timeout.
                print(f"  batch at {start}: no response in {batch_timeout:.0f}s — "
                      f"isolating files one at a time", file=sys.stderr)
                if not restart_et():
                    errors += len(chunk)
                    print(f"  batch at {start}: ExifTool would not restart; skipping",
                          file=sys.stderr)
                    continue
                updates, n_timeouts = read_chunk_per_file(chunk, args.timeout)
                timeouts += n_timeouts
            except Exception as e:
                errors += len(chunk)
                print(f"  batch at {start}: ERROR {e}", file=sys.stderr)
                continue
            for o, _pid in updates:
                dist[o] = dist.get(o, 0) + 1
            index.set_orientations(updates)  # one executemany + one commit for the whole batch
            done += len(updates)
            print(f"  [{done}/{len(pending)}] committed")
    finally:
        stop_et()

    dt = time.time() - t0
    summary = ", ".join(f"{o}×{n}" for o, n in sorted(dist.items()))
    print(f"\nDone: stored orientation for {done} file(s) in {dt:.1f}s "
          f"({errors} errors, {timeouts} timed out).")
    print(f"Orientation distribution (value×count): {summary}")


if __name__ == "__main__":
    main()