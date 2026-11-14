"""
Run a face-detection pass over the indexed photo library.

Detects faces in every image that hasn't been scanned yet and stores their
embeddings so they can be recognized later. Safe to re-run; it only processes
photos with no prior face scan.

Run:  uv run python scripts/scan_faces.py
      uv run python scripts/scan_faces.py --cache-dir D:/path/.geotagger
      uv run python scripts/scan_faces.py --rescan       # redo every photo
      uv run python scripts/scan_faces.py --rescan-empty # redo photos with no faces (tag-safe)
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


def main():
    parser = argparse.ArgumentParser(description="Detect faces across the library")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--limit", type=int, default=0, help="Max photos to process (0 = all)")
    parser.add_argument("--rescan", action="store_true", help="Re-detect even already-scanned photos")
    parser.add_argument("--rescan-empty", action="store_true",
                        help="Re-queue scanned photos that have no faces at all (safe for tags)")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)
    thumbnails.init_thumbs(root)
    faces.init_faces(root)
    # RAW/HEIC/video previews are extracted via ExifTool, so the shared session
    # must be running — the server starts it in its lifespan; we start it here.
    start_et()

    if args.rescan:
        with index.transaction() as db:
            db.execute("UPDATE photos SET faces_scanned_at=NULL, faces_scan_error=NULL "
                       "WHERE media_type='image'")
    elif args.rescan_empty:
        # Repair for audit F1: before the fix, a model that failed to load marked
        # every photo "scanned, 0 faces", indistinguishable from a real empty scan.
        # Re-queue only photos with no face rows at all (detected, manual, ignored):
        # rescanning those can't delete a tag. Legit no-face photos just cost one
        # more detection each.
        with index.transaction() as db:
            n = db.execute(
                "UPDATE photos SET faces_scanned_at=NULL, faces_det_dimension=NULL "
                "WHERE media_type='image' AND faces_scanned_at IS NOT NULL "
                "AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = photos.id)"
            ).rowcount
        print(f"Re-queued {n} scanned photos that have no faces.")

    pending = index.get_unscanned_photo_ids()
    if args.limit:
        pending = pending[: args.limit]

    if not pending:
        print("Nothing to do — all photos already scanned for faces.")
        return

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


if __name__ == "__main__":
    main()
