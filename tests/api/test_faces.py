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
        "remaining_photos": 0, "failed_photos": 0, "total_faces": 0, "unlabeled_faces": 0,
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


def test_photo_tagged_people_only_committed(client):
    db = index.get_db()
    rng = np.random.default_rng(7)
    fid = ff.seed_unlabeled(db, ff.unit_vectors(rng, 1))[0]
    photo_id = db.execute("SELECT photo_id FROM faces WHERE id=?", (fid,)).fetchone()[0]

    # Unassigned face: nothing to list yet.
    assert client.get(f"/api/photos/{photo_id}/tagged-people").json() == []

    pid = client.post(f"/api/faces/{fid}/assign", json={"name": "Dave"}).json()["person_id"]
    people = client.get(f"/api/photos/{photo_id}/tagged-people").json()
    assert len(people) == 1
    assert people[0]["id"] == fid
    assert people[0]["person_id"] == pid
    assert people[0]["person_name"] == "Dave"
    assert len(people[0]["bbox"]) == 4

    assert client.get("/api/photos/999/tagged-people").status_code == 404


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


def test_persons_face_count_matches_delete(client):
    """face_count (opt-in) counts exactly the faces DELETE would unlabel: the
    person's assigned faces, not ignored ones, not another person's."""
    db = index.get_db()
    rng = np.random.default_rng(31)
    alice_id, alice_faces = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 3))
    bob_id, _ = ff.seed_person(db, "Bob", ff.unit_vectors(rng, 2))
    carol_id = client.post("/api/persons", json={"name": "Carol"}).json()["id"]
    ff.seed_unlabeled(db, ff.unit_vectors(rng, 2))
    # Ignoring one of Alice's faces takes it off her (and out of her count).
    client.post("/api/faces/ignore", json={"face_ids": [alice_faces[0]]})

    # Default listing stays count-free (the People page's hot path).
    assert all("face_count" not in p for p in client.get("/api/persons").json())

    counts = {p["id"]: p["face_count"]
              for p in client.get("/api/persons?face_counts=true").json()}
    assert counts == {alice_id: 2, bob_id: 2, carol_id: 0}

    unlabeled_before = client.get("/api/faces?scope=unlabeled").json()["total"]
    assert client.delete(f"/api/persons/{alice_id}").json() == {"success": True}
    unlabeled_after = client.get("/api/faces?scope=unlabeled").json()["total"]
    assert unlabeled_after - unlabeled_before == counts[alice_id]
    assert db.execute("SELECT COUNT(*) FROM faces WHERE ignored=1").fetchone()[0] == 1
    counts = {p["id"]: p["face_count"]
              for p in client.get("/api/persons?face_counts=true").json()}
    assert counts == {bob_id: 2, carol_id: 0}


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
        cur = db.execute(
            "INSERT INTO faces (photo_id, person_id, bbox, det_score, "
            "source, ignored, created_at) VALUES (?, NULL, '0,0,1,1', 0.9, 'detected', 0, 0)",
            (photo_id,))
        db.execute(
            "INSERT INTO face_embeddings (face_id, embedding) VALUES (?, ?)",
            (cur.lastrowid, vec))
    db.commit()
    ff.reset_faces_caches()

    r = client.get("/api/crowds?min_faces=2").json()
    assert r["photo_count"] == 1
    assert len(r["groups"]) == 1
    g = r["groups"][0]
    assert g["total_faces"] == 3 and g["unlabeled_faces"] == 3
    assert g["label"] == "January 1, 2021"
    # Un-geocoded photo -> no place names (the People page sorts groups by these).
    assert g["photos"][0]["location"] is None

    # Once reverse-geocoded, each crowd photo carries its place names.
    db.execute("UPDATE photos SET loc_city='Boise', loc_state='Idaho', "
               "loc_country='United States' WHERE id=?", (photo_id,))
    db.commit()
    located = client.get("/api/crowds?min_faces=2").json()
    assert located["groups"][0]["photos"][0]["location"] == {
        "city": "Boise", "sublocation": None,
        "state": "Idaho", "country": "United States",
    }

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
            cur = db.execute(
                "INSERT INTO faces (photo_id, person_id, bbox, det_score, "
                "source, ignored, created_at) VALUES (?, NULL, '0,0,1,1', 0.9, 'detected', 0, 0)",
                (pid,))
            db.execute(
                "INSERT INTO face_embeddings (face_id, embedding) VALUES (?, ?)",
                (cur.lastrowid, vec))
        db.commit()

    seed_crowd("crowd2015.jpg", ff.epoch(2015, 6, 1))
    seed_crowd("crowd2020.jpg", ff.epoch(2020, 6, 1))
    ff.reset_faces_caches()

    assert client.get("/api/crowds?min_faces=2").json()["photo_count"] == 2
    start, end = _2015
    win = client.get(f"/api/crowds?min_faces=2&start_ts={start}&end_ts={end}").json()
    assert win["photo_count"] == 1
    assert win["groups"][0]["label"] == "June 1, 2015"


# ── Deleting a person / family (FKs aren't enforced, so cleanup is explicit) ──

def _face_row(db, fid):
    return db.execute(
        "SELECT person_id, assigned_at, representative FROM faces WHERE id=?", (fid,)).fetchone()


def test_delete_person_returns_faces_to_unlabeled(client):
    db = index.get_db()
    rng = np.random.default_rng(31)
    alice_id, fids = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 3))
    index.set_person_representatives(alice_id, fids[:1])

    assert client.delete(f"/api/persons/{alice_id}").json() == {"success": True}

    for fid in fids:
        row = _face_row(db, fid)
        assert (row["person_id"], row["assigned_at"], row["representative"]) == (None, None, 0)
    listing = client.get("/api/faces?scope=unlabeled").json()
    assert listing["total"] == 3
    assert sorted(f["id"] for f in listing["faces"]) == sorted(fids)


def test_new_person_does_not_inherit_deleted_persons_faces(client):
    """persons.id has no AUTOINCREMENT, so the next person can reuse the id."""
    db = index.get_db()
    rng = np.random.default_rng(32)
    alice_id, _ = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 2))
    client.delete(f"/api/persons/{alice_id}")

    bob_id = client.post("/api/persons", json={"name": "Bob"}).json()["id"]

    assert client.get(f"/api/faces?scope=person&person_id={bob_id}").json()["total"] == 0


def test_delete_family_detaches_members(client):
    fid = client.post("/api/families", json={"name": "Smiths"}).json()["id"]
    pid = client.post("/api/persons", json={"name": "Alice"}).json()["id"]
    client.patch(f"/api/persons/{pid}", json={"family_id": fid})

    assert client.delete(f"/api/families/{fid}").json() == {"success": True}

    assert index.get_person(pid)["family_id"] is None
    alice = next(p for p in client.get("/api/persons").json() if p["id"] == pid)
    assert alice["family_id"] is None


def test_init_db_repairs_refs_left_by_old_deletes(client, tmp_path):
    """DBs written before deletes cleaned up after themselves still hold faces,
    negatives and family links pointing at rows that are gone."""
    db = index.get_db()
    rng = np.random.default_rng(33)
    alice_id, fids = ff.seed_person(db, "Alice", ff.unit_vectors(rng, 2))
    bob_id, bob_fids = ff.seed_person(db, "Bob", ff.unit_vectors(rng, 1))
    loose = ff.seed_unlabeled(db, ff.unit_vectors(rng, 1))[0]
    index.add_face_negatives([loose], alice_id)
    fam = index.create_family("Smiths")
    index.set_person_family(bob_id, fam)
    # The old delete paths: parent row only.
    db.execute("DELETE FROM persons WHERE id=?", (alice_id,))
    db.execute("DELETE FROM families WHERE id=?", (fam,))
    db.commit()

    reopened = index.init_db(tmp_path)
    try:
        for fid in fids:
            row = _face_row(reopened, fid)
            assert (row["person_id"], row["assigned_at"]) == (None, None)
        assert _face_row(reopened, bob_fids[0])["person_id"] == bob_id  # untouched
        assert reopened.execute("SELECT COUNT(*) FROM face_negatives").fetchone()[0] == 0
        assert index.get_person(bob_id)["family_id"] is None
    finally:
        reopened.close()
        index._db = db


def test_assign_to_unknown_person_404(client):
    db = index.get_db()
    rng = np.random.default_rng(34)
    fid = ff.seed_unlabeled(db, ff.unit_vectors(rng, 1))[0]
    photo_id = db.execute("SELECT photo_id FROM faces WHERE id=?", (fid,)).fetchone()[0]

    assert client.post("/api/faces/assign",
                       json={"face_ids": [fid], "person_id": 999}).status_code == 404
    assert client.post(f"/api/faces/{fid}/assign", json={"person_id": 999}).status_code == 404
    assert client.post(f"/api/photos/{photo_id}/faces",
                       json={"bbox": [0.1, 0.1, 0.2, 0.2], "person_id": 999}).status_code == 404
    assert _face_row(db, fid)["person_id"] is None
    assert db.execute("SELECT COUNT(*) FROM faces").fetchone()[0] == 1


# ── Person/family mutation: validation, 409 on duplicate names, 404 on unknown ids ──

def _person(client, name):
    return client.post("/api/persons", json={"name": name}).json()["id"]


def _person_row(client, pid):
    return next(p for p in client.get("/api/persons").json() if p["id"] == pid)


def test_patch_person_invalid_date_applies_nothing(client):
    pid = _person(client, "Alice")
    r = client.patch(f"/api/persons/{pid}",
                     json={"name": "Alicia", "birth_date": "not-a-date"})
    assert r.status_code == 400
    assert _person_row(client, pid)["name"] == "Alice"


def test_patch_person_conflict_rolls_back_other_fields(client):
    bob = _person(client, "Bob")
    pid = _person(client, "Alice")
    r = client.patch(f"/api/persons/{pid}",
                     json={"name": "Bob", "birth_date": "1990-01-02"})
    detail = r.json()["detail"]
    assert r.status_code == 409 and "Bob" in detail["message"]
    # Enough for the UI to offer "merge into them?".
    assert detail["existing_person_id"] == bob
    row = _person_row(client, pid)
    assert row["name"] == "Alice" and row["birth_date"] is None


def test_duplicate_person_create_409(client):
    _person(client, "Alice")
    r = client.post("/api/persons", json={"name": "Alice"})
    assert r.status_code == 409
    assert len([p for p in client.get("/api/persons").json() if p["name"] == "Alice"]) == 1


def test_duplicate_family_create_and_rename_409(client):
    client.post("/api/families", json={"name": "Smith"})
    fid = client.post("/api/families", json={"name": "Jones"}).json()["id"]
    assert client.post("/api/families", json={"name": "Smith"}).status_code == 409
    r = client.patch(f"/api/families/{fid}", json={"name": "Smith"})
    assert r.status_code == 409
    names = [f["name"] for f in client.get("/api/families").json()]
    assert sorted(names) == ["Jones", "Smith"]


def test_unknown_person_and_family_ids_404(client):
    assert client.patch("/api/persons/9999", json={"name": "X"}).status_code == 404
    assert client.patch("/api/persons/9999", json={"birth_date": "2000-01-01"}).status_code == 404
    assert client.delete("/api/persons/9999").status_code == 404
    assert client.patch("/api/families/9999", json={"name": "X"}).status_code == 404
    assert client.delete("/api/families/9999").status_code == 404


def test_patch_person_unknown_family_404_and_unchanged(client):
    pid = _person(client, "Alice")
    r = client.patch(f"/api/persons/{pid}", json={"name": "Alicia", "family_id": 9999})
    assert r.status_code == 404
    assert _person_row(client, pid)["name"] == "Alice"


# ── D10: assign routes need exactly one intent; counts are truthful ──

def _labeled_pair(client, seed):
    """Two faces already assigned to Alice, one unlabeled spare."""
    db = index.get_db()
    ids = ff.seed_unlabeled(db, ff.unit_vectors(np.random.default_rng(seed), 3))
    alice = client.post("/api/persons", json={"name": "Alice"}).json()["id"]
    assert client.post("/api/faces/assign",
                       json={"face_ids": ids[:2], "person_id": alice}).json()["assigned"] == 2
    return db, ids, alice


def test_bulk_assign_empty_intent_400_and_labels_untouched(client):
    db, ids, alice = _labeled_pair(client, 50)
    for body in ({}, {"name": ""}, {"name": "   "}, {"clear": False},
                 {"person_id": alice, "clear": True},
                 {"person_id": alice, "name": "Bob"}, {"name": "Bob", "clear": True}):
        r = client.post("/api/faces/assign", json={"face_ids": ids[:2], **body})
        assert r.status_code == 400, body
    assert [_face_row(db, i)["person_id"] for i in ids[:2]] == [alice, alice]
    assert db.execute("SELECT COUNT(*) FROM persons").fetchone()[0] == 1  # no "Bob"


def test_bulk_assign_clear_reports_count(client):
    db, ids, alice = _labeled_pair(client, 51)
    r = client.post("/api/faces/assign", json={"face_ids": ids[:2], "clear": True})
    assert r.status_code == 200
    assert r.json() == {"assigned": 2, "not_found": 0, "person_id": None}
    assert all(_face_row(db, i)["person_id"] is None for i in ids)


def test_bulk_assign_counts_matched_rows_with_unknown_ids(client):
    db, ids, alice = _labeled_pair(client, 52)
    r = client.post("/api/faces/assign",
                    json={"face_ids": [ids[2], ids[2], 9998, 9999], "name": "Bob"})
    assert r.status_code == 200
    body = r.json()
    assert (body["assigned"], body["not_found"]) == (1, 2)   # duplicate counts once
    assert _face_row(db, ids[2])["person_id"] == body["person_id"]
    # Re-assigning faces already on the person still counts them (matched, not changed).
    r = client.post("/api/faces/assign", json={"face_ids": ids[:2], "person_id": alice})
    assert r.json()["assigned"] == 2


def test_bulk_assign_404s_and_no_orphan_person(client):
    db, ids, alice = _labeled_pair(client, 53)
    assert client.post("/api/faces/assign",
                       json={"face_ids": ids, "person_id": 999}).status_code == 404
    assert client.post("/api/faces/assign",
                       json={"face_ids": [9998, 9999], "name": "Ghost"}).status_code == 404
    assert client.post("/api/faces/assign",
                       json={"face_ids": [9998], "clear": True}).status_code == 404
    assert client.post("/api/faces/assign",
                       json={"face_ids": [], "clear": True}).status_code == 400
    assert db.execute("SELECT COUNT(*) FROM persons").fetchone()[0] == 1


def test_single_assign_requires_exactly_one_intent(client):
    db, ids, alice = _labeled_pair(client, 54)
    fid = ids[0]
    for body in ({}, {"person_id": None}, {"name": "  "}, {"person_id": alice, "clear": True},
                 {"person_id": alice, "name": "Bob"}):
        assert client.post(f"/api/faces/{fid}/assign", json=body).status_code == 400, body
    assert _face_row(db, fid)["person_id"] == alice
    assert client.post(f"/api/faces/{fid}/assign", json={"person_id": 999}).status_code == 404
    assert client.post("/api/faces/9999/assign", json={"clear": True}).status_code == 404
    r = client.post(f"/api/faces/{fid}/assign", json={"clear": True})
    assert r.status_code == 200 and r.json() == {"face_id": fid, "person_id": None}
    assert _face_row(db, fid)["person_id"] is None


# ── Paging (U5: the People grid's "Load more") ──

def _page_ids(client, url: str, page: int) -> tuple[list[int], int]:
    """Walk ``url`` page by page via next_offset; returns (ids in order, total)."""
    ids: list[int] = []
    offset, total = 0, None
    while offset is not None:
        r = client.get(f"{url}&limit={page}&offset={offset}").json()
        assert r["offset"] == offset and r["returned"] == len(r["faces"])
        total = r["total"]
        ids += [f["id"] for f in r["faces"]]
        offset = r["next_offset"]
    return ids, total


def test_faces_paging_is_stable_across_tied_scores(client):
    # Every face shares det_score 0.9, so only the id tiebreaker keeps page
    # boundaries stable — without it pages could overlap or skip rows.
    db = index.get_db()
    rng = np.random.default_rng(10)
    seeded = ff.seed_unlabeled(db, ff.unit_vectors(rng, 7))
    one_shot = [f["id"] for f in client.get("/api/faces?scope=unlabeled&limit=100").json()["faces"]]
    paged, total = _page_ids(client, "/api/faces?scope=unlabeled", 3)
    assert total == 7
    assert paged == one_shot and sorted(paged) == sorted(seeded)


def test_faces_paging_envelope(client):
    db = index.get_db()
    rng = np.random.default_rng(11)
    ff.seed_unlabeled(db, ff.unit_vectors(rng, 5))
    first = client.get("/api/faces?scope=unlabeled&limit=2").json()
    assert (first["total"], first["returned"], first["offset"], first["next_offset"]) == (5, 2, 0, 2)
    last = client.get("/api/faces?scope=unlabeled&limit=2&offset=4").json()
    assert (last["returned"], last["next_offset"]) == (1, None)
    past = client.get("/api/faces?scope=unlabeled&limit=2&offset=50").json()
    assert (past["faces"], past["next_offset"], past["total"]) == ([], None, 5)
    assert client.get("/api/faces?scope=unlabeled&offset=-1").status_code == 422


def test_faces_paging_person_recent_and_ignored(client):
    db = index.get_db()
    rng = np.random.default_rng(12)
    pid, labeled = ff.seed_person(db, "Carol", ff.unit_vectors(rng, 5))
    paged, total = _page_ids(client, f"/api/faces?scope=person&person_id={pid}", 2)
    assert total == 5 and sorted(paged) == sorted(labeled) and len(set(paged)) == 5
    # seed_person stamps one shared assigned_at — a whole tie for "recent".
    paged, total = _page_ids(client, "/api/faces?scope=recent", 2)
    assert total == 5 and sorted(paged) == sorted(labeled)
    # One ignore batch shares ignored_at too.
    ids = ff.seed_unlabeled(db, ff.unit_vectors(rng, 4))
    client.post("/api/faces/ignore", json={"face_ids": ids, "ignored": True})
    paged, total = _page_ids(client, "/api/faces?scope=ignored", 3)
    assert total == 4 and sorted(paged) == sorted(ids)


def test_faces_paging_suggested_scopes(client):
    db = index.get_db()
    rng = np.random.default_rng(13)
    c = ff.unit_vectors(rng, 1)[0]
    alice_id, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, c, 3, intra_cos=0.9))
    ff.seed_unlabeled(db, ff.cluster_around(rng, c, 5, intra_cos=0.9))
    for url in (f"/api/faces?scope=suggested&person_id={alice_id}",
                "/api/faces?scope=unlabeled&suggested_only=true"):
        one_shot = client.get(f"{url}&limit=100").json()
        paged, total = _page_ids(client, url, 2)
        assert total == one_shot["total"] >= 2
        assert paged == [f["id"] for f in one_shot["faces"]]


def test_faces_by_ids_returns_current_state_and_missing(client):
    # The People page re-validates staged work restored from sessionStorage (U7)
    # against this: current person/ignored state per face, and the gone ids.
    db = index.get_db()
    rng = np.random.default_rng(7)
    ids = ff.seed_unlabeled(db, ff.unit_vectors(rng, 3))
    client.post("/api/faces/assign", json={"face_ids": [ids[0]], "name": "Cora"})
    client.post("/api/faces/ignore", json={"face_ids": [ids[1]], "ignored": True})

    r = client.post("/api/faces/by-ids", json={"face_ids": [ids[0], ids[1], ids[2], 999999, ids[0]]})
    assert r.status_code == 200
    body = r.json()
    by_id = {f["id"]: f for f in body["faces"]}
    assert set(by_id) == set(ids)
    assert by_id[ids[0]]["person_name"] == "Cora"
    assert by_id[ids[1]]["ignored"] is True
    assert by_id[ids[2]]["person_id"] is None and not by_id[ids[2]]["ignored"]
    assert body["missing"] == [999999]

    assert client.post("/api/faces/by-ids", json={"face_ids": []}).json() == {"faces": [], "missing": []}
