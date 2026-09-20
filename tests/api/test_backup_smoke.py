from geotagger import index


def test_backup_smoke(client):
    fam_id = index.create_family("Watts")
    pid = index.create_person("Dan")
    index.set_person_family(pid, fam_id)
    place_id = index.create_place("Home", "custom", "[[0,0],[1,1]]")
    index.upsert_photo("a.jpg", "C:/photos", "jpg", "image", 0, 0, 1.0, 2.0, "manual", None, None, 0, 0)
    photo = index.get_photos()[0]
    import numpy as np
    index.replace_faces(photo["id"], [{"bbox": "0,0,1,1", "det_score": 0.9, "embedding": np.zeros(4, dtype="float32")}])
    face = index.get_faces_for_photo(photo["id"])[0]
    index.assign_face(face["id"], pid)

    res = client.get("/api/data/backup")
    assert res.status_code == 200
    assert "attachment" in res.headers["content-disposition"]
    data = res.json()
    assert data["families"] == [{"name": "Watts", "created_at": data["families"][0]["created_at"]}]
    assert data["persons"][0]["name"] == "Dan"
    assert data["persons"][0]["family"] == "Watts"
    assert data["places"][0]["name"] == "Home"
    assert data["faces"][0]["photo_filename"] == "a.jpg"
    assert data["faces"][0]["person"] == "Dan"
    assert data["geotags"] == [
        {"dir": "C:/photos", "filename": "a.jpg", "lat": 1.0, "lng": 2.0, "geotag_source": "manual"}
    ]
