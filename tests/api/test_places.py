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


def _add_photo(name, lat, lng, ts):
    index.upsert_photo(
        filename=name, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng, geotag_source="sidecar",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=ts, gps_accuracy=None, orientation=1,
    )


def test_places_stats_counts_only_photos_inside(client):
    # 1 km circle at the equator, where 0.009° of latitude is ~1000 m.
    bounds = '{"lat": 0.0, "lng": 0.0, "radius": 1000}'
    pid = client.post("/api/places",
                      json={"name": "Ring", "type": "circle", "bounds": bounds}).json()["id"]

    _add_photo("centre.jpg", 0.0, 0.0, 1000)
    _add_photo("edge.jpg", 0.005, 0.0, 5000)          # ~556 m out — inside
    _add_photo("corner.jpg", 0.008, 0.008, 9000)      # in the bbox, ~1258 m out
    _add_photo("far.jpg", 10.0, 10.0, 9999)           # nowhere near

    place = next(p for p in client.get("/api/places?stats=true").json() if p["id"] == pid)
    # corner.jpg is the point of this test: it survives the R*Tree bbox and must
    # be dropped by the exact distance pass.
    assert place["photo_count"] == 2
    assert place["last_ts"] == 5000


def test_places_stats_are_opt_in(client):
    client.post("/api/places", json={"name": "Q", "type": "circle",
                                     "bounds": '{"lat": 0, "lng": 0, "radius": 10}'})
    plain = client.get("/api/places").json()[0]
    assert "photo_count" not in plain and "last_ts" not in plain


def test_places_stats_survive_unparseable_bounds(client):
    pid = client.post("/api/places",
                      json={"name": "Broken", "type": "circle", "bounds": "{}"}).json()["id"]
    place = next(p for p in client.get("/api/places?stats=true").json() if p["id"] == pid)
    assert place["photo_count"] == 0 and place["last_ts"] is None


def test_place_representative_unknown_photo_404(client):
    pid = client.post("/api/places", json={"name": "X", "type": "circle", "bounds": "{}"}).json()["id"]
    assert client.put(f"/api/places/{pid}/representative", json={"photo_id": 999999}).status_code == 404
