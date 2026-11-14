"""Endpoint tests for geotagger.api.geotag (geotag write/remove/ignore, guess)."""

import json
from pathlib import Path

import pytest
from PIL import Image

from geotagger import config, index
from geotagger.exiftool_session import exiftool_status


def _add(path, lat=None, lng=None, dt=1000):
    p = Path(path)
    index.upsert_photo(
        filename=p.name, dir_=str(p.parent),
        ext=".jpg", media_type="image", mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=dt, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(p.parent), p.name)
    ).fetchone()[0]


def test_ignore_toggles_flag(client):
    pid = _add("u.jpg", dt=1000)
    r = client.post("/api/geotag/ignore", json={"ids": [pid], "ignored": True})
    assert r.status_code == 200
    assert r.json() == {"ids": [pid], "geocode_ignored": True}
    assert client.get(f"/api/photo/{pid}").json()["geocode_ignored"] is True

    client.post("/api/geotag/ignore", json={"ids": [pid], "ignored": False})
    assert client.get(f"/api/photo/{pid}").json()["geocode_ignored"] is False


def test_geotag_write_and_remove_db_only_by_default(et_session, client, tmp_path):
    # Removal clears GPS through sidecar.remove_gps (ExifTool) even in DB-only mode.
    """WRITE_XMP_ON_GEOTAG defaults to off: geotag lands in the DB, no sidecar
    is created."""
    assert config.WRITE_XMP_ON_GEOTAG is False
    img = tmp_path / "g.jpg"
    Image.new("RGB", (8, 8), "green").save(img, "JPEG")
    pid = _add(str(img), dt=1000)

    r = client.post("/api/geotag", json={"ids": [pid], "lat": 10.0, "lng": 20.0})
    assert r.status_code == 200
    body = r.json()["results"]
    assert body[0]["geotag_source"] == "database"
    assert body[0]["lat"] == 10.0 and body[0]["lng"] == 20.0
    assert not (tmp_path / "g.xmp").exists()
    assert client.get(f"/api/photo/{pid}").json()["lat"] == 10.0

    r = client.post("/api/geotag/remove", json={"ids": [pid]})
    assert r.json()["results"][0]["geotag_source"] == "none"
    assert client.get(f"/api/photo/{pid}").json()["lat"] is None


def test_geotag_writes_sidecar_when_setting_enabled(et_session, client, tmp_path):
    assert exiftool_status()["ok"]
    img = tmp_path / "g2.jpg"
    Image.new("RGB", (8, 8), "green").save(img, "JPEG")
    pid = _add(str(img), dt=1000)

    config.apply_setting_override("WRITE_XMP_ON_GEOTAG", True)
    try:
        r = client.post("/api/geotag", json={"ids": [pid], "lat": 10.0, "lng": 20.0})
        assert r.status_code == 200
        body = r.json()["results"]
        assert body[0]["geotag_source"] == "sidecar"
        assert (tmp_path / "g2.xmp").exists()
    finally:
        config.reset_setting("WRITE_XMP_ON_GEOTAG")


def test_guess_uses_time_neighbors(client):
    _add("neighbor.jpg", lat=10.0, lng=20.0, dt=1000)
    tid = _add("target.jpg", dt=1010)
    g = client.get(f"/api/guess/{tid}").json()
    assert g["source"] == "time-neighbors"
    assert g["lat"] == 10.0 and g["lng"] == 20.0


def test_guess_already_tagged_400(client):
    pid = _add("t.jpg", lat=1.0, lng=2.0, dt=1000)
    assert client.get(f"/api/guess/{pid}").status_code == 400


def test_guess_no_neighbors_404(client):
    pid = _add("lonely.jpg", dt=1000)
    assert client.get(f"/api/guess/{pid}").status_code == 404


# ── D7: validation, per-photo isolation, structured results ──

def _photos(tmp_path, n=3):
    ids = []
    for i in range(n):
        img = tmp_path / f"b{i}.jpg"
        Image.new("RGB", (8, 8), "green").save(img, "JPEG")
        ids.append(_add(str(img), dt=1000 + i))
    return ids


def _lat(pid):
    return index.get_db().execute("SELECT lat FROM photos WHERE id=?", (pid,)).fetchone()[0]


@pytest.mark.parametrize("body", [
    {"lat": 999, "lng": 20},
    {"lat": 10, "lng": 181},
    {"lat": -90.5, "lng": 0},
    {"lat": float("nan"), "lng": 0},
    {"lat": 0, "lng": float("inf")},
    {"lat": 10, "lng": 20, "gps_accuracy": -1},
    {"lat": 10, "lng": 20, "gps_accuracy": float("inf")},
])
def test_geotag_rejects_bad_coordinates(client, tmp_path, body, monkeypatch):
    from geotagger import sidecar
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", True)
    wrote = []
    monkeypatch.setattr(sidecar, "write_gps", lambda *a, **k: wrote.append(a))
    (pid,) = _photos(tmp_path, 1)
    # json= would refuse NaN/inf client-side; a hostile client sends them raw.
    r = client.post("/api/geotag", content=json.dumps({"ids": [pid], **body}),
                    headers={"Content-Type": "application/json"})
    assert r.status_code in (400, 422)
    assert wrote == [] and _lat(pid) is None


def test_service_and_sidecar_guard_out_of_range(db, tmp_path):
    from geotagger import sidecar
    from geotagger.services import geotag_service
    (pid,) = _photos(tmp_path, 1)
    with pytest.raises(ValueError):
        geotag_service.write_geotag([pid], 999.0, 0.0)
    assert _lat(pid) is None
    with pytest.raises(ValueError):
        sidecar.write_gps(tmp_path / "b0.jpg", 999.0, 0.0)
    assert not (tmp_path / "b0.xmp").exists()


def test_partial_failure_reports_breakdown_and_invalidates(client, tmp_path, monkeypatch):
    from geotagger import sidecar
    from geotagger.services import hotspots_service, work_queue_service
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", True)
    ids = _photos(tmp_path, 3)

    def fake_write(p, lat, lng, location=None, gps_accuracy=None):
        if p.name == "b1.jpg":
            raise RuntimeError("exiftool exploded\nwith a traceback")
        return p.with_suffix(".xmp")

    monkeypatch.setattr(sidecar, "write_gps", fake_write)
    inval = []
    monkeypatch.setattr(hotspots_service, "invalidate", lambda: inval.append("hotspots"))
    monkeypatch.setattr(work_queue_service, "invalidate", lambda: inval.append("queue"))

    r = client.post("/api/geotag", json={"ids": [ids[0], ids[1], ids[2], 99999], "lat": 10.0, "lng": 20.0})
    assert r.status_code == 200
    body = r.json()
    assert body["written"] == [ids[0], ids[2]]
    assert body["failed"] == [{"id": ids[1], "error": "exiftool exploded"}]
    assert body["not_found"] == [99999]
    assert [x["id"] for x in body["results"]] == [ids[0], ids[2]]
    assert _lat(ids[0]) == 10.0 and _lat(ids[2]) == 10.0
    assert _lat(ids[1]) is None            # sidecar failed -> row untouched
    assert inval == ["hotspots", "queue"]


def test_invalidation_runs_when_loop_aborts(db, tmp_path, monkeypatch):
    from geotagger.services import geotag_service, hotspots_service
    (pid,) = _photos(tmp_path, 1)
    called = []
    monkeypatch.setattr(hotspots_service, "invalidate", lambda: called.append(1))
    monkeypatch.setattr(index, "get_photo", lambda i: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        geotag_service.write_geotag([pid], 1.0, 2.0)
    assert called == [1]


def test_db_failure_after_sidecar_write_is_reported_failed(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", False)
    ids = _photos(tmp_path, 2)
    real = index.update_geotag

    def flaky(pid, *a, **k):
        if pid == ids[0]:
            raise RuntimeError("db is locked")
        return real(pid, *a, **k)

    monkeypatch.setattr(index, "update_geotag", flaky)
    body = client.post("/api/geotag", json={"ids": ids, "lat": 1.0, "lng": 2.0}).json()
    assert body["written"] == [ids[1]]
    assert body["failed"] == [{"id": ids[0], "error": "db is locked"}]


def test_all_failed_is_502_with_breakdown(client, tmp_path, monkeypatch):
    from geotagger import sidecar
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", True)
    ids = _photos(tmp_path, 2)

    def boom(*a, **k):
        raise RuntimeError("nope")

    monkeypatch.setattr(sidecar, "write_gps", boom)
    r = client.post("/api/geotag", json={"ids": ids, "lat": 1.0, "lng": 2.0})
    assert r.status_code == 502
    body = r.json()
    assert body["written"] == [] and [f["id"] for f in body["failed"]] == ids
    assert all(_lat(i) is None for i in ids)


def test_all_unknown_ids_is_404_and_empty_is_200(client):
    r = client.post("/api/geotag", json={"ids": [98765], "lat": 1.0, "lng": 2.0})
    assert r.status_code == 404 and r.json()["not_found"] == [98765]
    assert client.post("/api/geotag", json={"ids": [], "lat": 1.0, "lng": 2.0}).status_code == 200
    assert client.post("/api/geotag/remove", json={"ids": [98765]}).status_code == 404


def test_remove_partial_failure(et_session, client, tmp_path, monkeypatch):
    from geotagger import sidecar
    from geotagger.services import hotspots_service
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", False)
    ids = _photos(tmp_path, 3)
    client.post("/api/geotag", json={"ids": ids, "lat": 1.0, "lng": 2.0})

    real = sidecar.remove_gps

    def flaky(p, create=False):
        if p.name == "b1.jpg":
            raise TimeoutError("slow")
        return real(p, create=create)

    monkeypatch.setattr(sidecar, "remove_gps", flaky)
    inval = []
    monkeypatch.setattr(hotspots_service, "invalidate", lambda: inval.append(1))
    r = client.post("/api/geotag/remove", json={"ids": ids + [99999]})
    assert r.status_code == 200
    body = r.json()
    assert body["written"] == [ids[0], ids[2]]
    assert body["failed"] == [{"id": ids[1], "error": "slow"}]
    assert body["not_found"] == [99999]
    assert _lat(ids[0]) is None and _lat(ids[2]) is None and _lat(ids[1]) == 1.0
    assert inval == [1]

    monkeypatch.setattr(sidecar, "remove_gps", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))
    assert client.post("/api/geotag/remove", json={"ids": [ids[1]]}).status_code == 502
