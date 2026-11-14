"""Undo for the one-click face and person writes (audit U3): every write returns
an ``undo`` token and POST /api/faces/undo restores exactly what it changed,
refusing faces changed since."""

import numpy as np

from geotagger import index

import face_fixtures as ff

COLS = ("person_id", "ignored", "ignored_at", "come_back", "come_back_at",
        "representative", "assigned_at")


def _state(ids) -> dict:
    db = index.get_db()
    return {r["id"]: tuple(r[c] for c in COLS) for r in db.execute(
        f"SELECT id, {', '.join(COLS)} FROM faces WHERE id IN (SELECT value FROM json_each(?))",
        (index.ids_json(ids),))}


def _negatives() -> set:
    return {(r[0], r[1], r[2]) for r in index.get_db().execute(
        "SELECT face_id, person_id, created_at FROM face_negatives")}


def _photo_of(face_id: int) -> int:
    return index.get_db().execute("SELECT photo_id FROM faces WHERE id=?",
                                  (face_id,)).fetchone()[0]


def _undo(client, token):
    return client.post("/api/faces/undo", json=token)


def _mixed(seed: int):
    """Alice with 2 faces (one representative), one ignored face, one come-back
    face, two unlabeled faces — one carrying "not Alice"."""
    db = index.get_db()
    rng = np.random.default_rng(seed)
    alice, a = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 2))
    index.set_person_representatives(alice, [a[0]])
    u = ff.seed_unlabeled(db, ff.unit_vectors(rng, 4))
    index.set_faces_ignored([u[0]], True)
    index.set_faces_come_back([u[1]], True)
    index.add_face_negatives([u[2]], alice)
    return alice, a, u


def test_bulk_assign_undo_restores_every_column_and_negative(client):
    alice, a, u = _mixed(1)
    bob = index.create_person("Bob")
    ids = [*a, *u]
    before, negs = _state(ids), _negatives()
    r = client.post("/api/faces/assign", json={"face_ids": ids, "person_id": alice})
    assert r.status_code == 200
    token = r.json()["undo"]
    # Alice's own faces only had assigned_at refreshed — still a change to undo.
    assert {s["face_id"] for s in token["faces"]} == set(ids)
    assert (u[2], alice) not in {(f, p) for f, p, _ in _negatives()}
    index.create_person("Unrelated")  # unrelated writes don't count as conflicts
    out = _undo(client, token).json()
    assert sorted(out["restored"]) == sorted(ids) and out["conflicts"] == []
    assert _state(ids) == before
    assert _negatives() == negs
    assert index.get_person(bob)


def test_unassign_single_face_undo(client):
    alice, a, _ = _mixed(2)
    before = _state(a)
    r = client.post(f"/api/faces/{a[0]}/assign", json={"clear": True})
    assert r.json()["undo"]["faces"][0]["face_id"] == a[0]
    assert _state([a[0]])[a[0]][0] is None
    _undo(client, r.json()["undo"])
    assert _state(a) == before  # representative flag and assigned_at are back


def test_ignore_group_and_come_back_undo(client):
    alice, a, u = _mixed(3)
    ids = [a[1], u[2], u[3]]
    before = _state(ids)
    tok = client.post("/api/faces/ignore", json={"face_ids": ids, "ignored": True}).json()["undo"]
    _undo(client, tok)
    assert _state(ids) == before
    tok = client.post("/api/faces/come-back", json={"face_ids": ids, "come_back": True}).json()["undo"]
    _undo(client, tok)
    assert _state(ids) == before
    # Restoring an ignored face (ignored=false) is undoable too.
    before = _state([u[0]])
    tok = client.post("/api/faces/ignore", json={"face_ids": [u[0]], "ignored": False}).json()["undo"]
    _undo(client, tok)
    assert _state([u[0]]) == before


def test_unchanged_faces_are_left_out_of_the_token(client):
    _, _, u = _mixed(4)
    # Taking u[3] out of a come-back queue it isn't in changes nothing.
    tok = client.post("/api/faces/come-back",
                      json={"face_ids": [u[3]], "come_back": False}).json()["undo"]
    assert tok["faces"] == []


def test_ignore_unlabeled_in_photo_undo(client):
    alice, a, u = _mixed(5)
    photos = [_photo_of(f) for f in (*a, *u)]
    ids = [*a, *u]
    before = _state(ids)
    r = client.post("/api/crowds/ignore-unlabeled", json={"photo_ids": photos}).json()
    assert r["ignored"] == 2  # u[2], u[3]
    assert {s["face_id"] for s in r["undo"]["faces"]} == {u[2], u[3]}
    _undo(client, r["undo"])
    assert _state(ids) == before


def test_conflict_refuses_only_the_changed_face(client):
    alice, a, u = _mixed(6)
    tok = client.post("/api/faces/ignore",
                      json={"face_ids": [u[2], u[3]], "ignored": True}).json()["undo"]
    client.post("/api/faces/assign", json={"face_ids": [u[3]], "person_id": alice})
    after_u3 = _state([u[3]])
    out = _undo(client, tok).json()
    assert out["restored"] == [u[2]] and out["conflicts"] == [u[3]]
    assert _state([u[3]]) == after_u3  # the later edit stands
    # A second undo of the same token: u[2] has moved on (it was restored).
    assert _undo(client, tok).json()["conflicts"] == [u[2], u[3]]


def test_assign_by_new_name_undo_removes_the_created_person(client):
    _, _, u = _mixed(7)
    r = client.post("/api/faces/assign", json={"face_ids": [u[3]], "name": "Carol"}).json()
    carol = r["person_id"]
    assert r["undo"]["created_person_id"] == carol
    out = _undo(client, r["undo"]).json()
    assert out["removed_person_id"] == carol and index.get_person(carol) is None
    # By an existing name: nothing to remove.
    r = client.post("/api/faces/assign", json={"face_ids": [u[3]], "name": "Alice"}).json()
    assert r["undo"]["created_person_id"] is None


def test_delete_person_undo_restores_person_faces_and_negatives(client):
    alice, a, u = _mixed(8)
    fam = client.post("/api/families", json={"name": "Smith"}).json()["id"]
    client.patch(f"/api/persons/{alice}", json={
        "birth_date": "1990-02-03", "not_before": "2000-01-01", "not_after": "2020-12-31",
        "family_id": fam})
    person_before = dict(index.get_person(alice))
    ids = [*a, *u]
    before, negs = _state(ids), _negatives()
    r = client.delete(f"/api/persons/{alice}")
    assert r.status_code == 200
    token = r.json()["undo"]
    assert index.get_person(alice) is None
    assert all(v[0] is None for v in _state(a).values())
    out = _undo(client, token).json()
    assert out["person_id"] == alice and not out["person_id_changed"]
    assert not out["family_dropped"]
    assert dict(index.get_person(alice)) == person_before
    assert _state(ids) == before
    assert _negatives() == negs


def test_delete_person_undo_name_taken_is_409_and_writes_nothing(client):
    alice, a, _ = _mixed(9)
    token = client.delete(f"/api/persons/{alice}").json()["undo"]
    client.post("/api/persons", json={"name": "Alice"})
    snapshot = _state(a)
    r = _undo(client, token)
    assert r.status_code == 409
    assert _state(a) == snapshot


def test_delete_person_undo_reused_id_gets_a_new_one(client):
    alice, a, _ = _mixed(10)
    token = client.delete(f"/api/persons/{alice}").json()["undo"]
    # No AUTOINCREMENT: the next person takes the freed (highest) id.
    other = client.post("/api/persons", json={"name": "Zed"}).json()["id"]
    assert other == alice
    out = _undo(client, token).json()
    new = out["person_id"]
    assert out["person_id_changed"] and new != alice
    assert index.get_person(new)["name"] == "Alice"
    assert {f for f, v in _state(a).items() if v[0] == new} == set(a)


def test_delete_person_undo_conflicting_face_and_dropped_family(client):
    alice, a, u = _mixed(11)
    fam = client.post("/api/families", json={"name": "Smith"}).json()["id"]
    client.patch(f"/api/persons/{alice}", json={"family_id": fam})
    token = client.delete(f"/api/persons/{alice}").json()["undo"]
    client.post("/api/faces/ignore", json={"face_ids": [a[1]], "ignored": True})
    client.delete(f"/api/families/{fam}")
    out = _undo(client, token).json()
    assert out["restored"] == [a[0]] and out["conflicts"] == [a[1]]
    assert out["family_dropped"]
    assert index.get_person(alice)["family_id"] is None
    assert _state([a[1]])[a[1]][1] == 1  # still ignored


def test_undo_validates_the_token(client):
    assert _undo(client, {}).status_code == 400
    bad = {"faces": [{"face_id": 1, "expect": {},
                      "before": {"person_id": 1, "ignored": True}}]}
    assert _undo(client, bad).status_code == 422
    bad_person = {"person": {"id": 5, "name": "X", "birth_date": "1990/01/01"}}
    assert _undo(client, bad_person).status_code == 400


def test_undo_bumps_the_faces_generation(client):
    _, _, u = _mixed(12)
    tok = client.post("/api/faces/ignore", json={"face_ids": [u[3]], "ignored": True}).json()["undo"]
    gen = index.faces_generation()
    _undo(client, tok)
    assert index.faces_generation() > gen
