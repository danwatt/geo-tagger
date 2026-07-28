"""Hotspot clustering (the location palette) and the selection proposer."""

import pytest

from geotagger import index
from geotagger.services import geotag_service, hotspots_service


def _upsert(path, lat=None, lng=None, photo_datetime=1000, geotag_source="none"):
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng, geotag_source=geotag_source,
        sidecar_path=None, sidecar_mtime=None,
        camera=None, photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE filename=?", (path,)
    ).fetchone()["id"]


@pytest.fixture(autouse=True)
def _clear_hotspot_cache():
    hotspots_service.invalidate()
    yield
    hotspots_service.invalidate()


# One degree of latitude is ~111 km, so these are convenient metre-scale offsets.
def _lat_offset(meters):
    return meters / 111_320.0


class TestClustering:
    def test_drops_a_few_hundred_feet_apart_become_one_hotspot(self, db):
        # ~50 m and ~150 m north of the anchor — the "slight variation" case.
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("b.jpg", lat=40.0 + _lat_offset(50), lng=-75.0, geotag_source="sidecar")
        _upsert("c.jpg", lat=40.0 + _lat_offset(150), lng=-75.0, geotag_source="sidecar")

        result = hotspots_service.get_hotspots()
        assert len(result["hotspots"]) == 1
        assert result["hotspots"][0]["count"] == 3

    def test_places_beyond_the_merge_radius_stay_separate(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("b.jpg", lat=40.0 + _lat_offset(2000), lng=-75.0, geotag_source="sidecar")

        result = hotspots_service.get_hotspots()
        assert len(result["hotspots"]) == 2

    def test_ranked_by_photo_count(self, db):
        for i in range(5):
            _upsert(f"busy{i}.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("quiet.jpg", lat=41.0, lng=-75.0, geotag_source="sidecar")

        hotspots = hotspots_service.get_hotspots()["hotspots"]
        assert [h["count"] for h in hotspots] == [5, 1]

    def test_sort_recent_orders_by_last_photo(self, db):
        for i in range(5):
            _upsert(f"busy{i}.jpg", lat=40.0, lng=-75.0, photo_datetime=1000,
                    geotag_source="sidecar")
        _upsert("fresh.jpg", lat=41.0, lng=-75.0, photo_datetime=9000,
                geotag_source="sidecar")

        by_recent = hotspots_service.get_hotspots(sort="recent")["hotspots"]
        assert by_recent[0]["last_ts"] == 9000
        assert by_recent[0]["count"] == 1

    def test_centroid_anchors_on_the_busiest_cell(self, db):
        # 10 photos at the anchor, 1 photo ~200 m away: the centroid should stay
        # essentially on the anchor rather than splitting the difference.
        for i in range(10):
            _upsert(f"a{i}.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("outlier.jpg", lat=40.0 + _lat_offset(200), lng=-75.0,
                geotag_source="sidecar")

        hotspot = hotspots_service.get_hotspots()["hotspots"][0]
        assert hotspot["count"] == 11
        assert hotspot["lat"] == pytest.approx(40.0, abs=_lat_offset(30))

    def test_ungeotagged_photos_are_ignored(self, db):
        _upsert("untagged.jpg")
        assert hotspots_service.get_hotspots()["hotspots"] == []

    def test_label_falls_back_to_coordinates(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        label = hotspots_service.get_hotspots()["hotspots"][0]["label"]
        # No GeoNames/OSM data in the test env, so the raw coordinate is the label.
        assert "40.0" in label


class TestSortNear:
    def test_ranked_by_distance_from_the_given_point(self, db):
        # Busiest place is the furthest away, so a distance ranking has to
        # override the default count ranking to pass.
        for i in range(10):
            _upsert(f"far{i}.jpg", lat=45.0, lng=-75.0, geotag_source="sidecar")
        _upsert("mid.jpg", lat=41.0, lng=-75.0, geotag_source="sidecar")
        _upsert("close.jpg", lat=40.01, lng=-75.0, geotag_source="sidecar")

        hotspots = hotspots_service.get_hotspots(sort="near", lat=40.0, lng=-75.0)["hotspots"]
        assert [round(h["lat"], 2) for h in hotspots] == [40.01, 41.0, 45.0]

    def test_reports_the_distance_it_sorted_on(self, db):
        _upsert("a.jpg", lat=40.0 + _lat_offset(1000), lng=-75.0, geotag_source="sidecar")
        h = hotspots_service.get_hotspots(sort="near", lat=40.0, lng=-75.0)["hotspots"][0]
        assert h["meters"] == pytest.approx(1000, rel=0.02)

    def test_missing_coordinates_is_an_error(self, db):
        with pytest.raises(ValueError):
            hotspots_service.get_hotspots(sort="near")

    def test_other_sorts_omit_the_distance(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        assert "meters" not in hotspots_service.get_hotspots()["hotspots"][0]


DAY = 86400


class TestSortTime:
    def test_ranked_by_use_inside_the_window(self, db):
        # 10 photos at the all-time favourite, but none of them in the window.
        for i in range(10):
            _upsert(f"fav{i}.jpg", lat=45.0, lng=-75.0, photo_datetime=1000,
                    geotag_source="sidecar")
        # 2 photos at another place, inside the window.
        for i in range(2):
            _upsert(f"trip{i}.jpg", lat=41.0, lng=-75.0, photo_datetime=500_000 + i,
                    geotag_source="sidecar")

        result = hotspots_service.get_hotspots(sort="time", from_ts=400_000, to_ts=600_000)
        assert len(result["hotspots"]) == 1
        assert result["hotspots"][0]["lat"] == pytest.approx(41.0)
        assert result["hotspots"][0]["window_count"] == 2
        # The all-time count still rides along, it just isn't what ranked it.
        assert result["hotspots"][0]["count"] == 2

    def test_neighbouring_months_are_reachable_by_widening_the_window(self, db):
        june = 1_717_200_000        # mid-2024, exact value irrelevant
        _upsert("may.jpg", lat=41.0, lng=-75.0, photo_datetime=june - 20 * DAY,
                geotag_source="sidecar")
        _upsert("july.jpg", lat=42.0, lng=-75.0, photo_datetime=june + 20 * DAY,
                geotag_source="sidecar")

        tight = hotspots_service.get_hotspots(sort="time", from_ts=june - DAY, to_ts=june + DAY)
        assert tight["hotspots"] == []

        wide = hotspots_service.get_hotspots(sort="time",
                                             from_ts=june - 31 * DAY, to_ts=june + 31 * DAY)
        assert len(wide["hotspots"]) == 2

    def test_jittered_drops_in_the_window_fold_into_one_entry(self, db):
        for i in range(4):
            _upsert(f"a{i}.jpg", lat=40.0 + _lat_offset(60 * i), lng=-75.0,
                    photo_datetime=500_000 + i, geotag_source="sidecar")

        result = hotspots_service.get_hotspots(sort="time", from_ts=400_000, to_ts=600_000)
        assert len(result["hotspots"]) == 1
        assert result["hotspots"][0]["window_count"] == 4

    def test_empty_window_returns_nothing_rather_than_favourites(self, db):
        for i in range(10):
            _upsert(f"fav{i}.jpg", lat=45.0, lng=-75.0, photo_datetime=1000,
                    geotag_source="sidecar")
        assert hotspots_service.get_hotspots(sort="time",
                                             from_ts=900_000, to_ts=999_999)["hotspots"] == []

    def test_missing_window_is_an_error(self, db):
        with pytest.raises(ValueError):
            hotspots_service.get_hotspots(sort="time")


class TestHotspotCache:
    def test_new_geotag_invalidates_the_cache(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        assert hotspots_service.get_hotspots()["hotspots"][0]["count"] == 1

        _upsert("b.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        assert hotspots_service.get_hotspots()["hotspots"][0]["count"] == 2


class TestProposeLocations:
    def test_proposes_the_location_of_the_nearest_time_neighbor(self, db):
        _upsert("n1.jpg", lat=40.0, lng=-75.0, photo_datetime=1000,
                geotag_source="sidecar")
        target = _upsert("t.jpg", photo_datetime=1100)

        result = geotag_service.propose_locations([target])
        assert result["selected"] == 1
        assert result["voted"] == 1
        assert result["candidates"][0]["lat"] == pytest.approx(40.0)
        assert result["candidates"][0]["votes"] == 1

    def test_two_places_stay_separate_instead_of_averaging(self, db):
        # The failure mode of a single averaged guess: two neighbours 2 degrees
        # apart would propose the empty midpoint at lat 41.
        _upsert("west.jpg", lat=40.0, lng=-75.0, photo_datetime=1000,
                geotag_source="sidecar")
        _upsert("east.jpg", lat=42.0, lng=-75.0, photo_datetime=5000,
                geotag_source="sidecar")
        t1 = _upsert("t1.jpg", photo_datetime=1100)
        t2 = _upsert("t2.jpg", photo_datetime=5100)

        result = geotag_service.propose_locations([t1, t2])
        lats = sorted(c["lat"] for c in result["candidates"])
        assert len(result["candidates"]) == 2
        assert lats[0] == pytest.approx(40.0)
        assert lats[1] == pytest.approx(42.0)

    def test_majority_candidate_ranks_first(self, db):
        for i in range(4):
            _upsert(f"home{i}.jpg", lat=40.0, lng=-75.0, photo_datetime=1000 + i,
                    geotag_source="sidecar")
        _upsert("away.jpg", lat=42.0, lng=-75.0, photo_datetime=5000,
                geotag_source="sidecar")
        targets = [_upsert(f"t{i}.jpg", photo_datetime=1010 + i) for i in range(4)]
        targets.append(_upsert("t_away.jpg", photo_datetime=5010))

        result = geotag_service.propose_locations(targets)
        assert result["selected"] == 5
        assert result["voted"] == 5
        assert result["candidates"][0]["lat"] == pytest.approx(40.0)
        assert result["candidates"][0]["votes"] == 4

    def test_neighbors_outside_the_window_do_not_vote(self, db):
        _upsert("far.jpg", lat=40.0, lng=-75.0, photo_datetime=1000,
                geotag_source="sidecar")
        target = _upsert("t.jpg", photo_datetime=1000 + 7200)

        result = geotag_service.propose_locations([target], window=3600)
        assert result["voted"] == 0
        assert result["candidates"] == []

    def test_already_geotagged_photos_are_not_proposable(self, db):
        _upsert("n1.jpg", lat=40.0, lng=-75.0, photo_datetime=1000,
                geotag_source="sidecar")
        tagged = _upsert("t.jpg", lat=1.0, lng=2.0, photo_datetime=1100,
                         geotag_source="sidecar")

        result = geotag_service.propose_locations([tagged])
        assert result["selected"] == 0
        assert result["candidates"] == []

    def test_undated_photos_are_not_proposable(self, db):
        _upsert("n1.jpg", lat=40.0, lng=-75.0, photo_datetime=1000,
                geotag_source="sidecar")
        target = _upsert("t.jpg", photo_datetime=0)

        assert geotag_service.propose_locations([target])["selected"] == 0

    def test_empty_selection(self, db):
        result = geotag_service.propose_locations([])
        assert result == {"candidates": [], "selected": 0, "voted": 0,
                          "window_sec": geotag_service.DEFAULT_PROPOSE_WINDOW}
