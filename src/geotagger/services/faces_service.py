"""Blocking face-pipeline jobs: detection over a batch of photos and clustering the
unlabeled queue into display-ready groups. Framework-free; called from routes via
run_in_executor."""

from collections import Counter
from pathlib import Path

from geotagger import index, faces, serializers, thumbnails, config

# Most groups worth reviewing are the larger ones; cap the response/DOM.
CLUSTER_DISPLAY_LIMIT = 100


def scan_faces_batch(photo_ids: list[int]) -> dict:
    """Run detection over a list of photo ids (blocking; called in executor)."""
    processed = 0
    total_faces = 0
    errors = []
    for pid in photo_ids:
        row = index.get_photo(pid)
        if not row:
            continue
        try:
            total_faces += faces.detect_and_store(row)
            processed += 1
        except Exception as e:
            errors.append(f"{row['filename']}: {e}")
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
