"""
Backfill the full EXIF snapshot (and orientation) for the indexed photo library.

For every indexed file that doesn't have one yet, reads the complete ExifTool
metadata and stores it as JSON in photos.exif_json so every tag is searchable
later. Orientation (1..8) is derived from the same read and kept in its own
photos.orientation column, which the grid, previews, and face crops read to
render upright. The scanner now fills both columns for new/changed files itself;
this one-time pass is for rows indexed before the columns existed (exif_json=NULL).
Safe to re-run — it only touches rows where exif_json IS NULL. Files ExifTool
can't read (or that time out) get orientation 1 and a small error marker so the
run completes and they aren't retried into the hang.

Run:  uv run python scripts/backfill_orientation.py
      uv run python scripts/backfill_orientation.py --cache-dir D:/path/.geotagger
      uv run python scripts/backfill_orientation.py --rescan     # re-read every file
"""
import argparse
import json
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


# Sentinel exif_json for a file we couldn't read: valid JSON so later JSON1
# queries don't choke, and non-NULL so the row clears the pending queue instead
# of re-hanging on every run. Searchable by its "_geotagger_error" key.
_ERR_TIMEOUT = json.dumps({"_geotagger_error": "read timed out"})
_ERR_FAILED = json.dumps({"_geotagger_error": "read failed"})


def exif_row(pid: int, meta: dict | None, error: str | None = None) -> tuple[int, str, int]:
    """Build a (orientation, exif_json, photo_id) triple for index.set_exif() from
    one file's ExifTool metadata. Orientation is coerced to 1..8 (default 1) and
    kept top-level for the UI; the full dict is serialized to JSON. `error` (or a
    missing `meta`) stores an error marker instead so the row still clears."""
    if error is not None or not meta:
        return 1, (_ERR_TIMEOUT if error == "timeout" else _ERR_FAILED), pid
    orientation = sidecar._coerce_orientation(meta.get("EXIF:Orientation"))
    # Same serializer the scanner uses, so scan-time and backfill JSON are identical.
    return orientation, sidecar.dumps_exif(meta), pid


def read_chunk_per_file(chunk, timeout_s: float) -> tuple[list[tuple[int, str, int]], int]:
    """Re-read a wedged batch one file at a time so a single hanging file can be
    timed out, logged, and skipped instead of stalling the whole run.

    Returns ``(updates, n_timeouts)`` where ``updates`` is a list of
    (orientation, exif_json, photo_id) triples ready for index.set_exif(). A file
    that hangs past ``timeout_s`` (or otherwise fails) gets orientation 1 and an
    error marker so the run completes and the file isn't retried into the same hang
    next time. Each skipped file's path is logged for inspection / re-run."""
    updates: list[tuple[int, str, int]] = []
    n_timeouts = 0
    for r in chunk:
        p = r["path"]
        try:
            metas = run_with_timeout(lambda: sidecar.read_all_metadata([p]), timeout_s)
            updates.append(exif_row(r["id"], metas.get(Path(p))))
        except TimeoutError:
            n_timeouts += 1
            updates.append(exif_row(r["id"], None, error="timeout"))
            print(f"    TIMEOUT (> {timeout_s:.0f}s), skipping: {p}", file=sys.stderr)
            restart_et()  # the timeout killed the session; revive it for the next file
        except Exception as e:
            updates.append(exif_row(r["id"], None, error="failed"))
            print(f"    ERROR reading {p}: {e}", file=sys.stderr)
    return updates, n_timeouts


def main():
    parser = argparse.ArgumentParser(description="Backfill EXIF orientation across the library")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--limit", type=int, default=0, help="Max files to read (0 = all)")
    parser.add_argument("--rescan", action="store_true",
                        help="Re-read even rows that already have an EXIF snapshot")
    parser.add_argument("--batch-size", type=int, default=100,
                        help="Files per ExifTool call + per DB transaction (default 100)")
    parser.add_argument("--timeout", type=float, default=10.0,
                        help="Per-file read timeout in seconds; a file that hangs longer "
                             "is logged and skipped (default 10)")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)

    if args.rescan:
        db = index.get_db()
        db.execute("UPDATE photos SET orientation=NULL, exif_json=NULL")
        db.commit()

    pending = index.get_photos_missing_exif(args.limit or None)
    if not pending:
        print("Nothing to do — every indexed file already has its EXIF snapshot.")
        return

    if not start_et():
        sys.exit("ExifTool unavailable — run: uv run python scripts/get_exiftool.py")

    print(f"Reading full EXIF for {len(pending)} file(s)…")
    t0 = time.time()
    done = errors = timeouts = 0
    dist: dict[int, int] = {}  # orientation value -> count, for a summary
    # A healthy metadata read of a whole batch takes at most a few seconds, so give
    # the batch a generous ceiling: if it exceeds this, one of its files has wedged
    # ExifTool and we fall back to reading the batch a file at a time.
    batch_timeout = max(30.0, args.timeout)
    try:
        for start in range(0, len(pending), args.batch_size):
            chunk = pending[start:start + args.batch_size]
            paths = [r["path"] for r in chunk]
            try:
                metas = run_with_timeout(lambda: sidecar.read_all_metadata(paths), batch_timeout)
                updates = [exif_row(r["id"], metas.get(Path(r["path"]))) for r in chunk]
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
            for o, _ej, _pid in updates:
                dist[o] = dist.get(o, 0) + 1
            index.set_exif(updates)  # one executemany + one commit for the whole batch
            done += len(updates)
            print(f"  [{done}/{len(pending)}] committed")
    finally:
        stop_et()

    dt = time.time() - t0
    summary = ", ".join(f"{o}×{n}" for o, n in sorted(dist.items()))
    print(f"\nDone: stored EXIF for {done} file(s) in {dt:.1f}s "
          f"({errors} errors, {timeouts} timed out).")
    print(f"Orientation distribution (value×count): {summary}")


if __name__ == "__main__":
    main()
