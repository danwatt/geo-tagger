"""Endpoint tests for geotagger.api.places."""

from geotagger import index


def test_places_crud(client):
    r = client.post("/api/places", json={"name": "Home", "type": "circle", "bounds": "{}"})
    assert r.status_code == 200
    pid = r.json()["id"]
    assert r.json() == {"id": pid, "name": "Home", "type": "circle", "bounds": "{}"}

    place = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert place["name"] == "Home" and place["type"] == "circle"
    assert "created_at" in place

    assert client.patch(f"/api/places/{pid}", json={"bounds": '{"r":1}'}).json() == {"success": True}
    updated = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert updated["bounds"] == '{"r":1}'

    # rename (name-only patch leaves bounds untouched)
    assert client.patch(f"/api/places/{pid}", json={"name": "Cabin"}).json() == {"success": True}
    renamed = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert renamed["name"] == "Cabin" and renamed["bounds"] == '{"r":1}'

    assert client.delete(f"/api/places/{pid}").json() == {"success": True}
    assert all(p["id"] != pid for p in client.get("/api/places").json())


def test_place_representative_set_and_clear(client):
    pid = client.post("/api/places", json={"name": "Park", "type": "circle", "bounds": "{}"}).json()["id"]
    index.upsert_photo(
        filename="rep.jpg", dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=1.0, lng=2.0, geotag_source="sidecar",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=1000, gps_accuracy=None, orientation=1,
    )
    photo_id = index.get_db().execute(
        "SELECT id FROM photos WHERE filename='rep.jpg'").fetchone()[0]

    # default is null
    place = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert place["representative_photo_id"] is None

    r = client.put(f"/api/places/{pid}/representative", json={"photo_id": photo_id})
    assert r.status_code == 200 and r.json()["representative_photo_id"] == photo_id
    place = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert place["representative_photo_id"] == photo_id

    # clear
    assert client.put(f"/api/places/{pid}/representative", json={"photo_id": None}).json()["representative_photo_id"] is None
    place = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert place["representative_photo_id"] is None


def test_place_representative_unknown_photo_404(client):
    pid = client.post("/api/places", json={"name": "X", "type": "circle", "bounds": "{}"}).json()["id"]
    assert client.put(f"/api/places/{pid}/representative", json={"photo_id": 999999}).status_code == 404
