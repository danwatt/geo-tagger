"""
Backfill SHA-256 checksums for the indexed photo library.

Hashes the bytes of every indexed file that doesn't yet have a checksum and
stores the digest in the DB. This is the one-time job for libraries indexed
before the checksum column existed; going forward the scanner hashes new and
changed files itself, so this only ever fills in the gaps. Safe to re-run — it
only touches rows where checksum IS NULL.

Run:  uv run python scripts/backfill_checksums.py
      uv run python scripts/backfill_checksums.py --cache-dir D:/path/.geotagger
      uv run python scripts/backfill_checksums.py --rescan     # re-hash every file
"""
import argparse
import os
import sys
import time
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index, scanner  # noqa: E402


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


def main():
    parser = argparse.ArgumentParser(description="Backfill file checksums across the library")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--limit", type=int, default=0, help="Max files to hash (0 = all)")
    parser.add_argument("--rescan", action="store_true", help="Re-hash even files that already have a checksum")
    parser.add_argument("--batch-size", type=int, default=100,
                        help="Rows per DB transaction — larger = fewer commits (default 100)")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)

    if args.rescan:
        db = index.get_db()
        db.execute("UPDATE photos SET checksum=NULL")
        db.commit()

    pending = index.get_photos_missing_checksum(args.limit or None)
    if not pending:
        print("Nothing to do — every indexed file already has a checksum.")
        return

    print(f"Hashing {len(pending)} file(s)…")
    t0 = time.time()
    done = errors = 0
    pairs: list[tuple[str, int]] = []  # (checksum, photo_id) buffered for a batch commit
    for i, row in enumerate(pending, 1):
        path = Path(row["path"])
        try:
            pairs.append((scanner.file_checksum(path), row["id"]))
            done += 1
        except Exception as e:
            errors += 1
            print(f"  [{i}/{len(pending)}] {path.name}: ERROR {e}", file=sys.stderr)
        if len(pairs) >= args.batch_size:
            index.set_checksums(pairs)  # one executemany + one commit for the whole batch
            pairs.clear()
            print(f"  [{i}/{len(pending)}] committed ({done} hashed, {errors} errors)")
    index.set_checksums(pairs)  # flush the tail

    dt = time.time() - t0
    print(f"\nDone: hashed {done} file(s) in {dt:.1f}s ({errors} errors).")


if __name__ == "__main__":
    main()
