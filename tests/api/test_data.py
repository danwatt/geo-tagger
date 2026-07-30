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
