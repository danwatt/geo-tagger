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
        "ignored_faces": 0, "come_back_faces": 0, "tagged_faces": 0,
    }


def test_come_back_moves_faces_out_of_unlabeled_and_restores(client):
    db = index.get_db()
    rng = np.random.default_rng(2)
    ids = ff.seed_unlabeled(db, ff.unit_vectors(rng, 2))
    r = client.post("/api/faces/come-back", json={"face_ids": ids, "come_back": True})
    assert r.status_code == 200 and r.json() == {"updated": 2, "come_back": True}
    assert client.get("/api/faces?scope=unlabeled").json()["total"] == 0
    assert client.get("/api/faces?scope=come_back").json()["total"] == 2

    r = client.post("/api/faces/come-back", json={"face_ids": ids, "come_back": False})
    assert r.status_code == 200 and r.json() == {"updated": 2, "come_back": False}
    assert client.get("/api/faces?scope=come_back").json()["total"] == 0
    assert client.get("/api/faces?scope=unlabeled").json()["total"] == 2


def test_assign_clears_come_back(client):
    db = index.get_db()
    rng = np.random.default_rng(3)
    ids = ff.seed_unlabeled(db, ff.unit_vectors(rng, 1))
    client.post("/api/faces/come-back", json={"face_ids": ids, "come_back": True})
    r = client.post("/api/faces/assign", json={"face_ids": ids, "name": "Bob"})
    assert r.status_code == 200 and r.json()["assigned"] == 1
    assert client.get("/api/faces?scope=come_back").json()["total"] == 0


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


# ── Face negatives ("definitely not person A") ──

def test_face_negatives_removes_and_restores_suggestion(client):
    db = index.get_db()
    rng = np.random.default_rng(20)
    c = ff.unit_vectors(rng, 1)[0]
    alice_id, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, c, 3, intra_cos=0.9))
    fid = ff.seed_unlabeled(db, ff.cluster_around(rng, c, 1, intra_cos=0.9))[0]
    photo_id = db.execute("SELECT photo_id FROM faces WHERE id=?", (fid,)).fetchone()[0]

    before = client.get(f"/api/photos/{photo_id}/faces").json()
    assert before[0]["suggestion"]["person_id"] == alice_id
    assert before[0]["negatives"] == []

    r = client.post("/api/faces/negatives",
                    json={"face_ids": [fid], "person_id": alice_id, "negative": True})
    assert r.status_code == 200
    assert r.json() == {"updated": 1, "person_id": alice_id, "negative": True}

    # The face stays in the unlabeled queue (negatives are orthogonal to ignore).
    assert client.get("/api/faces?scope=unlabeled").json()["total"] == 1

    after = client.get(f"/api/photos/{photo_id}/faces").json()
    assert after[0]["suggestion"] is None
    assert after[0]["negatives"] == [alice_id]

    # Undo: negative=false restores the suggestion.
    r2 = client.post("/api/faces/negatives",
                     json={"face_ids": [fid], "person_id": alice_id, "negative": False})
    assert r2.json()["negative"] is False
    restored = client.get(f"/api/photos/{photo_id}/faces").json()
    assert restored[0]["suggestion"]["person_id"] == alice_id
    assert restored[0]["negatives"] == []


def test_face_negatives_unknown_person_404(client):
    r = client.post("/api/faces/negatives", json={"face_ids": [1], "person_id": 999})
    assert r.status_code == 404


def test_scope_suggested_excludes_rejected_face(client):
    db = index.get_db()
    rng = np.random.default_rng(21)
    c = ff.unit_vectors(rng, 1)[0]
    alice_id, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, c, 3, intra_cos=0.9))
    fids = ff.seed_unlabeled(db, ff.cluster_around(rng, c, 2, intra_cos=0.9))

    before = client.get(f"/api/faces?scope=suggested&person_id={alice_id}").json()
    assert before["total"] == 2

    client.post("/api/faces/negatives",
               json={"face_ids": [fids[0]], "person_id": alice_id})
    after = client.get(f"/api/faces?scope=suggested&person_id={alice_id}").json()
    assert after["total"] == 1
    assert all(f["id"] != fids[0] for f in after["faces"])


def test_assign_clears_conflicting_negative(client):
    """A face can't be simultaneously 'assigned to Alice' and 'not Alice'."""
    db = index.get_db()
    rng = np.random.default_rng(22)
    alice_id = client.post("/api/persons", json={"name": "Alice"}).json()["id"]
    fid = ff.seed_unlabeled(db, ff.unit_vectors(rng, 1))[0]

    client.post("/api/faces/negatives", json={"face_ids": [fid], "person_id": alice_id})
    assert db.execute(
        "SELECT COUNT(*) FROM face_negatives WHERE face_id=? AND person_id=?", (fid, alice_id)
    ).fetchone()[0] == 1

    client.post(f"/api/faces/{fid}/assign", json={"person_id": alice_id})
    assert db.execute(
        "SELECT COUNT(*) FROM face_negatives WHERE face_id=? AND person_id=?", (fid, alice_id)
    ).fetchone()[0] == 0


def test_delete_person_removes_face_negatives(client):
    db = index.get_db()
    rng = np.random.default_rng(23)
    c = ff.unit_vectors(rng, 1)[0]
    alice_id, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, c, 2, intra_cos=0.9))
    fid = ff.seed_unlabeled(db, ff.cluster_around(rng, c, 1, intra_cos=0.9))[0]

    client.post("/api/faces/negatives", json={"face_ids": [fid], "person_id": alice_id})
    assert db.execute("SELECT COUNT(*) FROM face_negatives").fetchone()[0] == 1

    assert client.delete(f"/api/persons/{alice_id}").json() == {"success": True}
    assert db.execute("SELECT COUNT(*) FROM face_negatives").fetchone()[0] == 0


# ── Time Focus window (start_ts/end_ts) on the tagging/discovery surfaces ──

_2015 = (ff.epoch(2015, 1, 1), ff.epoch(2016, 1, 1))  # a [start, end] covering 2015


def test_unlabeled_scope_windows_by_photo_time(client):
    db = index.get_db()
    rng = np.random.default_rng(10)
    ff.seed_unlabeled(db, ff.unit_vectors(rng, 2), photo_datetimes=ff.epoch(2015, 6, 1))
    ff.seed_unlabeled(db, ff.unit_vectors(rng, 3), photo_datetimes=ff.epoch(2020, 6, 1))
    ff.seed_unlabeled(db, ff.unit_vectors(rng, 1), photo_datetimes=None)  # undated

    assert client.get("/api/faces?scope=unlabeled").json()["total"] == 6
    start, end = _2015
    win = client.get(f"/api/faces?scope=unlabeled&start_ts={start}&end_ts={end}").json()
    assert win["total"] == 2 and len(win["faces"]) == 2
    # Undated faces fall outside every window (a wide 2000–2025 span still omits it).
    wide = client.get(
        f"/api/faces?scope=unlabeled&start_ts={ff.epoch(2000,1,1)}&end_ts={ff.epoch(2025,1,1)}"
    ).json()
    assert wide["total"] == 5


def test_persons_window_hides_out_of_range(client):
    db = index.get_db()
    rng = np.random.default_rng(11)
    c1, c2 = ff.unit_vectors(rng, 2)
    ff.seed_person(db, "Alice", ff.cluster_around(rng, c1, 3, intra_cos=0.9),
                   photo_datetimes=[ff.epoch(2015, 6, 1), ff.epoch(2015, 7, 1),
                                    ff.epoch(2020, 6, 1)])
    ff.seed_person(db, "Bob", ff.cluster_around(rng, c2, 2, intra_cos=0.9),
                   photo_datetimes=ff.epoch(2020, 6, 1))

    # No face_count anywhere (too expensive to compute — see index.get_persons).
    full = client.get("/api/persons").json()
    assert all("face_count" not in p for p in full)
    assert {p["name"] for p in full} == {"Alice", "Bob"}

    start, end = _2015
    win = client.get(f"/api/persons?start_ts={start}&end_ts={end}").json()
    # Bob (no 2015 faces) drops out; Alice (has some) stays, still with no count.
    assert {p["name"] for p in win} == {"Alice"}
    assert all("face_count" not in p for p in win)


def test_scan_status_window_scopes_unlabeled_only(client):
    db = index.get_db()
    rng = np.random.default_rng(12)
    ff.seed_unlabeled(db, ff.unit_vectors(rng, 2), photo_datetimes=ff.epoch(2015, 6, 1))
    ff.seed_unlabeled(db, ff.unit_vectors(rng, 3), photo_datetimes=ff.epoch(2020, 6, 1))
    start, end = _2015
    s = client.get(f"/api/faces/scan/status?start_ts={start}&end_ts={end}").json()
    assert s["unlabeled_faces"] == 2   # windowed
    assert s["total_faces"] == 5       # global (unwindowed nav scope)


def test_suggested_scopes_window_candidates(client):
    db = index.get_db()
    rng = np.random.default_rng(13)
    c = ff.unit_vectors(rng, 1)[0]
    # Alice's gallery is undated (still global); unknowns are split across years.
    alice_id, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, c, 3, intra_cos=0.9))
    ff.seed_unlabeled(db, ff.cluster_around(rng, c, 2, intra_cos=0.9),
                      photo_datetimes=ff.epoch(2015, 6, 1))
    ff.seed_unlabeled(db, ff.cluster_around(rng, c, 4, intra_cos=0.9),
                      photo_datetimes=ff.epoch(2020, 6, 1))
    start, end = _2015

    # scope=suggested ("Find more") only offers the in-window candidates.
    sug = client.get(
        f"/api/faces?scope=suggested&person_id={alice_id}&start_ts={start}&end_ts={end}"
    ).json()
    assert sug["total"] == 2
    # suggested_only on the unlabeled queue windows the same way.
    only = client.get(
        f"/api/faces?scope=unlabeled&suggested_only=true&start_ts={start}&end_ts={end}"
    ).json()
    assert only["total"] == 2


def test_clusters_window_candidates(client):
    db = index.get_db()
    rng = np.random.default_rng(14)
    c1, c2 = ff.unit_vectors(rng, 2)
    ff.seed_unlabeled(db, ff.cluster_around(rng, c1, 5, intra_cos=0.9),
                      photo_datetimes=ff.epoch(2015, 6, 1))
    ff.seed_unlabeled(db, ff.cluster_around(rng, c2, 5, intra_cos=0.9),
                      photo_datetimes=ff.epoch(2020, 6, 1))
    start, end = _2015
    data = client.get(f"/api/faces/clusters?start_ts={start}&end_ts={end}").json()
    # Only the 2015 group's faces are scanned, so one cluster of 5 is found.
    assert data["scanned"] == 5
    assert [c["size"] for c in data["clusters"]] == [5]


def test_crowds_groups_and_ignore(client):
    from geotagger import faces as faces_mod
    db = index.get_db()
    index.upsert_photo(
        filename="crowd.jpg", dir_=".", ext=".jpg",
        media_type="image", mtime=0.0, size=0, lat=None, lng=None,
        geotag_source="none", sidecar_path=None, sidecar_mtime=None,
        photo_datetime=1_609_459_200,  # 2021-01-01 UTC
    )
    photo_id = db.execute("SELECT id FROM photos WHERE filename='crowd.jpg'").fetchone()[0]
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


def test_crowds_window_filters_photos(client):
    from geotagger import faces as faces_mod
    db = index.get_db()
    rng = np.random.default_rng(15)

    def seed_crowd(path, dt):
        index.upsert_photo(
            filename=path, dir_=".", ext=".jpg", media_type="image",
            mtime=0.0, size=0, lat=None, lng=None, geotag_source="none",
            sidecar_path=None, sidecar_mtime=None, photo_datetime=dt,
        )
        pid = db.execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()[0]
        db.execute("UPDATE photos SET faces_scanned_at=1 WHERE id=?", (pid,))
        vec = faces_mod.encode_embedding(ff.unit_vectors(rng, 1)[0])
        for _ in range(3):
            db.execute(
                "INSERT INTO faces (photo_id, person_id, bbox, det_score, embedding, "
                "source, ignored, created_at) VALUES (?, NULL, '0,0,1,1', 0.9, ?, 'detected', 0, 0)",
                (pid, vec))
        db.commit()

    seed_crowd("crowd2015.jpg", ff.epoch(2015, 6, 1))
    seed_crowd("crowd2020.jpg", ff.epoch(2020, 6, 1))
    ff.reset_faces_caches()

    assert client.get("/api/crowds?min_faces=2").json()["photo_count"] == 2
    start, end = _2015
    win = client.get(f"/api/crowds?min_faces=2&start_ts={start}&end_ts={end}").json()
    assert win["photo_count"] == 1
    assert win["groups"][0]["label"] == "June 1, 2015"
