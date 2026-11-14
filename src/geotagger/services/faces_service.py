"""Blocking face-pipeline jobs: detection over a batch of photos and clustering the
unlabeled queue into display-ready groups. Framework-free; called from routes via
run_in_executor."""

import logging
import time
from collections import Counter
from pathlib import Path

from geotagger import index, faces, serializers, thumbnails, config
from geotagger.scan_failures import BatchAborted, FailureStreak, FileUnreadable

logger = logging.getLogger(__name__)

# Most groups worth reviewing are the larger ones; cap the response/DOM.
CLUSTER_DISPLAY_LIMIT = 100


def load_model_or_abort() -> None:
    """Load the face model before touching any photo; a failure here (model pack
    missing or corrupt, onnxruntime unable to build a session, out of memory) is
    about the pipeline, so the batch aborts with nothing marked (audit F1)."""
    try:
        faces.load_model()
    except Exception as e:
        logger.exception("Face model failed to load")
        # Drop any half-built pipeline so the next attempt reloads from scratch.
        faces.reset_model()
        raise BatchAborted(f"Face model failed to load: {e}", code="model") from e


def scan_faces_batch(photo_ids: list[int], allow_failures: bool = False) -> dict:
    """Run detection over a list of photo ids (blocking; called in executor).

    Raises BatchAborted — with nothing marked from the failing photo on — when the
    model won't load or run, on any error not attributable to one photo's file, and
    when ``config.SCAN_FAILURE_STREAK_LIMIT`` photos in a row are unreadable (unless
    ``allow_failures``: the user looked at those errors and says the files really
    are bad). Photos whose own file is unreadable (truncated HEIC, broken JPEG, file
    deleted since the last scan) are recorded via mark_face_scan_failures so the
    queue moves on; "Retry failed" re-queues them."""
    # The model loads once, before the loop; an empty id list (or only unknown ids)
    # needs no model at all, which keeps the queue's final empty call free.
    rows = [r for r in (index.get_photo(pid) for pid in photo_ids) if r]
    processed = 0
    total_faces = 0
    errors: list[str] = []
    if not rows:
        return {"processed": 0, "faces_found": 0, "errors": errors}
    load_model_or_abort()
    streak = FailureStreak(config.SCAN_FAILURE_STREAK_LIMIT, allow=allow_failures)
    try:
        for row in rows:
            try:
                total_faces += faces.detect_and_store(row)
            except FileUnreadable as e:
                errors.append(f"{row['filename']}: {e}")
                streak.fail((row["id"], str(e)), errors[-1])
            except Exception as e:
                logger.exception(f"Face detection failed on {row['filename']}")
                raise BatchAborted(f"Face detection failed on {row['filename']}: {e}") from e
            else:
                index.mark_face_scan_failures(streak.ok())
            processed += 1
    except BatchAborted as e:
        # A systemic error after a run of unreadable files says those weren't the
        # files' fault either — the held-back marks are dropped with the batch.
        e.errors = e.errors or errors
        raise
    index.mark_face_scan_failures(streak.drain())
    return {"processed": processed, "faces_found": total_faces, "errors": errors}


def nuke_photo_faces(photo_ids: list[int]) -> dict:
    """Nuclear option: hard-delete every face for these photos and wipe every
    cached rendition on disk, so a rescan starts completely from scratch."""
    faces_deleted = index.delete_photo_faces(photo_ids)
    files_deleted = 0
    for pid in photo_ids:
        row = index.get_photo(pid)
        if not row:
            continue
        files_deleted += thumbnails.invalidate_photo_cache(
            Path(index.photo_path(row)), row["mtime"], row["size"])
    return {"photos": len(photo_ids), "faces_deleted": faces_deleted,
            "files_deleted": files_deleted}


def add_manual_face(photo_id: int, disp_bbox: list[float],
                    person_id: int | None = None) -> dict:
    """Store a hand-drawn face box for one photo (blocking; called in executor).

    ``disp_bbox`` is normalized 0..1 in DISPLAY space — what the user dragged over
    the oriented preview — and is mapped to the sensor-space storage convention
    here, the same trip detection makes (see faces.detect_faces).

    Embedding the box needs the InsightFace model, which may be absent or may find
    nothing inside the drawn region; either way the face is still stored, just
    without recognition data. ``embedded`` in the result says which happened.
    """
    row = index.get_photo(photo_id)
    if not row:
        raise ValueError(f"No such photo: {photo_id}")

    x1, y1, x2, y2 = (max(0.0, min(1.0, float(v))) for v in disp_bbox)
    if x2 - x1 < 0.005 or y2 - y1 < 0.005:
        raise ValueError("Box is too small")

    embedding, det_score = None, None
    try:
        embedding, det_score = faces.embed_bbox(
            Path(index.photo_path(row)), row["mtime"], row["size"],
            [x1, y1, x2, y2], row["orientation"])
    except Exception as e:
        # No model installed, unreadable file, decode failure — the box itself is
        # still worth keeping, so log and fall through unembedded.
        logger.warning(f"Manual face embedding failed for photo {photo_id}: {e}")

    bbox = thumbnails.unorient_bbox([x1, y1, x2, y2], row["orientation"])
    face_id = index.add_manual_face(
        photo_id, ",".join(f"{v:.5f}" for v in bbox), person_id,
        # A user-drawn box is an assertion, not a guess: 1.0 keeps it at the top of
        # the det_score DESC orderings. The model's own score (when we got one) is
        # reported back for the UI, not stored.
        det_score=1.0, embedding=embedding)
    return {"face_id": face_id, "photo_id": photo_id, "person_id": person_id,
            "embedded": embedding is not None,
            "det_score": round(det_score, 4) if det_score is not None else None}


def refresh_orientations(photo_ids: list[int]) -> int:
    """Re-read EXIF orientation from disk for these photos and store any that
    changed. Returns the number of rows updated.

    photos.orientation is normally written once at scan time, so a row indexed
    before orientation was read (NULL), or one whose tag was fixed in the file
    afterwards, keeps rendering sideways forever — every consumer (previews, grid
    thumbs, face crops, bbox mapping) rotates from the DB value, not the file.
    Cheap enough to re-read on the rescan path: one batched ExifTool call."""
    from geotagger import sidecar

    rows = [r for r in (index.get_photo(pid) for pid in photo_ids) if r]
    if not rows:
        return 0
    paths = [Path(index.photo_path(r)) for r in rows]
    by_path = sidecar.read_orientations(paths)
    updates = [(by_path[p], r["id"]) for r, p in zip(rows, paths)
               if by_path.get(p) is not None and by_path[p] != r["orientation"]]
    if updates:
        index.set_orientations(updates)
    return len(updates)


def rescan_photo_faces(photo_ids: list[int]) -> dict:
    """Nuke then immediately re-detect: the single-photo "start over" action. Same
    wipe as nuke_photo_faces (faces + cached renditions), followed by a detection
    pass over the same photos in this one executor trip so the caller can render
    the fresh faces straight away.

    The model is loaded before the wipe, so a broken model aborts with the photo's
    faces (and tags) still intact rather than wiped and then never re-detected.

    Orientation is re-read from the file between the two halves: a wrong stored
    orientation is one of the reasons a photo's faces come out wrong in the first
    place, and detection reads photos.orientation. Order matters — the wipe must
    come first so no cached rendition (whose filename carries the *old*
    orientation suffix) survives the change."""
    if any(index.get_photo(pid) for pid in photo_ids):   # unknown ids need no model
        load_model_or_abort()
    nuked = nuke_photo_faces(photo_ids)
    reoriented = refresh_orientations(photo_ids)
    # allow_failures: this is an explicit per-photo action, not a queue walk —
    # an unreadable file here is just recorded, never a reason to refuse.
    scanned = scan_faces_batch(photo_ids, allow_failures=True)
    return {**nuked, **scanned, "orientations_updated": reoriented}


def recompute_all_representatives() -> dict:
    """Recluster every person with enough labeled faces (config.FACE_DEDUP_MIN_FACES)
    and flag one representative per look-alike cluster. Pure read + numpy
    clustering + write over already-computed embeddings (no model inference),
    but still routed through the executor by the caller since a very prolific
    library's full recompute can take a noticeable moment."""
    persons = []
    for pid in index.get_persons_with_min_labeled_faces(config.FACE_DEDUP_MIN_FACES):
        reps, total = faces.compute_representatives_for_person(pid)
        index.set_person_representatives(pid, reps)
        persons.append({"person_id": pid, "total": total, "representative": len(reps)})
    return {"persons": persons}


def compute_clusters(rows, unknowns, times, gallery, names, threshold, min_size, full):
    """Cluster the unlabeled matrix into display-ready groups. Pure compute (no DB
    access), so it's safe in the executor. Each group carries all its face ids (for
    bulk assign), face items (a 24-face sample, or every face when ``full``), and a
    majority-vote 'looks like <existing person>' hint when it matches a known
    person."""
    clusters_idx = faces.cluster_unlabeled(unknowns, threshold, min_size)[:CLUSTER_DISPLAY_LIMIT]
    matches = (faces.suggest_persons_batch(rows, gallery, unknowns=unknowns, times=times)
               if len(gallery) > 0 else [None] * len(rows))
    out = []
    for idxs in clusters_idx:
        votes = Counter(matches[i][0] for i in idxs if matches[i])
        suggestion = None
        if votes:
            pid, cnt = votes.most_common(1)[0]
            if cnt >= max(2, len(idxs) // 2):   # a clear plurality of the group
                suggestion = {"person_id": pid, "person_name": names.get(pid),
                              "score": round(cnt / len(idxs), 2)}
        sample_idx = idxs if full else idxs[:24]
        out.append({
            "size": len(idxs),
            "face_ids": [rows[i]["id"] for i in idxs],
            "sample": [serializers.face_item(rows[i]) for i in sample_idx],
            "suggestion": suggestion,
        })
    return out


# ── Untagged-face search (Search page's "find untagged faces of these people") ──

def max_bipartite_matching(left: list, right: list, adj: dict) -> dict:
    """Kuhn's augmenting-path matcher. ``left``/``right`` are node lists,
    ``adj[l]`` the eligible ``right`` nodes for ``l`` (ordered best-first by the
    caller to favor strong edges when a tie could go either way). Returns
    ``{left_node: right_node}`` for every ``left`` node that found a distinct
    match. O(V*E) — fine for the single-digit person/face counts per photo here."""
    match_right: dict = {}   # right node -> left node

    def try_assign(l, seen: set) -> bool:
        for r in adj.get(l, ()):
            if r in seen:
                continue
            seen.add(r)
            if r not in match_right or try_assign(match_right[r], seen):
                match_right[r] = l
                return True
        return False

    for l in left:
        try_assign(l, set())
    return {l: r for r, l in match_right.items()}


def _bbox_for_row(row) -> list[float]:
    return thumbnails.orient_bbox(row["bbox"].split(","), row["orientation"])


def find_untagged_face_photos(pids: list[int], date_from: str | None, date_to: str | None,
                              bbox: str | None, location: str | None, geotagged: str,
                              threshold: float | None, limit: int,
                              place_id: int | None = None, nearby_m: float = 0,
                              location_fields: str | None = None) -> dict:
    """Photos where the searched people appear but at least one is only an
    untagged near-match, not yet confirmed. Single person -> exhaustive
    "suggested for them" scan; two+ -> "together, some/none tagged" bipartite
    cover. See FACE_SEARCH_PLAN.md for the full algorithm writeup."""
    t0 = time.perf_counter()
    threshold = config.FACE_MATCH_THRESHOLD if threshold is None else threshold
    warnings: list[str] = []

    # Ids only: this is a whole-library membership set. Full photo rows are
    # fetched afterwards for just the candidates that survive the limit.
    allowed_ids = {r["id"] for r in index.search_photos(
        date_from=date_from, date_to=date_to, bbox=bbox, location=location,
        person_ids=None, geotagged=geotagged, limit=10_000_000,
        place_id=place_id, nearby_m=nearby_m, location_fields=location_fields,
        ids_only=True)}

    gallery = faces.build_gallery()
    names = serializers.person_name_map()
    for pid in pids:
        if pid not in gallery._pid_to_group:
            warnings.append(f"No examples for {names.get(pid, pid)}; can't match by face.")

    rows, unknowns, times = faces.get_unlabeled_matrix()
    neg_map = faces.get_negatives_map()

    if len(pids) == 1:
        result = _find_single(pids[0], allowed_ids, gallery, names,
                              rows, unknowns, times, threshold, limit)
    else:
        result = _find_together(pids, allowed_ids, gallery, names,
                                rows, unknowns, times, neg_map, threshold, limit)
    _attach_photos(result["candidates"])
    result["warnings"] = warnings
    logger.info("find_untagged_face_photos pids=%s mode=%s candidates=%d total=%d %.2fms",
               pids, result["mode"], len(result["candidates"]), result["total"],
               (time.perf_counter() - t0) * 1000)
    return result


def _attach_photos(candidates: list[dict]) -> None:
    """Fill each candidate's ``photo`` (from its ``_photo_id``) with one batched
    fetch, only for the candidates actually returned. ``photo`` is placed first to
    keep the response's key order."""
    photos = {r["id"]: r for r in index.get_photos(ids=[c["_photo_id"] for c in candidates])}
    for i, c in enumerate(candidates):
        pid = c.pop("_photo_id")
        candidates[i] = {"photo": serializers.photo_to_dict(photos[pid]), **c}


def _find_single(pid: int, allowed_ids: set[int],
                 gallery, names: dict, rows, unknowns, times,
                 threshold: float, limit: int) -> dict:
    if pid not in gallery._pid_to_group:
        return {"mode": "single", "threshold": threshold, "total": 0, "candidates": []}

    cand_rows, cand_embs, cand_times = faces.window_rows(rows, unknowns, times, None, None, allowed_ids)
    scored = faces.suggest_for_person(cand_rows, gallery, pid, threshold=threshold,
                                      unknowns=cand_embs, times=cand_times)

    already_tagged = index.photo_ids_with_tagged_person([pid])
    by_photo: dict[int, dict] = {}
    for row, score, _alts in scored:
        photo_id = row["photo_id"]
        if photo_id in already_tagged:
            continue
        entry = by_photo.setdefault(photo_id, {
            "_photo_id": photo_id,
            "tagged": [], "proposed": [], "_best": 0.0,
        })
        entry["proposed"].append({
            "person_id": pid, "person_name": names.get(pid),
            "face_id": row["id"], "score": round(score, 4),
            "bbox": _bbox_for_row(row),
        })
        entry["_best"] = max(entry["_best"], score)

    candidates = sorted(by_photo.values(), key=lambda c: -c["_best"])
    total = len(candidates)
    for c in candidates:
        del c["_best"]
    return {"mode": "single", "threshold": threshold, "total": total,
            "candidates": candidates[:limit]}


def _find_together(pids: list[int], allowed_ids: set[int],
                   gallery, names: dict, rows, unknowns, times, neg_map,
                   threshold: float, limit: int) -> dict:
    u_rows, u_embs, u_times = faces.window_rows(rows, unknowns, times, None, None, allowed_ids)
    per_person = faces._best_per_person_f32(gallery, u_embs, u_times) if len(u_rows) else None
    p_row = {pp: gallery._pid_to_group[pp] for pp in pids if pp in gallery._pid_to_group}

    def uscore(j: int, pp: int) -> float:
        r = p_row.get(pp)
        if r is None:
            return float("-inf")
        if pp in neg_map.get(u_rows[j]["id"], ()):
            return float("-inf")
        return float(per_person[r, j])

    tagged_in = index.tagged_person_faces_in_photos(pids)

    coverable: dict[int, set[int]] = {pp: set() for pp in pids}
    for ph, tset in tagged_in.items():
        if ph in allowed_ids:
            for pp, _fid in tset:
                coverable[pp].add(ph)
    for j, r in enumerate(u_rows):
        for pp in pids:
            if uscore(j, pp) >= threshold:
                coverable[pp].add(r["photo_id"])
    candidate_photos = set.intersection(*coverable.values()) if pids else set()

    untagged_by_photo: dict[int, list[int]] = {}
    for j, r in enumerate(u_rows):
        if r["photo_id"] in candidate_photos:
            untagged_by_photo.setdefault(r["photo_id"], []).append(j)

    candidates = []
    for photo_id in candidate_photos:
        tagged_here = [(pp, fid) for pp, fid in tagged_in.get(photo_id, ()) if pp in pids]
        untagged_j = untagged_by_photo.get(photo_id, [])
        faces_here = [("tagged", fid, pp) for pp, fid in tagged_here] + \
                     [("untagged", u_rows[j]["id"], j) for j in untagged_j]
        if len(faces_here) < len(pids):
            continue

        adj: dict[int, list] = {pp: [] for pp in pids}
        for kind, fid, ref in faces_here:
            node = (kind, fid)
            if kind == "tagged":
                adj[ref].append(node)
            else:
                j = ref
                scored_pp = sorted((pp for pp in pids if uscore(j, pp) >= threshold),
                                   key=lambda pp: -uscore(j, pp))
                for pp in scored_pp:
                    adj[pp].append(node)

        matching = max_bipartite_matching(pids, [(k, f) for k, f, _ in faces_here], adj)
        if len(matching) != len(pids):
            continue
        used_untagged = [pp for pp in pids if matching[pp][0] == "untagged"]
        if not used_untagged:
            continue

        node_to_j = {("untagged", u_rows[j]["id"]): j for j in untagged_j}
        tagged_out = [{"person_id": pp, "person_name": names.get(pp), "face_id": matching[pp][1]}
                     for pp in pids if matching[pp][0] == "tagged"]
        proposed_out = []
        best = 0.0
        for pp in used_untagged:
            kind, fid = matching[pp]
            j = node_to_j[(kind, fid)]
            score = uscore(j, pp)
            best = max(best, score)
            proposed_out.append({
                "person_id": pp, "person_name": names.get(pp), "face_id": fid,
                "score": round(score, 4), "bbox": _bbox_for_row(u_rows[j]),
            })
        candidates.append({
            "_photo_id": photo_id,
            "tagged": tagged_out, "proposed": proposed_out, "_best": best,
        })

    candidates.sort(key=lambda c: -c["_best"])
    total = len(candidates)
    for c in candidates:
        del c["_best"]
    return {"mode": "together", "threshold": threshold, "total": total,
            "candidates": candidates[:limit]}
