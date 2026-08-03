"""Endpoint tests for geotagger.api.data (Data Management page).

Only the read-only surface: the download endpoints themselves reach out to
GeoNames/GeoFabrik/Census, so they're not exercised here — just their status
shape and the idle job state the page polls.
"""


def test_status_lists_every_dataset(client):
    body = client.get("/api/data/status").json()
    assert {"geonames", "osm", "census", "face_model"} <= set(body)


def test_census_status_reports_not_built(client, census_db):
    census = client.get("/api/data/status").json()["census"]
    assert census["available"] is False
    assert census["places"] == 0
    assert census["url"].endswith("_us_place_500k.zip")
    assert "census" in census["db_path"].lower()


def test_census_status_reports_counts_once_built(client, census_db):
    outer = [[39.9, -74.1], [40.1, -74.1], [40.1, -73.9], [39.9, -73.9]]
    census_db([{"name": "Testville CDP", "kind": "CDP", "polygons": [[outer, []]]}])
    census = client.get("/api/data/status").json()["census"]
    assert census["available"] is True
    assert census["places"] == 1
    assert census["by_kind"] == {"CDP": 1}


def test_census_job_status_starts_idle(client):
    job = client.get("/api/data/census/download/status").json()
    assert job["running"] is False
    assert job["done"] is False
    assert job["error"] is None


def test_download_history_endpoint_is_empty_on_a_fresh_db(client):
    assert client.get("/api/data/downloads").json() == {"downloads": []}


# ── Street search ──
# The scan itself is covered in tests/test_osm_streets.py; these lock in the HTTP
# contract the Data Management page's search card depends on.


def test_streets_status_reports_no_cached_extracts(client):
    body = client.get("/api/data/streets/status").json()
    assert body["available"] is False
    assert body["files"] == []
    assert "pbf-cache" in body["cache_dir"]


def test_streets_search_job_starts_idle(client):
    job = client.get("/api/data/streets/search/status").json()
    assert job["running"] is False
    assert job["done"] is False
    assert job["error"] is None


def test_streets_search_without_cached_extracts_is_a_400(client):
    res = client.post("/api/data/streets/search",
                      json={"bbox": "-96.1,29.9,-95.9,30.1", "query": "main"})
    assert res.status_code == 400
    assert "no longer on disk" in res.json()["detail"]


def test_streets_search_rejects_a_short_query(client):
    res = client.post("/api/data/streets/search",
                      json={"bbox": "-96.1,29.9,-95.9,30.1", "query": "m"})
    assert res.status_code == 400
    assert "2 characters" in res.json()["detail"]


def test_streets_search_rejects_a_malformed_bbox(client):
    res = client.post("/api/data/streets/search", json={"bbox": "nope", "query": "main"})
    assert res.status_code == 400
    assert "minLng" in res.json()["detail"]
