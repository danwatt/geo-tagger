"""Endpoint tests for geotagger.api.stats."""

from geotagger import index


def _add(path, lat=None, lng=None, dt=None, media="image", ignored=False):
    index.upsert_photo(
        path=path, filename=path, dir_=".", ext=".jpg", media_type=media,
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=dt, gps_accuracy=None, orientation=1,
    )
    db = index.get_db()
    pid = db.execute("SELECT id FROM photos WHERE path=?", (path,)).fetchone()[0]
    if ignored:
        db.execute("UPDATE photos SET geocode_ignored=1 WHERE id=?", (pid,))
        db.commit()
    return pid


JAN_2020 = 1_577_836_800  # 2020-01-01 00:00:00 UTC


def test_summary_counts(client):
    _add("a.jpg", lat=10, lng=20, dt=JAN_2020)
    _add("b.jpg", dt=JAN_2020)
    _add("c.jpg", dt=JAN_2020, ignored=True)
    _add("v.mp4", lat=1, lng=2, dt=JAN_2020, media="video")
    s = client.get("/api/stats/summary").json()
    assert s["photos"] == {"total": 4, "images": 3, "videos": 1}
    assert s["geotag"] == {"tagged": 2, "ignored": 1, "untagged": 1}


def test_bounds(client):
    _add("a.jpg", lat=10, lng=20)
    _add("b.jpg", lat=1, lng=2)
    b = client.get("/api/stats/bounds").json()
    assert b == {"has_data": True, "min_lat": 1, "max_lat": 10, "min_lng": 2, "max_lng": 20}


def test_bounds_empty(client):
    assert client.get("/api/stats/bounds").json() == {"has_data": False}


def test_months(client):
    _add("a.jpg", lat=10, lng=20, dt=JAN_2020)
    _add("b.jpg", dt=JAN_2020)
    months = client.get("/api/stats/months").json()["months"]
    assert {"year": 2020, "month": 1, "total": 2,
            "geotagged": 1, "not_geotagged": 1} in months


def test_dates_all_and_filtered(client):
    _add("a.jpg", dt=JAN_2020)
    assert {"date": "2020-01-01", "count": 1} in client.get("/api/stats/dates").json()["dates"]
    filtered = client.get("/api/stats/dates?year=2020&month=1").json()["dates"]
    assert filtered == [{"date": "2020-01-01", "count": 1}]
