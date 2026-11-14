"""Unlabeled-suggestion cache invalidation (audit F2).

The cache is patched in place on removals (label/ignore) and re-tagged to the
new generation so the accept loop never re-reads. That re-tag is only sound when
the cache was current right before the caller's own bump; these tests pin both
halves: new detections become visible, and the cheap patch path still applies."""
import numpy as np
import pytest

import face_fixtures as ff
from geotagger import faces, index


@pytest.fixture
def population(db):
    """One labeled person plus three unlabeled faces of them; returns
    (person_id, person centroid, unlabeled face ids)."""
    rng = np.random.default_rng(42)
    centroid = ff.unit_vectors(rng, 1)[0]
    pid, _ = ff.seed_person(db, "Ann", ff.cluster_around(rng, centroid, 4))
    unl = ff.seed_unlabeled(db, ff.cluster_around(rng, centroid, 3))
    return pid, centroid, unl, rng


def _new_photo(db, name: str) -> int:
    index.upsert_photo(
        filename=name, dir_="/f2", ext=".jpg", media_type="image", mtime=0.0, size=0,
        lat=None, lng=None, geotag_source="none", sidecar_path=None, sidecar_mtime=None,
        photo_datetime=None)
    return db.execute("SELECT id FROM photos WHERE dir='/f2' AND filename=?",
                      (name,)).fetchone()[0]


def _count_list_faces(monkeypatch) -> list[int]:
    calls: list[int] = []
    real = index.list_faces

    def spy(*a, **k):
        calls.append(1)
        return real(*a, **k)
    monkeypatch.setattr(index, "list_faces", spy)
    return calls


def _ids(rows) -> set[int]:
    return {r["id"] for r in rows}


def test_first_time_detection_reaches_warm_suggestions(db, population, monkeypatch):
    pid, centroid, unl, rng = population
    rows, scores = faces.get_suggested_scores()          # warm both caches
    assert _ids(rows) == set(unl)
    gallery = faces.build_gallery()

    photo_id = _new_photo(db, "new.jpg")
    vec = ff.cluster_around(rng, centroid, 1)[0]
    index.replace_faces(photo_id, [{"bbox": "0.1,0.1,0.5,0.5", "det_score": 0.95,
                                    "embedding": faces.encode_embedding(vec)}])
    new_id = db.execute("SELECT id FROM faces WHERE photo_id=?", (photo_id,)).fetchone()[0]

    rows, scores = faces.get_suggested_scores()
    assert new_id in _ids(rows)
    assert len(scores) == len(rows)
    by_id = dict(zip((r["id"] for r in rows), scores))
    assert by_id[new_id] is not None and by_id[new_id][0] == pid
    assert new_id in _ids(faces.get_unlabeled_matrix()[0])
    # Detection alone must not force a labeled-gallery rebuild.
    assert faces.build_gallery() is gallery

    # The label action after it still takes the in-place patch path (no re-read)
    # and stays correct.
    calls = _count_list_faces(monkeypatch)
    index.assign_face(unl[0], pid)
    rows, scores = faces.get_suggested_scores()
    assert calls == []
    assert _ids(rows) == (set(unl) - {unl[0]}) | {new_id}
    assert len(scores) == len(rows)
    assert dict(zip((r["id"] for r in rows), scores))[new_id][0] == pid


def test_rescan_replacing_faces_shows_new_ids(db, population):
    _, centroid, unl, rng = population
    photo_id = _new_photo(db, "re.jpg")
    # SQLite may reuse the deleted face's rowid, so the embedding (not the id) is
    # what proves each read reflects the latest scan rather than a cached row.
    for _ in range(2):
        vec = ff.cluster_around(rng, centroid, 1)[0]
        index.replace_faces(photo_id, [{"bbox": "0.1,0.1,0.5,0.5", "det_score": 0.95,
                                        "embedding": faces.encode_embedding(vec)}])
        rows, unknowns, _ = faces.get_unlabeled_matrix()
        new = [i for i, r in enumerate(rows) if r["photo_id"] == photo_id]
        assert len(new) == 1
        assert np.array_equal(unknowns[new[0]], vec)
    # A rescan that finds nothing just prunes, no rebuild needed to drop it.
    index.replace_faces(photo_id, [])
    assert _ids(faces.get_unlabeled_matrix()[0]) == set(unl)


def test_label_after_unassign_rebuilds_instead_of_retagging(db, population):
    pid, _, unl, _ = population
    faces.get_unlabeled_matrix()                          # warm
    labeled_id = db.execute("SELECT id FROM faces WHERE person_id=? LIMIT 1",
                            (pid,)).fetchone()[0]
    index.assign_face(labeled_id, None)    # addition: bumps, cache now stale
    index.assign_face(unl[0], pid)         # removal: must not re-tag the stale cache
    rows = faces.get_unlabeled_matrix()[0]
    assert _ids(rows) == (set(unl) - {unl[0]}) | {labeled_id}


def test_drop_with_stale_cache_does_not_retag(db, population):
    _, _, unl, _ = population
    faces.get_unlabeled_matrix()
    built_at = faces._unlabeled_cache[0]
    index.bump_faces_generation()                       # some unseen change
    gen = index.bump_faces_generation()                 # caller's own bump
    faces.drop_from_unlabeled_cache([unl[0]], gen)
    assert faces._unlabeled_cache[0] == built_at        # left stale -> rebuilds


def test_drop_with_superseded_gen_does_not_retag(db, population):
    """A bump from another thread between the caller's bump and its drop means
    the caller's gen is no longer current: re-tagging to it would claim the
    other change was seen."""
    _, _, unl, _ = population
    faces.get_unlabeled_matrix()
    built_at = faces._unlabeled_cache[0]
    gen = index.bump_faces_generation()                 # caller's bump (built_at + 1)
    index.bump_faces_generation()                       # concurrent change
    faces.drop_from_unlabeled_cache([unl[0]], gen)
    assert faces._unlabeled_cache[0] == built_at


def test_drop_with_current_cache_retags(db, population):
    _, _, unl, _ = population
    faces.get_unlabeled_matrix()
    gen = index.bump_faces_generation()
    faces.drop_from_unlabeled_cache([unl[0]], gen)
    assert faces._unlabeled_cache[0] == gen
    assert unl[0] not in _ids(faces.get_unlabeled_matrix()[0])
