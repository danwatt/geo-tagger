"""End-to-end smoke tests over the FastAPI app via TestClient.

These lock in the current HTTP contract for a representative slice of routes so the
main.py -> routers/services refactor (MAIN_REFACTOR_PLAN.md) can't silently change
response shapes. They deliberately exercise the executor (lifespan), the DB, and a
POST-with-Pydantic-model round-trip.
"""


def test_status_ok(client):
    res = client.get("/api/status")
    assert res.status_code == 200
    body = res.json()
    # exiftool_status() keys are merged in at the top level, plus these:
    assert "ok" in body

    assert body["db_total"] == 0
    assert "geocoder" in body


def test_stats_summary_shape(client):
    res = client.get("/api/stats/summary")
    assert res.status_code == 200
    body = res.json()
    assert set(body) >= {"photos", "geotag", "guessable", "geocode", "faces",
                         "people"}
    # SQLite SUM() over zero rows is NULL, so image/video breakdowns come back None.
    assert body["photos"] == {"total": 0, "images": None, "videos": None}
    assert body["people"] == {"persons": 0, "families": 0}


def test_photos_empty(client):
    res = client.get("/api/photos")
    assert res.status_code == 200
    assert res.json() == []


def test_settings_list_has_defaults(client):
    res = client.get("/api/settings")
    assert res.status_code == 200
    settings = res.json()["settings"]
    assert len(settings) > 0
    first = settings[0]
    assert {"key", "value", "default", "overridden"} <= set(first)


def test_places_crud(client):
    res = client.post("/api/places", json={"name": "Home", "type": "circle",
                                           "bounds": '{"lat":1,"lng":2,"radius":50}'})
    assert res.status_code == 200, res.text
    place_id = res.json()["id"]

    res = client.get("/api/places")
    assert res.status_code == 200
    assert any(p["id"] == place_id and p["name"] == "Home" for p in res.json())

    res = client.patch(f"/api/places/{place_id}", json={"bounds": '{"lat":3,"lng":4,"radius":9}'})
    assert res.status_code == 200
    assert res.json() == {"success": True}

    res = client.delete(f"/api/places/{place_id}")
    assert res.status_code == 200
    assert res.json() == {"success": True}


def test_persons_and_families(client):
    res = client.post("/api/persons", json={"name": "Alice"})
    assert res.status_code == 200, res.text
    person_id = res.json()["id"]

    res = client.post("/api/families", json={"name": "Smith"})
    assert res.status_code == 200, res.text
    assert res.json()["person_count"] == 0

    assert any(p["id"] == person_id for p in client.get("/api/persons").json())
    assert client.get("/api/families").status_code == 200

    res = client.delete(f"/api/persons/{person_id}")
    assert res.json() == {"success": True}


def test_faces_and_geocode_status(client):
    res = client.get("/api/faces/scan/status")
    assert res.status_code == 200
    assert res.json() == {"remaining_photos": 0, "total_faces": 0,
                          "unlabeled_faces": 0, "ignored_faces": 0,
                          "come_back_faces": 0, "tagged_faces": 0}

    res = client.get("/api/faces")  # scope=unlabeled default
    assert res.status_code == 200
    assert res.json() == {"faces": [], "total": 0, "returned": 0}

    res = client.get("/api/geocode/status")
    assert res.status_code == 200
    assert {"geocoded", "pending"} <= set(res.json())


def test_faces_rescan(client):
    # No photo_ids is a client error, not a silent no-op.
    assert client.post("/api/faces/rescan", json={"photo_ids": []}).status_code == 400

    # Unknown photo ids are skipped by both halves (wipe + detect), not fatal.
    res = client.post("/api/faces/rescan", json={"photo_ids": [999999]})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["faces_deleted"] == 0
    assert body["processed"] == 0
    assert body["faces_found"] == 0
    assert body["errors"] == []
    assert body["orientations_updated"] == 0


def test_add_manual_face_validation(client):
    res = client.post("/api/photos/999999/faces", json={"bbox": [0.1, 0.1]})
    assert res.status_code == 400            # malformed bbox, before any DB work

    res = client.post("/api/photos/999999/faces", json={"bbox": [0.1, 0.1, 0.4, 0.4]})
    assert res.status_code == 400            # unknown photo → ValueError → 400

    assert client.delete("/api/faces/999999").status_code == 404


def test_geotag_hotspots_and_propose_empty(client):
    res = client.get("/api/geotag/hotspots")
    assert res.status_code == 200
    assert res.json()["hotspots"] == []

    res = client.get("/api/geotag/hotspots?sort=nonsense")
    assert res.status_code == 422

    # Relative sorts need the thing they're relative to.
    assert client.get("/api/geotag/hotspots?sort=near").status_code == 400
    assert client.get("/api/geotag/hotspots?sort=time").status_code == 400
    assert client.get("/api/geotag/hotspots?sort=near&lat=40&lng=-75").status_code == 200
    assert client.get("/api/geotag/hotspots?sort=time&from_ts=0&to_ts=9").status_code == 200

    # The viewport filter is all four bounds or none.
    assert client.get("/api/geotag/hotspots?min_lat=39&max_lat=41").status_code == 400
    assert client.get(
        "/api/geotag/hotspots?min_lat=39&max_lat=41&min_lng=-76&max_lng=-74"
    ).status_code == 200

    res = client.post("/api/geotag/propose", json={"ids": []})
    assert res.status_code == 200
    assert res.json()["candidates"] == []


def test_crowds_empty(client):
    res = client.get("/api/crowds")
    assert res.status_code == 200
    assert res.json() == {"groups": [], "photo_count": 0}
