"""Endpoint tests for geotagger.api.geocode."""


def _city_row(geonameid, name, lat, lng, population=1000000):
    return "\t".join([str(geonameid), name, name, "", str(lat), str(lng), "P", "PPL",
                       "US", "", "NY", "061", "", "", str(population), "", "", "", ""])


def _write_geonames(dir_, rows=None):
    (dir_ / "cities500.txt").write_text(
        "\n".join(rows or [_city_row(1, "Testville", 40.0, -74.0)]) + "\n", encoding="utf-8")
    (dir_ / "admin1CodesASCII.txt").write_text("US.NY\tNew York\tNew York\t1\n", encoding="utf-8")
    (dir_ / "admin2Codes.txt").write_text("US.NY.061\tNew York County\tNew York County\t10\n", encoding="utf-8")
    (dir_ / "countryInfo.txt").write_text("# header\nUS\tUSA\t840\tUS\tUnited States\tWashington\n", encoding="utf-8")


def test_status_shape(client):
    s = client.get("/api/geocode/status").json()
    assert {"available", "geocoded", "pending", "landmarks"} <= set(s)
    assert s["geocoded"] == 0 and s["pending"] == 0


def test_places_503_without_data(client, geonames_dir):
    # geonames_dir points the geocoder at an empty dir -> data unavailable.
    assert client.get("/api/geocode/places?bbox=-1,-1,1,1").status_code == 503


def test_backfill_503_without_data(client, geonames_dir):
    assert client.post("/api/geocode/backfill", json={"limit": 10}).status_code == 503


def test_next_group_none_when_library_empty(client):
    r = client.get("/api/geocode/next-group")
    assert r.status_code == 200
    assert r.json() is None


def test_places_returns_geonames_within_bbox(client, geonames_dir):
    _write_geonames(geonames_dir)
    r = client.get("/api/geocode/places?bbox=-180,-90,180,90")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    assert any(p["city"] == "Testville" for p in body["places"])


def test_voronoi_503_without_data(client, geonames_dir):
    assert client.get("/api/geocode/voronoi?bbox=-1,-1,1,1").status_code == 503


def test_voronoi_400_bad_bbox(client, geonames_dir):
    _write_geonames(geonames_dir)
    assert client.get("/api/geocode/voronoi?bbox=nonsense").status_code == 400


def test_landmarks_503_without_data(client, overture_dir):
    assert client.get("/api/geocode/landmarks?bbox=-1,-1,1,1").status_code == 503


def test_landmarks_400_bad_bbox(client, overture_dir):
    (overture_dir / "landmarks.jsonl").write_text("", encoding="utf-8")
    assert client.get("/api/geocode/landmarks?bbox=nonsense").status_code == 400


def test_landmarks_503_when_file_exists_but_fails_to_parse(client, overture_dir):
    # A single malformed *row* is skipped gracefully (not a 503) — but a file
    # that can't even be opened (e.g. "exists" as a directory, matching the
    # equivalent GeoNames test) is a genuine load failure -> 503, not a silent
    # 200 with empty results (see geocode.landmarks_ready()).
    (overture_dir / "landmarks.jsonl").mkdir()
    assert client.get("/api/geocode/landmarks?bbox=-1,-1,1,1").status_code == 503


def test_landmarks_returns_polygons_and_points_within_bbox(client, overture_dir):
    import json
    building = {"kind": "building", "name": "Test Tower", "category": "office",
                "polygon": [[39.999, -74.001], [39.999, -73.999], [40.001, -73.999], [40.001, -74.001]]}
    (overture_dir / "landmarks.jsonl").write_text(json.dumps(building) + "\n", encoding="utf-8")
    r = client.get("/api/geocode/landmarks?bbox=-75,39,-73,41")
    assert r.status_code == 200
    body = r.json()
    assert {"polygons", "points", "total", "truncated"} <= set(body)
    assert body["total"] == 1
    assert body["polygons"][0]["name"] == "Test Tower"


def test_voronoi_returns_cell_polygons(client, geonames_dir):
    _write_geonames(geonames_dir, [
        _city_row(1, "Testville", 40.0, -74.0),
        _city_row(2, "North", 40.5, -74.0, population=500),
        _city_row(3, "East", 40.0, -73.0, population=500),
    ])
    r = client.get("/api/geocode/voronoi?bbox=-75,39,-73,41")
    assert r.status_code == 200
    body = r.json()
    assert {"cells", "total", "truncated"} <= set(body)
    assert body["total"] == 3
    cell = next(c for c in body["cells"] if c["city"] == "Testville")
    assert len(cell["polygon"]) >= 3
    assert all(len(pt) == 2 for pt in cell["polygon"])
