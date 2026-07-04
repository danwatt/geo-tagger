import pytest

from geotagger import geocode, index


def _city_row(geonameid, name, lat, lng, cc, admin1="", admin2="", population=0):
    # Minimal GeoNames cities500.txt row (tab-separated, 19 columns). Only
    # columns 1, 4, 5, 8, 10, 11, 14 are read by the loader.
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


CITY_A = dict(geonameid=1, name="Testville", lat=40.0000, lng=-74.0000,
              cc="US", admin1="NY", admin2="061", population=1_000_000)
CITY_B = dict(geonameid=2, name="Smallburg", lat=40.1000, lng=-74.1000,
              cc="US", admin1="NY", admin2="061", population=500)
CITY_C = dict(geonameid=3, name="Otherton", lat=34.0000, lng=-118.0000,
              cc="US", admin1="CA", admin2="", population=2_000_000)
CITY_D = dict(geonameid=4, name="Northplace", lat=43.7000, lng=-79.4000,
              cc="CA", admin1="08", admin2="", population=300_000)


def _write_admin_files(dir_):
    (dir_ / "admin1CodesASCII.txt").write_text(
        "US.NY\tNew York\tNew York\t1\n"
        "US.CA\tCalifornia\tCalifornia\t2\n"
        "CA.08\tOntario\tOntario\t3\n",
        encoding="utf-8",
    )
    (dir_ / "admin2Codes.txt").write_text(
        "US.NY.061\tNew York County\tNew York County\t10\n",
        encoding="utf-8",
    )
    (dir_ / "countryInfo.txt").write_text(
        "# comment header line, should be skipped\n"
        "US\tUSA\t840\tUS\tUnited States\tWashington\n"
        "CA\tCAN\t124\tCA\tCanada\tOttawa\n",
        encoding="utf-8",
    )


def _write_geonames_files(dir_, cities):
    lines = [_city_row(**c) for c in cities]
    (dir_ / "cities500.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    _write_admin_files(dir_)


class TestQuantize:
    def test_rounds_to_configured_precision(self, monkeypatch):
        monkeypatch.setattr(geocode, "GEOCODE_PRECISION", 4)
        assert geocode.quantize(40.712812, -74.006015) == (407128, -740060)

    def test_different_precision(self, monkeypatch):
        monkeypatch.setattr(geocode, "GEOCODE_PRECISION", 2)
        assert geocode.quantize(40.712812, -74.006015) == (4071, -7401)

    def test_nearby_coordinates_share_a_bucket(self, monkeypatch):
        monkeypatch.setattr(geocode, "GEOCODE_PRECISION", 2)
        a = geocode.quantize(40.7101, -74.0032)
        b = geocode.quantize(40.7099, -74.0028)
        assert a == b


class TestIsAvailable:
    def test_false_when_cities_file_missing(self, geonames_dir):
        assert geocode.is_available() is False

    def test_true_when_cities_file_present(self, geonames_dir):
        (geonames_dir / "cities500.txt").write_text("dummy\n")
        assert geocode.is_available() is True


class TestStatus:
    def test_unloaded_before_any_lookup(self, geonames_dir):
        (geonames_dir / "cities500.txt").write_text("dummy\n")
        s = geocode.status()
        assert s == {"available": True, "state": "unloaded", "error": None, "cities": 0}

    def test_unavailable_when_data_missing(self, geonames_dir):
        geocode._ensure_loaded()
        s = geocode.status()
        assert s["available"] is False
        assert s["state"] == "unavailable"
        assert s["error"] is not None
        assert s["cities"] == 0

    def test_ready_after_successful_load(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, CITY_C, CITY_D])
        geocode._ensure_loaded()
        s = geocode.status()
        assert s["state"] == "ready"
        assert s["cities"] == 4

    def test_load_failure_degrades_to_unavailable_without_crashing(self, geonames_dir):
        # A directory named cities500.txt "exists" (is_available() is True)
        # but .open() inside _load() raises — must degrade gracefully.
        (geonames_dir / "cities500.txt").mkdir()
        geocode._ensure_loaded()
        s = geocode.status()
        assert s["state"] == "unavailable"
        assert s["error"] is not None

    def test_load_is_idempotent(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A])
        geocode._ensure_loaded()
        geocode._ensure_loaded()
        assert len(geocode._names) == 1

    def test_load_itself_is_a_noop_once_already_loaded(self, geonames_dir):
        # _load()'s own state guard (belt-and-suspenders alongside
        # _ensure_loaded()'s check, for the race where two callers both pass
        # that check before either acquires the lock).
        _write_geonames_files(geonames_dir, [CITY_A])
        geocode._load()
        geocode._load()
        assert len(geocode._names) == 1


class TestMalformedData:
    def test_short_rows_are_skipped_without_crashing(self, geonames_dir):
        (geonames_dir / "cities500.txt").write_text(
            "too\tfew\tcolumns\n" + _city_row(**CITY_A) + "\n", encoding="utf-8",
        )
        _write_admin_files(geonames_dir)
        geocode._ensure_loaded()
        assert geocode.status() == {"available": True, "state": "ready", "error": None, "cities": 1}

    def test_rows_with_invalid_coordinates_are_skipped(self, geonames_dir):
        bad_row = _city_row(**{**CITY_A, "lat": "not-a-number"})
        good_row = _city_row(**CITY_B)
        (geonames_dir / "cities500.txt").write_text(bad_row + "\n" + good_row + "\n", encoding="utf-8")
        _write_admin_files(geonames_dir)
        geocode._ensure_loaded()
        assert geocode.status()["cities"] == 1

    def test_row_with_invalid_population_defaults_to_zero(self, geonames_dir):
        row = _city_row(**{**CITY_A, "population": "not-a-number"})
        (geonames_dir / "cities500.txt").write_text(row + "\n", encoding="utf-8")
        _write_admin_files(geonames_dir)
        geocode._ensure_loaded()
        places, total = geocode.cities_in_bbox(39.9, 40.2, -74.2, -73.9)
        assert total == 1
        assert places[0]["population"] == 0


class TestRawLookup:
    def test_none_when_data_unavailable(self, geonames_dir):
        assert geocode._raw_lookup(40.0, -74.0) is None

    def test_nearest_city_with_full_hierarchy(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, CITY_C, CITY_D])
        result = geocode._raw_lookup(40.001, -74.001)
        assert result == {
            "city": "Testville", "state": "New York", "county": "New York County",
            "country": "United States", "country_code": "US",
        }

    def test_picks_actual_nearest_not_just_first_in_file(self, geonames_dir):
        # Smallburg is listed before Testville, but Testville is the true
        # nearest neighbor to the query point.
        _write_geonames_files(geonames_dir, [CITY_B, CITY_A, CITY_C, CITY_D])
        result = geocode._raw_lookup(40.001, -74.001)
        assert result["city"] == "Testville"

    def test_city_without_county_data_has_none_county(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, CITY_C, CITY_D])
        result = geocode._raw_lookup(34.0001, -118.0001)
        assert result["city"] == "Otherton"
        assert result["state"] == "California"
        assert result["county"] is None

    def test_foreign_country_resolves_its_own_hierarchy(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, CITY_C, CITY_D])
        result = geocode._raw_lookup(43.7001, -79.4001)
        assert result["city"] == "Northplace"
        assert result["state"] == "Ontario"
        assert result["country"] == "Canada"
        assert result["country_code"] == "CA"


class TestCitiesInBbox:
    def test_empty_when_data_unavailable(self, geonames_dir):
        places, total = geocode.cities_in_bbox(0, 1, 0, 1)
        assert places == []
        assert total == 0

    def test_filters_to_the_bounding_box(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, CITY_C, CITY_D])
        places, total = geocode.cities_in_bbox(39.9, 40.2, -74.2, -73.9)
        assert total == 2
        assert {p["city"] for p in places} == {"Testville", "Smallburg"}

    def test_caps_results_keeping_highest_population(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, CITY_C, CITY_D])
        places, total = geocode.cities_in_bbox(-90, 90, -180, 180, limit=2)
        assert total == 4
        assert len(places) == 2
        assert {p["city"] for p in places} == {"Otherton", "Testville"}  # top 2 by population

    def test_includes_lat_lng_and_population(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A])
        places, total = geocode.cities_in_bbox(39.9, 40.2, -74.2, -73.9)
        assert total == 1
        p = places[0]
        assert p["lat"] == pytest.approx(40.0)
        assert p["lng"] == pytest.approx(-74.0)
        assert p["population"] == 1_000_000


class TestClipPolygonToBbox:
    def test_polygon_fully_inside_is_unchanged(self):
        poly = [(1.0, 1.0), (1.0, 2.0), (2.0, 2.0), (2.0, 1.0)]
        clipped = geocode._clip_polygon_to_bbox(poly, 0.0, 5.0, 0.0, 5.0)
        assert clipped == poly

    def test_polygon_fully_outside_clips_to_nothing(self):
        poly = [(10.0, 10.0), (10.0, 12.0), (12.0, 12.0), (12.0, 10.0)]
        clipped = geocode._clip_polygon_to_bbox(poly, 0.0, 5.0, 0.0, 5.0)
        assert clipped == []

    def test_polygon_spanning_the_box_clips_down_to_it(self):
        poly = [(-10.0, -10.0), (-10.0, 10.0), (10.0, 10.0), (10.0, -10.0)]
        clipped = geocode._clip_polygon_to_bbox(poly, 0.0, 5.0, 0.0, 5.0)
        lats = {round(la, 6) for la, ln in clipped}
        lngs = {round(ln, 6) for la, ln in clipped}
        assert lats == {0.0, 5.0}
        assert lngs == {0.0, 5.0}


class TestVoronoiCells:
    def test_empty_when_data_unavailable(self, geonames_dir):
        cells, total = geocode.voronoi_cells(0, 1, 0, 1)
        assert cells == []
        assert total == 0

    def test_fewer_than_three_points_in_padded_region_returns_no_cells(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B])
        cells, total = geocode.voronoi_cells(39.9, 40.2, -74.2, -73.9)
        assert total == 2
        assert cells == []

    def test_symmetric_neighbours_yield_the_exact_bisector_square(self, geonames_dir):
        # C has one neighbour in each cardinal direction, equidistant after
        # longitude is scaled by cos(lat) — so C's Voronoi cell is exactly
        # the axis-aligned square whose edges are the four perpendicular
        # bisectors, independent of any qhull/clipping approximation.
        import math

        center_lat, center_lng = 40.0, -74.0
        cos_lat = math.cos(math.radians(center_lat))
        dlat = 0.01
        dlng = dlat / cos_lat

        pts = {
            "Center": (center_lat, center_lng),
            "North": (center_lat + dlat, center_lng),
            "South": (center_lat - dlat, center_lng),
            "East": (center_lat, center_lng + dlng),
            "West": (center_lat, center_lng - dlng),
        }
        cities = [
            dict(geonameid=i, name=name, lat=lat, lng=lng, cc="US", population=100)
            for i, (name, (lat, lng)) in enumerate(pts.items(), start=1)
        ]
        _write_geonames_files(geonames_dir, cities)

        cells, total = geocode.voronoi_cells(
            center_lat - dlat / 2, center_lat + dlat / 2,
            center_lng - dlng / 2, center_lng + dlng / 2,
        )
        assert total == 1
        assert len(cells) == 1
        cell = cells[0]
        assert cell["city"] == "Center"

        expected_lat_half = dlat / 2
        expected_lng_half = (dlat / 2) / cos_lat
        lats = {round(la, 6) for la, ln in cell["polygon"]}
        lngs = {round(ln, 6) for la, ln in cell["polygon"]}
        assert lats == {
            round(center_lat - expected_lat_half, 6),
            round(center_lat + expected_lat_half, 6),
        }
        assert lngs == {
            round(center_lng - expected_lng_half, 6),
            round(center_lng + expected_lng_half, 6),
        }

    def test_only_sites_inside_the_viewport_get_a_returned_cell(self, geonames_dir):
        # North and East sit just outside the queried bbox but within
        # Center's padding — they should shape Center's cell without getting
        # one of their own back.
        center = dict(geonameid=1, name="Center", lat=40.0, lng=-74.0, cc="US", population=100)
        north = dict(geonameid=2, name="North", lat=40.012, lng=-74.0, cc="US", population=50)
        east = dict(geonameid=3, name="East", lat=40.0, lng=-73.988, cc="US", population=50)
        _write_geonames_files(geonames_dir, [center, north, east])
        cells, total = geocode.voronoi_cells(39.995, 40.005, -74.005, -73.995)
        assert total == 1
        assert {c["city"] for c in cells} == {"Center"}

    def test_includes_place_metadata_on_each_cell(self, geonames_dir):
        # A third point out in the padding is needed alongside Testville and
        # Smallburg — Voronoi needs 3+ points to produce a bounded region.
        third = dict(geonameid=99, name="ThirdFar", lat=40.45, lng=-74.0, cc="US", population=10)
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, third])
        cells, total = geocode.voronoi_cells(39.9, 40.2, -74.2, -73.9)
        assert total == 2
        by_city = {c["city"]: c for c in cells}
        assert by_city["Testville"]["state"] == "New York"
        assert by_city["Testville"]["county"] == "New York County"
        assert by_city["Testville"]["population"] == 1_000_000
        assert by_city["Testville"]["lat"] == pytest.approx(40.0)
        assert len(by_city["Testville"]["polygon"]) >= 3


def _rect(min_lat, max_lat, min_lng, max_lng):
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return [[outer, []]]


class TestMergedLookup:
    """geocode.lookup merges OSM polygon containment (city + sublocation) with the
    GeoNames nearest-point lookup (state/county/country). OSM replaces the city."""

    def test_osm_city_replaces_geonames_city(self, geonames_dir, osm_db):
        _write_geonames_files(geonames_dir, [CITY_A])  # Testville @ (40,-74), NY
        osm_db([dict(name="OsmCity", category="city", admin_level=8, area=1.0,
                     polygons=_rect(39.9, 40.1, -74.1, -73.9))])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "OsmCity"                 # from OSM boundary, not GeoNames
        assert r["state"] == "New York"               # still from GeoNames
        assert r["country_code"] == "US"

    def test_osm_sublocation_is_surfaced(self, geonames_dir, osm_db):
        _write_geonames_files(geonames_dir, [CITY_A])
        osm_db([
            dict(name="OsmCity", category="city", admin_level=8, area=1.0,
                 polygons=_rect(39.9, 40.1, -74.1, -73.9)),
            dict(name="Riverside Park", category="park", area=0.001,
                 polygons=_rect(39.99, 40.01, -74.01, -73.99)),
        ])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "OsmCity"
        assert r["sublocation"] == "Riverside Park"

    def test_point_outside_every_osm_city_falls_back_to_geonames_by_default(self, geonames_dir, osm_db):
        # Default OSM_CITY_FALLBACK_GEONAMES=True: a point outside every OSM
        # polygon still gets a usable city (from GeoNames' nearest-point lookup)
        # instead of "(none)" — the common case while OSM coverage is partial.
        _write_geonames_files(geonames_dir, [CITY_A])
        osm_db([dict(name="Elsewhere", category="city", admin_level=8, area=1.0,
                     polygons=_rect(10.0, 11.0, 10.0, 11.0))])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "Testville"  # GeoNames city, since fallback defaults on
        assert r["sublocation"] is None
        assert r["state"] == "New York"
        assert r["country_code"] == "US"

    def test_point_in_no_osm_city_has_none_city_when_fallback_disabled(self, geonames_dir, osm_db, monkeypatch):
        # Opt back into strict "OSM replaces city" (no fallback): a point inside
        # no OSM city gets city None, while GeoNames still supplies state/country.
        monkeypatch.setattr(geocode.config, "OSM_CITY_FALLBACK_GEONAMES", False)
        _write_geonames_files(geonames_dir, [CITY_A])
        osm_db([dict(name="Elsewhere", category="city", admin_level=8, area=1.0,
                     polygons=_rect(10.0, 11.0, 10.0, 11.0))])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] is None
        assert r["sublocation"] is None
        assert r["state"] == "New York"
        assert r["country_code"] == "US"

    def test_falls_back_to_geonames_city_when_osm_not_installed(self, geonames_dir):
        # No osm_db fixture → OSM DB absent → graceful GeoNames city, no sublocation.
        _write_geonames_files(geonames_dir, [CITY_A])
        r = geocode.lookup(40.001, -74.001)
        assert r["city"] == "Testville"
        assert r["sublocation"] is None


class TestLookupCacheIntegration:
    def test_none_coordinates_return_none(self, geonames_dir):
        assert geocode.lookup(None, -74.0) is None
        assert geocode.lookup(40.0, None) is None

    def test_lookup_without_db_falls_back_gracefully(self, geonames_dir):
        # No DB initialized — cache access must degrade silently, not raise.
        _write_geonames_files(geonames_dir, [CITY_A])
        result = geocode.lookup(40.001, -74.001)
        assert result["city"] == "Testville"

    def test_lookup_writes_through_to_the_cache(self, geonames_dir, db):
        _write_geonames_files(geonames_dir, [CITY_A])
        result = geocode.lookup(40.001, -74.001)
        qlat, qlng = geocode.quantize(40.001, -74.001)
        assert index.get_cached_geocode(qlat, qlng) == result

    def test_lookup_reads_from_cache_before_the_kd_tree(self, geonames_dir, db):
        _write_geonames_files(geonames_dir, [CITY_A])
        qlat, qlng = geocode.quantize(40.001, -74.001)
        index.put_cached_geocode(qlat, qlng, {
            "city": "CachedCity", "state": None, "county": None,
            "country": None, "country_code": None,
        })
        result = geocode.lookup(40.001, -74.001)
        assert result["city"] == "CachedCity"

    def test_use_cache_false_bypasses_and_does_not_populate_cache(self, geonames_dir, db):
        _write_geonames_files(geonames_dir, [CITY_A])
        qlat, qlng = geocode.quantize(40.001, -74.001)
        index.put_cached_geocode(qlat, qlng, {
            "city": "CachedCity", "state": None, "county": None,
            "country": None, "country_code": None,
        })
        result = geocode.lookup(40.001, -74.001, use_cache=False)
        assert result["city"] == "Testville"
        # The stale cache entry is left untouched, not overwritten.
        assert index.get_cached_geocode(qlat, qlng)["city"] == "CachedCity"
