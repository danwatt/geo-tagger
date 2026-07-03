"""
TEMPORARY one-off: re-scan RAW photos whose faces were detected on the low-quality
embedded preview, this time with a full LibRaw decode.

Background: face detection normally runs on the small JPEG ExifTool extracts from a RAW.
Photos scanned that way have ``photos.faces_det_dimension = NULL``. With the "Full RAW
decode" setting on, new scans instead do a full LibRaw decode and record the detection
long-edge in ``faces_det_dimension``. This script forces a full-decode re-scan of the
RAW photos that predate that (dimension NULL, or below ``--target-dim``), so the library
ends up detected at a consistent, higher resolution. It's deliberately a standalone
script — the feature is temporary catch-up, not part of the app.

SAFETY: re-detection replaces a photo's detected faces from scratch (``replace_faces``
deletes + re-inserts), which discards any person assignments on that photo. So by default
this script SKIPS any RAW that already has labeled faces. Pass ``--include-labeled`` to
re-scan those too, knowingly discarding their existing tags.

Run:  uv run python scripts/rescan_raw_faces.py --dry-run
      uv run python scripts/rescan_raw_faces.py
      uv run python scripts/rescan_raw_faces.py --cache-dir D:/path/.geotagger
      uv run python scripts/rescan_raw_faces.py --target-dim 3000 --limit 100
"""
import argparse
import os
import sys
import time
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index, thumbnails, faces, config  # noqa: E402
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


def find_candidates(target_dim: int, include_labeled: bool, all_raw: bool = False):
    """RAW image photos needing a higher-res re-scan, split into (todo, skipped).

    A photo qualifies when its ``faces_det_dimension`` is NULL (detected on the
    embedded preview, or never scanned) or below ``target_dim`` — or, when
    ``all_raw`` is set, unconditionally (every RAW image, regardless of the recorded
    dimension). ``all_raw`` is what you want after a decode-orientation fix, where
    already-full-decode-scanned RAWs (non-NULL dimension, but wrong boxes) must all be
    re-detected. Photos that already have at least one labeled face go to ``skipped``
    unless ``include_labeled``.
    """
    exts = sorted(config.RAW_EXTENSIONS)
    placeholders = ",".join("?" * len(exts))
    dim_clause = "" if all_raw else \
        " AND (ph.faces_det_dimension IS NULL OR ph.faces_det_dimension < ?)"
    params = list(exts) if all_raw else [*exts, target_dim]
    rows = index.get_db().execute(
        f"""
        SELECT ph.id, ph.filename, ph.faces_det_dimension AS dim,
               COUNT(CASE WHEN f.person_id IS NOT NULL THEN 1 END) AS labeled
        FROM photos ph
        LEFT JOIN faces f ON f.photo_id = ph.id
        WHERE ph.media_type = 'image'
          AND LOWER(ph.ext) IN ({placeholders})
          {dim_clause}
        GROUP BY ph.id
        ORDER BY ph.id
        """,
        params,
    ).fetchall()

    todo, skipped = [], []
    for r in rows:
        (skipped if (r["labeled"] and not include_labeled) else todo).append(r)
    return todo, skipped


def main():
    parser = argparse.ArgumentParser(
        description="Re-scan RAW photos for faces at full LibRaw decode resolution")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--limit", type=int, default=0, help="Max photos to process (0 = all)")
    parser.add_argument("--target-dim", type=int, default=0,
                        help="Also re-scan RAWs whose recorded detection long-edge is below this "
                             "(default 0 = only ones with NULL, i.e. embedded-preview scans)")
    parser.add_argument("--all", dest="all_raw", action="store_true",
                        help="Re-scan EVERY RAW regardless of faces_det_dimension "
                             "(use after a decode/orientation fix to redo already-full-decoded RAWs)")
    parser.add_argument("--decode-max", type=int, default=0,
                        help="Override FACE_DECODE_MAX_DIM for this run (0 = use the configured value)")
    parser.add_argument("--include-labeled", action="store_true",
                        help="Also re-scan RAWs that already have labeled faces (DISCARDS those tags)")
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would be re-scanned and exit, changing nothing")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)
    # Respect saved runtime settings (e.g. FACE_DECODE_MAX_DIM), then force full RAW
    # decode on for this run regardless of the persisted/env value.
    config.apply_all_overrides(index.get_all_settings())
    thumbnails.init_thumbs(root)
    faces.init_faces(root)
    config.RAW_FULL_DECODE = True
    if args.decode_max:
        config.FACE_DECODE_MAX_DIM = args.decode_max

    todo, skipped = find_candidates(args.target_dim, args.include_labeled, args.all_raw)
    if args.limit:
        todo = todo[: args.limit]

    print(f"RAW re-scan at full decode (FACE_DECODE_MAX_DIM={config.FACE_DECODE_MAX_DIM}, "
          f"formats={sorted(config.RAW_EXTENSIONS)})")
    if skipped:
        print(f"Skipping {len(skipped)} RAW(s) with labeled faces "
              f"(use --include-labeled to re-scan them, discarding those tags).")
    if not todo:
        print("Nothing to do — no matching RAW photos.")
        return

    if args.dry_run:
        print(f"Would re-scan {len(todo)} RAW photo(s):")
        for r in todo[:50]:
            print(f"  {r['filename']} (dim={r['dim'] if r['dim'] is not None else 'NULL'})")
        if len(todo) > 50:
            print(f"  … and {len(todo) - 50} more")
        return

    # RAW previews/embedded fallback go through ExifTool, so the shared session must run.
    start_et()
    print(f"Loading model and re-scanning {len(todo)} RAW photo(s)…")
    t0 = time.time()
    total_faces = 0
    errors = 0
    fell_back = 0
    try:
        for i, r in enumerate(todo, 1):
            row = index.get_photo(r["id"])
            if not row:
                continue
            try:
                n = faces.detect_and_store(row)
                total_faces += n
                new_dim = index.get_db().execute(
                    "SELECT faces_det_dimension FROM photos WHERE id=?", (r["id"],)
                ).fetchone()[0]
                if new_dim is None:
                    fell_back += 1
                    note = " (full decode FAILED — used embedded preview)"
                else:
                    note = f" @ {new_dim}px"
                print(f"  [{i}/{len(todo)}] {row['filename']}: {n} face(s){note}")
            except Exception as e:
                errors += 1
                print(f"  [{i}/{len(todo)}] {row['filename']}: ERROR {e}", file=sys.stderr)
    finally:
        stop_et()

    dt = time.time() - t0
    print(f"\nDone: re-scanned {len(todo)} RAW(s), {total_faces} faces in {dt:.1f}s "
          f"({errors} errors, {fell_back} fell back to embedded preview).")


if __name__ == "__main__":
    main()
