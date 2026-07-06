"""Endpoint tests for geotagger.api.geotag (geotag write/remove/ignore, guess)."""

from pathlib import Path

import pytest
from PIL import Image

from geotagger import index
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


def test_geotag_write_and_remove(client, tmp_path):
    if not exiftool_status()["ok"]:
        pytest.skip("ExifTool unavailable")
    img = tmp_path / "g.jpg"
    Image.new("RGB", (8, 8), "green").save(img, "JPEG")
    pid = _add(str(img), dt=1000)

    r = client.post("/api/geotag", json={"ids": [pid], "lat": 10.0, "lng": 20.0})
    assert r.status_code == 200
    body = r.json()
    assert body[0]["geotag_source"] == "sidecar"
    assert body[0]["lat"] == 10.0 and body[0]["lng"] == 20.0
    assert (tmp_path / "g.xmp").exists()
    assert client.get(f"/api/photo/{pid}").json()["lat"] == 10.0

    r = client.post("/api/geotag/remove", json={"ids": [pid]})
    assert r.json()[0]["geotag_source"] == "none"
    assert client.get(f"/api/photo/{pid}").json()["lat"] is None


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
