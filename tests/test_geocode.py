import pytest

from geotagger import config, geocode, index


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
        assert len(geocode._data.names) == 1

    def test_load_itself_is_a_noop_once_already_loaded(self, geonames_dir):
        # _load()'s own state guard (belt-and-suspenders alongside
        # _ensure_loaded()'s check, for the race where two callers both pass
        # that check before either acquires the lock).
        _write_geonames_files(geonames_dir, [CITY_A])
        geocode._load()
        geocode._load()
        assert len(geocode._data.names) == 1


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


class TestPopulationWeighting:
    # Mirrors the real Houston case that motivated the weighting: "Oak Cliff
    # Place" (a GNIS subdivision, pop 1800) sits 6.3 km from the query point,
    # the recognizable town of Cypress (pop 200839) 8.1 km away, and both carry
    # feature code PPL — so plain nearest-point picks the subdivision.
    SUBDIVISION = dict(geonameid=10, name="Subdivision", lat=30.0 - 6.3 / 111.0,
                       lng=-95.0, cc="US", admin1="TX", population=1_800)
    REAL_TOWN = dict(geonameid=11, name="RealTown", lat=30.0,
                     lng=-95.0 - 8.1 / 96.13, cc="US", admin1="TX",
                     population=200_839)

    def test_larger_place_wins_a_near_tie_in_distance(self, geonames_dir):
        _write_geonames_files(geonames_dir, [self.SUBDIVISION, self.REAL_TOWN])
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "RealTown"

    def test_disabled_weighting_returns_the_plain_nearest(self, geonames_dir, monkeypatch):
        monkeypatch.setattr(config, "GEOCODE_POP_WEIGHT", False)
        _write_geonames_files(geonames_dir, [self.SUBDIVISION, self.REAL_TOWN])
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "Subdivision"

    def test_nearest_still_wins_when_it_is_also_the_larger_place(self, geonames_dir):
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B, CITY_C, CITY_D])
        # Testville: 1M people and the nearest — nothing to trade off.
        assert geocode._raw_lookup(40.001, -74.001)["city"] == "Testville"

    def test_reach_cap_keeps_a_distant_metropolis_from_stealing_the_label(
            self, geonames_dir, monkeypatch):
        monkeypatch.setattr(config, "GEOCODE_POP_WEIGHT_MAX_KM", 2.0)
        metropolis = dict(geonameid=12, name="FarMetropolis", lat=30.0 - 10.0 / 111.0,
                          lng=-95.0, cc="US", admin1="TX", population=10_000_000)
        _write_geonames_files(geonames_dir, [self.SUBDIVISION, metropolis])
        # Unweighted score would favour FarMetropolis (10.0/8 < 6.3/4.26), but it
        # lies 3.7 km past the nearest place, beyond the 2 km cap.
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "Subdivision"

    def test_margin_keeps_the_nearest_place_when_the_scores_nearly_tie(self, geonames_dir):
        # The real Bryson City NC (1458, 15.3 km) vs Gatlinburg TN (4184, 16.9 km)
        # case: scores 3.67 vs 3.66, well inside the 10% margin, so the nearest
        # place keeps the label instead of the label hopping across a state line.
        near = dict(geonameid=15, name="NearSmall", lat=30.0 - 15.3 / 111.0,
                    lng=-95.0, cc="US", admin1="TX", population=1_458)
        far = dict(geonameid=16, name="FarBigger", lat=30.0 - 16.9 / 111.0,
                   lng=-95.0, cc="US", admin1="TX", population=4_184)
        _write_geonames_files(geonames_dir, [near, far])
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "NearSmall"

    def test_a_dropped_margin_lets_the_near_tie_flip(self, geonames_dir, monkeypatch):
        monkeypatch.setattr(config, "GEOCODE_POP_WEIGHT_MARGIN", 0.0)
        near = dict(geonameid=15, name="NearSmall", lat=30.0 - 15.3 / 111.0,
                    lng=-95.0, cc="US", admin1="TX", population=1_458)
        far = dict(geonameid=16, name="FarBigger", lat=30.0 - 16.9 / 111.0,
                   lng=-95.0, cc="US", admin1="TX", population=4_184)
        _write_geonames_files(geonames_dir, [near, far])
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "FarBigger"

    def test_zero_population_places_do_not_break_the_score(self, geonames_dir):
        a = dict(geonameid=13, name="Nowhere", lat=30.0, lng=-95.0, cc="US",
                 admin1="TX", population=0)
        b = dict(geonameid=14, name="AlsoNowhere", lat=30.02, lng=-95.0, cc="US",
                 admin1="TX", population=0)
        _write_geonames_files(geonames_dir, [a, b])
        # log10 of a clamped population of 1 is 0, so the score is just distance.
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "Nowhere"

    def test_single_city_dataset_resolves(self, geonames_dir):
        # k clamps to 1, where scipy hands back scalars instead of arrays.
        _write_geonames_files(geonames_dir, [self.REAL_TOWN])
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "RealTown"

    def test_more_candidates_than_places_is_harmless(self, geonames_dir, monkeypatch):
        # k is clamped to the place count (and _pick_weighted also drops the inf
        # distances / out-of-range indices cKDTree would pad an unclamped k with).
        monkeypatch.setattr(config, "GEOCODE_CANDIDATES", 50)
        _write_geonames_files(geonames_dir, [self.SUBDIVISION, self.REAL_TOWN])
        assert geocode._raw_lookup(30.0, -95.0)["city"] == "RealTown"


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

    def test_fewer_than_three_points_in_padded_region_returns_no_exact_cells(
            self, geonames_dir, monkeypatch):
        # qhull needs three generators for a Voronoi diagram; the exact path gives
        # up rather than inventing cells.
        monkeypatch.setattr(config, "GEOCODE_POP_WEIGHT", False)
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B])
        cells, total = geocode.voronoi_cells(39.9, 40.2, -74.2, -73.9)
        assert total == 2
        assert cells == []

    def test_two_points_still_get_grid_traced_cells(self, geonames_dir):
        # The weighted path traces labelled grid regions, so it has no such floor.
        _write_geonames_files(geonames_dir, [CITY_A, CITY_B])
        cells, total = geocode.voronoi_cells(39.9, 40.2, -74.2, -73.9)
        assert total == 2
        assert {c["city"] for c in cells} == {"Testville", "Smallburg"}

    def test_symmetric_neighbours_yield_the_exact_bisector_square(self, geonames_dir, monkeypatch):
        # C has one neighbour in each cardinal direction, equidistant after
        # longitude is scaled by cos(lat) — so C's Voronoi cell is exactly
        # the axis-aligned square whose edges are the four perpendicular
        # bisectors, independent of any qhull/clipping approximation. Pinned to the
        # unweighted lookup, the only mode whose cells are exact geometry.
        import math

        monkeypatch.setattr(config, "GEOCODE_POP_WEIGHT", False)

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
        assert by_city["Testville"]["polygons"] == [by_city["Testville"]["polygon"]]


class TestWeightedCellGeometry:
    """With config.GEOCODE_POP_WEIGHT on, cells are traced off a grid labelled by
    the real lookup — so they must agree with _raw_lookup, not with the plain
    Voronoi diagram."""

    # Two equidistant-from-center places 0.04 deg apart, one 1000x the other's
    # population: the small one's region has to be visibly smaller than the half
    # of the viewport a plain Voronoi diagram would give it.
    SMALL = dict(geonameid=1, name="Small", lat=40.0, lng=-74.02, cc="US",
                 admin1="NY", population=1_000)
    BIG = dict(geonameid=2, name="Big", lat=40.0, lng=-73.98, cc="US",
               admin1="NY", population=1_000_000)
    BBOX = (39.98, 40.02, -74.04, -73.96)

    @staticmethod
    def _area(cell):
        # Shoelace over every ring of the cell, in squared degrees — only ever
        # compared against another cell from the same viewport, so the lat/lng
        # distortion cancels out.
        def ring_area(ring):
            n = len(ring)
            return abs(sum(ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]
                           for i in range(n))) / 2
        return sum(ring_area(r) for r in cell["polygons"])

    def test_larger_population_claims_the_bigger_share(self, geonames_dir):
        _write_geonames_files(geonames_dir, [self.SMALL, self.BIG])
        cells, _ = geocode.voronoi_cells(*self.BBOX)
        by_city = {c["city"]: c for c in cells}
        assert set(by_city) == {"Small", "Big"}
        # Not a landslide — the 10% margin protects a band around the bisector
        # where the nearest place keeps the label regardless of population.
        assert self._area(by_city["Big"]) > 1.2 * self._area(by_city["Small"])

    def test_unweighted_cells_split_the_viewport_evenly(self, geonames_dir, monkeypatch):
        # Same two places, weighting off: population stops mattering and the cells
        # are the two halves of the bisector. The far north/south pair is only there
        # to give qhull bounded regions for the two we assert on.
        monkeypatch.setattr(config, "GEOCODE_POP_WEIGHT", False)
        # Inside the padded bbox (a viewport's worth on each side) but outside the
        # viewport, so they bound the two cells symmetrically without getting one.
        north = dict(geonameid=3, name="North", lat=40.05, lng=-74.0, cc="US", population=10)
        south = dict(geonameid=4, name="South", lat=39.95, lng=-74.0, cc="US", population=10)
        _write_geonames_files(geonames_dir, [self.SMALL, self.BIG, north, south])
        cells, _ = geocode.voronoi_cells(*self.BBOX)
        by_city = {c["city"]: c for c in cells}
        assert self._area(by_city["Big"]) == pytest.approx(
            self._area(by_city["Small"]), rel=0.01)

    def test_cell_boundaries_agree_with_the_lookup(self, geonames_dir):
        # Sample the viewport and check every point's cell membership matches what
        # _raw_lookup says, to within the grid step the trace is accurate to.
        from geotagger.geometry import point_in_polygon

        _write_geonames_files(geonames_dir, [self.SMALL, self.BIG])
        min_lat, max_lat, min_lng, max_lng = self.BBOX
        cells, _ = geocode.voronoi_cells(*self.BBOX)
        rings = {c["city"]: c["polygons"] for c in cells}
        step = (max_lng - min_lng) / config.GEOCODE_BOUNDARY_GRID

        mismatches = 0
        checked = 0
        for i in range(1, 20):
            lat = min_lat + (max_lat - min_lat) * i / 20
            for j in range(1, 20):
                lng = min_lng + (max_lng - min_lng) * j / 20
                expected = geocode._raw_lookup(lat, lng)["city"]
                inside = [city for city, polys in rings.items()
                          if any(point_in_polygon(lat, lng, r) for r in polys)]
                # Points within one grid step of a boundary may land either side.
                near_boundary = any(
                    abs(lng - (-74.0 + d)) <= 2 * step for d in (0.0,)
                )
                checked += 1
                if inside != [expected] and not near_boundary:
                    mismatches += 1
        assert checked > 300
        assert mismatches == 0

    def test_grid_resolution_is_configurable(self, geonames_dir, monkeypatch):
        _write_geonames_files(geonames_dir, [self.SMALL, self.BIG])
        monkeypatch.setattr(config, "GEOCODE_BOUNDARY_GRID", 32)
        coarse, _ = geocode.voronoi_cells(*self.BBOX)
        monkeypatch.setattr(config, "GEOCODE_BOUNDARY_GRID", 256)
        fine, _ = geocode.voronoi_cells(*self.BBOX)
        # Both resolve the same two places; the finer grid can only place the
        # curved boundary more precisely, never differently.
        assert {c["city"] for c in coarse} == {c["city"] for c in fine} == {"Small", "Big"}
        coarse_area = self._area({c["city"]: c for c in coarse}["Small"])
        fine_area = self._area({c["city"]: c for c in fine}["Small"])
        assert fine_area == pytest.approx(coarse_area, rel=0.15)


class TestRingTracing:
    def test_single_cell_mask_traces_its_square(self):
        import numpy as np

        mask = np.zeros((3, 3), dtype=bool)
        mask[1, 1] = True
        rings = geocode._trace_mask_rings(mask)
        assert len(rings) == 1
        assert set(rings[0]) == {(1, 1), (1, 2), (2, 2), (2, 1)}

    def test_disjoint_blobs_trace_as_separate_rings(self):
        import numpy as np

        mask = np.zeros((5, 5), dtype=bool)
        mask[0, 0] = True
        mask[4, 4] = True
        assert len(geocode._trace_mask_rings(mask)) == 2

    def test_collinear_points_are_dropped(self):
        ring = [(0.0, 0.0), (0.0, 1.0), (0.0, 2.0), (1.0, 2.0), (1.0, 0.0)]
        assert geocode._drop_collinear(ring) == [(0.0, 0.0), (0.0, 2.0), (1.0, 2.0), (1.0, 0.0)]

    def test_simplify_keeps_the_shape_within_tolerance(self):
        # A staircase along a diagonal collapses toward the diagonal itself.
        ring = [(0.0, 0.0), (0.0, 0.1), (0.1, 0.1), (0.1, 0.2), (0.2, 0.2), (0.2, 0.0)]
        simplified = geocode._simplify_ring(ring, 0.06)
        assert 3 <= len(simplified) < len(ring)

    def test_simplify_never_degenerates_a_ring(self):
        # A tolerance coarser than the shape itself would collapse it to a line;
        # the original ring is returned instead of something unrenderable.
        ring = [(0.0, 0.0), (0.0, 0.1), (0.1, 0.1), (0.1, 0.2), (0.2, 0.2), (0.2, 0.0)]
        assert geocode._simplify_ring(ring, 10.0) == ring


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


class TestCensusInTheCityChain:
    """The city chain is OSM containment -> Census containment -> GeoNames estimate.
    Census only ever displaces the GeoNames guess, never an OSM boundary."""

    def test_census_beats_the_geonames_estimate(self, geonames_dir, osm_db, census_db):
        _write_geonames_files(geonames_dir, [CITY_A])  # Testville @ (40,-74)
        osm_db([dict(name="Elsewhere", category="city", admin_level=8, area=1.0,
                     polygons=_rect(10.0, 11.0, 10.0, 11.0))])
        census_db([{"name": "CensusPlace", "kind": "CDP", "state_fp": "36", "state": "New York",
                    "polygons": _rect(39.9, 40.1, -74.1, -73.9)}])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "CensusPlace"
        assert r["state"] == "New York"
        assert r["sublocation"] is None       # census file has no sub-features

    def test_osm_city_still_wins_over_census(self, geonames_dir, osm_db, census_db):
        _write_geonames_files(geonames_dir, [CITY_A])
        osm_db([dict(name="OsmCity", category="city", admin_level=8, area=1.0,
                     polygons=_rect(39.9, 40.1, -74.1, -73.9))])
        census_db([{"name": "CensusPlace", "polygons": _rect(39.9, 40.1, -74.1, -73.9)}])
        assert geocode.lookup(40.0, -74.0)["city"] == "OsmCity"

    def test_census_applies_even_with_the_geonames_fallback_disabled(
            self, geonames_dir, osm_db, census_db, monkeypatch):
        # OSM_CITY_FALLBACK_GEONAMES governs the *distance estimate*; census
        # containment is a real answer, so it still applies.
        monkeypatch.setattr(geocode.config, "OSM_CITY_FALLBACK_GEONAMES", False)
        _write_geonames_files(geonames_dir, [CITY_A])
        osm_db([dict(name="Elsewhere", category="city", admin_level=8, area=1.0,
                     polygons=_rect(10.0, 11.0, 10.0, 11.0))])
        census_db([{"name": "CensusPlace", "polygons": _rect(39.9, 40.1, -74.1, -73.9)}])
        assert geocode.lookup(40.0, -74.0)["city"] == "CensusPlace"

    def test_geonames_still_used_where_census_has_no_place(self, geonames_dir, census_db):
        _write_geonames_files(geonames_dir, [CITY_A])
        census_db([{"name": "CensusPlace", "polygons": _rect(10.0, 11.0, 10.0, 11.0)}])
        assert geocode.lookup(40.001, -74.001)["city"] == "Testville"

    def test_census_alone_can_name_a_point(self, census_db):
        # No GeoNames data and no OSM DB: census containment is the only source, and
        # it still produces a city rather than the whole lookup returning None.
        census_db([{"name": "CensusPlace", "polygons": _rect(39.9, 40.1, -74.1, -73.9)}])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "CensusPlace"
        # The place's own state (the fixture's default, Texas) — no GeoNames needed.
        assert r["state"] == "Texas"
        assert r["country_code"] == "US"
        # Named from the static table, spelled as GeoNames spells it (audit G7).
        assert r["country"] == "United States"

    def test_census_alone_names_a_territory_country(self, census_db):
        census_db([{"name": "San Juan", "state_fp": "72", "state": "Puerto Rico",
                    "polygons": _rect(18.3, 18.5, -66.2, -66.0)}])
        r = geocode.lookup(18.4, -66.1)
        assert r["city"] == "San Juan"
        assert (r["country_code"], r["country"]) == ("PR", "Puerto Rico")

    def test_osm_alone_gives_a_city_and_no_country(self, osm_db):
        # The OSM DB has no state/country polygons, so with nothing else installed
        # the hierarchy is simply unknown — not an error, not a guess.
        osm_db([dict(name="OsmCity", category="city", admin_level=8, area=1.0,
                     polygons=_rect(39.9, 40.1, -74.1, -73.9))])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "OsmCity"
        assert r["state"] is None and r["country"] is None and r["country_code"] is None
        assert geocode.lookup(10.0, 10.0) is None    # outside every polygon

    def test_nothing_installed_still_returns_none(self, geonames_dir):
        assert geocode.lookup(40.0, -74.0) is None


class TestZctaInTheCityChain:
    """The ZIP's mailing city sits below Census place containment and above the
    GeoNames distance estimate; the ZIP code itself is returned regardless."""

    ZCTA = {"zip": "10001", "city": "PostalCity", "state": "New York",
            "state_code": "NY", "polygons": _rect(39.9, 40.1, -74.1, -73.9)}

    def test_postal_code_is_returned_whoever_wins_the_city(self, geonames_dir, osm_db, census_db):
        _write_geonames_files(geonames_dir, [CITY_A])
        osm_db([dict(name="OsmCity", category="city", admin_level=8, area=1.0,
                     polygons=_rect(39.9, 40.1, -74.1, -73.9))])
        census_db([], zctas=[self.ZCTA])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "OsmCity"          # OSM still wins
        assert r["postal_code"] == "10001"     # ZIP rides along anyway

    def test_zip_city_beats_the_geonames_estimate(self, geonames_dir, census_db):
        _write_geonames_files(geonames_dir, [CITY_A])
        census_db([], zctas=[self.ZCTA])
        assert geocode.lookup(40.0, -74.0)["city"] == "PostalCity"

    def test_census_place_beats_the_zip_city(self, geonames_dir, census_db):
        _write_geonames_files(geonames_dir, [CITY_A])
        census_db([{"name": "CensusPlace", "polygons": _rect(39.9, 40.1, -74.1, -73.9)}],
                  zctas=[self.ZCTA])
        assert geocode.lookup(40.0, -74.0)["city"] == "CensusPlace"

    def test_fallback_can_be_disabled_without_losing_the_zip(self, geonames_dir, census_db,
                                                             monkeypatch):
        # Rural ZIPs are named for whichever small post office serves them, so this
        # switch exists; it must not also suppress the stored ZIP code.
        monkeypatch.setattr(geocode.config, "ZCTA_CITY_FALLBACK", False)
        _write_geonames_files(geonames_dir, [CITY_A])
        census_db([], zctas=[self.ZCTA])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "Testville"        # back to the GeoNames estimate
        assert r["postal_code"] == "10001"

    def test_zip_without_a_city_name_does_not_win(self, geonames_dir, census_db):
        _write_geonames_files(geonames_dir, [CITY_A])
        census_db([], zctas=[{"zip": "10001", "polygons": _rect(39.9, 40.1, -74.1, -73.9)}])
        r = geocode.lookup(40.0, -74.0)
        assert r["city"] == "Testville"
        assert r["postal_code"] == "10001"


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
        assert index.get_cached_geocode(qlat, qlng, version=geocode.cache_version()) == result

    def test_lookup_reads_from_cache_before_the_kd_tree(self, geonames_dir, db):
        _write_geonames_files(geonames_dir, [CITY_A])
        qlat, qlng = geocode.quantize(40.001, -74.001)
        index.put_cached_geocode(qlat, qlng, {
            "city": "CachedCity", "state": None, "county": None,
            "country": None, "country_code": None,
        }, version=geocode.cache_version())
        result = geocode.lookup(40.001, -74.001)
        assert result["city"] == "CachedCity"

    def test_use_cache_false_bypasses_and_does_not_populate_cache(self, geonames_dir, db):
        _write_geonames_files(geonames_dir, [CITY_A])
        qlat, qlng = geocode.quantize(40.001, -74.001)
        index.put_cached_geocode(qlat, qlng, {
            "city": "CachedCity", "state": None, "county": None,
            "country": None, "country_code": None,
        }, version=geocode.cache_version())
        result = geocode.lookup(40.001, -74.001, use_cache=False)
        assert result["city"] == "Testville"
        # The stale cache entry is left untouched, not overwritten.
        assert index.get_cached_geocode(qlat, qlng, version=geocode.cache_version())["city"] == "CachedCity"


# ── Admin fields follow the city's source (audit G6) ──

def _write_border_geonames(dir_, cities):
    """GeoNames files for the border cases below: their own admin1/admin2/country
    tables, since the shared ones only know NY/CA/Ontario."""
    (dir_ / "cities500.txt").write_text(
        "\n".join(_city_row(**c) for c in cities) + "\n", encoding="utf-8")
    (dir_ / "admin1CodesASCII.txt").write_text(
        "US.WA\tWashington\tWashington\t1\n"
        "US.ID\tIdaho\tIdaho\t2\n"
        "US.VT\tVermont\tVermont\t3\n"
        "US.TX\tTexas\tTexas\t4\n"
        "US.AR\tArkansas\tArkansas\t5\n"
        "US.DC\tWashington, D.C.\tWashington, D.C.\t6\n"
        "CA.02\tBritish Columbia\tBritish Columbia\t7\n"
        "CA.10\tQuebec\tQuebec\t8\n"
        "PR.21\tSan Juan\tSan Juan\t9\n",
        encoding="utf-8")
    (dir_ / "admin2Codes.txt").write_text(
        "US.WA.063\tSpokane County\tSpokane County\t10\n"
        "US.ID.055\tKootenai County\tKootenai County\t11\n"
        "US.WA.073\tWhatcom County\tWhatcom County\t12\n"
        "US.TX.037\tBowie County\tBowie County\t13\n"
        "US.AR.091\tMiller County\tMiller County\t14\n",
        encoding="utf-8")
    (dir_ / "countryInfo.txt").write_text(
        "US\tUSA\t840\tUS\tUnited States\tWashington\n"
        "CA\tCAN\t124\tCA\tCanada\tOttawa\n"
        "PR\tPRI\t630\tRQ\tPuerto Rico\tSan Juan\n",
        encoding="utf-8")


# Washington / Idaho line near Post Falls: the WA town is the nearer GeoNames point.
SPOKANE_VALLEY = dict(geonameid=10, name="Spokane Valley", lat=47.70, lng=-117.05,
                      cc="US", admin1="WA", admin2="063", population=1000)
RATHDRUM = dict(geonameid=11, name="Rathdrum", lat=47.70, lng=-116.90,
                cc="US", admin1="ID", admin2="055", population=1000)
# US / Canada line: White Rock BC is the nearer point to a spot in Blaine WA.
WHITE_ROCK = dict(geonameid=12, name="White Rock", lat=49.02, lng=-122.80,
                  cc="CA", admin1="02", population=1000)
BLAINE = dict(geonameid=13, name="Blaine", lat=48.96, lng=-122.75,
              cc="US", admin1="WA", admin2="073", population=1000)
# Quebec / Vermont line: Derby Line VT is the nearer point to a spot in Stanstead QC.
DERBY_LINE = dict(geonameid=14, name="Derby Line", lat=45.00, lng=-72.10,
                  cc="US", admin1="VT", population=1000)
STANSTEAD = dict(geonameid=15, name="Stanstead", lat=45.04, lng=-72.10,
                 cc="CA", admin1="10", population=1000)
# Texarkana: one name, two states.
TEXARKANA_TX = dict(geonameid=16, name="Texarkana", lat=33.43, lng=-94.06,
                    cc="US", admin1="TX", admin2="037", population=1000)
TEXARKANA_AR = dict(geonameid=17, name="Texarkana", lat=33.44, lng=-94.00,
                    cc="US", admin1="AR", admin2="091", population=1000)


class TestAdminFollowsTheCity:
    """State/country come from the polygon that supplied the city, not from whichever
    GeoNames point happens to be nearest; near a border that is often across it."""

    def test_census_city_takes_the_census_state_not_the_nearest_points(
            self, geonames_dir, census_db):
        _write_border_geonames(geonames_dir, [SPOKANE_VALLEY, RATHDRUM])
        census_db([{"name": "Post Falls", "state_fp": "16", "state": "Idaho",
                    "polygons": _rect(47.69, 47.71, -117.01, -116.99)}])
        r = geocode.lookup(47.70, -117.00)        # Spokane Valley WA is nearest
        assert r["city"] == "Post Falls"
        assert r["state"] == "Idaho"
        assert r["county"] == "Kootenai County"   # nearest GeoNames place *in Idaho*
        assert r["country"] == "United States"
        assert r["country_code"] == "US"

    def test_census_city_by_the_canadian_border_stays_in_the_us(self, geonames_dir, census_db):
        _write_border_geonames(geonames_dir, [WHITE_ROCK, BLAINE])
        census_db([{"name": "Blaine", "state_fp": "53", "state": "Washington",
                    "polygons": _rect(48.99, 49.01, -122.79, -122.77)}])
        r = geocode.lookup(49.00, -122.78)         # White Rock BC is nearest
        assert (r["city"], r["state"], r["county"]) == ("Blaine", "Washington", "Whatcom County")
        assert (r["country"], r["country_code"]) == ("United States", "US")

    def test_census_state_is_normalised_to_the_geonames_name(self, geonames_dir, census_db):
        # The FIPS code maps onto GeoNames' admin1 code, so the stored name matches
        # what a GeoNames-only lookup in the same state would have said.
        _write_border_geonames(geonames_dir, [BLAINE])
        census_db([{"name": "Washington", "state_fp": "11", "state": "District of Columbia",
                    "polygons": _rect(38.8, 39.0, -77.2, -76.9)}])
        assert geocode.lookup(38.9, -77.03)["state"] == "Washington, D.C."

    def test_territory_census_place_gets_its_own_country(self, geonames_dir, census_db):
        _write_border_geonames(geonames_dir, [
            dict(geonameid=18, name="San Juan", lat=18.46, lng=-66.10, cc="PR", admin1="21",
                 population=1000)])
        census_db([{"name": "San Juan", "state_fp": "72", "state": "Puerto Rico",
                    "polygons": _rect(18.4, 18.5, -66.2, -66.0)}])
        r = geocode.lookup(18.45, -66.1)
        assert (r["country"], r["country_code"], r["state"]) == ("Puerto Rico", "PR", "San Juan")

    def test_zip_city_takes_the_zips_state(self, geonames_dir, census_db):
        _write_border_geonames(geonames_dir, [SPOKANE_VALLEY, RATHDRUM])
        census_db([], zctas=[{"zip": "83854", "city": "Post Falls", "state": "Idaho",
                              "state_code": "ID",
                              "polygons": _rect(47.69, 47.71, -117.01, -116.99)}])
        r = geocode.lookup(47.70, -117.00)
        assert (r["city"], r["state"], r["county"]) == ("Post Falls", "Idaho", "Kootenai County")

    def test_geonames_fallback_city_is_picked_inside_the_containing_state(
            self, geonames_dir, census_db, monkeypatch):
        # With the ZIP city switched off the city is the GeoNames estimate, but the ZIP
        # still says which state the point is in: the estimate is the nearest place in
        # *that* state, so city and state agree.
        monkeypatch.setattr(geocode.config, "ZCTA_CITY_FALLBACK", False)
        _write_border_geonames(geonames_dir, [SPOKANE_VALLEY, RATHDRUM])
        census_db([], zctas=[{"zip": "83854", "city": "Post Falls", "state": "Idaho",
                              "state_code": "ID",
                              "polygons": _rect(47.69, 47.71, -117.01, -116.99)}])
        r = geocode.lookup(47.70, -117.00)
        assert (r["city"], r["state"], r["postal_code"]) == ("Rathdrum", "Idaho", "83854")

    def test_osm_city_takes_the_state_of_the_same_named_geonames_place(self, geonames_dir, osm_db):
        _write_border_geonames(geonames_dir, [DERBY_LINE, STANSTEAD])
        osm_db([dict(name="Stanstead", category="city", admin_level=8, area=1.0,
                     polygons=_rect(45.00, 45.02, -72.11, -72.09))])
        r = geocode.lookup(45.01, -72.10)          # Derby Line VT is nearest
        assert r["city"] == "Stanstead"
        assert (r["state"], r["country"], r["country_code"]) == ("Quebec", "Canada", "CA")

    def test_osm_city_outranks_a_census_border_sliver_in_another_country(
            self, geonames_dir, osm_db, census_db):
        # Generalised Census polygons overhang the national border slightly; the OSM
        # city's own Canadian record wins over that sliver.
        _write_border_geonames(geonames_dir, [DERBY_LINE, STANSTEAD])
        osm_db([dict(name="Stanstead", category="city", admin_level=8, area=1.0,
                     polygons=_rect(45.00, 45.02, -72.11, -72.09))])
        census_db([{"name": "Derby Line", "state_fp": "50", "state": "Vermont",
                    "polygons": _rect(44.99, 45.015, -72.12, -72.08)}])
        r = geocode.lookup(45.01, -72.10)
        assert (r["city"], r["state"], r["country_code"]) == ("Stanstead", "Quebec", "CA")

    def test_osm_city_in_the_us_still_takes_the_census_state(self, geonames_dir, osm_db, census_db):
        # Same name on both sides of a state line: containment decides which one.
        _write_border_geonames(geonames_dir, [TEXARKANA_TX, TEXARKANA_AR])
        osm_db([dict(name="Texarkana", category="city", admin_level=8, area=1.0,
                     polygons=_rect(33.42, 33.46, -94.04, -93.98))])
        census_db([{"name": "Texarkana", "state_fp": "05", "state": "Arkansas",
                    "polygons": _rect(33.42, 33.46, -94.04, -93.98)}])
        r = geocode.lookup(33.43, -94.035)        # Texarkana TX is the nearer point
        assert (r["state"], r["county"]) == ("Arkansas", "Miller County")

    def test_osm_city_without_a_geonames_namesake_keeps_the_nearest_points_admin(
            self, geonames_dir, osm_db):
        _write_border_geonames(geonames_dir, [DERBY_LINE, STANSTEAD])
        osm_db([dict(name="Rock Island", category="city", admin_level=8, area=1.0,
                     polygons=_rect(45.00, 45.02, -72.11, -72.09))])
        r = geocode.lookup(45.01, -72.10)
        assert (r["city"], r["state"], r["country_code"]) == ("Rock Island", "Vermont", "US")

    def test_a_far_away_namesake_is_not_taken_for_the_osm_city(self, geonames_dir, osm_db):
        _write_border_geonames(geonames_dir, [DERBY_LINE, dict(STANSTEAD, lat=46.5)])  # ~165 km
        osm_db([dict(name="Stanstead", category="city", admin_level=8, area=1.0,
                     polygons=_rect(45.00, 45.02, -72.11, -72.09))])
        assert geocode.lookup(45.01, -72.10)["state"] == "Vermont"

    def test_osm_name_match_ignores_case_accents_and_city_of(self):
        assert geocode._norm_name("Montréal") == geocode._norm_name("MONTREAL")
        assert geocode._norm_name("City of Bristol") == geocode._norm_name("Bristol")
        assert geocode._norm_name("Winston-Salem") == geocode._norm_name("Winston Salem")

    def test_geonames_only_lookup_is_unchanged(self, geonames_dir):
        # No polygons installed: every field still comes from the one nearest record.
        _write_border_geonames(geonames_dir, [SPOKANE_VALLEY, RATHDRUM])
        r = geocode.lookup(47.70, -117.00)
        assert (r["city"], r["state"], r["county"], r["country_code"]) == (
            "Spokane Valley", "Washington", "Spokane County", "US")
