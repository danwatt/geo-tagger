"""
Re-run face DETECTION (fresh embeddings + boxes) for photos that already have faces,
WITHOUT losing existing person assignments or ignored/reviewed state.

Background: ``index.replace_faces`` (called by every detection pass) deletes and
re-inserts ALL of a photo's detected faces from scratch — including ones already
assigned to a person or marked ignored — because a rescan mints new face ids and
has no way to know which new box corresponds to which old one. Left alone, that
means "just re-run detection" silently wipes tags. This script closes that gap:
before re-detecting a photo it snapshots each existing face's (bbox, state), then
after re-detection it matches new boxes back to old ones by IoU (same face moves
at most a few px between a low-res and high-res decode of the same photo) and
re-applies whichever state the matched old face had — assigned-to-person or
ignored. Boxes with no good match (the detector didn't re-find that face at the
new resolution) are left unlabeled and logged for manual review.

Known limitation, inherited from ``replace_faces`` and not fixed here: face
NEGATIVES ("this is NOT person X") are keyed on the old face id and are not
carried over even when a box matches — same accepted gap as a plain rescan.

Typical use case: RAW photos whose faces were originally detected on the small
embedded JPEG preview (``faces_det_dimension`` NULL) and have since had their
preview/thumbnail cache rebuilt at full LibRaw-decode resolution — the stored
embeddings still reflect the old, blurrier crop, so recognition against them
throws more false positives than it should. Re-embedding fixes that.

Run:  uv run python scripts/reembed_faces.py --dry-run
      uv run python scripts/reembed_faces.py --dir "D:/Photos/2019/Reunion"
      uv run python scripts/reembed_faces.py --dir "D:/Photos/2019/Reunion" --dry-run
      uv run python scripts/reembed_faces.py --all --limit 200
      uv run python scripts/reembed_faces.py --cache-dir D:/path/.geotagger
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

DEFAULT_IOU_THRESHOLD = 0.5


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


def find_candidates(target_dim: int, all_raw: bool, dir_filter: Path | None = None):
    """RAW image photos that currently have at least one detected face, needing a
    re-embed. Same NULL/below-``target_dim`` eligibility as ``rescan_raw_faces.py``,
    but here labeled/ignored photos are INCLUDED by default — that's the point of
    this script — since state is reattached after re-detection rather than lost.
    """
    exts = sorted(config.RAW_EXTENSIONS)
    placeholders = ",".join("?" * len(exts))
    dim_clause = "" if all_raw else \
        " AND (ph.faces_det_dimension IS NULL OR ph.faces_det_dimension < ?)"
    params = list(exts) if all_raw else [*exts, target_dim]
    rows = index.get_db().execute(
        f"""
        SELECT ph.id, ph.filename, ph.path, ph.faces_det_dimension AS dim,
               COUNT(f.id) AS face_count,
               COUNT(CASE WHEN f.person_id IS NOT NULL THEN 1 END) AS labeled_count,
               COUNT(CASE WHEN f.ignored = 1 THEN 1 END) AS ignored_count
        FROM photos ph
        JOIN faces f ON f.photo_id = ph.id
        WHERE ph.media_type = 'image'
          AND LOWER(ph.ext) IN ({placeholders})
          {dim_clause}
        GROUP BY ph.id
        ORDER BY ph.id
        """,
        params,
    ).fetchall()
    if dir_filter is not None:
        rows = [r for r in rows if _under_dir(r["path"], dir_filter)]
    return rows


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = (float(v) for v in bbox.split(","))
    return x1, y1, x2, y2


def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _snapshot_state(photo_id: int) -> list[dict]:
    """Old faces worth preserving: assigned-to-person or ignored (bbox + state)."""
    snapshot = []
    for f in index.get_faces_for_photo(photo_id):
        if f["person_id"] is not None:
            snapshot.append({"bbox": _parse_bbox(f["bbox"]), "person_id": f["person_id"],
                             "person_name": f["person_name"]})
        elif f["ignored"]:
            snapshot.append({"bbox": _parse_bbox(f["bbox"]), "person_id": None,
                             "person_name": None})
    return snapshot


def _reattach_state(photo_id: int, old_state: list[dict], iou_threshold: float) -> dict:
    """Match freshly-detected faces back to ``old_state`` by IoU and reapply
    assignment/ignored status. Returns counts for reporting; each old entry is
    matched at most once (best IoU first, greedy) and each new face at most once."""
    result = {"reassigned": 0, "reignored": 0, "unmatched": []}
    if not old_state:
        return result
    new_faces = index.get_faces_for_photo(photo_id)
    if not new_faces:
        result["unmatched"] = old_state
        return result

    # All (old_idx, new_idx, iou) pairs above threshold, best first — greedy
    # one-to-one matching so two old faces can't both claim the same new box.
    pairs = []
    for oi, old in enumerate(old_state):
        for ni, new in enumerate(new_faces):
            iou = _iou(old["bbox"], _parse_bbox(new["bbox"]))
            if iou >= iou_threshold:
                pairs.append((iou, oi, ni))
    pairs.sort(reverse=True)

    used_old, used_new = set(), set()
    for iou, oi, ni in pairs:
        if oi in used_old or ni in used_new:
            continue
        used_old.add(oi)
        used_new.add(ni)
        old = old_state[oi]
        new_id = new_faces[ni]["id"]
        if old["person_id"] is not None:
            index.assign_faces([new_id], old["person_id"])
            result["reassigned"] += 1
        else:
            index.set_faces_ignored([new_id], True)
            result["reignored"] += 1

    result["unmatched"] = [old_state[oi] for oi in range(len(old_state)) if oi not in used_old]
    return result


def run(todo, iou_threshold: float, dry_run: bool) -> None:
    if dry_run:
        print(f"Would re-embed {len(todo)} RAW photo(s):")
        for r in todo[:50]:
            print(f"  {r['filename']} ({r['face_count']} face(s), "
                  f"{r['labeled_count']} labeled, {r['ignored_count']} ignored, "
                  f"dim={r['dim'] if r['dim'] is not None else 'NULL'})")
        if len(todo) > 50:
            print(f"  … and {len(todo) - 50} more")
        return
    if not todo:
        print("Nothing to do — no matching RAW photos.")
        return

    start_et()
    print(f"Loading model and re-embedding {len(todo)} RAW photo(s)…")
    t0 = time.time()
    total_faces = total_reassigned = total_reignored = total_unmatched = 0
    errors = 0
    try:
        for i, r in enumerate(todo, 1):
            row = index.get_photo(r["id"])
            if not row:
                continue
            try:
                old_state = _snapshot_state(row["id"])
                n = faces.detect_and_store(row)
                reattach = _reattach_state(row["id"], old_state, iou_threshold)
                total_faces += n
                total_reassigned += reattach["reassigned"]
                total_reignored += reattach["reignored"]
                total_unmatched += len(reattach["unmatched"])
                note = f"{n} face(s), {reattach['reassigned']} reassigned, " \
                       f"{reattach['reignored']} re-ignored"
                if reattach["unmatched"]:
                    names = ", ".join(u["person_name"] or "(ignored)" for u in reattach["unmatched"])
                    note += f", {len(reattach['unmatched'])} UNMATCHED ({names})"
                print(f"  [{i}/{len(todo)}] {row['filename']}: {note}")
            except Exception as e:
                errors += 1
                print(f"  [{i}/{len(todo)}] {row['filename']}: ERROR {e}", file=sys.stderr)
    finally:
        stop_et()

    dt = time.time() - t0
    print(f"\nDone: re-embedded {len(todo)} RAW(s) in {dt:.1f}s — {total_faces} faces detected, "
          f"{total_reassigned} reassigned, {total_reignored} re-ignored, "
          f"{total_unmatched} unmatched (need manual review), {errors} errors.")


def main():
    parser = argparse.ArgumentParser(
        description="Re-embed faces for RAW photos, preserving existing person "
                    "assignments and ignored state via bbox matching")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--dir", help="Only process photos whose path is under this directory "
                                      "(try a change against one folder before running library-wide)")
    parser.add_argument("--limit", type=int, default=0, help="Max photos to process (0 = all)")
    parser.add_argument("--target-dim", type=int, default=0,
                        help="Re-embed RAWs whose recorded detection long-edge is below this "
                             "(default 0 = only ones with NULL, i.e. embedded-preview scans)")
    parser.add_argument("--all", dest="all_raw", action="store_true",
                        help="Re-embed EVERY RAW with faces regardless of faces_det_dimension")
    parser.add_argument("--iou-threshold", type=float, default=DEFAULT_IOU_THRESHOLD,
                        help=f"Minimum box overlap to treat a new detection as the same face "
                             f"(default {DEFAULT_IOU_THRESHOLD})")
    parser.add_argument("--decode-max", type=int, default=0,
                        help="Override FACE_DECODE_MAX_DIM for this run (0 = use configured value)")
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would be processed and exit, changing nothing")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)
    config.apply_all_overrides(index.get_all_settings())
    thumbnails.init_thumbs(root)
    faces.init_faces(root)
    if args.decode_max:
        config.FACE_DECODE_MAX_DIM = args.decode_max

    dir_filter = Path(args.dir).resolve() if args.dir else None
    if args.dir and not dir_filter.is_dir():
        sys.exit(f"--dir does not exist or is not a directory: {args.dir}")

    # Force full RAW decode for this run regardless of the persisted/env value —
    # get_detection_preview isn't disk-cached, so there's no filename to mismatch,
    # only the in-memory detection input changes.
    config.RAW_FULL_DECODE = True
    todo = find_candidates(args.target_dim, args.all_raw, dir_filter)
    if args.limit:
        todo = todo[: args.limit]

    print(f"RAW re-embed (FACE_DECODE_MAX_DIM={config.FACE_DECODE_MAX_DIM}, "
          f"iou_threshold={args.iou_threshold}, formats={sorted(config.RAW_EXTENSIONS)})"
          + (f", dir={dir_filter}" if dir_filter else ""))
    run(todo, args.iou_threshold, args.dry_run)


if __name__ == "__main__":
    main()
