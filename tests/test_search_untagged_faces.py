"""Tests for faces_service.find_untagged_face_photos (see FACE_SEARCH_PLAN.md).

Scenario A (one person) reuses faces.suggest_for_person's math directly (already
covered by test_faces_math.py); these tests focus on the service's own logic:
excluding already-tagged photos, the Scenario B bipartite cover, negatives,
warnings, and the base date filter. Faces are seeded with synthetic embeddings
via face_fixtures (no InsightFace model needed). Calls the service function
directly (same pattern as test_services.py) rather than through the HTTP layer.
"""
import time

import numpy as np

import face_fixtures as ff
from geotagger import faces, index
from geotagger.services import faces_service
from geotagger.services.faces_service import max_bipartite_matching


def _new_photo(dt=None):
    n = next(ff._photo_seq)
    index.upsert_photo(
        filename=f"together_{n}.jpg", dir_="/test", ext=".jpg",
        media_type="image", mtime=0.0, size=0, lat=None, lng=None,
        geotag_source="none", sidecar_path=None, sidecar_mtime=None,
        photo_datetime=dt,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", ("/test", f"together_{n}.jpg")
    ).fetchone()[0]


def _add_face(db, photo_id, embedding, person_id=None, det_score=0.9):
    now = time.time()
    cur = db.execute(
        """INSERT INTO faces (photo_id, person_id, bbox, det_score,
                              source, ignored, created_at, assigned_at)
           VALUES (?, ?, '0.0,0.0,1.0,1.0', ?, 'detected', 0, ?, ?)""",
        (photo_id, person_id, det_score, now, now if person_id is not None else None),
    )
    face_id = cur.lastrowid
    db.execute(
        "INSERT INTO face_embeddings (face_id, embedding) VALUES (?, ?)",
        (face_id, faces.encode_embedding(embedding)),
    )
    db.commit()
    return face_id


def _search(pids, **kw):
    kw.setdefault("date_from", None)
    kw.setdefault("date_to", None)
    kw.setdefault("bbox", None)
    kw.setdefault("location", None)
    kw.setdefault("geotagged", "all")
    kw.setdefault("threshold", None)
    kw.setdefault("limit", 500)
    return faces_service.find_untagged_face_photos(pids, **kw)


def test_max_bipartite_matching_perfect_and_impossible():
    # Perfect: two persons, two faces, each covers only one.
    m = max_bipartite_matching([1, 2], ["fa", "fb"], {1: ["fa"], 2: ["fb"]})
    assert m == {1: "fa", 2: "fb"}

    # Impossible: both persons can only match the same single face.
    m = max_bipartite_matching([1, 2], ["fa"], {1: ["fa"], 2: ["fa"]})
    assert len(m) == 1

    # One face matches two people, a second distinct face frees up the match.
    m = max_bipartite_matching([1, 2], ["fa", "fb"], {1: ["fa", "fb"], 2: ["fa"]})
    assert len(m) == 2
    assert m[2] == "fa"


class TestSingle:
    def test_positive_excludes_already_tagged(self, db):
        rng = np.random.default_rng(1)
        centroid = ff.unit_vectors(rng, 1)[0]
        alice, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, centroid, 6))

        # An untagged near-match face of Alice in a fresh photo -> candidate.
        match_photo = _new_photo(ff.epoch(2020, 6))
        match_face = _add_face(db, match_photo, ff.cluster_around(rng, centroid, 1)[0])

        # A photo where Alice is already tagged -> excluded even if another
        # untagged face in it also near-matches her.
        tagged_photo = _new_photo(ff.epoch(2020, 7))
        _add_face(db, tagged_photo, ff.cluster_around(rng, centroid, 1)[0], person_id=alice)
        _add_face(db, tagged_photo, ff.cluster_around(rng, centroid, 1)[0])
        ff.reset_faces_caches()

        data = _search([alice])
        assert data["mode"] == "single"
        photo_ids = {c["photo"]["id"] for c in data["candidates"]}
        assert match_photo in photo_ids
        assert tagged_photo not in photo_ids
        cand = next(c for c in data["candidates"] if c["photo"]["id"] == match_photo)
        assert cand["tagged"] == []
        assert cand["proposed"][0]["face_id"] == match_face
        assert cand["proposed"][0]["person_id"] == alice

    def test_no_examples_returns_warning(self, db):
        bob = index.create_person("Bob")
        data = _search([bob])
        assert data["candidates"] == []
        assert data["warnings"]

    def test_base_date_filter_excludes_out_of_range_photo(self, db):
        rng = np.random.default_rng(2)
        centroid = ff.unit_vectors(rng, 1)[0]
        alice, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, centroid, 6))
        out_of_range = _new_photo(ff.epoch(2019, 1))
        _add_face(db, out_of_range, ff.cluster_around(rng, centroid, 1)[0])
        ff.reset_faces_caches()

        data = _search([alice], date_from="2020-01-01")
        assert all(c["photo"]["id"] != out_of_range for c in data["candidates"])


class TestTogether:
    def _seed_two(self, db):
        rng = np.random.default_rng(7)
        ca, cb = ff.unit_vectors(rng, 2)
        alice, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, ca, 6))
        bob, _ = ff.seed_person(db, "Bob", ff.cluster_around(rng, cb, 6))
        return rng, ca, cb, alice, bob

    def test_partly_tagged_qualifies(self, db):
        rng, ca, cb, alice, bob = self._seed_two(db)
        photo = _new_photo(ff.epoch(2021, 1))
        _add_face(db, photo, ff.cluster_around(rng, ca, 1)[0], person_id=alice)
        bob_face = _add_face(db, photo, ff.cluster_around(rng, cb, 1)[0])
        ff.reset_faces_caches()

        data = _search([alice, bob])
        assert data["mode"] == "together"
        cand = next(c for c in data["candidates"] if c["photo"]["id"] == photo)
        assert {t["person_id"] for t in cand["tagged"]} == {alice}
        assert {p["person_id"] for p in cand["proposed"]} == {bob}
        assert cand["proposed"][0]["face_id"] == bob_face

    def test_fully_untagged_qualifies(self, db):
        rng, ca, cb, alice, bob = self._seed_two(db)
        cc, = ff.unit_vectors(rng, 1)
        carol, _ = ff.seed_person(db, "Carol", ff.cluster_around(rng, cc, 6))
        photo = _new_photo(ff.epoch(2021, 2))
        _add_face(db, photo, ff.cluster_around(rng, ca, 1)[0])
        _add_face(db, photo, ff.cluster_around(rng, cb, 1)[0])
        _add_face(db, photo, ff.cluster_around(rng, cc, 1)[0])
        ff.reset_faces_caches()

        data = _search([alice, bob, carol])
        cand = next(c for c in data["candidates"] if c["photo"]["id"] == photo)
        assert cand["tagged"] == []
        assert {p["person_id"] for p in cand["proposed"]} == {alice, bob, carol}

    def test_too_few_faces_not_a_candidate(self, db):
        rng, ca, cb, alice, bob = self._seed_two(db)
        cc, = ff.unit_vectors(rng, 1)
        carol, _ = ff.seed_person(db, "Carol", ff.cluster_around(rng, cc, 6))
        photo = _new_photo(ff.epoch(2021, 3))
        # Only two untagged faces for three searched people.
        _add_face(db, photo, ff.cluster_around(rng, ca, 1)[0])
        _add_face(db, photo, ff.cluster_around(rng, cb, 1)[0])
        ff.reset_faces_caches()

        data = _search([alice, bob, carol])
        assert all(c["photo"]["id"] != photo for c in data["candidates"])

    def test_fully_tagged_excluded(self, db):
        rng, ca, cb, alice, bob = self._seed_two(db)
        photo = _new_photo(ff.epoch(2021, 4))
        _add_face(db, photo, ff.cluster_around(rng, ca, 1)[0], person_id=alice)
        _add_face(db, photo, ff.cluster_around(rng, cb, 1)[0], person_id=bob)
        ff.reset_faces_caches()

        data = _search([alice, bob])
        assert all(c["photo"]["id"] != photo for c in data["candidates"])

    def test_negative_excludes_face(self, db):
        rng, ca, cb, alice, bob = self._seed_two(db)
        photo = _new_photo(ff.epoch(2021, 5))
        _add_face(db, photo, ff.cluster_around(rng, ca, 1)[0], person_id=alice)
        bob_face = _add_face(db, photo, ff.cluster_around(rng, cb, 1)[0])
        ff.reset_faces_caches()
        index.add_face_negatives([bob_face], bob)
        ff.reset_faces_caches()

        data = _search([alice, bob])
        assert all(c["photo"]["id"] != photo for c in data["candidates"])
