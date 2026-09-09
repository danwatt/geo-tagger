"""Hotspot clustering (the location palette) and the selection proposer."""

import json

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
    def test_drops_within_the_merge_radius_become_one_hotspot(self, db):
        # ~40 m and ~80 m north of the anchor — the "aimed by hand twice" case.
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("b.jpg", lat=40.0 + _lat_offset(40), lng=-75.0, geotag_source="sidecar")
        _upsert("c.jpg", lat=40.0 + _lat_offset(80), lng=-75.0, geotag_source="sidecar")

        result = hotspots_service.get_hotspots()
        assert len(result["hotspots"]) == 1
        assert result["hotspots"][0]["count"] == 3

    def test_places_beyond_the_merge_radius_stay_separate(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("b.jpg", lat=40.0 + _lat_offset(2000), lng=-75.0, geotag_source="sidecar")

        result = hotspots_service.get_hotspots()
        assert len(result["hotspots"]) == 2

    def test_a_block_away_is_a_different_hotspot(self, db):
        # 250 m apart: one hotspot under the old 300 m radius, two under the
        # current 100 m one. A hotspot is a place you can point at, not a block.
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("b.jpg", lat=40.0 + _lat_offset(250), lng=-75.0, geotag_source="sidecar")

        assert len(hotspots_service.get_hotspots()["hotspots"]) == 2

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
        # 10 photos at the anchor, 1 photo ~60 m away (inside the merge radius):
        # the centroid should stay essentially on the anchor rather than
        # splitting the difference.
        for i in range(10):
            _upsert(f"a{i}.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("outlier.jpg", lat=40.0 + _lat_offset(60), lng=-75.0,
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
            _upsert(f"a{i}.jpg", lat=40.0 + _lat_offset(30 * i), lng=-75.0,
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


class TestPaging:
    """`offset` walks the ranked list a page at a time — the Custom Places
    page's "Load more", for a library with more hotspots than one slice."""

    def _ranked(self):
        # Three clusters, distinct counts, so "count" order is unambiguous.
        for i in range(5):
            _upsert(f"a{i}.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        for i in range(3):
            _upsert(f"b{i}.jpg", lat=45.0, lng=-75.0, geotag_source="sidecar")
        _upsert("c0.jpg", lat=50.0, lng=-75.0, geotag_source="sidecar")

    def test_pages_do_not_overlap_or_skip(self, db):
        self._ranked()
        page1 = hotspots_service.get_hotspots(limit=2, offset=0)["hotspots"]
        page2 = hotspots_service.get_hotspots(limit=2, offset=2)["hotspots"]
        assert [h["count"] for h in page1] == [5, 3]
        assert [h["count"] for h in page2] == [1]

    def test_total_is_the_whole_list_not_the_page(self, db):
        self._ranked()
        assert hotspots_service.get_hotspots(limit=2, offset=2)["total"] == 3

    def test_offset_past_the_end_is_empty_not_an_error(self, db):
        self._ranked()
        result = hotspots_service.get_hotspots(limit=2, offset=99)
        assert result["hotspots"] == [] and result["total"] == 3

    def test_offset_defaults_to_the_first_page(self, db):
        self._ranked()
        assert hotspots_service.get_hotspots(limit=1)["hotspots"][0]["count"] == 5


class TestBoundingBox:
    """`bbox` narrows the answer to one patch of the world — the Custom Places
    page's "only in view" filter."""

    def _three_places(self):
        _upsert("here.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("north.jpg", lat=45.0, lng=-75.0, geotag_source="sidecar")
        _upsert("east.jpg", lat=40.0, lng=-70.0, geotag_source="sidecar")

    def test_only_hotspots_inside_the_box(self, db):
        self._three_places()
        hotspots = hotspots_service.get_hotspots(
            bbox=(39.5, 40.5, -75.5, -74.5))["hotspots"]
        assert [(round(h["lat"], 2), round(h["lng"], 2)) for h in hotspots] == [(40.0, -75.0)]

    def test_no_box_returns_everything(self, db):
        self._three_places()
        assert len(hotspots_service.get_hotspots()["hotspots"]) == 3

    def test_total_counts_only_what_is_in_the_box(self, db):
        self._three_places()
        assert hotspots_service.get_hotspots(bbox=(39.5, 40.5, -75.5, -74.5))["total"] == 1

    def test_the_limit_slices_inside_the_box_not_the_world(self, db):
        # The two busiest places are outside the box. A global top-2 followed by a
        # box filter would answer nothing; filtering first answers the quiet one.
        for i in range(5):
            _upsert(f"busy{i}.jpg", lat=45.0, lng=-75.0, geotag_source="sidecar")
        for i in range(3):
            _upsert(f"mid{i}.jpg", lat=46.0, lng=-75.0, geotag_source="sidecar")
        _upsert("quiet.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")

        hotspots = hotspots_service.get_hotspots(
            limit=2, bbox=(39.5, 40.5, -75.5, -74.5))["hotspots"]
        assert [round(h["lat"], 2) for h in hotspots] == [40.0]

    def test_combines_with_a_sort(self, db):
        self._three_places()
        _upsert("nearby.jpg", lat=40.2, lng=-75.0, geotag_source="sidecar")
        hotspots = hotspots_service.get_hotspots(
            sort="near", lat=40.0, lng=-75.0, bbox=(39.0, 41.0, -76.0, -74.0))["hotspots"]
        assert [round(h["lat"], 2) for h in hotspots] == [40.0, 40.2]

    def test_a_box_across_the_antimeridian_wraps(self, db):
        # What Leaflet reports for a view over the Pacific: west edge east of the
        # east edge, once both are wrapped back into ±180.
        _upsert("fiji.jpg", lat=-17.7, lng=178.0, geotag_source="sidecar")
        _upsert("samoa.jpg", lat=-13.8, lng=-172.0, geotag_source="sidecar")
        _upsert("elsewhere.jpg", lat=-15.0, lng=0.0, geotag_source="sidecar")

        hotspots = hotspots_service.get_hotspots(bbox=(-20.0, -10.0, 175.0, -170.0))["hotspots"]
        assert sorted(round(h["lng"], 1) for h in hotspots) == [-172.0, 178.0]

    def test_in_bbox_edges_are_inclusive(self, db):
        assert hotspots_service.in_bbox(40.0, -75.0, (40.0, 41.0, -75.0, -74.0))
        assert not hotspots_service.in_bbox(39.9, -75.0, (40.0, 41.0, -75.0, -74.0))


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


class TestSuppressedByNamedPlaces:
    """A hotspot a saved place already covers is a duplicate of that place, so the
    palette drops it (hotspots_service.PLACE_COVERAGE_THRESHOLD)."""

    def _circle(self, name, lat, lng, radius):
        return index.create_place(name, "circle", json.dumps(
            {"lat": lat, "lng": lng, "radius": radius}))

    def _rect(self, name, south, north, west, east):
        return index.create_place(name, "rectangle", json.dumps(
            {"south": south, "north": north, "west": west, "east": east}))

    def test_place_on_the_hotspot_hides_it(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        assert len(hotspots_service.get_hotspots()["hotspots"]) == 1

        # What "save this hotspot as a place" writes: same point, same radius.
        self._circle("Home", 40.0, -75.0, 100)
        assert hotspots_service.get_hotspots()["hotspots"] == []

    def test_hide_named_false_shows_it_anyway(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._circle("Home", 40.0, -75.0, 100)
        assert len(hotspots_service.get_hotspots(hide_named=False)["hotspots"]) == 1

    def test_place_a_few_metres_off_still_hides_it(self, db):
        # The centroid drifts as photos land, so coverage is a threshold, not
        # an equality test.
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._circle("Home", 40.0 + _lat_offset(8), -75.0, 100)
        assert hotspots_service.get_hotspots()["hotspots"] == []

    def test_place_next_door_leaves_it_alone(self, db):
        # 150 m away with a 100 m radius: the discs barely touch, nowhere near
        # the coverage threshold.
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._circle("Neighbour", 40.0 + _lat_offset(150), -75.0, 100)
        assert len(hotspots_service.get_hotspots()["hotspots"]) == 1

    def test_small_pin_inside_the_hotspot_also_hides_it(self, db):
        # The other direction of "overlaps": a 20 m pin is far too small to
        # cover the hotspot, but it names the same spot, so the row still goes.
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._circle("Grandma's", 40.0, -75.0, 20)
        assert hotspots_service.get_hotspots()["hotspots"] == []

    def test_small_pin_outside_the_hotspot_leaves_it_alone(self, db):
        # Same tiny pin, but 300 m away: different spot, keep the hotspot.
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._circle("Mailbox", 40.0 + _lat_offset(300), -75.0, 20)
        assert len(hotspots_service.get_hotspots()["hotspots"]) == 1

    def test_small_rectangle_inside_the_hotspot_hides_it(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._rect("Yard", 40.0 - _lat_offset(20), 40.0 + _lat_offset(20),
                   -75.0002, -74.9998)
        assert hotspots_service.get_hotspots()["hotspots"] == []

    def test_rectangle_place_covers_a_hotspot_inside_it(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._rect("Campus", 40.0 - _lat_offset(500), 40.0 + _lat_offset(500),
                   -75.01, -74.99)
        assert hotspots_service.get_hotspots()["hotspots"] == []

    def test_rectangle_place_elsewhere_leaves_it_alone(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        self._rect("Elsewhere", 41.0, 41.1, -75.01, -74.99)
        assert len(hotspots_service.get_hotspots()["hotspots"]) == 1

    def test_only_the_covered_hotspot_is_dropped(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        _upsert("b.jpg", lat=41.0, lng=-75.0, geotag_source="sidecar")
        self._circle("Home", 40.0, -75.0, 100)

        remaining = hotspots_service.get_hotspots()["hotspots"]
        assert len(remaining) == 1
        assert remaining[0]["lat"] == pytest.approx(41.0)

    def test_suppressed_entries_do_not_eat_the_limit(self, db):
        # Three distinct places, the busiest one named. limit=2 should still
        # come back with two rows, not one.
        for i in range(5):
            _upsert(f"named{i}.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        for i in range(3):
            _upsert(f"mid{i}.jpg", lat=41.0, lng=-75.0, geotag_source="sidecar")
        _upsert("quiet.jpg", lat=42.0, lng=-75.0, geotag_source="sidecar")
        self._circle("Home", 40.0, -75.0, 100)

        result = hotspots_service.get_hotspots(limit=2)
        assert [h["count"] for h in result["hotspots"]] == [3, 1]
        assert result["total"] == 2   # total counts what survived the filter

    def test_unparseable_bounds_are_ignored(self, db):
        _upsert("a.jpg", lat=40.0, lng=-75.0, geotag_source="sidecar")
        index.create_place("Broken", "circle", "not json")
        index.create_place("Half", "circle", json.dumps({"lat": 40.0}))
        assert len(hotspots_service.get_hotspots()["hotspots"]) == 1
