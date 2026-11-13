"""
Purge HEIC photos whose faces were all left unassigned.

Deletes the index rows (and every row hanging off them) for photos matching all
three conditions:

  1. ``photos.ext`` is a HEIC-family extension (``--ext``, default ``.heic,.heif``)
  2. at least one ``faces`` row with ``person_id IS NULL`` (an unassigned face,
     whatever its ignored / come_back flag says)
  3. no ``faces`` row with ``person_id IS NOT NULL`` (nothing was ever tagged)

DB-only: the original files and their ``.xmp`` sidecars stay on disk untouched,
and so do cached thumbs. Note that means a later ``scan`` re-indexes these files
from scratch (fresh photo rows, faces_scanned_at NULL) — this reclaims DB rows
and resets face state, it does not make the library forget the files.

Dry run by default; pass --apply to actually delete.

Run:  uv run python scripts/delete_unassigned_heics.py
      uv run python scripts/delete_unassigned_heics.py --apply
      uv run python scripts/delete_unassigned_heics.py --cache-dir D:/path/.geotagger --apply
      uv run python scripts/delete_unassigned_heics.py --ext .heic --apply
"""
import argparse
import os
import sys
import time
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index  # noqa: E402

# Rows per DELETE ... IN (...) chunk. Keeps the parameter count well under
# SQLite's SQLITE_MAX_VARIABLE_NUMBER (32766 on modern builds).
CHUNK = 500


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


def find_targets(exts: list[str]) -> list[tuple[int, str, str, int]]:
    """Photo rows matching the three conditions, as (id, dir, filename, face_count).

    EXISTS/NOT EXISTS rather than a GROUP BY over faces: both subqueries are
    served by idx_faces_photo and stop at the first matching row, so this stays
    a per-candidate point lookup instead of aggregating the whole faces table.
    """
    db = index.get_db()
    placeholders = ",".join("?" * len(exts))
    rows = db.execute(
        f"""
        SELECT p.id, p.dir, p.filename,
               (SELECT COUNT(*) FROM faces f WHERE f.photo_id = p.id) AS face_count
        FROM photos p
        WHERE p.ext IN ({placeholders})
          AND EXISTS (
                SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.person_id IS NULL
              )
          AND NOT EXISTS (
                SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.person_id IS NOT NULL
              )
        ORDER BY p.dir, p.filename
        """,
        exts,
    ).fetchall()
    return [(r["id"], r["dir"], r["filename"], r["face_count"]) for r in rows]


def delete_photos(photo_ids: list[int]) -> dict[str, int]:
    """Hard-delete these photos and everything keyed off them. Returns per-table counts.

    FKs aren't enforced on this DB (no ON DELETE CASCADE in practice — see
    index.delete_photo_faces), so every dependent row is removed explicitly.
    photos_spatial is the one exception: index.init_db installs an AFTER DELETE
    trigger on photos that prunes the R*Tree entry.
    """
    counts = {"faces": 0, "face_embeddings": 0, "face_negatives": 0,
              "places_cleared": 0, "photos": 0}

    for i in range(0, len(photo_ids), CHUNK):
        batch = photo_ids[i:i + CHUNK]
        ph = ",".join("?" * len(batch))

        # One unit per chunk: a failure midway rolls the chunk back rather than
        # leaving faces deleted for photos that still exist.
        with index.transaction() as db:
            face_ids = [r[0] for r in db.execute(
                f"SELECT id FROM faces WHERE photo_id IN ({ph})", batch
            ).fetchall()]
            if face_ids:
                fph = ",".join("?" * len(face_ids))
                counts["face_negatives"] += db.execute(
                    f"DELETE FROM face_negatives WHERE face_id IN ({fph})", face_ids
                ).rowcount
                counts["face_embeddings"] += db.execute(
                    f"DELETE FROM face_embeddings WHERE face_id IN ({fph})", face_ids
                ).rowcount
                counts["faces"] += db.execute(
                    f"DELETE FROM faces WHERE id IN ({fph})", face_ids
                ).rowcount

            # A place pointing at a deleted photo would render a broken cover image.
            counts["places_cleared"] += db.execute(
                f"UPDATE places SET representative_photo_id=NULL "
                f"WHERE representative_photo_id IN ({ph})", batch
            ).rowcount

            counts["photos"] += db.execute(
                f"DELETE FROM photos WHERE id IN ({ph})", batch
            ).rowcount

    index.bump_faces_generation()
    return counts


def main():
    parser = argparse.ArgumentParser(
        description="Delete HEIC photos that have unassigned faces and no assigned ones")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--ext", default=".heic,.heif",
                        help="Comma-separated extensions to treat as HEIC (default .heic,.heif)")
    parser.add_argument("--apply", action="store_true",
                        help="Actually delete. Without this the script only reports.")
    parser.add_argument("--list", action="store_true", help="Print every matched file path")
    args = parser.parse_args()

    exts = [e.strip().lower() for e in args.ext.split(",") if e.strip()]
    exts = [e if e.startswith(".") else "." + e for e in exts]

    root = resolve_root(args)
    index.init_db(root)

    t0 = time.time()
    targets = find_targets(exts)
    print(f"Matched {len(targets)} photo(s) "
          f"({sum(t[3] for t in targets)} face rows) in {(time.time() - t0) * 1000:.0f}ms")
    if not targets:
        return

    if args.list:
        for pid, d, fn, n in targets:
            print(f"  [{pid}] {Path(d) / fn}  ({n} face(s))")
    else:
        for pid, d, fn, n in targets[:10]:
            print(f"  [{pid}] {Path(d) / fn}  ({n} face(s))")
        if len(targets) > 10:
            print(f"  … and {len(targets) - 10} more (pass --list to see all)")

    if not args.apply:
        print("\nDry run — nothing deleted. Re-run with --apply to delete these rows.")
        return

    counts = delete_photos([t[0] for t in targets])
    print("\nDeleted: "
          f"{counts['photos']} photo(s), {counts['faces']} face(s), "
          f"{counts['face_embeddings']} embedding(s), {counts['face_negatives']} negative(s); "
          f"cleared {counts['places_cleared']} place cover reference(s).")
    print("Originals and sidecars on disk were not touched — a future scan will re-index them.")


if __name__ == "__main__":
    main()
