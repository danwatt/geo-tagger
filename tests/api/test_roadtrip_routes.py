"""Endpoint tests for geotagger.api.roadtrip. The corridor geometry and route
suggestion logic are covered against the service in tests/test_roadtrip.py;
these pin the HTTP contract: validation, ValueError -> 400, and response shape.

Road Trip mode is switched off — api/__init__.py deliberately leaves its router
out of ROUTERS — so these mount it on a bare app of its own. The `client`
fixture still supplies the isolated DB and the running request executor."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from geotagger import index
from geotagger.api import ROUTERS, roadtrip


@pytest.fixture
def rt(client):
    assert roadtrip.router not in ROUTERS     # still disabled; drop this file's shim if not
    app = FastAPI()
    app.include_router(roadtrip.router)
    return TestClient(app)

ROUTE = [[0.0, 0.0], [0.0, 1.0]]   # due east along the equator, ~111 km


def _add(name, lat=None, lng=None, ts=1000):
    index.upsert_photo(
        filename=name, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=ts, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute("SELECT id FROM photos WHERE filename=?", (name,)).fetchone()[0]


# ── /api/roadtrip/suggest ──

def test_suggest_route_between_two_photos(rt):
    a = _add("a.jpg", 0.0, 0.0, ts=1000)
    b = _add("b.jpg", 0.0, 1.0, ts=9000)
    _add("stop.jpg", 0.5, 0.5, ts=5000)
    r = rt.post("/api/roadtrip/suggest", json={"start_id": b, "end_id": a})
    assert r.status_code == 200
    out = r.json()
    assert out["start"]["filename"] == "a.jpg"            # ordered by time, not click
    assert out["cluster_count"] == 1 and len(out["points"]) == 3
    assert (out["from_ts"], out["to_ts"]) == (1000, 9000)


def test_suggest_route_bad_endpoints_400(rt):
    a = _add("a.jpg", 0.0, 0.0)
    untagged = _add("u.jpg")
    undated = _add("nd.jpg", 1.0, 1.0, ts=0)
    for start, end in ((a, 999_999), (a, untagged), (a, undated)):
        r = rt.post("/api/roadtrip/suggest", json={"start_id": start, "end_id": end})
        assert r.status_code == 400, (start, end)
    assert rt.post("/api/roadtrip/suggest",
                       json={"start_id": a, "end_id": a, "cluster_m": 0}).status_code == 422


# ── /api/roadtrip/photos ──

def test_corridor_returns_tagged_photos_and_candidates(rt):
    _add("on.jpg", 0.001, 0.2, ts=1000)
    _add("on2.jpg", 0.001, 0.8, ts=9000)
    _add("off.jpg", 1.0, 0.5, ts=5000)                     # ~111 km north: outside
    between = _add("between.jpg", ts=5000)                  # untagged, timestamped between
    r = rt.post("/api/roadtrip/photos", json={"points": ROUTE, "radius_m": 5000})
    assert r.status_code == 200
    out = r.json()
    assert sorted(p["filename"] for p in out["photos"]) == ["on.jpg", "on2.jpg"]
    assert out["anchor_count"] == 2
    assert [c["id"] for c in out["candidates"]] == [between]
    assert out["route_length_m"] == pytest.approx(111_320, rel=0.01)


@pytest.mark.parametrize("body,status", [
    ({"points": [[0.0, 0.0]], "radius_m": 100}, 400),        # one point is not a route
    ({"points": [], "radius_m": 100}, 400),
    ({"points": ROUTE, "radius_m": 0}, 422),
    ({"points": ROUTE, "radius_m": 300_000}, 422),
    ({"points": ROUTE, "radius_m": 100, "edge_window": -1}, 422),
    ({"points": ROUTE}, 422),
])
def test_corridor_validation(rt, body, status):
    assert rt.post("/api/roadtrip/photos", json=body).status_code == status
