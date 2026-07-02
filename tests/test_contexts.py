import pytest

from geotagger.contexts import point_in_polygon, polygon_bbox, polygon_centroid

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
