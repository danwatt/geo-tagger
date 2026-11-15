"""Endpoint tests for geotagger.api.places."""

import pytest

from geotagger import index


_CIRCLE = '{"lat": 1.0, "lng": 2.0, "radius": 50.0}'
_RECT = '{"south": 1.0, "north": 3.0, "west": 2.0, "east": 4.0}'


def test_places_crud(client):
    r = client.post("/api/places", json={"name": "Home", "type": "circle", "bounds": _CIRCLE})
    assert r.status_code == 200
    pid = r.json()["id"]
    assert r.json() == {"ok": True, "id": pid, "name": "Home", "type": "circle", "bounds": _CIRCLE}

    place = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert place["name"] == "Home" and place["type"] == "circle"
    assert place["bounds_valid"] is True
    assert "created_at" in place

    moved = '{"lat": 5.0, "lng": 6.0, "radius": 75.0}'
    assert client.patch(f"/api/places/{pid}", json={"bounds": moved}).json() == {
        "ok": True, "id": pid, "success": True, "bounds": moved}
    updated = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert updated["bounds"] == moved

    # rename (name-only patch leaves bounds untouched)
    assert client.patch(f"/api/places/{pid}", json={"name": "Cabin"}).json()["success"] is True
    renamed = next(p for p in client.get("/api/places").json() if p["id"] == pid)
    assert renamed["name"] == "Cabin" and renamed["bounds"] == moved

    assert client.delete(f"/api/places/{pid}").json() == {"ok": True, "id": pid, "success": True}
    assert all(p["id"] != pid for p in client.get("/api/places").json())


def test_place_representative_set_and_clear(client):
    pid = client.post("/api/places", json={"name": "Park", "type": "circle", "bounds": _CIRCLE}).json()["id"]
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
    pid = index.create_place("Broken", "circle", "{}")   # legacy row, bypassing the API
    place = next(p for p in client.get("/api/places?stats=true").json() if p["id"] == pid)
    assert place["photo_count"] == 0 and place["last_ts"] is None


def test_place_representative_unknown_photo_404(client):
    pid = client.post("/api/places", json={"name": "X", "type": "circle", "bounds": _CIRCLE}).json()["id"]
    assert client.put(f"/api/places/{pid}/representative", json={"photo_id": 999999}).status_code == 404
    assert client.put("/api/places/987654/representative", json={"photo_id": None}).status_code == 404


# ── Malformed bounds and missing ids (audit A5) ──

_MALFORMED = ["not json", "{}", '{"lat": "x", "lng": 0, "radius": 5}', "[1, 2]", "null"]


@pytest.mark.parametrize("bounds", _MALFORMED)
def test_listing_and_jump_search_survive_malformed_bounds(client, bounds):
    """Rows already stored with bad bounds (A5 has no create-time validation yet)
    must not take down the read paths that only need a bbox."""
    pid = index.create_place("Bad", "circle", bounds)
    _add_photo("in.jpg", 0.0, 0.0, 1000)
    stats = client.get("/api/places?stats=true")
    assert stats.status_code == 200
    assert next(p for p in stats.json() if p["id"] == pid)["photo_count"] == 0
    r = client.get("/api/search/locations?q=Bad")
    assert r.status_code == 200
    assert [m["bounds"] for m in r.json()["locations"] if m["label"] == "Bad"] == [None]


@pytest.mark.parametrize("bounds", _MALFORMED)
def test_place_search_with_malformed_bounds_is_not_500(client, bounds):
    pid = index.create_place("Bad", "circle", bounds)
    _add_photo("in.jpg", 0.0, 0.0, 1000)
    r = client.get("/api/search", params={"place_id": pid})
    assert r.status_code in (200, 400)


@pytest.mark.parametrize("kind,bounds", [
    ("circle", '{"lat": 0, "lng": 0, "radius": 0}'),          # out-of-range values that
    ("circle", '{"lat": 0, "lng": 0, "radius": -5}'),         # still parse as JSON
    ("circle", '{"lat": 91, "lng": 0, "radius": 5}'),
    ("rectangle", '{"south": 3, "west": 0, "north": 1, "east": 1}'),
    ("rectangle", '{"lat": 0, "lng": 0, "radius": 5}'),       # circle data, rectangle type
    ("triangle", '{"lat": 0, "lng": 0, "radius": 5}'),        # unknown type
])
def test_legacy_out_of_range_rows_match_nothing_and_are_flagged(client, kind, bounds):
    pid = index.create_place("Bad", kind, bounds)
    _add_photo("in.jpg", 0.0, 0.0, 1000)
    r = client.get("/api/search", params={"place_id": pid})
    assert r.status_code == 200 and r.json()["total"] == 0
    listed = next(p for p in client.get("/api/places?stats=true").json() if p["id"] == pid)
    assert listed["bounds_valid"] is False and listed["photo_count"] == 0
    # The hotspot palette's coverage test reads the same rows.
    from geotagger.services import hotspots_service
    assert hotspots_service.covered_by_place(0.0, 0.0, 50.0, index.get_places()) is False


def test_search_by_valid_place_still_matches(client):
    pid = client.post("/api/places", json={"name": "Here", "type": "rectangle",
                                           "bounds": '{"south": -1, "west": -1, "north": 1, "east": 1}'}
                      ).json()["id"]
    _add_photo("in.jpg", 0.0, 0.0, 1000)
    _add_photo("out.jpg", 5.0, 5.0, 2000)
    r = client.get("/api/search", params={"place_id": pid})
    assert r.status_code == 200 and r.json()["total"] == 1


@pytest.mark.parametrize("kind,bounds", [
    ("circle", "not json"),
    ("circle", "[1, 2]"),
    ("circle", "null"),
    ("circle", "{}"),
    ("circle", '{"lat": "1", "lng": 0, "radius": 5}'),       # strings aren't coordinates
    ("circle", '{"lat": true, "lng": 0, "radius": 5}'),
    ("circle", '{"lat": 90.5, "lng": 0, "radius": 5}'),
    ("circle", '{"lat": 0, "lng": 0, "radius": 0}'),
    ("circle", '{"lat": 0, "lng": 0, "radius": 1e300}'),
    ("circle", '{"lat": NaN, "lng": 0, "radius": 5}'),
    ("circle", '{"lat": 0, "lng": Infinity, "radius": 5}'),
    ("rectangle", '{"south": 2, "west": 0, "north": 1, "east": 1}'),   # south > north
    ("rectangle", '{"south": -91, "west": 0, "north": 1, "east": 1}'),
    ("rectangle", '{"south": 0, "west": 0, "north": 1, "east": 400}'),  # wider than 360 deg
    ("rectangle", '{"south": 0, "west": 190, "north": 1, "east": 10}'),  # east<west unwrapped
    ("rectangle", '{"south": 0, "west": 0, "north": 1}'),
])
def test_create_and_patch_reject_invalid_bounds(client, kind, bounds):
    r = client.post("/api/places", json={"name": "Bad", "type": kind, "bounds": bounds})
    assert r.status_code == 400, r.text
    assert client.get("/api/places").json() == []

    good = _CIRCLE if kind == "circle" else _RECT
    pid = client.post("/api/places", json={"name": "Ok", "type": kind, "bounds": good}).json()["id"]
    assert client.patch(f"/api/places/{pid}", json={"bounds": bounds}).status_code == 400
    assert client.get("/api/places").json()[0]["bounds"] == good     # unchanged


def test_create_rejects_unknown_type_and_blank_name(client):
    assert client.post("/api/places", json={"name": "T", "type": "triangle",
                                            "bounds": _CIRCLE}).status_code == 422
    assert client.post("/api/places", json={"name": "  ", "type": "circle",
                                            "bounds": _CIRCLE}).status_code == 422
    pid = client.post("/api/places", json={"name": "T", "type": "circle", "bounds": _CIRCLE}).json()["id"]
    assert client.patch(f"/api/places/{pid}", json={"name": ""}).status_code == 422


def test_unwrapped_leaflet_longitudes_are_normalized(client):
    """Leaflet reports longitudes past +-180 after a pan round the globe; they're
    legitimate and stored wrapped, not rejected."""
    import json
    r = client.post("/api/places", json={"name": "C", "type": "circle",
                                         "bounds": '{"lat": 10, "lng": 362.5, "radius": 5}'})
    assert r.status_code == 200 and json.loads(r.json()["bounds"])["lng"] == pytest.approx(2.5)
    r = client.post("/api/places", json={"name": "R", "type": "rectangle",
                                         "bounds": '{"south": 0, "west": -458.4, "north": 1, "east": -456.1}'})
    b = json.loads(r.json()["bounds"])
    assert (b["west"], b["east"]) == (pytest.approx(-98.4), pytest.approx(-96.1))
    # The explicit antimeridian form (east < west, both wrapped) is accepted as-is.
    r = client.post("/api/places", json={"name": "A", "type": "rectangle",
                                         "bounds": '{"south": 0, "west": 170, "north": 1, "east": -170}'})
    assert r.status_code == 200


def test_create_place_rejects_malformed_bounds(client):
    r = client.post("/api/places", json={"name": "Bad", "type": "circle", "bounds": "not json"})
    assert r.status_code in (400, 422)
    assert client.get("/api/places").json() == []


def test_patch_and_delete_missing_place_404(client):
    assert client.patch("/api/places/987654", json={"name": "X"}).status_code == 404
    assert client.patch("/api/places/987654", json={"bounds": _CIRCLE}).status_code == 404
    assert client.patch("/api/places/987654", json={}).status_code == 404
    assert client.delete("/api/places/987654").status_code == 404
