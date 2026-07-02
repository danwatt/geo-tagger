from datetime import datetime

from geotagger import index
from geotagger.geotag_groups import get_next_geotag_group


def _ts(y, m, d, h=12, mi=0, s=0):
    # Noon by default to steer clear of local DST-transition edge cases.
    return int(datetime(y, m, d, h, mi, s).timestamp())


def _upsert(path, photo_datetime, lat=None, lng=None, geotag_source="none"):
    index.upsert_photo(
        path=path, filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng, geotag_source=geotag_source,
        sidecar_path=None, sidecar_mtime=None,
        camera=None, photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute("SELECT id FROM photos WHERE path=?", (path,)).fetchone()["id"]


class TestNoGroupAvailable:
    def test_returns_none_when_db_empty(self, db):
        assert get_next_geotag_group(2020) is None

    def test_returns_none_when_all_photos_already_geotagged(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1), lat=1.0, lng=2.0, geotag_source="sidecar")
        assert get_next_geotag_group(2020) is None

    def test_returns_none_when_ungeotagged_photos_predate_start_year(self, db):
        _upsert("a.jpg", _ts(2019, 6, 1))
        assert get_next_geotag_group(2020) is None

    def test_geocode_ignored_photos_are_not_grouped(self, db):
        pid = _upsert("a.jpg", _ts(2021, 6, 1))
        index.set_geocode_ignored([pid], True)
        assert get_next_geotag_group(2020) is None


class TestGrouping:
    def test_single_photo_forms_a_group(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1))
        result = get_next_geotag_group(2020)
        assert [p["filename"] for p in result["to_tag"]] == ["a.jpg"]

    def test_photos_within_window_are_grouped_together(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1, 8))
        _upsert("b.jpg", _ts(2021, 6, 1, 20))  # 12h later, within the 1-day window
        result = get_next_geotag_group(2020)
        assert [p["filename"] for p in result["to_tag"]] == ["a.jpg", "b.jpg"]

    def test_group_stops_at_first_gap_beyond_window(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1, 8))
        _upsert("b.jpg", _ts(2021, 6, 1, 20))
        _upsert("c.jpg", _ts(2021, 6, 10, 8))  # far outside the window
        result = get_next_geotag_group(2020, group_window_days=1)
        assert [p["filename"] for p in result["to_tag"]] == ["a.jpg", "b.jpg"]

    def test_group_chains_through_consecutive_small_gaps(self, db):
        # Each hop is 20h (< the 24h window), but the whole chain spans 60h --
        # the window check only ever compares to the *previous* photo added to
        # the group, not the group's first photo, so it keeps growing.
        _upsert("a.jpg", _ts(2021, 6, 1, 0))
        _upsert("b.jpg", _ts(2021, 6, 1, 20))
        _upsert("c.jpg", _ts(2021, 6, 2, 16))
        _upsert("d.jpg", _ts(2021, 6, 3, 12))
        result = get_next_geotag_group(2020, group_window_days=1)
        assert [p["filename"] for p in result["to_tag"]] == ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]

    def test_narrow_window_keeps_two_day_gap_split(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1, 0))
        _upsert("b.jpg", _ts(2021, 6, 3, 0))  # 2 days later
        result = get_next_geotag_group(2020, group_window_days=1)
        assert [p["filename"] for p in result["to_tag"]] == ["a.jpg"]

    def test_wide_window_merges_two_day_gap(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1, 0))
        _upsert("b.jpg", _ts(2021, 6, 3, 0))  # 2 days later
        result = get_next_geotag_group(2020, group_window_days=3)
        assert [p["filename"] for p in result["to_tag"]] == ["a.jpg", "b.jpg"]


class TestPagination:
    def test_after_ts_skips_to_the_next_group(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1, 8))
        _upsert("b.jpg", _ts(2021, 6, 1, 20))
        _upsert("c.jpg", _ts(2021, 6, 20, 8))

        first = get_next_geotag_group(2020, group_window_days=1)
        assert [p["filename"] for p in first["to_tag"]] == ["a.jpg", "b.jpg"]

        last_ts = first["to_tag"][-1]["photo_datetime"]
        second = get_next_geotag_group(2020, after_ts=last_ts, group_window_days=1)
        assert [p["filename"] for p in second["to_tag"]] == ["c.jpg"]

    def test_after_ts_past_the_last_photo_returns_none(self, db):
        _upsert("a.jpg", _ts(2021, 6, 1, 8))
        result = get_next_geotag_group(2020, after_ts=_ts(2021, 6, 2))
        assert result is None


class TestContextPhotos:
    def test_before_and_after_pick_up_nearby_geotagged_photos(self, db):
        _upsert("before.jpg", _ts(2021, 5, 31, 12), lat=1.0, lng=1.0, geotag_source="sidecar")
        _upsert("a.jpg", _ts(2021, 6, 1, 8))
        _upsert("after.jpg", _ts(2021, 6, 2, 4), lat=2.0, lng=2.0, geotag_source="sidecar")

        result = get_next_geotag_group(2020, context_window_days=1)
        assert [p["filename"] for p in result["before"]] == ["before.jpg"]
        assert [p["filename"] for p in result["after"]] == ["after.jpg"]

    def test_context_photos_outside_window_are_excluded(self, db):
        _upsert("far_before.jpg", _ts(2021, 5, 20, 12), lat=1.0, lng=1.0, geotag_source="sidecar")
        _upsert("a.jpg", _ts(2021, 6, 1, 8))
        _upsert("far_after.jpg", _ts(2021, 6, 15, 12), lat=2.0, lng=2.0, geotag_source="sidecar")

        result = get_next_geotag_group(2020, context_window_days=1)
        assert result["before"] == []
        assert result["after"] == []

    def test_before_and_after_exclude_ungeotagged_photos(self, db):
        # group_window_days=0 keeps "decoy" as its own isolated to_tag group
        # (the next ungeotagged candidate, 24h later, misses a zero window).
        _upsert("decoy.jpg", _ts(2021, 5, 31, 12))
        _upsert("ungeotagged_after.jpg", _ts(2021, 6, 1, 12))  # in range, no GPS
        _upsert("real_after.jpg", _ts(2021, 6, 2, 6), lat=5.0, lng=5.0, geotag_source="sidecar")

        result = get_next_geotag_group(2020, group_window_days=0, context_window_days=2)
        assert [p["filename"] for p in result["to_tag"]] == ["decoy.jpg"]
        after_names = [p["filename"] for p in result["after"]]
        assert "ungeotagged_after.jpg" not in after_names
        assert "real_after.jpg" in after_names
