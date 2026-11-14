"""
Backfill SHA-256 checksums for the indexed photo library.

Hashes the bytes of every indexed file that doesn't yet have a checksum and
stores the digest in the DB. This is the one-time job for libraries indexed
before the checksum column existed; going forward the scanner hashes new and
changed files itself, so this only ever fills in the gaps. Safe to re-run — it
only touches rows where checksum IS NULL.

Run:  uv run python scripts/backfill_checksums.py
      uv run python scripts/backfill_checksums.py --cache-dir D:/path/.geotagger
      uv run python scripts/backfill_checksums.py --rescan --dry-run  # preview the reset
      uv run python scripts/backfill_checksums.py --rescan --yes      # re-hash every file

--rescan clears every stored checksum before re-hashing, so it only runs with
--yes; without it the script prints what it would clear and exits non-zero.
--dry-run reports the counts and changes nothing.
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Backfill file checksums across the library")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--limit", type=int, default=0, help="Max files to hash (0 = all)")
    parser.add_argument("--rescan", action="store_true",
                        help="Clear every stored checksum and re-hash all files (needs --yes)")
    parser.add_argument("--yes", action="store_true", help="Confirm the --rescan reset")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be cleared and hashed and exit, changing nothing")
    parser.add_argument("--batch-size", type=int, default=100,
                        help="Rows per DB transaction — larger = fewer commits (default 100)")
    args = parser.parse_args(argv)

    root = resolve_root(args)
    index.init_db(root)

    # ── Reset gate ──
    if args.rescan:
        n_set = index.get_db().execute(
            "SELECT COUNT(*) FROM photos WHERE checksum IS NOT NULL").fetchone()[0]
        summary = f"--rescan would clear {n_set} stored checksum(s) and re-hash every indexed file"
        if args.dry_run:
            n_all = index.get_db().execute("SELECT COUNT(*) FROM photos").fetchone()[0]
            print(f"{summary} ({n_all} file(s)). Dry run — nothing changed.")
            return 0
        if not args.yes:
            print(f"{summary}.\nRe-run with --yes to proceed (or --dry-run to preview).",
                  file=sys.stderr)
            return 2
        with index.transaction() as db:
            db.execute("UPDATE photos SET checksum=NULL WHERE checksum IS NOT NULL")
        print(f"Cleared {n_set} stored checksum(s).")

    pending = index.get_photos_missing_checksum(args.limit or None)
    if args.dry_run:
        print(f"Would hash {len(pending)} file(s). Dry run — nothing changed.")
        return 0
    if not pending:
        print("Nothing to do — every indexed file already has a checksum.")
        return 0

    print(f"Hashing {len(pending)} file(s)…")
    t0 = time.time()
    done = errors = 0
    pairs: list[tuple[str, int]] = []  # (checksum, photo_id) buffered for a batch commit
    for i, row in enumerate(pending, 1):
        path = Path(index.photo_path(row))
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
