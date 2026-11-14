"""
Run a face-detection pass over the indexed photo library.

Detects faces in every image that hasn't been scanned yet and stores their
embeddings so they can be recognized later. Safe to re-run; it only processes
photos with no prior face scan.

--rescan and --rescan-empty reset scan state library-wide, so they only run
with --yes; without it they print what they would reset and exit non-zero.
--rescan is the dangerous one: re-detection replaces each photo's faces from
scratch, discarding the person tags on them. --dry-run reports the counts and
changes nothing.

Run:  uv run python scripts/scan_faces.py
      uv run python scripts/scan_faces.py --cache-dir D:/path/.geotagger
      uv run python scripts/scan_faces.py --rescan --dry-run   # preview the reset
      uv run python scripts/scan_faces.py --rescan --yes       # redo every photo
      uv run python scripts/scan_faces.py --rescan-empty --yes # redo photos with no faces (tag-safe)
"""
import argparse
import os
import sys
import time
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index, thumbnails, faces  # noqa: E402
from geotagger.exiftool_session import start_et, stop_et  # noqa: E402


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


# --rescan: every image that has been scanned (or failed to scan) goes back on
# the queue. Rows already NULL on both are already pending, so leaving them out
# of the WHERE changes nothing but makes the count mean "photos re-queued".
_RESCAN_WHERE = ("media_type='image' AND "
                 "(faces_scanned_at IS NOT NULL OR faces_scan_error IS NOT NULL)")
# --rescan-empty, the repair for audit F1: before the fix, a model that failed to
# load marked every photo "scanned, 0 faces", indistinguishable from a real empty
# scan. Re-queue only photos with no face rows at all (detected, manual, ignored):
# rescanning those can't delete a tag. Legit no-face photos just cost one more
# detection each.
_RESCAN_EMPTY_WHERE = ("media_type='image' AND faces_scanned_at IS NOT NULL "
                       "AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = photos.id)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Detect faces across the library")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--limit", type=int, default=0, help="Max photos to process (0 = all)")
    reset = parser.add_mutually_exclusive_group()
    reset.add_argument("--rescan", action="store_true",
                       help="Re-detect even already-scanned photos (DISCARDS person tags on "
                            "them; needs --yes)")
    reset.add_argument("--rescan-empty", action="store_true",
                       help="Re-queue scanned photos that have no faces at all (safe for tags; "
                            "needs --yes)")
    parser.add_argument("--yes", action="store_true",
                        help="Confirm a --rescan/--rescan-empty reset of scan state")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be reset and scanned and exit, changing nothing")
    args = parser.parse_args(argv)

    root = resolve_root(args)
    index.init_db(root)

    # ── Reset gate ── decide before starting ExifTool so a refused or dry run
    # costs nothing beyond opening the DB.
    db = index.get_db()
    where = _RESCAN_WHERE if args.rescan else _RESCAN_EMPTY_WHERE if args.rescan_empty else None
    if where:
        flag = "--rescan" if args.rescan else "--rescan-empty"
        n_reset = db.execute(f"SELECT COUNT(*) FROM photos WHERE {where}").fetchone()[0]
        n_tags = db.execute(
            f"SELECT COUNT(*) FROM faces WHERE person_id IS NOT NULL AND photo_id IN "
            f"(SELECT id FROM photos WHERE {where})"
        ).fetchone()[0]
        summary = f"{flag} would re-queue {n_reset} already-scanned photo(s) for face detection"
        if n_tags:
            summary += f", discarding {n_tags} person tag(s) on them when they are re-detected"
        if args.dry_run:
            print(f"{summary}.")
            print(f"{len(index.get_unscanned_photo_ids())} photo(s) are already pending. "
                  "Dry run — nothing changed.")
            return 0
        if not args.yes:
            print(f"{summary}.\nRe-run with --yes to proceed (or --dry-run to preview).",
                  file=sys.stderr)
            return 2
        with index.transaction() as db:
            if args.rescan:
                n = db.execute("UPDATE photos SET faces_scanned_at=NULL, faces_scan_error=NULL "
                               f"WHERE {where}").rowcount
            else:
                n = db.execute("UPDATE photos SET faces_scanned_at=NULL, faces_det_dimension=NULL "
                               f"WHERE {where}").rowcount
        print(f"Re-queued {n} scanned photo(s).")

    pending = index.get_unscanned_photo_ids()
    if args.limit:
        pending = pending[: args.limit]

    if args.dry_run:
        print(f"Would scan {len(pending)} photo(s) for faces. Dry run — nothing changed.")
        return 0
    if not pending:
        print("Nothing to do — all photos already scanned for faces.")
        return 0

    thumbnails.init_thumbs(root)
    faces.init_faces(root)
    # RAW/HEIC/video previews are extracted via ExifTool, so the shared session
    # must be running — the server starts it in its lifespan; we start it here.
    start_et()

    print(f"Loading model and scanning {len(pending)} photos…")
    # Load up front so a broken model fails once, not once per photo.
    faces.load_model()
    t0 = time.time()
    total_faces = 0
    errors = 0
    try:
        for i, pid in enumerate(pending, 1):
            row = index.get_photo(pid)
            if not row:
                continue
            try:
                n = faces.detect_and_store(row)
                total_faces += n
                print(f"  [{i}/{len(pending)}] {row['filename']}: {n} face(s)")
            except Exception as e:
                errors += 1
                print(f"  [{i}/{len(pending)}] {row['filename']}: ERROR {e}", file=sys.stderr)
    finally:
        stop_et()

    dt = time.time() - t0
    print(f"\nDone: {total_faces} faces across {len(pending)} photos in {dt:.1f}s "
          f"({errors} errors).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
