"""Endpoint tests for the destructive / bulk face routes (audit T2):
/api/faces/nuke and the representative-face dedup trio
(/api/faces/dedup/recompute, /persons, /groups).

Faces are seeded with synthetic embeddings via face_fixtures, so no InsightFace
model is needed. Nuke needs no model either (it only deletes); its cache wipe is
checked against real files in an isolated thumbnail directory.
"""

import time
from pathlib import Path

import numpy as np

from geotagger import config, index, thumbnails

import face_fixtures as ff


def _count(sql: str, params=()) -> int:
    return index.get_db().execute(sql, params).fetchone()[0]


def _photo_of(face_id: int) -> int:
    return _count("SELECT photo_id FROM faces WHERE id=?", (face_id,))


# ── /api/faces/nuke ──

def test_nuke_requires_photo_ids(client):
    """There is no confirm token — the UI confirms — so an empty selection is the
    only server-side guard against a body that would mean "nothing"."""
    assert client.post("/api/faces/nuke", json={"photo_ids": []}).status_code == 400
    assert client.post("/api/faces/nuke", json={}).status_code == 422


def test_nuke_deletes_every_face_of_the_selected_photos_only(client, thumbs_dir):
    db = index.get_db()
    rng = np.random.default_rng(10)
    person, (assigned, other_assigned) = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 2))
    ignored, come_back, kept = ff.seed_unlabeled(db, ff.unit_vectors(rng, 3))
    bob = index.create_person("Bob")
    index.set_faces_ignored([ignored], True)
    index.set_faces_come_back([come_back], True)
    index.add_face_negatives([assigned], bob)

    # Pile three faces (assigned, ignored, come-back) onto one photo, so nuking
    # it must remove faces in every state; `kept` and `other_assigned` stay put.
    target = _photo_of(assigned)
    with index.transaction() as tx:
        tx.execute("UPDATE faces SET photo_id=? WHERE id IN (?, ?)", (target, ignored, come_back))
        tx.execute("UPDATE photos SET faces_scanned_at=?, faces_det_dimension=640 WHERE id=?",
                   (time.time(), target))

    # Cached renditions for the target photo (and one for a bystander photo).
    row = index.get_photo(target)
    key = thumbnails._cache_key(Path(index.photo_path(row)), row["mtime"], row["size"])
    sub = thumbs_dir / key[:2]
    sub.mkdir(parents=True, exist_ok=True)
    for suffix in ("thumb.webp", "preview.webp", "face_1.webp"):
        (sub / f"{key}_{suffix}").write_bytes(b"x")
    bystander = index.get_photo(_photo_of(kept))
    bkey = thumbnails._cache_key(Path(index.photo_path(bystander)), bystander["mtime"], bystander["size"])
    (thumbs_dir / bkey[:2]).mkdir(parents=True, exist_ok=True)
    (thumbs_dir / bkey[:2] / f"{bkey}_thumb.webp").write_bytes(b"x")

    r = client.post("/api/faces/nuke", json={"photo_ids": [target, 999_999]})
    assert r.status_code == 200
    assert r.json() == {"photos": 2, "faces_deleted": 3, "files_deleted": 3}

    assert _count("SELECT COUNT(*) FROM faces WHERE photo_id=?", (target,)) == 0
    gone = (assigned, ignored, come_back)
    assert _count("SELECT COUNT(*) FROM face_embeddings WHERE face_id IN (?,?,?)", gone) == 0
    assert _count("SELECT COUNT(*) FROM face_negatives WHERE face_id IN (?,?,?)", gone) == 0
    scan = index.get_db().execute(
        "SELECT faces_scanned_at, faces_det_dimension FROM photos WHERE id=?", (target,)).fetchone()
    assert tuple(scan) == (None, None)       # queued for a from-scratch rescan
    assert not list(sub.glob(f"{key}_*"))

    # Bystanders untouched: their faces, embeddings, person link and cache file.
    assert {f["id"] for f in index.get_db().execute("SELECT id FROM faces")} == {other_assigned, kept}
    assert _count("SELECT person_id FROM faces WHERE id=?", (other_assigned,)) == person
    assert (thumbs_dir / bkey[:2] / f"{bkey}_thumb.webp").exists()
    persons = {p["id"]: p for p in client.get("/api/persons?face_counts=true").json()}
    assert persons[person]["face_count"] == 1


def test_nuke_unknown_photos_is_a_harmless_noop(client, thumbs_dir):
    rng = np.random.default_rng(11)
    (fid,) = ff.seed_unlabeled(index.get_db(), ff.unit_vectors(rng, 1))
    r = client.post("/api/faces/nuke", json={"photo_ids": [424242]})
    assert r.status_code == 200
    assert r.json() == {"photos": 1, "faces_deleted": 0, "files_deleted": 0}
    assert _count("SELECT COUNT(*) FROM faces WHERE id=?", (fid,)) == 1


# ── /api/faces/dedup/* (representative faces) ──

def _two_look_person(rng, name: str, per_look: int) -> tuple[int, list[int], list[int]]:
    """A person whose labeled faces form two tight, mutually distant clusters
    (e.g. with and without glasses) — so recompute must pick two representatives."""
    a, b = ff.unit_vectors(rng, 2)
    look_a = ff.cluster_around(rng, a, per_look, intra_cos=0.9)
    look_b = ff.cluster_around(rng, b, per_look, intra_cos=0.9)
    pid, ids = ff.seed_person(index.get_db(), name, np.vstack([look_a, look_b]))
    return pid, ids[:per_look], ids[per_look:]


def _flags(person_id: int) -> set[int]:
    return {r[0] for r in index.get_db().execute(
        "SELECT id FROM faces WHERE person_id=? AND representative=1", (person_id,))}


def test_dedup_recompute_flags_one_representative_per_look(client, monkeypatch):
    monkeypatch.setattr(config, "FACE_DEDUP_MIN_FACES", 10)
    monkeypatch.setattr(config, "FACE_DEDUP_MAX_FRACTION", 0.5)
    rng = np.random.default_rng(20)
    alice, look_a, look_b = _two_look_person(rng, "Alice", 6)
    small, _ = ff.seed_person(index.get_db(), "Small", ff.unit_vectors(rng, 3))  # below min

    assert client.get("/api/faces/dedup/persons").json() == []   # nothing until recompute

    r = client.post("/api/faces/dedup/recompute")
    assert r.status_code == 200
    assert r.json() == {"persons": [{"person_id": alice, "total": 12, "representative": 2}]}
    reps = _flags(alice)
    assert len(reps & set(look_a)) == 1 and len(reps & set(look_b)) == 1
    assert _flags(small) == set()

    assert client.get("/api/faces/dedup/persons").json() == [
        {"person_id": alice, "name": "Alice", "total": 12, "representative": 2}]

    # Re-running is a from-scratch recompute, not an accumulation.
    assert client.post("/api/faces/dedup/recompute").json()["persons"][0]["representative"] == 2
    assert _flags(alice) == reps


def test_dedup_groups_pair_each_representative_with_its_look(client, monkeypatch):
    monkeypatch.setattr(config, "FACE_DEDUP_MIN_FACES", 10)
    monkeypatch.setattr(config, "FACE_DEDUP_MAX_FRACTION", 0.5)
    rng = np.random.default_rng(21)
    alice, look_a, look_b = _two_look_person(rng, "Alice", 6)
    client.post("/api/faces/dedup/recompute")

    body = client.get(f"/api/faces/dedup/groups?person_id={alice}").json()
    assert body["total"] == 12
    groups = body["groups"]
    assert len(groups) == 2 and sorted(g["size"] for g in groups) == [6, 6]
    for g in groups:
        members = {g["representative"]["id"], *(f["id"] for f in g["others"])}
        assert members in (set(look_a), set(look_b))   # no face lands in the wrong look

    # group_limit caps the sample but not `size`.
    capped = client.get(f"/api/faces/dedup/groups?person_id={alice}&group_limit=2").json()["groups"]
    assert all(len(g["others"]) == 2 and g["size"] == 6 for g in capped)


def test_dedup_groups_empty_and_invalid(client):
    rng = np.random.default_rng(22)
    pid, _ = ff.seed_person(index.get_db(), "Never", ff.unit_vectors(rng, 3))
    assert client.get(f"/api/faces/dedup/groups?person_id={pid}").json() == {"groups": [], "total": 0}
    assert client.get("/api/faces/dedup/groups?person_id=987654").json() == {"groups": [], "total": 0}
    assert client.get("/api/faces/dedup/groups").status_code == 422
    assert client.get(f"/api/faces/dedup/groups?person_id={pid}&group_limit=0").status_code == 422
    assert client.get(f"/api/faces/dedup/groups?person_id={pid}&group_limit=201").status_code == 422


def test_dedup_recompute_clears_flags_of_reassigned_faces(client, monkeypatch):
    """After a representative face is moved to someone else, a recompute must not
    leave that person or the new owner with a stale flag (D9's route-level twin)."""
    monkeypatch.setattr(config, "FACE_DEDUP_MIN_FACES", 10)
    monkeypatch.setattr(config, "FACE_DEDUP_MAX_FRACTION", 0.5)
    rng = np.random.default_rng(23)
    alice, look_a, look_b = _two_look_person(rng, "Alice", 6)
    client.post("/api/faces/dedup/recompute")
    rep = next(iter(_flags(alice) & set(look_a)))

    r = client.post("/api/faces/assign", json={"face_ids": [rep], "name": "Bob"})
    assert r.status_code == 200
    bob = r.json()["person_id"]
    assert _count("SELECT representative FROM faces WHERE id=?", (rep,)) == 0

    client.post("/api/faces/dedup/recompute")
    reps = _flags(alice)
    assert rep not in reps and len(reps & set(look_a)) == 1 and len(reps & set(look_b)) == 1
    assert _flags(bob) == set()            # Bob has 1 face: below the min, never flagged
