import pytest

from geotagger.geometry import (point_in_polygon, polygon_bbox, polygon_centroid,
                                normalize_lng_bbox)

# A simple 1x1 degree square: lat 0..1, lng 0..1
SQUARE = [[0, 0], [0, 1], [1, 1], [1, 0]]


class TestPointInPolygon:
    def test_point_inside(self):
        assert point_in_polygon(0.5, 0.5, SQUARE) is True

    def test_point_outside(self):
        assert point_in_polygon(2, 2, SQUARE) is False

    def test_point_outside_but_within_bbox_of_concave_shape(self):
        # C-shape (concave): a point in the bbox but inside the "bite" is outside.
        c_shape = [[0, 0], [0, 3], [3, 3], [3, 2], [1, 2], [1, 1], [3, 1], [3, 0]]
        assert point_in_polygon(1.5, 1.5, c_shape) is False
        assert point_in_polygon(0.5, 1.5, c_shape) is True

    def test_point_far_outside_bbox(self):
        assert point_in_polygon(-10, -10, SQUARE) is False

    def test_degenerate_empty_polygon(self):
        assert point_in_polygon(0, 0, []) is False


class TestPolygonBbox:
    def test_square(self):
        assert polygon_bbox(SQUARE) == (0, 1, 0, 1)

    def test_single_vertex(self):
        assert polygon_bbox([[5, 10]]) == (5, 5, 10, 10)

    def test_negative_and_mixed_coords(self):
        verts = [[-10, 20], [5, -3], [0, 0]]
        assert polygon_bbox(verts) == (-10, 5, -3, 20)


class TestPolygonCentroid:
    def test_square_centroid(self):
        lat, lng = polygon_centroid(SQUARE)
        assert lat == pytest.approx(0.5)
        assert lng == pytest.approx(0.5)


class TestNormalizeLngBbox:
    def test_already_in_range_is_unchanged(self):
        assert normalize_lng_bbox(-97.5, -96.0) == pytest.approx((-97.5, -96.0))

    def test_unwraps_a_bbox_panned_once_around_the_globe(self):
        # Reported bug: Leaflet's getBounds() after panning past +/-180 returns
        # raw longitudes like these for a Fort Worth, TX viewport.
        min_lng, max_lng = normalize_lng_bbox(-458.4223937988281, -456.0946655273438)
        assert min_lng == pytest.approx(-98.4223937988281)
        assert max_lng == pytest.approx(-96.0946655273438)

    def test_unwraps_a_bbox_panned_the_other_direction(self):
        min_lng, max_lng = normalize_lng_bbox(456.0, 458.0)
        assert min_lng == pytest.approx(96.0)
        assert max_lng == pytest.approx(98.0)

    def test_preserves_width(self):
        min_lng, max_lng = normalize_lng_bbox(-458.4223937988281, -456.0946655273438)
        assert (max_lng - min_lng) == pytest.approx(-456.0946655273438 - -458.4223937988281)

    def test_bbox_spanning_the_antimeridian_is_left_alone(self):
        # A legitimate small bbox straddling +/-180 (min > max): center is
        # already normalized, so no shift is applied.
        assert normalize_lng_bbox(170.0, -170.0) == pytest.approx((170.0, -170.0))

    def test_triangle_centroid(self):
        triangle = [[0, 0], [0, 3], [3, 0]]
        lat, lng = polygon_centroid(triangle)
        assert lat == pytest.approx(1.0)
        assert lng == pytest.approx(1.0)

    def test_empty_polygon_returns_origin(self):
        assert polygon_centroid([]) == (0.0, 0.0)

    def test_degenerate_zero_area_falls_back_to_vertex_mean(self):
        # Three collinear points -> zero shoelace area -> mean-of-vertices fallback.
        line = [[0, 0], [1, 1], [2, 2]]
        lat, lng = polygon_centroid(line)
        assert lat == pytest.approx(1.0)
        assert lng == pytest.approx(1.0)
