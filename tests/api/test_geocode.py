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
    assert {"available", "geocoded", "pending", "osm", "census"} <= set(s)
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


def _osm_city_row(name, min_lat, max_lat, min_lng, max_lng, area=1.0):
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return dict(name=name, category="city", admin_level=8, area=area, polygons=[[outer, []]])


def test_osm_places_503_without_data(client, osm_db):
    assert client.get("/api/geocode/osm-places?bbox=-1,-1,1,1").status_code == 503


def test_osm_places_400_bad_bbox(client, osm_db):
    osm_db([_osm_city_row("Testville", 39.9, 40.1, -74.1, -73.9)])
    assert client.get("/api/geocode/osm-places?bbox=nonsense").status_code == 400


def test_osm_places_returns_geojson_feature_collection_within_bbox(client, osm_db):
    osm_db([_osm_city_row("Testville", 39.9, 40.1, -74.1, -73.9)])
    r = client.get("/api/geocode/osm-places?bbox=-75,39,-73,41")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["total"] == 1
    assert len(body["features"]) == 1
    feature = body["features"][0]
    assert feature["type"] == "Feature"
    assert feature["properties"]["name"] == "Testville"
    assert feature["geometry"]["type"] == "MultiPolygon"


def _census_row(name, min_lat, max_lat, min_lng, max_lng, kind="CDP"):
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return {"name": name, "kind": kind, "polygons": [[outer, []]]}


def test_census_places_503_without_data(client, census_db):
    assert client.get("/api/geocode/census-places?bbox=-1,-1,1,1").status_code == 503


def test_census_places_400_bad_bbox(client, census_db):
    census_db([_census_row("Testville CDP", 39.9, 40.1, -74.1, -73.9)])
    assert client.get("/api/geocode/census-places?bbox=nonsense").status_code == 400


def test_census_places_returns_geojson_feature_collection(client, census_db):
    census_db([_census_row("Testville CDP", 39.9, 40.1, -74.1, -73.9)])
    r = client.get("/api/geocode/census-places?bbox=-75,39,-73,41")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["total"] == 1
    feature = body["features"][0]
    assert feature["properties"]["name"] == "Testville CDP"
    assert feature["properties"]["kind"] == "CDP"
    assert feature["geometry"]["type"] == "MultiPolygon"


def _zcta_row(zip_code, min_lat, max_lat, min_lng, max_lng, city=None):
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return {"zip": zip_code, "city": city, "polygons": [[outer, []]]}


def test_zctas_503_without_data(client, census_db):
    assert client.get("/api/geocode/zctas?bbox=-1,-1,1,1").status_code == 503


def test_zctas_503_when_the_db_has_no_zcta_layer(client, census_db):
    # Built places-only (or before the ZCTA layer existed) — a distinct condition
    # from "no census DB at all", and the map surfaces the message.
    census_db([_census_row("Testville CDP", 39.9, 40.1, -74.1, -73.9)])
    r = client.get("/api/geocode/zctas?bbox=-75,39,-73,41")
    assert r.status_code == 503
    assert "ZIP areas" in r.json()["detail"]


def test_zctas_400_bad_bbox(client, census_db):
    census_db([], zctas=[_zcta_row("10001", 39.9, 40.1, -74.1, -73.9)])
    assert client.get("/api/geocode/zctas?bbox=nonsense").status_code == 400


def test_zctas_returns_geojson_with_zip_and_city(client, census_db):
    census_db([], zctas=[_zcta_row("10001", 39.9, 40.1, -74.1, -73.9, city="PostalCity")])
    r = client.get("/api/geocode/zctas?bbox=-75,39,-73,41")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["total"] == 1
    props = body["features"][0]["properties"]
    assert props["zip"] == "10001"
    assert props["city"] == "PostalCity"


def test_lookup_reports_each_source(client, geonames_dir, census_db):
    _write_geonames(geonames_dir)
    census_db([_census_row("Census CDP", 39.9, 40.1, -74.1, -73.9)])
    body = client.get("/api/geocode/lookup?lat=40.0&lng=-74.0").json()
    # Census containment wins the city; the GeoNames guess is still reported.
    assert body["location"]["city"] == "Census CDP"
    assert body["sources"]["osm"] is None
    assert body["sources"]["census"]["city"] == "Census CDP"
    assert body["sources"]["geonames"]["city"] == "Testville"


def test_lookup_503_with_nothing_installed(client, geonames_dir):
    assert client.get("/api/geocode/lookup?lat=40.0&lng=-74.0").status_code == 503


def test_osm_places_unwraps_a_bbox_panned_around_the_globe(client, osm_db):
    # Regression: Leaflet's getBounds() after panning past +/-180 sent raw,
    # unwrapped longitudes like these for a Fort Worth, TX viewport, which
    # matched nothing until the bbox was unwrapped back into [-180, 180].
    osm_db([_osm_city_row("Fort Worth", 32.5, 33.1, -97.5, -96.0)])
    r = client.get(
        "/api/geocode/osm-places"
        "?bbox=-458.4223937988281,32.5635873170885,-456.0946655273438,33.0926823840692"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["features"][0]["properties"]["name"] == "Fort Worth"
