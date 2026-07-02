import json

from geotagger import index


def _upsert(db, path="p1.jpg", mtime=1000.0, sidecar_path=None, sidecar_mtime=None,
            camera="Canon EOS", photo_datetime=123, gps_accuracy=5.0, orientation=1):
    index.upsert_photo(
        path=path, filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=mtime, size=100, lat=None, lng=None, geotag_source="none",
        sidecar_path=sidecar_path, sidecar_mtime=sidecar_mtime,
        camera=camera, photo_datetime=photo_datetime,
        gps_accuracy=gps_accuracy, orientation=orientation,
    )


class TestIsFresh:
    def test_missing_row_is_not_fresh(self, db):
        assert index.is_fresh("missing.jpg", 1000.0, None, None) is False

    def test_unchanged_row_is_fresh(self, db):
        _upsert(db, mtime=1000.0, sidecar_path="p1.xmp", sidecar_mtime=500.0)
        assert index.is_fresh("p1.jpg", 1000.0, "p1.xmp", 500.0) is True

    def test_mtime_drift_within_one_second_is_still_fresh(self, db):
        _upsert(db, mtime=1000.0, sidecar_path=None, sidecar_mtime=None)
        assert index.is_fresh("p1.jpg", 1000.4, None, None) is True

    def test_mtime_changed_is_stale(self, db):
        _upsert(db, mtime=1000.0, sidecar_path=None, sidecar_mtime=None)
        assert index.is_fresh("p1.jpg", 1005.0, None, None) is False

    def test_sidecar_added_is_stale(self, db):
        _upsert(db, mtime=1000.0, sidecar_path=None, sidecar_mtime=None)
        assert index.is_fresh("p1.jpg", 1000.0, "p1.xmp", 500.0) is False

    def test_sidecar_mtime_changed_is_stale(self, db):
        _upsert(db, mtime=1000.0, sidecar_path="p1.xmp", sidecar_mtime=500.0)
        assert index.is_fresh("p1.jpg", 1000.0, "p1.xmp", 600.0) is False

    def test_partially_indexed_row_is_stale(self, db):
        # camera=None simulates a row inserted by the fast scan pass before the
        # full-metadata read has happened.
        _upsert(db, camera=None)
        assert index.is_fresh("p1.jpg", 1000.0, None, None) is False


class TestContextsForTime:
    def _make(self, db, name, start_ts, end_ts):
        return index.create_context(
            name, json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            start_ts, end_ts, 0, 1, 0, 1,
        )

    def test_open_ended_context_matches_any_time(self, db):
        self._make(db, "always", None, None)
        rows = index.contexts_for_time(9999999)
        assert len(rows) == 1

    def test_closed_range_matches_inside(self, db):
        self._make(db, "range", 100, 200)
        assert len(index.contexts_for_time(150)) == 1

    def test_closed_range_excludes_before_and_after(self, db):
        self._make(db, "range", 100, 200)
        assert index.contexts_for_time(50) == []
        assert index.contexts_for_time(250) == []

    def test_open_start_matches_up_to_end(self, db):
        self._make(db, "until-200", None, 200)
        assert len(index.contexts_for_time(-500)) == 1
        assert index.contexts_for_time(201) == []

    def test_open_end_matches_from_start_onward(self, db):
        self._make(db, "from-100", 100, None)
        assert len(index.contexts_for_time(100)) == 1
        assert len(index.contexts_for_time(1_000_000)) == 1
        assert index.contexts_for_time(99) == []

    def test_only_matching_contexts_returned(self, db):
        self._make(db, "early", 0, 100)
        self._make(db, "late", 200, 300)
        rows = index.contexts_for_time(50)
        assert [r["name"] for r in rows] == ["early"]


class TestContextsForPointTime:
    def test_point_inside_polygon_and_time_matches(self, db):
        index.create_context(
            "square", json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            None, None, 0, 1, 0, 1,
        )
        rows = index.contexts_for_point_time(0.5, 0.5, 123)
        assert len(rows) == 1

    def test_point_outside_bbox_excluded(self, db):
        index.create_context(
            "square", json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            None, None, 0, 1, 0, 1,
        )
        assert index.contexts_for_point_time(5, 5, 123) == []

    def test_time_outside_range_excludes_even_if_point_matches(self, db):
        index.create_context(
            "square", json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            100, 200, 0, 1, 0, 1,
        )
        assert index.contexts_for_point_time(0.5, 0.5, 999) == []
