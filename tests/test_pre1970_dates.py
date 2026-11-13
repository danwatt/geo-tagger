"""Pre-1970 photo dates (audit D2).

photo_datetime is wall-clock-as-UTC epoch seconds, so a scan assigned 1955 is
negative. On Windows datetime.fromtimestamp(negative) raises OSError, which used
to 500 /api/photo, guess-dates and crowds; and `photo_datetime > 0` filters
classed these photos as undated. Undated is 0 or NULL.

Run on Windows these exercise the real OSError path; elsewhere they still pin
the predicate and ordering behaviour.
"""

import time
from datetime import datetime

import numpy as np
import pytest

from geotagger import faces, index, serializers, timeutil
from geotagger.services import geotag_service, roadtrip_service, work_queue_service

T1955 = timeutil.wallclock_to_epoch(datetime(1955, 6, 1, 12, 0, 0))
T1975 = timeutil.wallclock_to_epoch(datetime(1975, 3, 10, 9, 30, 0))
T1900 = timeutil.wallclock_to_epoch(datetime(1900, 1, 1))
T1826 = timeutil.wallclock_to_epoch(datetime(1826, 1, 1))


def _upsert(name, photo_datetime, lat=None, lng=None, camera="CamA", dir_="/lib"):
    index.upsert_photo(
        filename=name, dir_=dir_, ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera=camera,
        photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE filename=? AND dir=?", (name, dir_)).fetchone()["id"]


def _set_precision(pid, precision):
    with index.transaction() as db:
        db.execute("UPDATE photos SET date_precision=? WHERE id=?", (precision, pid))


@pytest.fixture
def library(client):
    """A 1955 photo, a 1975 photo, and one undated photo of each storage form."""
    ids = {
        "p1955": _upsert("p1955.jpg", T1955),
        "p1975": _upsert("p1975.jpg", T1975),
        "undated0": _upsert("undated0.jpg", 0),
        "undatedNull": _upsert("undatedNull.jpg", None),
    }
    return client, ids


# ── Conversions and the predicate ──

class TestTimeutil:
    def test_has_date(self):
        assert timeutil.has_date(T1955)
        assert timeutil.has_date(T1975)
        assert not timeutil.has_date(0)
        assert not timeutil.has_date(None)

    @pytest.mark.parametrize("wall", [datetime(1826, 1, 1), datetime(1900, 1, 1),
                                      datetime(1955, 6, 1, 12), datetime(1969, 12, 31, 23, 59, 59)])
    def test_round_trip_pre_1970(self, wall):
        ts = timeutil.wallclock_to_epoch(wall)
        assert ts < 0
        assert timeutil.epoch_to_wallclock(ts) == wall

    def test_sidecar_re_exports_the_same_helpers(self):
        from geotagger import sidecar
        assert sidecar.epoch_to_wallclock is timeutil.epoch_to_wallclock
        assert sidecar.wallclock_to_epoch is timeutil.wallclock_to_epoch

    def test_sql_predicate_matches_python(self, db):
        for name, ts in (("a", T1955), ("b", T1975), ("c", 0), ("d", None)):
            _upsert(name, ts)
        dated = {r[0] for r in db.execute(
            f"SELECT photo_datetime FROM photos WHERE {index.HAS_DATE_SQL}")}
        undated = db.execute(
            f"SELECT COUNT(*) FROM photos WHERE {index.UNDATED_SQL}").fetchone()[0]
        assert dated == {T1955, T1975}
        assert undated == 2
        assert index.has_date_sql("ph") == "(ph.photo_datetime != 0)"
        assert index.undated_sql("ph") == "(ph.photo_datetime IS NULL OR ph.photo_datetime = 0)"


# ── Crashes: serializers and labels ──

class TestFormatting:
    def test_exact_1955(self):
        assert serializers.format_photo_datetime(T1955, None) == "1955-06-01 12:00:00"

    def test_year_and_month_precision_old_dates(self):
        assert serializers.format_photo_datetime(T1826, "year") == "~1826"
        assert serializers.format_photo_datetime(T1900, "month") == "~January 1900"

    def test_undated_is_none(self):
        assert serializers.format_photo_datetime(0, None) is None
        assert serializers.format_photo_datetime(None, None) is None

    def test_crowd_label(self):
        assert serializers.format_crowd_group_label(T1955) == "June 1, 1955"
        assert serializers.format_crowd_group_label(None) == "Unknown date"

    def test_work_queue_span_label(self):
        assert work_queue_service.date_span_label(T1955, T1955 + 3600) == "Jun 1 1955"
        assert work_queue_service.date_span_label(T1900, T1955) == "Jan 1 1900 – Jun 1 1955"


# ── Crashes: endpoints ──

class TestEndpointsDoNotCrash:
    def test_photo_detail(self, library):
        client, ids = library
        r = client.get(f"/api/photo/{ids['p1955']}")
        assert r.status_code == 200
        assert r.json()["datetime"] == "1955-06-01 12:00:00"

    @pytest.mark.parametrize("year, precision, expected", [
        (1826, "year", "~1826"), (1900, "month", "~January 1900")])
    def test_photo_detail_oldest_years(self, client, year, precision, expected):
        pid = _upsert(f"old{year}.jpg", timeutil.wallclock_to_epoch(datetime(year, 1, 1)))
        _set_precision(pid, precision)
        r = client.get(f"/api/photo/{pid}")
        assert r.status_code == 200
        assert r.json()["datetime"] == expected

    def test_guess_dates(self, library):
        client, ids = library
        r = client.post("/api/photos/guess-dates", json={"photo_ids": [ids["p1955"]]})
        assert r.status_code == 200
        assert r.json()["guesses"][0]["current_datetime"] == "1955-06-01 12:00:00"

    def test_crowds_keep_undated_and_1955_apart(self, library):
        client, ids = library
        now = time.time()
        with index.transaction() as db:
            for pid in (ids["p1955"], ids["undatedNull"], ids["undated0"]):
                db.execute("UPDATE photos SET faces_scanned_at=? WHERE id=?", (now, pid))
                for _ in range(2):
                    db.execute(
                        "INSERT INTO faces (photo_id, person_id, bbox, det_score, source, "
                        "ignored, created_at) VALUES (?, NULL, '0,0,10,10', 0.9, 'detected', 0, ?)",
                        (pid, now))
        r = client.get("/api/crowds?min_faces=2")
        assert r.status_code == 200
        groups = r.json()["groups"]
        # Undated first as one group; 1955 on its own (not merged into undated:
        # a negative ts minus the undated 0 always passed the gap test).
        assert [g["label"] for g in groups] == ["Unknown date", "June 1, 1955"]
        assert {p["id"] for p in groups[0]["photos"]} == {ids["undatedNull"], ids["undated0"]}
        assert [p["id"] for p in groups[1]["photos"]] == [ids["p1955"]]


# ── "Has a date": stats, Undated grid, search ──

class TestNotUndated:
    def test_stats_months(self, library):
        client, _ = library
        body = client.get("/api/stats/months").json()
        assert {(m["year"], m["month"]) for m in body["months"]} == {(1955, 6), (1975, 3)}
        assert body["undated"]["total"] == 2

    def test_stats_years_skips_phantom_1970(self, library):
        # lo..hi spans 1970; the 1970 range-seek must not "find" the undated 0 row.
        client, _ = library
        assert client.get("/api/stats/years").json()["years"] == [1975, 1955]

    def test_stats_dates_for_a_1955_month(self, library):
        client, _ = library
        body = client.get("/api/stats/dates?year=1955&month=6").json()
        assert body["dates"] == [{"date": "1955-06-01", "count": 1}]

    def test_undated_grid_excludes_1955(self, library):
        client, ids = library
        got = {p["id"] for p in client.get("/api/photos?undated=true").json()}
        assert got == {ids["undated0"], ids["undatedNull"]}

    def test_search_undated_excludes_1955(self, library):
        client, ids = library
        got = {p["id"] for p in client.get("/api/search?undated=true").json()["photos"]}
        assert got == {ids["undated0"], ids["undatedNull"]}

    def test_faces_months_buckets_1955(self, library):
        client, ids = library
        with index.transaction() as db:
            db.execute("UPDATE photos SET faces_scanned_at=1", ())
        body = client.get("/api/stats/faces-months").json()
        assert {(m["year"], m["month"]) for m in body["months"]} == {(1955, 6), (1975, 3)}
        assert body["undated"]["no_faces"] == 2


# ── Date ranges across the 1970 boundary ──

class TestDateRanges:
    def test_range_spanning_the_1955_photo(self, library):
        client, ids = library
        got = [p["id"] for p in client.get(
            "/api/photos?date_from=1955-05-01&date_to=1955-06-30").json()]
        assert got == [ids["p1955"]]
        got = [p["id"] for p in client.get(
            "/api/search?date_from=1950-01-01&date_to=1980-12-31").json()["photos"]]
        assert got == [ids["p1955"], ids["p1975"]]

    def test_range_over_1970_01_01_excludes_undated_zero(self, library):
        client, _ = library
        assert client.get("/api/photos?date_from=1969-12-31&date_to=1970-01-01").json() == []
        assert client.get(
            "/api/search?date_from=1969-12-31&date_to=1970-01-01").json()["photos"] == []

    def test_last_day_before_1970(self, client):
        pid = _upsert("eve.jpg", -1)   # 1969-12-31 23:59:59
        got = [p["id"] for p in client.get(
            "/api/photos?date_from=1969-12-31&date_to=1969-12-31").json()]
        assert got == [pid]

    def test_time_range_helper_excludes_undated(self, db):
        _upsert("z.jpg", 0)
        keep = _upsert("y.jpg", -60)
        assert [r["id"] for r in index.get_photos_by_time_range(-3600, 3600)] == [keep]


# ── Ordering ──

class TestOrdering:
    def test_photo_list_undated_first_then_chronological(self, library):
        client, ids = library
        got = [p["id"] for p in client.get("/api/photos").json()]
        # Both undated forms together first, then 1955 before 1975 — 0-undated
        # no longer lands between the pre- and post-1970 photos.
        assert set(got[:2]) == {ids["undated0"], ids["undatedNull"]}
        assert got[2:] == [ids["p1955"], ids["p1975"]]

    def test_search_date_sorts_put_all_undated_last(self, library):
        client, ids = library
        asc = [p["id"] for p in client.get("/api/search?sort=date_asc").json()["photos"]]
        desc = [p["id"] for p in client.get("/api/search?sort=date_desc").json()["photos"]]
        assert asc[:2] == [ids["p1955"], ids["p1975"]]
        assert desc[:2] == [ids["p1975"], ids["p1955"]]
        assert set(asc[2:]) == set(desc[2:]) == {ids["undated0"], ids["undatedNull"]}


# ── Sessions, time-neighbour guesses, routes ──

class TestTimeLogic:
    def test_untagged_1955_photos_form_a_session(self, db):
        ids = [_upsert(f"s{i}.jpg", T1955 + i * 60) for i in range(3)]
        _upsert("u.jpg", 0)
        sessions = [b for b in work_queue_service.build(min_size=1)["batches"]
                    if b["kind"] == "session"]
        assert len(sessions) == 1
        s = sessions[0]
        assert s["member_ids"] == ids
        assert s["title"].startswith("Jun 1 1955")
        work_queue_service.invalidate()
        batch = work_queue_service.get_batch(s["id"], min_size=1)
        assert batch["photo_ids"] == ids
        work_queue_service.invalidate()

    def test_1955_neighbour_votes_in_the_work_queue_and_propose_bar(self, db):
        target = _upsert("t.jpg", T1955 + 60)
        _upsert("anchor.jpg", T1955, lat=48.85, lng=2.35)
        votes = work_queue_service._collect_votes(index.get_db())
        assert votes[target][:2] == (48.85, 2.35)
        proposed = geotag_service.propose_locations([target])
        assert proposed["selected"] == 1 and proposed["voted"] == 1

    def test_guess_and_guessable_count(self, client):
        target = _upsert("t.jpg", T1955 + 60)
        _upsert("anchor.jpg", T1955, lat=48.85, lng=2.35)
        r = client.get(f"/api/guess/{target}")
        assert r.status_code == 200
        assert r.json()["lat"] == pytest.approx(48.85)
        assert client.get("/api/stats/summary").json()["guessable"]["count"] == 1

    def test_route_anchors_and_predictions_before_1970(self, db):
        a = _upsert("a.jpg", T1955, lat=0.0, lng=0.0)
        b = _upsert("b.jpg", T1955 + 1000, lat=0.0, lng=1.0)
        mid = _upsert("mid.jpg", T1955 + 500)
        route = roadtrip_service.suggest_route(a, b)
        assert route["from_ts"] == T1955
        result = roadtrip_service.photos_along_route([[0.0, 0.0], [0.0, 1.0]], 5000.0)
        assert result["anchor_count"] == 2
        pred = next(c for c in result["candidates"] if c["id"] == mid)["predicted"]
        assert pred["method"] == "interpolated"
        assert pred["lng"] == pytest.approx(0.5, abs=1e-6)

    def test_people_focus_window_over_1970_skips_undated(self, db):
        # A Focus on calendar 1970 starts at epoch 0, exactly the undated sentinel.
        dated = _upsert("d.jpg", 3600)
        _upsert("u.jpg", 0)
        assert index._photo_ids_in_window(0, 365 * 86400) == [dated]

    def test_age_aware_matching_treats_1955_as_dated(self):
        # faces.py tests truthiness (not `> 0`), so a negative time is a real date
        # and only 0/None become NaN (undated).
        vec = faces.encode_embedding(np.ones(faces.EMBED_DIM, np.float32))
        rows = [{"photo_datetime": ts, "embedding": vec} for ts in (T1955, 0, None)]
        _, times = faces._stack_rows(rows)
        assert times[0] == float(T1955)
        assert np.isnan(times[1]) and np.isnan(times[2])
