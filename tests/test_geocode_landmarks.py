import json

import pytest

from geotagger import geocode, index


def _write_landmarks(dir_, entries):
    (dir_ / "landmarks.jsonl").write_text(
        "\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8"
    )


CITY_A = dict(geonameid=1, name="Testville", lat=40.0000, lng=-74.0000,
              cc="US", admin1="NY", admin2="061", population=1_000_000)


def _city_row(geonameid, name, lat, lng, cc, admin1="", admin2="", population=0):
    # Minimal GeoNames cities500.txt row (tab-separated, 19 columns) — see
    # test_geocode.py for the full field-by-field breakdown.
    cols = [
        str(geonameid), name, name, "",
        f"{lat}", f"{lng}",
        "P", "PPL",
        cc, "",
        admin1, admin2, "", "",
        str(population),
        "", "", "", "",
    ]
    return "\t".join(cols)


def _write_geonames_files(dir_, cities):
    (dir_ / "cities500.txt").write_text(
        "\n".join(_city_row(**c) for c in cities) + "\n", encoding="utf-8",
    )
    (dir_ / "admin1CodesASCII.txt").write_text("US.NY\tNew York\tNew York\t1\n", encoding="utf-8")
    (dir_ / "admin2Codes.txt").write_text(
        "US.NY.061\tNew York County\tNew York County\t10\n", encoding="utf-8",
    )
    (dir_ / "countryInfo.txt").write_text(
        "US\tUSA\t840\tUS\tUnited States\tWashington\n", encoding="utf-8",
    )


BUILDING_SQUARE = [[39.999, -74.001], [39.999, -73.999], [40.001, -73.999], [40.001, -74.001]]
PARK_SQUARE = [[40.999, -75.001], [40.999, -74.999], [41.001, -74.999], [41.001, -75.001]]

A_BUILDING = {"kind": "building", "name": "Test Tower", "category": "office", "polygon": BUILDING_SQUARE}
A_PARK = {"kind": "park", "name": "Test Gardens", "category": "park", "polygon": PARK_SQUARE}
A_PLACE = {"kind": "place", "name": "Test Monument", "category": "monument", "point": [42.0, -76.0]}


class TestLandmarkStatus:
    def test_unloaded_before_any_lookup(self, overture_dir):
        (overture_dir / "landmarks.jsonl").write_text("", encoding="utf-8")
        s = geocode.landmark_status()
        assert s == {"available": True, "state": "unloaded", "error": None,
                     "buildings": 0, "parks": 0, "places": 0}

    def test_unavailable_when_data_missing(self, overture_dir):
        geocode._ensure_landmarks_loaded()
        s = geocode.landmark_status()
        assert s["available"] is False
        assert s["state"] == "unavailable"
        assert s["error"] is not None

    def test_ready_after_successful_load(self, overture_dir):
        _write_landmarks(overture_dir, [A_BUILDING, A_PARK, A_PLACE])
        geocode._ensure_landmarks_loaded()
        s = geocode.landmark_status()
        assert s["state"] == "ready"
        assert s["buildings"] == 1
        assert s["parks"] == 1
        assert s["places"] == 1

    def test_missing_data_does_not_break_city_resolution(self, overture_dir, geonames_dir):
        # Two independent load-state machines: landmark data absent shouldn't
        # stop the (also-empty-here) city loader from reporting its own state.
        geocode._ensure_landmarks_loaded()
        geocode._ensure_loaded()
        assert geocode.landmark_status()["state"] == "unavailable"
        assert geocode.status()["state"] == "unavailable"


class TestResolveLandmark:
    def test_none_when_data_unavailable(self, overture_dir):
        assert geocode.resolve_landmark(40.0, -74.0) is None

    def test_resolves_inside_building_polygon(self, overture_dir):
        _write_landmarks(overture_dir, [A_BUILDING])
        result = geocode.resolve_landmark(40.0, -74.0)
        assert result == {"name": "Test Tower", "kind": "building", "category": "office"}

    def test_resolves_inside_park_polygon(self, overture_dir):
        _write_landmarks(overture_dir, [A_PARK])
        result = geocode.resolve_landmark(41.0, -75.0)
        assert result == {"name": "Test Gardens", "kind": "park", "category": "park"}

    def test_building_takes_priority_over_overlapping_park(self, overture_dir):
        overlapping_park = {"kind": "park", "name": "Overlap Park", "category": "park",
                             "polygon": BUILDING_SQUARE}
        _write_landmarks(overture_dir, [overlapping_park, A_BUILDING])
        result = geocode.resolve_landmark(40.0, -74.0)
        assert result["kind"] == "building"
        assert result["name"] == "Test Tower"

    def test_resolves_nearest_place_within_max_km(self, overture_dir, monkeypatch):
        monkeypatch.setattr(geocode, "LANDMARK_POI_MAX_KM", 0.5)
        _write_landmarks(overture_dir, [A_PLACE])
        result = geocode.resolve_landmark(42.0, -76.0)
        assert result == {"name": "Test Monument", "kind": "place", "category": "monument"}

    def test_place_farther_than_max_km_is_not_matched(self, overture_dir, monkeypatch):
        monkeypatch.setattr(geocode, "LANDMARK_POI_MAX_KM", 0.05)
        _write_landmarks(overture_dir, [A_PLACE])
        # ~1km away at this latitude — outside the tight radius above.
        result = geocode.resolve_landmark(42.009, -76.0)
        assert result is None

    def test_point_outside_all_features_returns_none(self, overture_dir):
        _write_landmarks(overture_dir, [A_BUILDING, A_PARK, A_PLACE])
        assert geocode.resolve_landmark(10.0, 10.0) is None

    def test_degenerate_polygons_are_skipped_without_crashing(self, overture_dir):
        degenerate = {"kind": "building", "name": "Line", "category": None,
                      "polygon": [[40.0, -74.0], [40.0, -74.001]]}
        _write_landmarks(overture_dir, [degenerate])
        geocode._ensure_landmarks_loaded()
        assert geocode.landmark_status()["buildings"] == 0

    def test_one_malformed_row_does_not_discard_the_rest_of_the_file(self, overture_dir):
        # Regression: a single bad line (invalid JSON, or missing an expected
        # key) must only drop that row, not mark the whole dataset unavailable.
        (overture_dir / "landmarks.jsonl").write_text(
            json.dumps(A_BUILDING) + "\n"
            "not valid json\n"
            + json.dumps({"kind": "park", "name": "Missing Polygon Key"}) + "\n"
            + json.dumps(A_PLACE) + "\n",
            encoding="utf-8",
        )
        geocode._ensure_landmarks_loaded()
        status = geocode.landmark_status()
        assert status["state"] == "ready"
        assert status["buildings"] == 1
        assert status["places"] == 1
        assert geocode.resolve_landmark(40.0, -74.0)["name"] == "Test Tower"


class TestLandmarksInBbox:
    def test_empty_when_data_unavailable(self, overture_dir):
        polygons, points, total = geocode.landmarks_in_bbox(0, 1, 0, 1)
        assert polygons == []
        assert points == []
        assert total == 0

    def test_filters_polygons_and_points_to_the_bbox(self, overture_dir):
        _write_landmarks(overture_dir, [A_BUILDING, A_PARK, A_PLACE])
        polygons, points, total = geocode.landmarks_in_bbox(39.9, 40.1, -74.1, -73.9)
        assert total == 1
        assert len(polygons) == 1
        assert polygons[0]["name"] == "Test Tower"
        assert points == []

    def test_includes_points_in_the_bbox(self, overture_dir):
        _write_landmarks(overture_dir, [A_BUILDING, A_PLACE])
        polygons, points, total = geocode.landmarks_in_bbox(41.9, 42.1, -76.1, -75.9)
        assert total == 1
        assert polygons == []
        assert points[0]["name"] == "Test Monument"
        assert points[0]["lat"] == pytest.approx(42.0)
        assert points[0]["lng"] == pytest.approx(-76.0)


class TestLookupLandmarkMerge:
    def test_lookup_merges_landmark_onto_city_result(self, overture_dir, geonames_dir, db):
        _write_geonames_files(geonames_dir, [CITY_A])
        _write_landmarks(overture_dir, [A_BUILDING])
        result = geocode.lookup(40.0, -74.0)
        assert result["city"] == "Testville"
        assert result["landmark"] == "Test Tower"
        assert result["landmark_type"] == "building"

    def test_lookup_returns_landmark_only_result_when_city_data_missing(self, overture_dir, geonames_dir, db):
        _write_landmarks(overture_dir, [A_BUILDING])
        result = geocode.lookup(40.0, -74.0)
        assert result["landmark"] == "Test Tower"
        assert result["city"] is None

    def test_lookup_sets_landmark_none_when_no_landmark_nearby(self, overture_dir, geonames_dir, db):
        _write_geonames_files(geonames_dir, [CITY_A])
        result = geocode.lookup(40.001, -74.001)
        assert result["city"] == "Testville"
        assert result["landmark"] is None
        assert result["landmark_type"] is None

    def test_city_cache_row_never_stores_landmark_fields(self, overture_dir, geonames_dir, db):
        # Landmark resolution is intentionally never cached (see lookup()'s
        # docstring) — the quantized cache grid is too coarse for exact
        # polygon containment, and it must never go stale as landmarks.jsonl
        # changes. Confirm the cached row itself carries city fields only.
        _write_geonames_files(geonames_dir, [CITY_A])
        _write_landmarks(overture_dir, [A_BUILDING])
        result = geocode.lookup(40.0, -74.0)
        assert result["landmark"] == "Test Tower"
        qlat, qlng = geocode.quantize(40.0, -74.0)
        cached = index.get_cached_geocode(qlat, qlng)
        assert "landmark" not in cached and "landmark_type" not in cached
        assert cached["city"] == "Testville"

    def test_landmark_resolves_even_when_city_result_is_pre_cached(self, overture_dir, geonames_dir, db):
        # Regression test: a coordinate whose city portion was cached before
        # Overture landmark data was ever fetched must still pick up a
        # landmark once it exists — a cache hit must not skip resolve_landmark().
        _write_geonames_files(geonames_dir, [CITY_A])
        qlat, qlng = geocode.quantize(40.0, -74.0)
        index.put_cached_geocode(qlat, qlng, {
            "city": "Testville", "state": "New York", "county": "New York County",
            "country": "United States", "country_code": "US",
        })
        _write_landmarks(overture_dir, [A_BUILDING])
        result = geocode.lookup(40.0, -74.0)
        assert result["city"] == "Testville"
        assert result["landmark"] == "Test Tower"
