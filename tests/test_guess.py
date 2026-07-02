import asyncio
import json

import pytest
from fastapi import HTTPException

from geotagger import index, main


def _upsert(path, lat=None, lng=None, photo_datetime=1000, geotag_source="none"):
    index.upsert_photo(
        path=path, filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng, geotag_source=geotag_source,
        sidecar_path=None, sidecar_mtime=None,
        camera=None, photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute("SELECT id FROM photos WHERE path=?", (path,)).fetchone()["id"]


def _guess(photo_id, window=900):
    return asyncio.run(main.api_guess(photo_id, window))


class TestApiGuessErrors:
    def test_unknown_photo_404s(self, db):
        with pytest.raises(HTTPException) as exc:
            _guess(999)
        assert exc.value.status_code == 404

    def test_already_geotagged_photo_400s(self, db):
        pid = _upsert("a.jpg", lat=1.0, lng=2.0, geotag_source="sidecar")
        with pytest.raises(HTTPException) as exc:
            _guess(pid)
        assert exc.value.status_code == 400

    def test_no_timestamp_400s(self, db):
        pid = _upsert("a.jpg", photo_datetime=0)
        with pytest.raises(HTTPException) as exc:
            _guess(pid)
        assert exc.value.status_code == 400

    def test_no_neighbors_no_context_404s(self, db):
        pid = _upsert("a.jpg", photo_datetime=1000)
        with pytest.raises(HTTPException) as exc:
            _guess(pid)
        assert exc.value.status_code == 404


class TestTimeNeighborWeighting:
    def test_single_neighbor_returned_as_is(self, db):
        target = _upsert("target.jpg", photo_datetime=1000)
        _upsert("n1.jpg", lat=10.0, lng=20.0, photo_datetime=1100, geotag_source="sidecar")
        result = _guess(target)
        assert result["source"] == "time-neighbors"
        assert result["lat"] == pytest.approx(10.0)
        assert result["lng"] == pytest.approx(20.0)
        assert result["source_count"] == 1

    def test_closer_neighbor_weighted_more_heavily(self, db):
        target = _upsert("target.jpg", photo_datetime=1000)
        # 10s away vs 500s away — inverse-distance weighting should pull the
        # average much closer to the near neighbor than a plain mean would.
        _upsert("near.jpg", lat=0.0, lng=0.0, photo_datetime=1010, geotag_source="sidecar")
        _upsert("far.jpg", lat=100.0, lng=0.0, photo_datetime=1500, geotag_source="sidecar")
        result = _guess(target, window=900)

        w_near = 1.0 / (abs(1010 - 1000) + 1)
        w_far = 1.0 / (abs(1500 - 1000) + 1)
        expected_lat = (0.0 * w_near + 100.0 * w_far) / (w_near + w_far)

        assert result["lat"] == pytest.approx(expected_lat)
        plain_mean = 50.0
        assert abs(result["lat"] - expected_lat) < abs(result["lat"] - plain_mean)

    def test_neighbors_outside_window_are_excluded(self, db):
        target = _upsert("target.jpg", photo_datetime=1000)
        _upsert("far.jpg", lat=5.0, lng=5.0, photo_datetime=5000, geotag_source="sidecar")
        with pytest.raises(HTTPException) as exc:
            _guess(target, window=900)
        assert exc.value.status_code == 404


class TestContextFallback:
    def _make_square_context(self, db, name="ctx", start_ts=None, end_ts=None):
        polygon = [[0, 0], [0, 1], [1, 1], [1, 0]]
        return index.create_context(
            name, json.dumps(polygon), start_ts, end_ts, 0, 1, 0, 1,
        )

    def test_centroid_fallback_when_no_time_neighbors(self, db):
        self._make_square_context(db)
        target = _upsert("target.jpg", photo_datetime=1000)
        result = _guess(target)
        assert result["source"] == "context-centroid"
        assert result["lat"] == pytest.approx(0.5)
        assert result["lng"] == pytest.approx(0.5)
        assert result["source_count"] == 0
        assert len(result["contexts"]) == 1

    def test_no_matching_context_and_no_neighbors_still_404s(self, db):
        # Context exists but its time range doesn't cover the target photo.
        self._make_square_context(db, start_ts=5000, end_ts=6000)
        target = _upsert("target.jpg", photo_datetime=1000)
        with pytest.raises(HTTPException) as exc:
            _guess(target)
        assert exc.value.status_code == 404

    def test_neighbors_outside_context_polygon_still_used_when_no_in_context_neighbor(self, db):
        # A context matches by time but none of the time-neighbors fall inside
        # its polygon -> falls back to using the unfiltered neighbor list
        # (not the centroid), per the `if in_ctx: nearby = in_ctx` guard.
        self._make_square_context(db)
        target = _upsert("target.jpg", photo_datetime=1000)
        _upsert("outside.jpg", lat=50.0, lng=50.0, photo_datetime=1010, geotag_source="sidecar")
        result = _guess(target)
        assert result["source"] == "time-neighbors"
        assert result["lat"] == pytest.approx(50.0)
        assert result["lng"] == pytest.approx(50.0)

    def test_neighbors_inside_context_polygon_are_preferred(self, db):
        # One neighbor inside the polygon, one outside — only the in-polygon
        # one should be averaged in.
        self._make_square_context(db)
        target = _upsert("target.jpg", photo_datetime=1000)
        _upsert("inside.jpg", lat=0.5, lng=0.5, photo_datetime=1010, geotag_source="sidecar")
        _upsert("outside.jpg", lat=50.0, lng=50.0, photo_datetime=1020, geotag_source="sidecar")
        result = _guess(target)
        assert result["source"] == "time-neighbors"
        assert result["source_count"] == 1
        assert result["lat"] == pytest.approx(0.5)
        assert result["lng"] == pytest.approx(0.5)

    def test_smallest_context_chosen_for_centroid_when_multiple_match(self, db):
        # Bigger context: 0..10, centroid (5,5). Smaller: 0..1, centroid (0.5,0.5).
        # The smaller (more specific) one should win the centroid fallback.
        index.create_context("big", json.dumps([[0, 0], [0, 10], [10, 10], [10, 0]]),
                              None, None, 0, 10, 0, 10)
        index.create_context("small", json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
                              None, None, 0, 1, 0, 1)
        target = _upsert("target.jpg", photo_datetime=1000)
        result = _guess(target)
        assert result["source"] == "context-centroid"
        assert result["lat"] == pytest.approx(0.5)
        assert result["lng"] == pytest.approx(0.5)
