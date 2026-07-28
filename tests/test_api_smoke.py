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
                         "people", "contexts"}
    # SQLite SUM() over zero rows is NULL, so image/video breakdowns come back None.
    assert body["photos"] == {"total": 0, "images": None, "videos": None}
    assert body["people"] == {"persons": 0, "families": 0}
    assert body["contexts"] == {"count": 0}


def test_photos_empty(client):
    res = client.get("/api/photos")
    assert res.status_code == 200
    assert res.json() == []


def test_contexts_crud_round_trip(client):
    # Create
    payload = {
        "name": "Test Trip",
        "polygon": [[10.0, 20.0], [10.0, 21.0], [11.0, 20.5]],
        "start_date": "2020-01-01",
        "end_date": "2020-01-31",
    }
    res = client.post("/api/contexts", json=payload)
    assert res.status_code == 200, res.text
    created = res.json()
    assert created["name"] == "Test Trip"
    assert created["start_date"] == "2020-01-01"
    # end_ts is stored as an exclusive end-of-day (start + 86400), so the returned
    # end_date is the day after the requested one. Locking in current behavior.
    assert created["end_date"] == "2020-02-01"
    assert created["polygon"] == payload["polygon"]
    assert created["persons"] == []
    ctx_id = created["id"]

    # Read
    res = client.get("/api/contexts")
    assert res.status_code == 200
    listing = res.json()
    assert any(c["id"] == ctx_id for c in listing)

    # Delete
    res = client.delete(f"/api/contexts/{ctx_id}")
    assert res.status_code == 200
    assert res.json() == {"success": True}

    res = client.get("/api/contexts")
    assert res.status_code == 200
    assert all(c["id"] != ctx_id for c in res.json())


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


def test_geotag_hotspots_and_propose_empty(client):
    res = client.get("/api/geotag/hotspots")
    assert res.status_code == 200
    assert res.json()["hotspots"] == []

    res = client.get("/api/geotag/hotspots?sort=nonsense")
    assert res.status_code == 422

    res = client.post("/api/geotag/propose", json={"ids": []})
    assert res.status_code == 200
    assert res.json()["candidates"] == []


def test_crowds_empty(client):
    res = client.get("/api/crowds")
    assert res.status_code == 200
    assert res.json() == {"groups": [], "photo_count": 0}
