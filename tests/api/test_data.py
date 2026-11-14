"""Endpoint tests for geotagger.api.data (Data Management page).

The download jobs themselves reach out to GeoNames/GeoFabrik/Census, so they're
not run here: the status shape, the idle job state the page polls, and (with
the job runner stubbed) the start / 409-while-running contract.
"""

import threading
import time

import pytest

from geotagger.services import data_service


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


# ── Dataset download kick-off routes (GeoNames, OSM, face model) ──
# The jobs themselves fetch from the network, so each runner is swapped for a
# stub that holds the job "running" until released. That keeps the real
# start/409/status bookkeeping under test without touching the network.

_JOBS = {
    # name: (POST url, status url, job global, runner global, lock global)
    "geonames": ("/api/data/geonames/download", "/api/data/geonames/download/status",
                 "_geonames_job", "_run_geonames_download", "_geonames_lock"),
    "osm": ("/api/data/osm/download", "/api/data/osm/download/status",
            "_osm_job", "_run_osm_download_and_merge", "_osm_lock"),
    "face_model": ("/api/data/face-model/download", "/api/data/face-model/download/status",
                   "_face_model_job", "_run_face_model_download", "_face_model_lock"),
}


def _body(name, force=False):
    if name == "osm":
        return {"regions": [next(iter(data_service._GEOFABRIK_REGIONS))], "force": force}
    return {"force": force}


@pytest.mark.parametrize("name", list(_JOBS))
def test_download_starts_once_then_409_until_done(client, monkeypatch, name):
    post_url, status_url, job_attr, runner_attr, lock_attr = _JOBS[name]
    monkeypatch.setattr(data_service, job_attr,
                        {"running": False, "done": False, "error": None, "message": "", "result": None})
    release, called = threading.Event(), []

    def fake_runner(*args):
        called.append(args)
        release.wait(10)
        with getattr(data_service, lock_attr):
            getattr(data_service, job_attr).update(running=False, done=True, message="Done")

    monkeypatch.setattr(data_service, runner_attr, fake_runner)
    try:
        assert client.get(status_url).json()["running"] is False
        r = client.post(post_url, json=_body(name, force=True))
        assert r.status_code == 200 and r.json() == {"started": True}
        assert client.get(status_url).json()["running"] is True
        assert client.post(post_url, json=_body(name)).status_code == 409
    finally:
        release.set()
    for _ in range(200):
        if client.get(status_url).json()["done"]:
            break
        time.sleep(0.01)
    status = client.get(status_url).json()
    assert status["running"] is False and status["done"] is True
    assert len(called) == 1 and True in called[0]        # force reached the runner


@pytest.mark.parametrize("regions", [[], ["atlantis_nowhere"]])
def test_osm_download_rejects_bad_regions(client, monkeypatch, regions):
    monkeypatch.setattr(data_service, "_run_osm_download_and_merge",
                        lambda *a: pytest.fail("job must not start"))
    r = client.post("/api/data/osm/download", json={"regions": regions})
    assert r.status_code == 400
    assert client.get("/api/data/osm/download/status").json()["running"] is False
