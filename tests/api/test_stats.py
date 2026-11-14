"""Endpoint tests for geotagger.api.stats."""

from geotagger import index


def _add(path, lat=None, lng=None, dt=None, media="image", ignored=False):
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type=media,
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=dt, gps_accuracy=None, orientation=1,
    )
    db = index.get_db()
    pid = db.execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()[0]
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


def test_face_coverage(client):
    import time
    db = index.get_db()
    alice = index.create_person("Alice")

    def photo(path, specs, scanned=True):
        pid = _add(path)
        if scanned:
            db.execute("UPDATE photos SET faces_scanned_at=? WHERE id=?", (time.time(), pid))
        for person_id, ignored in specs:
            cur = db.execute(
                "INSERT INTO faces (photo_id, person_id, bbox, det_score, "
                "source, ignored, created_at) VALUES (?, ?, '0,0,1,1', 0.9, "
                "'detected', ?, 0)",
                (pid, person_id, ignored),
            )
            db.execute(
                "INSERT INTO face_embeddings (face_id, embedding) VALUES (?, X'00')",
                (cur.lastrowid,),
            )
        db.commit()

    photo("full.jpg", [(alice, 0)])          # full
    photo("partial.jpg", [(alice, 0), (None, 0)])  # partial
    photo("none.jpg", [(None, 0)])           # none labeled
    photo("noface.jpg", [])                  # no faces detected
    photo("unscanned.jpg", [(None, 0)], scanned=False)  # excluded

    assert client.get("/api/stats/face-coverage").json() == {
        "full": 1, "partial": 1, "none": 1, "no_faces": 1,
    }


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


def test_years(client):
    _add("a.jpg", dt=JAN_2020)
    _add("b.jpg", dt=1_483_228_800)  # 2017-01-01
    _add("undated.jpg", dt=None)
    assert client.get("/api/stats/years").json()["years"] == [2020, 2017]


def test_years_empty(client):
    assert client.get("/api/stats/years").json()["years"] == []


def test_dates_all_and_filtered(client):
    _add("a.jpg", dt=JAN_2020)
    assert {"date": "2020-01-01", "count": 1} in client.get("/api/stats/dates").json()["dates"]
    filtered = client.get("/api/stats/dates?year=2020&month=1").json()["dates"]
    assert filtered == [{"date": "2020-01-01", "count": 1}]


# ── /api/stats/faces-months ──

def _scanned(pid, faces=()):
    """Mark a photo face-scanned and give it faces, each 'labeled', 'unlabeled'
    or 'ignored'."""
    with index.transaction() as db:
        db.execute("UPDATE photos SET faces_scanned_at=1 WHERE id=?", (pid,))
        person = None
        if "labeled" in faces:
            person = db.execute("INSERT INTO persons (name, created_at) VALUES (?, 0)",
                                (f"P{pid}",)).lastrowid
        for kind in faces:
            db.execute(
                "INSERT INTO faces (photo_id, person_id, bbox, det_score, source, ignored, created_at) "
                "VALUES (?, ?, '0,0,1,1', 0.9, 'detected', ?, 0)",
                (pid, person if kind == "labeled" else None, 1 if kind == "ignored" else 0))


def test_faces_months_buckets_by_labeling_state(client):
    JUN_2021 = 1_622_505_600  # 2021-06-01 00:00:00 UTC
    _scanned(_add("full.jpg", dt=JAN_2020), ["labeled", "labeled"])
    _scanned(_add("ign.jpg", dt=JAN_2020), ["labeled", "ignored"])      # ignored ≠ unlabeled
    _scanned(_add("part.jpg", dt=JAN_2020), ["labeled", "unlabeled"])
    _scanned(_add("none.jpg", dt=JAN_2020), ["unlabeled"])
    _scanned(_add("empty.jpg", dt=JUN_2021))
    _add("unscanned.jpg", dt=JAN_2020)                                   # excluded
    _scanned(_add("clip.mp4", dt=JAN_2020, media="video"), ["unlabeled"])  # excluded
    _scanned(_add("undated.jpg", dt=None), ["unlabeled"])
    _scanned(_add("undated0.jpg", dt=0))

    body = client.get("/api/stats/faces-months").json()
    assert body["months"] == [   # newest first
        {"year": 2021, "month": 6, "full": 0, "partial": 0, "none": 0, "no_faces": 1},
        {"year": 2020, "month": 1, "full": 2, "partial": 1, "none": 1, "no_faces": 0},
    ]
    assert body["undated"] == {"full": 0, "partial": 0, "none": 1, "no_faces": 1}


def test_faces_months_empty_library(client):
    assert client.get("/api/stats/faces-months").json() == {
        "months": [], "undated": {"full": 0, "partial": 0, "none": 0, "no_faces": 0}}
