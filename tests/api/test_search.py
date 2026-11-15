"""Endpoint tests for geotagger.api.search (flexible multi-criteria photo search)."""

from geotagger import index
import json


def _add(path, lat=None, lng=None, dt=1000, loc_city=None, loc_state=None, loc_country=None,
         camera="c", dir_=".", gps_accuracy=None):
    index.upsert_photo(
        filename=path, dir_=dir_, ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera=camera,
        photo_datetime=dt, gps_accuracy=gps_accuracy, orientation=1,
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


def test_search_undated_only(client):
    _add("dated.jpg", dt=1000)
    _add("undated.jpg", dt=None)
    r = client.get("/api/search?undated=true").json()
    assert [p["filename"] for p in r["photos"]] == ["undated.jpg"]


def test_search_undated_ignores_date_range(client):
    _add("dated.jpg", dt=946684800)
    _add("undated.jpg", dt=None)
    r = client.get("/api/search?undated=true&date_from=1999-01-01&date_to=1999-12-31").json()
    assert [p["filename"] for p in r["photos"]] == ["undated.jpg"]


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
    _add("neither.jpg", dt=1000)
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


def test_location_suggestions_and_exact_county(client):
    ranch = index.create_place("Family Kat-El Ranch", "circle", json.dumps({"lat": 30, "lng": -96, "radius": 100}))
    for state in ("Texas", "Oregon"):
        pid = _add(f"{state}.jpg", lat=30, lng=-96, loc_state=state, loc_country="USA")
        index.get_db().execute("UPDATE photos SET loc_county='Washington County' WHERE id=?", (pid,))
    index.get_db().commit()
    choices = client.get("/api/search/locations", params={"q": "Washington County, Texas"}).json()["locations"]
    assert len(choices) == 1
    result = client.get("/api/search", params={"location_fields": json.dumps(choices[0]["fields"])}).json()
    assert [p["filename"] for p in result["photos"]] == ["Texas.jpg"]
    choices = client.get("/api/search/locations?q=kat-el").json()["locations"]
    assert choices[0]["id"] == ranch


def test_location_suggestions_carry_bounds(client):
    # The geocode page's "jump to location" box pans to these offline extents.
    index.create_place("Box Ranch", "rectangle",
                       json.dumps({"south": 1, "west": 2, "north": 3, "east": 4}))
    _add("a.jpg", lat=10, lng=20, loc_city="Boxford")
    _add("b.jpg", lat=11, lng=22, loc_city="Boxford")
    _add("nogps.jpg", loc_city="Boxless")
    by_label = {c["label"]: c for c in
                client.get("/api/search/locations?q=box").json()["locations"]}
    assert by_label["Box Ranch"]["bounds"] == [1, 2, 3, 4]
    assert by_label["Boxford"]["bounds"] == [10, 20, 11, 22]
    assert by_label["Boxless"]["bounds"] is None


def test_saved_circle_nearby_date_and_limit(client):
    place = index.create_place("Ranch", "circle", json.dumps({"lat": 30, "lng": -96, "radius": 1000}))
    _add("outside.jpg", lat=30.009, lng=-95.990, dt=946684800)  # bbox corner, outside circle
    _add("inside.jpg", lat=30, lng=-96, dt=946684801)
    _add("old.jpg", lat=30, lng=-96, dt=1000)
    _add("no-gps.jpg", dt=946684802)
    params = {"place_id": place, "date_from": "2000-01-01", "date_to": "2000-01-01", "limit": 1}
    result = client.get("/api/search", params=params).json()
    assert [p["filename"] for p in result["photos"]] == ["inside.jpg"]
    params.update(nearby_m=500, limit=20)
    result = client.get("/api/search", params=params).json()
    assert {p["filename"] for p in result["photos"]} == {"inside.jpg", "outside.jpg"}


def test_saved_rectangle_boundary_and_nearby(client):
    place = index.create_place("Ranch", "rectangle", json.dumps({"south": 30, "north": 31, "west": -97, "east": -96}))
    _add("edge.jpg", lat=30, lng=-97)
    _add("near.jpg", lat=29.999, lng=-97)
    _add("far.jpg", lat=29, lng=-97)
    assert client.get("/api/search", params={"place_id": place}).json()["total"] == 1
    assert client.get("/api/search", params={"place_id": place, "nearby_m": 200}).json()["total"] == 2


def test_search_camera_filter(client):
    _add("nikon.jpg", dt=1000, camera="Nikon D300")
    _add("phone.jpg", dt=1000, camera="iPhone")
    r = client.get("/api/search?camera=Nikon D300").json()
    assert [p["filename"] for p in r["photos"]] == ["nikon.jpg"]


def test_search_folder_filter(client):
    _add("boxA.jpg", dt=1000, dir_="Box A")
    _add("boxB.jpg", dt=1000, dir_="Box B")
    r = client.get("/api/search", params={"dir": "Box A"}).json()
    assert [p["filename"] for p in r["photos"]] == ["boxA.jpg"]


def test_search_has_faces_filter(client):
    alice = index.create_person("Alice")
    with_face = _add("with_face.jpg", dt=1000)
    _add("without_face.jpg", dt=2000)
    _add_face(with_face, alice)
    assert [p["filename"] for p in client.get("/api/search?has_faces=yes").json()["photos"]] == ["with_face.jpg"]
    assert [p["filename"] for p in client.get("/api/search?has_faces=no").json()["photos"]] == ["without_face.jpg"]


def test_search_gps_accuracy_filter(client):
    _add("precise.jpg", lat=10, lng=20, dt=1000, gps_accuracy=None)
    _add("imprecise.jpg", lat=10, lng=20, dt=2000, gps_accuracy=500.0)
    assert [p["filename"] for p in client.get("/api/search?gps_accuracy=precise").json()["photos"]] == ["precise.jpg"]
    assert [p["filename"] for p in client.get("/api/search?gps_accuracy=imprecise").json()["photos"]] == ["imprecise.jpg"]


def test_search_sort(client):
    _add("b.jpg", dt=2000)
    _add("a.jpg", dt=1000)
    assert [p["filename"] for p in client.get("/api/search?sort=date_asc").json()["photos"]] == ["a.jpg", "b.jpg"]
    assert [p["filename"] for p in client.get("/api/search?sort=date_desc").json()["photos"]] == ["b.jpg", "a.jpg"]
    assert [p["filename"] for p in client.get("/api/search?sort=filename").json()["photos"]] == ["a.jpg", "b.jpg"]


def test_search_cameras_endpoint(client):
    _add("a.jpg", dt=1000, camera="Nikon D300")
    _add("b.jpg", dt=1000, camera="iPhone")
    _add("c.jpg", dt=1000, camera=None)
    assert set(client.get("/api/search/cameras").json()["cameras"]) == {"Nikon D300", "iPhone"}


def test_invalid_location_selection(client):
    assert client.get("/api/search?place_id=999").status_code == 404
    assert client.get("/api/search?nearby_m=500").status_code == 400
    assert client.get("/api/search?nearby_m=-1").status_code == 422
    for value in ('{}', '[]', 'null', '{"id": "1"}', 'bad'):
        assert client.get("/api/search", params={"location_fields": value}).status_code == 400


# ── Paging, true totals and the whole-set timeline (A3) ──

def _all_pages(client, params, limit):
    """Walk /api/search page by page; returns (ids in order, every response)."""
    ids, pages, offset = [], [], 0
    while offset is not None:
        r = client.get("/api/search", params={**params, "limit": limit, "offset": offset})
        assert r.status_code == 200
        page = r.json()
        pages.append(page)
        ids += [p["id"] for p in page["photos"]]
        offset = page["next_offset"]
        assert len(pages) < 50
    return ids, pages


def test_search_reports_true_total_and_truncated(client):
    for i in range(5):
        _add(f"p{i}.jpg", dt=1000 + i)
    r = client.get("/api/search", params={"limit": 2}).json()
    assert len(r["photos"]) == 2
    assert r["total"] == 5 and r["truncated"] is True
    assert r["offset"] == 0 and r["next_offset"] == 2 and r["limit"] == 2
    full = client.get("/api/search").json()
    assert full["total"] == 5 and full["truncated"] is False and full["next_offset"] is None


def test_search_default_page_size_comes_from_config(client, monkeypatch):
    from geotagger import config
    for i in range(3):
        _add(f"p{i}.jpg", dt=1000 + i)
    monkeypatch.setattr(config, "SEARCH_PAGE_SIZE", 2)
    r = client.get("/api/search").json()
    assert r["limit"] == 2 and len(r["photos"]) == 2 and r["total"] == 3 and r["truncated"]


def test_search_pages_are_disjoint_and_complete_with_ties(client):
    # Same timestamp everywhere, and the same filename in two folders: without
    # an id tiebreaker LIMIT/OFFSET pages could repeat or skip rows.
    for i in range(7):
        _add("same.jpg" if i < 4 else f"x{i}.jpg", dt=5000, dir_=f"d{i}", camera="cam")
    expected = {r[0] for r in index.get_db().execute("SELECT id FROM photos")}
    assert len(expected) == 7
    for sort in ("date_asc", "date_desc", "filename", "camera"):
        ids, pages = _all_pages(client, {"sort": sort}, limit=2)
        assert len(ids) == 7 and set(ids) == expected, sort
        assert all(p["total"] == 7 for p in pages)
        assert [p["truncated"] for p in pages] == [True, True, True, True]
        one = [p["id"] for p in client.get("/api/search", params={"sort": sort}).json()["photos"]]
        assert ids == one, sort   # paging walks exactly the unpaged order


def test_search_paging_with_place_filter(client):
    place = index.create_place("Ranch", "circle", json.dumps({"lat": 30, "lng": -96, "radius": 1000}))
    inside = {_add(f"in{i}.jpg", lat=30, lng=-96, dt=1000 + i) for i in range(3)}
    _add("far.jpg", lat=40, lng=-96, dt=1000)
    ids, pages = _all_pages(client, {"place_id": place}, limit=2)
    assert set(ids) == inside and len(ids) == 3
    assert pages[0]["total"] == 3 and pages[0]["truncated"]


def test_search_histogram_covers_every_match(client):
    day = 86400
    for i in range(4):
        _add(f"p{i}.jpg", dt=946684800 + i * day)
    _add("undated.jpg", dt=None)
    r = client.get("/api/search", params={"limit": 1}).json()
    h = r["histogram"]
    # Only one photo is in the page, but the bars describe all four dated ones.
    assert h["min"] == 946684800 and h["max"] == 946684800 + 3 * day
    assert h["bucket_secs"] == day and h["counts"] == [1, 1, 1, 1]
    # Fewer than two dated matches: nothing to draw.
    assert client.get("/api/search", params={"undated": "true"}).json()["histogram"] is None


def test_timeline_histogram_bucket_widths():
    from geotagger.services.search_service import timeline_histogram
    day = 86400
    assert timeline_histogram([0, None, 5]) is None
    assert timeline_histogram([day, 101 * day])["bucket_secs"] == 7 * day
    assert timeline_histogram([day, 91 * day])["counts"] == [1] + [0] * 89 + [1]
    h = timeline_histogram([-400 * day, 0, None, 0])  # pre-1970 kept, 0/None undated
    assert h is None
    h = timeline_histogram([-400 * day, day])
    assert h["bucket_secs"] == 30 * day and sum(h["counts"]) == 2


def test_search_ids_only_returns_every_match_in_order(client):
    for i in range(5):
        _add(f"p{i}.jpg", dt=1000 + (4 - i))
    r = client.get("/api/search", params={"ids_only": "true", "limit": 2, "sort": "date_asc"}).json()
    assert "photos" not in r
    assert r["total"] == 5 and len(r["ids"]) == 5
    page_ids, _ = _all_pages(client, {"sort": "date_asc"}, limit=2)
    assert r["ids"] == page_ids
    assert r["datetimes"] == sorted(r["datetimes"])


def test_search_offset_past_the_end(client):
    _add("a.jpg")
    r = client.get("/api/search", params={"offset": 5}).json()
    assert r["photos"] == [] and r["total"] == 1 and r["next_offset"] is None


def test_search_limit_offset_validation(client):
    for params in ({"limit": 0}, {"limit": 20001}, {"offset": -1}, {"offset": 10_000_001},
                   {"limit": "x"}):
        assert client.get("/api/search", params=params).status_code == 422, params
    assert client.get("/api/search", params={"limit": 20000, "offset": 0}).status_code == 200


def test_photos_by_ids_post(client):
    a, b = _add("a.jpg", dt=2000), _add("b.jpg", dt=1000)
    _add("c.jpg", dt=1500)
    r = client.post("/api/photos/by-ids", json={"ids": [a, b, 999999]})
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == [b, a]   # chronological, unknown ids skipped
    assert client.post("/api/photos/by-ids", json={"ids": []}).json() == []
    assert client.post("/api/photos/by-ids", json={"ids": ["x"]}).status_code == 422
    # Far more ids than fit in a GET request line still work in the body.
    many = list(range(1, 60001))
    assert {p["id"] for p in client.post("/api/photos/by-ids", json={"ids": many}).json()} == {a, b, 3}
