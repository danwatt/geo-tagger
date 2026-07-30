import asyncio

import pytest
from fastapi import HTTPException

from geotagger import index
from geotagger.api import geotag


def _upsert(path, lat=None, lng=None, photo_datetime=1000, geotag_source="none"):
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng, geotag_source=geotag_source,
        sidecar_path=None, sidecar_mtime=None,
        camera=None, photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()["id"]


def _guess(photo_id, window=900):
    return asyncio.run(geotag.api_guess(photo_id, window))


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

    def test_no_neighbors_404s(self, db):
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
