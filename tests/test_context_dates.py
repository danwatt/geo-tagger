"""Unit tests for the pure date/longitude helpers on geotagger.contexts
(moved there from main.py in the refactor)."""

import pytest

from geotagger import contexts


class TestDateToTs:
    def test_start_is_midnight_utc(self):
        # 2020-01-01 00:00:00 UTC
        assert contexts.date_to_ts_start("2020-01-01") == 1_577_836_800

    def test_end_is_start_plus_one_day(self):
        d = "2020-01-01"
        assert contexts.date_to_ts_end(d) == contexts.date_to_ts_start(d) + 86400

    def test_pre_1970_date_does_not_raise(self):
        # The whole reason for calendar.timegm over datetime.timestamp() on Windows.
        ts = contexts.date_to_ts_start("1969-07-20")
        assert ts < 0
        assert contexts.ts_to_date(ts) == "1969-07-20"

    def test_invalid_format_raises_valueerror(self):
        with pytest.raises(ValueError):
            contexts.date_to_ts_start("01/02/2020")


class TestTsToDate:
    def test_none_passthrough(self):
        assert contexts.ts_to_date(None) is None

    def test_round_trips_with_date_to_ts_start(self):
        for d in ("1955-11-05", "1970-01-01", "2000-02-29", "2024-12-31"):
            assert contexts.ts_to_date(contexts.date_to_ts_start(d)) == d


class TestNormalizeLng:
    def test_in_range_unchanged(self):
        assert contexts.normalize_lng(0.0) == 0.0
        assert contexts.normalize_lng(179.5) == pytest.approx(179.5)
        assert contexts.normalize_lng(-179.5) == pytest.approx(-179.5)

    def test_both_poles_of_antimeridian_map_to_positive_180(self):
        # Python's % yields a non-negative result, so -180 folds to +180 (same meridian).
        assert contexts.normalize_lng(180.0) == pytest.approx(180.0)
        assert contexts.normalize_lng(-180.0) == pytest.approx(180.0)

    def test_wraps_past_antimeridian(self):
        assert contexts.normalize_lng(190.0) == pytest.approx(-170.0)
        assert contexts.normalize_lng(-190.0) == pytest.approx(170.0)

    def test_wraps_multiple_turns(self):
        assert contexts.normalize_lng(360.0 + 45.0) == pytest.approx(45.0)
        assert contexts.normalize_lng(-(360.0 + 45.0)) == pytest.approx(-45.0)
