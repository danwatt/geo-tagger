"""
Prime the on-disk cache with missing grid thumbnails and face-preview (crop)
images, so the first real page load doesn't pay the decode cost.

Both ``thumbnails.get_thumbnail`` and ``thumbnails.get_face_crop`` are already
disk-cached and idempotent (a cache hit is just a file read), so this simply
walks every indexed photo / detected face and calls them — cheap no-ops where
a rendition already exists, generated on demand where it doesn't. Existence is
checked first (``thumbnail_exists`` / ``face_crop_exists``) purely so the
summary can report how many were actually generated vs. already warm.

Run:  uv run python scripts/prime_previews.py
      uv run python scripts/prime_previews.py --dir "D:/Photos/2019/Reunion"
      uv run python scripts/prime_previews.py --skip-faces
      uv run python scripts/prime_previews.py --skip-thumbnails --limit 500
      uv run python scripts/prime_previews.py --cache-dir D:/path/.geotagger
"""
import argparse
import os
import sys
import time
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index, thumbnails, config  # noqa: E402
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


def _under_dir(path_str: str, base: Path) -> bool:
    """True if ``path_str`` resolves to somewhere inside ``base`` (inclusive)."""
    try:
        Path(path_str).resolve().relative_to(base)
        return True
    except ValueError:
        return False


def find_photos(dir_filter: Path | None, limit: int) -> list:
    rows = index.get_db().execute(
        "SELECT id, dir, filename, mtime, size, orientation FROM photos ORDER BY id"
    ).fetchall()
    if dir_filter is not None:
        rows = [r for r in rows if _under_dir(index.photo_path(r), dir_filter)]
    if limit:
        rows = rows[:limit]
    return rows


def find_faces(dir_filter: Path | None, limit: int) -> list:
    rows = index.get_db().execute(
        """SELECT f.id, f.bbox, f.photo_id, ph.dir, ph.filename, ph.mtime, ph.size, ph.orientation
           FROM faces f JOIN photos ph ON ph.id = f.photo_id
           ORDER BY f.id"""
    ).fetchall()
    if dir_filter is not None:
        rows = [r for r in rows if _under_dir(index.photo_path(r), dir_filter)]
    if limit:
        rows = rows[:limit]
    return rows


def prime_thumbnails(rows, dry_run: bool) -> tuple[int, int, int]:
    """Returns (generated, already_cached, errors)."""
    generated = cached = errors = 0
    total = len(rows)
    for i, r in enumerate(rows, 1):
        path = Path(index.photo_path(r))
        already = thumbnails.thumbnail_exists(path, r["mtime"], r["size"])
        if already:
            cached += 1
            continue
        if dry_run:
            generated += 1
            continue
        try:
            thumbnails.get_thumbnail(path, r["mtime"], r["size"], r["orientation"])
            generated += 1
        except Exception as e:
            errors += 1
            print(f"  ERROR thumbnail for {r['filename']}: {e}", file=sys.stderr)
        if i % 200 == 0:
            print(f"  thumbnails [{i}/{total}] {generated} generated, {cached} cached, {errors} errors")
    return generated, cached, errors


def prime_face_crops(rows, dry_run: bool) -> tuple[int, int, int]:
    """Returns (generated, already_cached, errors)."""
    generated = cached = errors = 0
    total = len(rows)
    for i, r in enumerate(rows, 1):
        path = Path(index.photo_path(r))
        try:
            bbox = tuple(float(v) for v in r["bbox"].split(","))
        except (ValueError, AttributeError):
            errors += 1
            print(f"  ERROR bad bbox for face {r['id']}: {r['bbox']!r}", file=sys.stderr)
            continue
        already = thumbnails.face_crop_exists(path, r["mtime"], r["size"], bbox, r["orientation"])
        if already:
            cached += 1
            continue
        if dry_run:
            generated += 1
            continue
        try:
            thumbnails.get_face_crop(path, r["mtime"], r["size"], bbox, orientation=r["orientation"])
            generated += 1
        except Exception as e:
            errors += 1
            print(f"  ERROR face crop for face {r['id']} ({r['filename']}): {e}", file=sys.stderr)
        if i % 200 == 0:
            print(f"  face crops [{i}/{total}] {generated} generated, {cached} cached, {errors} errors")
    return generated, cached, errors


def main():
    parser = argparse.ArgumentParser(
        description="Prime the disk cache with missing thumbnail and face-preview images")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--dir", help="Only process photos whose path is under this directory")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max photos / faces to process per category (0 = all)")
    parser.add_argument("--skip-thumbnails", action="store_true", help="Skip grid thumbnails")
    parser.add_argument("--skip-faces", action="store_true", help="Skip face-preview crops")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what's missing without generating anything")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)
    config.resolve_data_paths(root)
    config.apply_all_overrides(index.get_all_settings())
    thumbnails.init_thumbs(root)

    dir_filter = Path(args.dir).resolve() if args.dir else None
    if args.dir and not dir_filter.is_dir():
        sys.exit(f"--dir does not exist or is not a directory: {args.dir}")

    start_et()
    t0 = time.time()
    try:
        if not args.skip_thumbnails:
            photos = find_photos(dir_filter, args.limit)
            print(f"Priming thumbnails for {len(photos)} photo(s)"
                  + (" (dry run)" if args.dry_run else "") + "...")
            t_gen, t_cached, t_err = prime_thumbnails(photos, args.dry_run)
            print(f"  thumbnails: {t_gen} generated, {t_cached} already cached, {t_err} errors")

        if not args.skip_faces:
            faces_rows = find_faces(dir_filter, args.limit)
            print(f"Priming face previews for {len(faces_rows)} face(s)"
                  + (" (dry run)" if args.dry_run else "") + "...")
            f_gen, f_cached, f_err = prime_face_crops(faces_rows, args.dry_run)
            print(f"  face previews: {f_gen} generated, {f_cached} already cached, {f_err} errors")
    finally:
        stop_et()

    print(f"\nDone in {time.time() - t0:.1f}s.")


if __name__ == "__main__":
    main()
