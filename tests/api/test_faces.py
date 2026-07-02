"""Endpoint tests for geotagger.api.faces (persons, families, faces, clusters, crowds).

Face data is seeded with synthetic embeddings via face_fixtures — no InsightFace
model needed. The detection-only routes (/api/faces/scan, /crop) that require the
model or a real image on disk are covered only by their not-found / empty paths.
"""

import numpy as np

from geotagger import index

import face_fixtures as ff


def test_persons_crud(client):
    pid = client.post("/api/persons", json={"name": "Alice"}).json()["id"]
    assert any(p["id"] == pid for p in client.get("/api/persons").json())
    assert client.delete(f"/api/persons/{pid}").json() == {"success": True}


def test_person_empty_name_400(client):
    assert client.post("/api/persons", json={"name": "   "}).status_code == 400


def test_families_crud(client):
    r = client.post("/api/families", json={"name": "Smith"})
    fid = r.json()["id"]
    assert r.json()["person_count"] == 0
    assert any(f["id"] == fid for f in client.get("/api/families").json())
    assert client.patch(f"/api/families/{fid}", json={"name": "Jones"}).json()["name"] == "Jones"
    assert client.delete(f"/api/families/{fid}").json() == {"success": True}


def test_list_assign_and_scopes(client):
    db = index.get_db()
    rng = np.random.default_rng(0)
    ids = ff.seed_unlabeled(db, ff.unit_vectors(rng, 3), det_score=0.9)

    listing = client.get("/api/faces?scope=unlabeled").json()
    assert listing["total"] == 3 and len(listing["faces"]) == 3

    r = client.post("/api/faces/assign", json={"face_ids": ids[:2], "name": "Alice"})
    assert r.status_code == 200 and r.json()["assigned"] == 2
    person_id = r.json()["person_id"]

    assert client.get(f"/api/faces?scope=person&person_id={person_id}").json()["total"] == 2
    assert client.get("/api/faces?scope=unlabeled").json()["total"] == 1


def test_ignore_moves_faces_out_of_unlabeled(client):
    db = index.get_db()
    rng = np.random.default_rng(1)
    ids = ff.seed_unlabeled(db, ff.unit_vectors(rng, 2))
    assert client.post("/api/faces/ignore", json={"face_ids": ids, "ignored": True}).status_code == 200
    assert client.get("/api/faces?scope=unlabeled").json()["total"] == 0
    assert client.get("/api/faces?scope=ignored").json()["total"] == 2


def test_scan_status_empty(client):
    assert client.get("/api/faces/scan/status").json() == {
        "remaining_photos": 0, "total_faces": 0, "unlabeled_faces": 0,
        "ignored_faces": 0, "tagged_faces": 0,
    }


def test_clusters_recovers_two_groups(client):
    db = index.get_db()
    rng = np.random.default_rng(0)
    c1, c2 = ff.unit_vectors(rng, 2)
    embs = np.concatenate([ff.cluster_around(rng, c1, 5), ff.cluster_around(rng, c2, 5)])
    ff.seed_unlabeled(db, embs)
    clusters = client.get("/api/faces/clusters").json()["clusters"]
    assert len(clusters) == 2
    assert sorted(c["size"] for c in clusters) == [5, 5]


def test_crowds_empty(client):
    assert client.get("/api/crowds").json() == {"groups": [], "photo_count": 0}


def test_face_crop_missing_404(client):
    assert client.get("/api/faces/999/crop").status_code == 404


# ── Recognition-suggestion paths (synthetic gallery, still no model) ──

def test_scope_suggested_ranks_person_guesses(client):
    db = index.get_db()
    rng = np.random.default_rng(3)
    c = ff.unit_vectors(rng, 1)[0]
    alice_id, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, c, 3, intra_cos=0.9))
    ff.seed_unlabeled(db, ff.cluster_around(rng, c, 2, intra_cos=0.9))
    r = client.get(f"/api/faces?scope=suggested&person_id={alice_id}").json()
    assert r["total"] >= 1
    assert all(f["suggestion"]["person_id"] == alice_id for f in r["faces"])


def test_scope_suggested_requires_person_id_400(client):
    assert client.get("/api/faces?scope=suggested").status_code == 400


def test_unlabeled_suggested_only(client):
    db = index.get_db()
    rng = np.random.default_rng(4)
    c = ff.unit_vectors(rng, 1)[0]
    ff.seed_person(db, "Bob", ff.cluster_around(rng, c, 3, intra_cos=0.9))
    ff.seed_unlabeled(db, ff.cluster_around(rng, c, 2, intra_cos=0.9))
    r = client.get("/api/faces?scope=unlabeled&suggested_only=true").json()
    assert r["total"] >= 1
    assert all(f["suggestion"] is not None for f in r["faces"])


def test_single_face_assign_by_name(client):
    db = index.get_db()
    rng = np.random.default_rng(5)
    fid = ff.seed_unlabeled(db, ff.unit_vectors(rng, 1))[0]
    r = client.post(f"/api/faces/{fid}/assign", json={"name": "Carol"})
    assert r.status_code == 200
    pid = r.json()["person_id"]
    assert client.get(f"/api/faces?scope=person&person_id={pid}").json()["total"] == 1


def test_single_face_assign_404(client):
    assert client.post("/api/faces/999/assign", json={"name": "x"}).status_code == 404


def test_photo_faces_lists_and_404(client):
    db = index.get_db()
    rng = np.random.default_rng(6)
    fid = ff.seed_unlabeled(db, ff.unit_vectors(rng, 1))[0]
    photo_id = db.execute("SELECT photo_id FROM faces WHERE id=?", (fid,)).fetchone()[0]
    faces_list = client.get(f"/api/photos/{photo_id}/faces").json()
    assert [f["id"] for f in faces_list] == [fid]
    assert faces_list[0]["person_id"] is None
    assert client.get("/api/photos/999/faces").status_code == 404


def test_crowds_groups_and_ignore(client):
    from geotagger import faces as faces_mod
    db = index.get_db()
    index.upsert_photo(
        path="crowd.jpg", filename="crowd.jpg", dir_=".", ext=".jpg",
        media_type="image", mtime=0.0, size=0, lat=None, lng=None,
        geotag_source="none", sidecar_path=None, sidecar_mtime=None,
        photo_datetime=1_609_459_200,  # 2021-01-01 UTC
    )
    photo_id = db.execute("SELECT id FROM photos WHERE path='crowd.jpg'").fetchone()[0]
    # get_crowd_photos only considers photos that have been face-scanned.
    db.execute("UPDATE photos SET faces_scanned_at=1 WHERE id=?", (photo_id,))
    vec = faces_mod.encode_embedding(ff.unit_vectors(np.random.default_rng(7), 1)[0])
    for _ in range(3):
        db.execute(
            "INSERT INTO faces (photo_id, person_id, bbox, det_score, embedding, "
            "source, ignored, created_at) VALUES (?, NULL, '0,0,1,1', 0.9, ?, 'detected', 0, 0)",
            (photo_id, vec))
    db.commit()
    ff.reset_faces_caches()

    r = client.get("/api/crowds?min_faces=2").json()
    assert r["photo_count"] == 1
    assert len(r["groups"]) == 1
    g = r["groups"][0]
    assert g["total_faces"] == 3 and g["unlabeled_faces"] == 3
    assert g["label"] == "January 1, 2021"

    # Ignore all unlabeled faces in the crowd photo. They're still counted in
    # total_faces (so the photo remains a crowd), but unlabeled_faces drops to 0.
    r = client.post("/api/crowds/ignore-unlabeled", json={"photo_ids": [photo_id]})
    assert r.json() == {"ignored": 3}
    after = client.get("/api/crowds?min_faces=2").json()
    assert after["photo_count"] == 1
    assert after["groups"][0]["unlabeled_faces"] == 0
