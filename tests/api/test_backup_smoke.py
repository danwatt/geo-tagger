import json

from geotagger import config, index


def _library():
    fam_id = index.create_family("Watts")
    pid = index.create_person("Dan")
    index.set_person_family(pid, fam_id)
    index.create_place("Home", "custom", "[[0,0],[1,1]]")
    index.upsert_photo("a.jpg", "C:/photos", "jpg", "image", 0, 0, 1.0, 2.0, "manual", None, None, 0, 0)
    photo = index.get_photos()[0]
    import numpy as np
    index.replace_faces(photo["id"], [{"bbox": "0,0,1,1", "det_score": 0.9, "embedding": np.zeros(4, dtype="float32")}])
    face = index.get_faces_for_photo(photo["id"])[0]
    index.assign_face(face["id"], pid)
    return photo, face


def test_backup_smoke(client):
    _library()
    res = client.get("/api/data/backup")
    assert res.status_code == 200
    assert "attachment" in res.headers["content-disposition"]
    data = res.json()
    assert data["format"] == 2
    assert data["families"] == [{"name": "Watts", "created_at": data["families"][0]["created_at"]}]
    assert data["persons"][0]["name"] == "Dan"
    assert data["persons"][0]["family"] == "Watts"
    assert data["places"][0]["name"] == "Home"
    # No scan root is configured in the test app, so the photo keeps its absolute path.
    (photo,) = data["photos"]
    assert photo["abs"] == "C:/photos/a.jpg" and photo["rel"] is None
    assert (photo["lat"], photo["lng"], photo["geotag_source"]) == (1.0, 2.0, "manual")
    assert data["faces"][0]["photo"] == 0
    assert data["faces"][0]["person"] == "Dan"


def test_restore_route_defaults_to_dry_run(client):
    photo, face = _library()
    backup = client.get("/api/data/backup").content
    index.assign_face(face["id"], None)

    res = client.post("/api/data/backup/restore", content=backup)
    assert res.status_code == 200, res.text
    assert res.json()["dry_run"] is True and res.json()["faces"]["applied"] == 1
    assert index.get_faces_for_photo(photo["id"])[0]["person_id"] is None  # untouched

    res = client.post("/api/data/backup/restore?dry_run=false", content=backup)
    assert res.status_code == 200, res.text
    assert res.json()["faces"]["applied"] == 1
    assert index.get_faces_for_photo(photo["id"])[0]["person_id"] is not None


def test_restore_route_rejects_bad_input(client, monkeypatch):
    assert client.post("/api/data/backup/restore", content=b"").status_code == 400
    r = client.post("/api/data/backup/restore", content=b"{not json")
    assert r.status_code == 400 and "JSON" in r.json()["detail"]
    r = client.post("/api/data/backup/restore", content=json.dumps({"format": 99}))
    assert r.status_code == 400 and "unsupported backup format" in r.json()["detail"]
    monkeypatch.setattr(config, "BACKUP_RESTORE_MAX_MB", 0)
    assert client.post("/api/data/backup/restore", content=b"{}").status_code == 413
