import pytest

from geotagger import index
from geotagger.geometry import (distance_to_route, local_scale,
                                point_along_route, route_cumulative_lengths)
from geotagger.services import roadtrip_service

# A due-east route at the equator keeps the arithmetic checkable by hand:
# one degree of longitude there is ~111320 m, and latitude offsets convert at
# ~111132 m/degree.
ROUTE = [[0.0, 0.0], [0.0, 1.0]]
DEG_LNG_M = 111320.0
DEG_LAT_M = 111132.0


def _upsert(path, lat=None, lng=None, photo_datetime=1000, geotag_source="none"):
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng, geotag_source=geotag_source,
        sidecar_path=None, sidecar_mtime=None,
        camera=None, photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE filename=?", (path,)).fetchone()["id"]


def _run(points=ROUTE, radius_m=5000.0, **kw):
    return roadtrip_service.photos_along_route(points, radius_m, **kw)


class TestRouteGeometry:
    def test_cumulative_lengths_measure_the_route(self):
        scale = local_scale(ROUTE)
        cum = route_cumulative_lengths(ROUTE, scale)
        assert cum[0] == 0.0
        assert cum[-1] == pytest.approx(DEG_LNG_M, rel=1e-6)

    def test_distance_to_route_is_perpendicular_offset(self):
        scale = local_scale(ROUTE)
        cum = route_cumulative_lengths(ROUTE, scale)
        dist, s = distance_to_route(0.01, 0.5, ROUTE, cum, scale)
        assert dist == pytest.approx(0.01 * DEG_LAT_M, rel=1e-6)
        assert s == pytest.approx(DEG_LNG_M / 2, rel=1e-6)

    def test_distance_past_the_end_measures_to_the_endpoint(self):
        scale = local_scale(ROUTE)
        cum = route_cumulative_lengths(ROUTE, scale)
        dist, s = distance_to_route(0.0, 1.1, ROUTE, cum, scale)
        assert dist == pytest.approx(0.1 * DEG_LNG_M, rel=1e-6)
        assert s == pytest.approx(cum[-1], rel=1e-9)

    def test_point_along_route_interpolates_and_clamps(self):
        scale = local_scale(ROUTE)
        cum = route_cumulative_lengths(ROUTE, scale)
        lat, lng = point_along_route(cum[-1] / 4, ROUTE, cum)
        assert (lat, lng) == pytest.approx((0.0, 0.25))
        assert point_along_route(-100, ROUTE, cum) == pytest.approx((0.0, 0.0))
        assert point_along_route(1e9, ROUTE, cum) == pytest.approx((0.0, 1.0))


class TestCorridorSelection:
    def test_rejects_a_route_with_one_point(self, db):
        with pytest.raises(ValueError):
            _run(points=[[0.0, 0.0]])

    def test_rejects_a_non_positive_radius(self, db):
        with pytest.raises(ValueError):
            _run(radius_m=0)

    def test_only_photos_inside_the_corridor_come_back(self, db):
        _upsert("near.jpg", lat=0.01, lng=0.5, geotag_source="sidecar")   # ~1.1 km off
        _upsert("far.jpg", lat=0.5, lng=0.5, geotag_source="sidecar")     # ~55 km off
        result = _run(radius_m=5000.0)
        assert [p["filename"] for p in result["photos"]] == ["near.jpg"]

    def test_untagged_photos_are_not_counted_as_corridor_photos(self, db):
        _upsert("anchor.jpg", lat=0.0, lng=0.1, photo_datetime=1000, geotag_source="sidecar")
        _upsert("untagged.jpg", photo_datetime=1200)
        result = _run()
        assert [p["filename"] for p in result["photos"]] == ["anchor.jpg"]
        assert [c["filename"] for c in result["candidates"]] == ["untagged.jpg"]

    def test_timeframe_excludes_anchors_outside_it(self, db):
        _upsert("in.jpg", lat=0.0, lng=0.2, photo_datetime=1000, geotag_source="sidecar")
        _upsert("out.jpg", lat=0.0, lng=0.8, photo_datetime=999_000, geotag_source="sidecar")
        result = _run(from_ts=0, to_ts=5000)
        assert [p["filename"] for p in result["photos"]] == ["in.jpg"]
        assert result["anchor_count"] == 1

    def test_no_anchors_means_no_candidates(self, db):
        _upsert("untagged.jpg", photo_datetime=1200)
        result = _run()
        assert result["anchor_count"] == 0
        assert result["candidates"] == []


class TestSuggestRoute:
    def _suggest(self, start, end, **kw):
        return roadtrip_service.suggest_route(start, end, **kw)

    def test_two_photos_with_nothing_between_give_a_straight_line(self, db):
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        b = _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        out = self._suggest(a, b)
        assert out["points"] == [[0.0, 0.0], [0.0, 1.0]]
        assert (out["from_ts"], out["to_ts"]) == (1000, 9000)
        assert out["cluster_count"] == 0

    def test_endpoints_are_ordered_by_time_not_by_click_order(self, db):
        a = _upsert("early.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        b = _upsert("late.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        out = self._suggest(b, a)   # user right-clicked the end photo first
        assert out["start"]["filename"] == "early.jpg"
        assert out["points"][0] == [0.0, 0.0]

    def test_tagged_photos_in_between_bend_the_line_in_travel_order(self, db):
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        b = _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        # A detour north, visited midway through the drive.
        _upsert("stop.jpg", lat=0.5, lng=0.5, photo_datetime=5000, geotag_source="sidecar")
        out = self._suggest(a, b)
        assert out["cluster_count"] == 1
        assert out["points"][1] == pytest.approx([0.5, 0.5])
        assert len(out["points"]) == 3

    def test_photos_at_one_stop_collapse_into_a_single_waypoint(self, db):
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        b = _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        for i in range(5):
            _upsert(f"stop{i}.jpg", lat=0.5, lng=0.5 + i * 0.001,
                    photo_datetime=5000 + i, geotag_source="sidecar")
        out = self._suggest(a, b)
        assert out["cluster_count"] == 1
        assert out["clusters"][0]["count"] == 5

    def test_returning_to_a_stop_later_is_a_separate_waypoint(self, db):
        # Same place, twice, with somewhere else in between: the line has to go
        # there, away, and back, so time order (not position) drives clustering.
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        b = _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        _upsert("stop1.jpg", lat=0.5, lng=0.3, photo_datetime=3000, geotag_source="sidecar")
        _upsert("away.jpg", lat=0.5, lng=0.6, photo_datetime=4000, geotag_source="sidecar")
        _upsert("stop2.jpg", lat=0.5, lng=0.3, photo_datetime=5000, geotag_source="sidecar")
        out = self._suggest(a, b)
        assert out["cluster_count"] == 3

    def test_photos_outside_the_window_are_not_waypoints(self, db):
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        b = _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        _upsert("before.jpg", lat=5.0, lng=5.0, photo_datetime=500, geotag_source="sidecar")
        _upsert("after.jpg", lat=6.0, lng=6.0, photo_datetime=99_000, geotag_source="sidecar")
        out = self._suggest(a, b)
        assert out["points"] == [[0.0, 0.0], [0.0, 1.0]]

    def test_untagged_endpoint_is_rejected(self, db):
        a = _upsert("a.jpg", photo_datetime=1000)
        b = _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        with pytest.raises(ValueError, match="no location"):
            self._suggest(a, b)

    def test_undated_endpoint_is_rejected(self, db):
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=0, geotag_source="sidecar")
        b = _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=9000, geotag_source="sidecar")
        with pytest.raises(ValueError, match="no timestamp"):
            self._suggest(a, b)

    def test_unknown_photo_is_rejected(self, db):
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        with pytest.raises(ValueError, match="not found"):
            self._suggest(a, 999_999)

    def test_same_photo_both_ends_still_yields_a_usable_route(self, db):
        a = _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        out = self._suggest(a, a)
        assert len(out["points"]) == 2


class TestPrediction:
    def test_midpoint_in_time_lands_midway_along_the_route(self, db):
        _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=2000, geotag_source="sidecar")
        pid = _upsert("mid.jpg", photo_datetime=1500)

        result = _run()
        pred = next(c for c in result["candidates"] if c["id"] == pid)["predicted"]
        assert pred["method"] == "interpolated"
        assert pred["lng"] == pytest.approx(0.5, abs=1e-6)
        assert pred["lat"] == pytest.approx(0.0, abs=1e-9)
        # Uncertainty is half the leg the photo was interpolated across.
        assert pred["accuracy_m"] == pytest.approx(DEG_LNG_M / 2, rel=1e-3)
        assert pred["gap_sec"] == 1000

    def test_prediction_follows_the_road_not_the_straight_line(self, db):
        # A dog-leg: north for a degree, then east for a degree. A photo taken
        # halfway through the drive belongs at the corner, not on the diagonal.
        route = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]
        _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        _upsert("b.jpg", lat=1.0, lng=1.0, photo_datetime=3000, geotag_source="sidecar")
        pid = _upsert("mid.jpg", photo_datetime=2000)

        result = _run(points=route, radius_m=5000.0)
        pred = next(c for c in result["candidates"] if c["id"] == pid)["predicted"]
        assert pred["lat"] == pytest.approx(1.0, abs=0.01)
        assert pred["lng"] == pytest.approx(0.0, abs=0.01)

    def test_photo_after_the_last_anchor_is_extrapolated_along_the_route(self, db):
        _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        _upsert("b.jpg", lat=0.0, lng=0.5, photo_datetime=11_000, geotag_source="sidecar")
        pid = _upsert("after.jpg", photo_datetime=16_000)

        result = _run(edge_window=7200)
        pred = next(c for c in result["candidates"] if c["id"] == pid)["predicted"]
        assert pred["method"] == "extrapolated"
        # 0.5 degrees per 10000 s carried on for another 5000 s → 0.75 degrees.
        assert pred["lng"] == pytest.approx(0.75, abs=1e-3)
        assert pred["accuracy_m"] == pytest.approx(0.25 * DEG_LNG_M, rel=1e-2)

    def test_extrapolation_is_clamped_to_the_end_of_the_route(self, db):
        _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        _upsert("b.jpg", lat=0.0, lng=0.5, photo_datetime=2000, geotag_source="sidecar")
        pid = _upsert("way-after.jpg", photo_datetime=1000 + 100_000)

        result = _run(edge_window=200_000)
        pred = next(c for c in result["candidates"] if c["id"] == pid)["predicted"]
        assert pred["lng"] == pytest.approx(1.0, abs=1e-9)   # route end, not past it

    def test_untagged_photos_beyond_the_edge_window_are_ignored(self, db):
        _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=2000, geotag_source="sidecar")
        _upsert("late.jpg", photo_datetime=2000 + 7200)

        result = _run(edge_window=3600)
        assert result["candidates"] == []

    def test_confidence_degrades_with_the_size_of_the_gap(self, db):
        _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        _upsert("b.jpg", lat=0.0, lng=1.0, photo_datetime=101_000, geotag_source="sidecar")
        pid = _upsert("mid.jpg", photo_datetime=51_000)

        result = _run()
        pred = next(c for c in result["candidates"] if c["id"] == pid)["predicted"]
        assert pred["confidence"] == "low"

    def test_a_parked_car_stays_high_confidence_over_a_long_gap(self, db):
        # Two anchors 40 minutes apart but 100 m of road apart: nothing moved,
        # so the photos between them are placed tightly despite the time gap.
        route = [[0.0, 0.0], [0.0, 0.001]]
        _upsert("a.jpg", lat=0.0, lng=0.0, photo_datetime=1000, geotag_source="sidecar")
        _upsert("b.jpg", lat=0.0, lng=0.001, photo_datetime=2500, geotag_source="sidecar")
        pid = _upsert("mid.jpg", photo_datetime=1750)

        result = _run(points=route, radius_m=1000.0)
        pred = next(c for c in result["candidates"] if c["id"] == pid)["predicted"]
        assert pred["confidence"] == "high"
