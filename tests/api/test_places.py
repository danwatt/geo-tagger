"""Endpoint tests for geotagger.api.places."""


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

    assert client.delete(f"/api/places/{pid}").json() == {"success": True}
    assert all(p["id"] != pid for p in client.get("/api/places").json())
