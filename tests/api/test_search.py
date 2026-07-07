"""Endpoint tests for geotagger.api.search (flexible multi-criteria photo search)."""

from geotagger import index


def _add(path, lat=None, lng=None, dt=1000, loc_city=None, loc_state=None, loc_country=None):
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=dt, gps_accuracy=None, orientation=1,
    )
    pid = index.get_db().execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()[0]
    if loc_city or loc_state or loc_country:
        index.get_db().execute(
            "UPDATE photos SET loc_city=?, loc_state=?, loc_country=? WHERE id=?",
            (loc_city, loc_state, loc_country, pid),
        )
        index.get_db().commit()
    return pid


def _add_face(photo_id, person_id, ignored=False):
    index.get_db().execute(
        "INSERT INTO faces (photo_id, person_id, bbox, det_score, source, ignored, created_at) "
        "VALUES (?, ?, '0.1,0.1,0.4,0.4', 0.9, 'detected', ?, 0)",
        (photo_id, person_id, 1 if ignored else 0),
    )
    index.get_db().commit()


def test_search_no_filters_returns_all(client):
    _add("a.jpg", dt=1000)
    _add("b.jpg", dt=2000)
    r = client.get("/api/search").json()
    assert r["total"] == 2
    assert {p["filename"] for p in r["photos"]} == {"a.jpg", "b.jpg"}


def test_search_date_range(client):
    _add("early.jpg", dt=946684800)    # 2000-01-01
    _add("late.jpg", dt=1893456000)    # 2030-01-01
    r = client.get("/api/search?date_from=1999-12-31&date_to=2000-01-02").json()
    assert [p["filename"] for p in r["photos"]] == ["early.jpg"]


def test_search_location_text(client):
    _add("paris.jpg", dt=1000, loc_city="Paris", loc_country="France")
    _add("tokyo.jpg", dt=1000, loc_city="Tokyo", loc_country="Japan")
    r = client.get("/api/search?location=Paris").json()
    assert [p["filename"] for p in r["photos"]] == ["paris.jpg"]

    r2 = client.get("/api/search?location=France").json()
    assert [p["filename"] for p in r2["photos"]] == ["paris.jpg"]


def test_search_bbox(client):
    _add("in.jpg", lat=10, lng=20, dt=1000)
    _add("out.jpg", lat=50, lng=50, dt=1000)
    r = client.get("/api/search?bbox=19,9,21,11").json()
    assert [p["filename"] for p in r["photos"]] == ["in.jpg"]


def test_search_geotagged_filter(client):
    _add("t.jpg", lat=10, lng=20, dt=1000)
    _add("u.jpg", dt=2000)
    r = client.get("/api/search?geotagged=yes").json()
    assert [p["filename"] for p in r["photos"]] == ["t.jpg"]


def test_search_person_any(client):
    alice = index.create_person("Alice")
    bob = index.create_person("Bob")
    p1 = _add("alice_only.jpg", dt=1000)
    p2 = _add("bob_only.jpg", dt=1000)
    p3 = _add("neither.jpg", dt=1000)
    _add_face(p1, alice)
    _add_face(p2, bob)
    r = client.get(f"/api/search?person_ids={alice},{bob}&person_mode=any").json()
    assert {p["filename"] for p in r["photos"]} == {"alice_only.jpg", "bob_only.jpg"}


def test_search_person_all_requires_together(client):
    alice = index.create_person("Alice")
    bob = index.create_person("Bob")
    together = _add("together.jpg", dt=1000)
    alice_only = _add("alice_only.jpg", dt=1000)
    _add_face(together, alice)
    _add_face(together, bob)
    _add_face(alice_only, alice)

    r_all = client.get(f"/api/search?person_ids={alice},{bob}&person_mode=all").json()
    assert [p["filename"] for p in r_all["photos"]] == ["together.jpg"]

    r_any = client.get(f"/api/search?person_ids={alice},{bob}&person_mode=any").json()
    assert {p["filename"] for p in r_any["photos"]} == {"together.jpg", "alice_only.jpg"}


def test_search_ignored_faces_excluded(client):
    alice = index.create_person("Alice")
    p1 = _add("x.jpg", dt=1000)
    _add_face(p1, alice, ignored=True)
    r = client.get(f"/api/search?person_ids={alice}&person_mode=any").json()
    assert r["photos"] == []


def test_search_invalid_person_ids_400(client):
    assert client.get("/api/search?person_ids=abc").status_code == 400


def test_search_combines_criteria_with_and(client):
    alice = index.create_person("Alice")
    p1 = _add("match.jpg", lat=10, lng=20, dt=1000, loc_city="Paris")
    p2 = _add("wrong_location.jpg", lat=10, lng=20, dt=1000, loc_city="Tokyo")
    _add_face(p1, alice)
    _add_face(p2, alice)
    r = client.get(f"/api/search?location=Paris&person_ids={alice}&person_mode=any").json()
    assert [p["filename"] for p in r["photos"]] == ["match.jpg"]
