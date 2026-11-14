"""POST /api/persons/{id}/merge — fold one person into another (audit U1)."""

import numpy as np

from geotagger import index

import face_fixtures as ff


def _faces_of(db, pid):
    return {r[0] for r in db.execute("SELECT id FROM faces WHERE person_id=?", (pid,))}


def _negatives(db):
    return {(r[0], r[1]) for r in db.execute("SELECT face_id, person_id FROM face_negatives")}


def _merge(client, src, tgt):
    return client.post(f"/api/persons/{src}/merge", json={"into": tgt})


def test_merge_moves_faces_flags_and_deletes_source(client):
    db = index.get_db()
    rng = np.random.default_rng(100)
    alice, a_faces = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 3))
    bob, b_faces = ff.seed_person(db, "Bob", ff.unit_vectors(rng, 2))
    a_assigned = {r[0]: r[1] for r in db.execute(
        "SELECT id, assigned_at FROM faces WHERE person_id=?", (alice,))}
    index.set_person_representatives(alice, [a_faces[0]])
    index.set_person_representatives(bob, [b_faces[0]])

    r = _merge(client, alice, bob)
    assert r.status_code == 200
    s = r.json()
    assert s["id"] == bob and s["name"] == "Bob"
    assert s["merged_from"] == {"id": alice, "name": "Alice"}
    assert s["moved_faces"] == 3 and s["moved_representatives"] == 1

    assert _faces_of(db, bob) == set(a_faces) | set(b_faces)
    assert index.get_person(alice) is None
    # Original tagging times survive; both people's representatives are kept.
    for fid, ts in a_assigned.items():
        assert db.execute("SELECT assigned_at FROM faces WHERE id=?", (fid,)).fetchone()[0] == ts
    reps = {r[0] for r in db.execute(
        "SELECT id FROM faces WHERE person_id=? AND representative=1", (bob,))}
    assert reps == {a_faces[0], b_faces[0]}

    counts = {p["id"]: p["face_count"]
              for p in client.get("/api/persons?face_counts=true").json()}
    assert counts == {bob: 5}


def test_merge_negatives_move_dedupe_and_drop_contradictions(client):
    db = index.get_db()
    rng = np.random.default_rng(101)
    alice, a_faces = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 1))
    bob, b_faces = ff.seed_person(db, "Bob", ff.unit_vectors(rng, 1))
    u = ff.seed_unlabeled(db, ff.unit_vectors(rng, 3))
    index.add_face_negatives([u[0], u[1]], alice)  # u0 moves, u1 duplicates
    index.add_face_negatives([u[1], u[2]], bob)    # u2: target's own, untouched
    index.add_face_negatives([b_faces[0]], alice)  # "Bob's face isn't Alice" → contradiction
    index.add_face_negatives([a_faces[0]], bob)    # "Alice's face isn't Bob" → contradiction

    s = _merge(client, alice, bob).json()
    assert s["merged_negatives"] == 1
    assert s["duplicate_negatives"] == 1
    assert s["dropped_negatives"] == 2
    assert _negatives(db) == {(u[0], bob), (u[1], bob), (u[2], bob)}


def test_merge_attributes_fill_widen_and_conflict(client):
    db = index.get_db()
    smith = client.post("/api/families", json={"name": "Smith"}).json()["id"]
    jones = client.post("/api/families", json={"name": "Jones"}).json()["id"]
    alice = index.create_person("Alice")
    bob = index.create_person("Bob")
    client.patch(f"/api/persons/{alice}", json={
        "birth_date": "1990-01-01", "family_id": smith,
        "not_before": "2005-01-01", "not_after": "2015-01-01"})
    client.patch(f"/api/persons/{bob}", json={
        "family_id": jones, "not_before": "2010-01-01", "not_after": "2012-01-01"})

    s = _merge(client, alice, bob).json()
    assert s["filled"] == ["birth_date"]
    assert sorted(s["widened"]) == ["not_after", "not_before"]
    assert s["conflicts"] == [{"field": "family_id", "kept": jones, "discarded": smith}]
    row = db.execute("SELECT * FROM persons WHERE id=?", (bob,)).fetchone()
    assert row["name"] == "Bob" and row["birth_date"] == "1990-01-01"
    assert row["family_id"] == jones
    assert (row["not_before"], row["not_after"]) == ("2005-01-01", "2015-01-01")


def test_merge_target_window_already_wider_is_kept(client):
    alice = index.create_person("Alice")
    bob = index.create_person("Bob")
    index.set_person_not_before(alice, "2010-01-01")
    index.set_person_not_before(bob, "2000-01-01")
    s = _merge(client, alice, bob).json()
    assert s["widened"] == [] and s["conflicts"] == []
    assert index.get_person(bob)["not_before"] == "2000-01-01"


def test_merge_errors(client):
    alice = index.create_person("Alice")
    assert _merge(client, alice, alice).status_code == 400
    assert _merge(client, alice, 9999).status_code == 404
    assert _merge(client, 9999, alice).status_code == 404
    assert index.get_person(alice) is not None


def test_merge_invalidates_suggestion_caches(client):
    """The target's gallery picks up the source's examples, and the source's id
    vanishes from rankings — even with every cache warmed beforehand."""
    db = index.get_db()
    rng = np.random.default_rng(102)
    c_alice, c_bob = ff.unit_vectors(rng, 2)
    alice, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, c_alice, 3, intra_cos=0.9))
    bob, _ = ff.seed_person(db, "Bob", ff.cluster_around(rng, c_bob, 3, intra_cos=0.9))
    fid = ff.seed_unlabeled(db, ff.cluster_around(rng, c_alice, 1, intra_cos=0.9))[0]
    photo_id = db.execute("SELECT photo_id FROM faces WHERE id=?", (fid,)).fetchone()[0]

    # Warm the gallery / unlabeled / score caches.
    assert client.get(f"/api/photos/{photo_id}/faces").json()[0]["suggestion"]["person_id"] == alice
    before = client.get("/api/faces?scope=unlabeled&suggested_only=true").json()
    assert before["faces"][0]["suggestion"]["person_id"] == alice
    assert client.get(f"/api/faces?scope=suggested&person_id={bob}").json()["total"] == 0

    assert _merge(client, alice, bob).status_code == 200

    sug = client.get(f"/api/photos/{photo_id}/faces").json()[0]["suggestion"]
    assert sug["person_id"] == bob and sug["person_name"] == "Bob"
    after = client.get("/api/faces?scope=unlabeled&suggested_only=true").json()
    assert after["faces"][0]["suggestion"]["person_id"] == bob
    found = client.get(f"/api/faces?scope=suggested&person_id={bob}").json()
    assert [f["id"] for f in found["faces"]] == [fid]


def test_rename_collision_then_merge(client):
    """The UI's path: rename → 409 carrying the existing id → merge into it."""
    alice = index.create_person("Alice")
    bob = index.create_person("Bob")
    r = client.patch(f"/api/persons/{alice}", json={"name": "Bob"})
    assert r.status_code == 409
    target = r.json()["detail"]["existing_person_id"]
    assert target == bob
    assert _merge(client, alice, target).status_code == 200
    assert [p["name"] for p in client.get("/api/persons").json()] == ["Bob"]
