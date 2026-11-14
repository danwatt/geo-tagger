"""US Census place boundaries: the shapefile -> SQLite build (census_builder) and
the containment lookup (census_places). The place this source occupies in the city
chain (OSM -> Census -> GeoNames) is covered in test_geocode.py's TestMergedLookup."""

import sqlite3
import sys

import pytest

from geotagger import census_builder, census_places, config


def _rect(min_lat, max_lat, min_lng, max_lng):
    """Stored ring format for an axis-aligned box: [[outer, []]]."""
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return [[outer, []]]


# ── Shapefile geometry conversion ──

class _Shape:
    """Minimal stand-in for a pyshp polygon shape (points in x=lng, y=lat order,
    split into rings by `parts`) — the two attributes _shape_to_polygons reads."""

    def __init__(self, points, parts=(0,)):
        self.points = points
        self.parts = list(parts)


# Clockwise in (lng, lat) space = outer ring per the shapefile spec; the same box
# counter-clockwise is a hole.
_CW_BOX = [(-96.0, 30.0), (-96.0, 31.0), (-95.0, 31.0), (-95.0, 30.0), (-96.0, 30.0)]
_CCW_INNER = [(-95.6, 30.4), (-95.4, 30.4), (-95.4, 30.6), (-95.6, 30.6), (-95.6, 30.4)]


class TestShapeToPolygons:
    def test_single_ring_becomes_one_outer_ring(self):
        polygons = census_builder._shape_to_polygons(_Shape(_CW_BOX))
        assert len(polygons) == 1
        outer, holes = polygons[0]
        assert holes == []
        # Stored as [lat, lng], the opposite of the shapefile's point order.
        assert outer[0] == [30.0, -96.0]

    def test_counter_clockwise_ring_becomes_a_hole(self):
        shape = _Shape(_CW_BOX + _CCW_INNER, parts=(0, len(_CW_BOX)))
        polygons = census_builder._shape_to_polygons(shape)
        assert len(polygons) == 1
        _outer, holes = polygons[0]
        assert len(holes) == 1

    def test_two_clockwise_rings_become_two_polygons(self):
        far = [(-90.0, 40.0), (-90.0, 41.0), (-89.0, 41.0), (-89.0, 40.0), (-90.0, 40.0)]
        shape = _Shape(_CW_BOX + far, parts=(0, len(_CW_BOX)))
        assert len(census_builder._shape_to_polygons(shape)) == 2

    def test_degenerate_rings_are_dropped(self):
        assert census_builder._shape_to_polygons(_Shape([])) == []
        assert census_builder._shape_to_polygons(_Shape([(0.0, 0.0), (1.0, 1.0)])) == []

    def test_hole_before_any_outer_ring_is_kept_as_an_outer_ring(self):
        # Malformed input (a leading CCW ring); better to keep the geometry than to
        # silently drop the whole place.
        polygons = census_builder._shape_to_polygons(_Shape(_CCW_INNER))
        assert len(polygons) == 1
        assert polygons[0][1] == []


# ── Build from a real shapefile ──

@pytest.fixture
def cb_zip(tmp_path):
    """A real cb_*_us_place_500k-shaped zip written with pyshp: two places, one of
    them a CDP with a hole."""
    import io
    import zipfile

    import shapefile

    shp, dbf, shx = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, dbf=dbf, shx=shx)
    w.field("STATEFP", "C", 2)
    w.field("PLACEFP", "C", 5)
    w.field("GEOID", "C", 7)
    w.field("NAME", "C", 100)
    w.field("NAMELSAD", "C", 100)
    w.field("LSAD", "C", 2)
    w.field("STATE_NAME", "C", 100)

    w.poly([[list(p) for p in _CW_BOX], [list(p) for p in _CCW_INNER]])
    w.record("48", "35000", "4835000", "Bigtown", "Bigtown city", "25", "Texas")

    small = [(-95.9, 30.1), (-95.9, 30.2), (-95.8, 30.2), (-95.8, 30.1), (-95.9, 30.1)]
    w.poly([[list(p) for p in small]])
    w.record("48", "12345", "4812345", "Smallplace", "Smallplace CDP", "57", "Texas")
    w.close()

    zip_path = tmp_path / "cb_2025_us_place_500k.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("cb_2025_us_place_500k.shp", shp.getvalue())
        zf.writestr("cb_2025_us_place_500k.dbf", dbf.getvalue())
        zf.writestr("cb_2025_us_place_500k.shx", shx.getvalue())
    return zip_path


class TestBuild:
    def test_builds_a_queryable_db(self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "out" / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        summary = census_builder.build(db_path, cb_zip)

        assert summary["total_places"] == 2
        assert summary["errors"] == 0
        assert summary["by_kind"] == {"city": 1, "CDP": 1}
        assert db_path.exists()

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        rows = {r["name"]: dict(r) for r in conn.execute(
            "SELECT name, name_lsad, lsad, kind, geoid, state_name FROM places")}
        assert rows["Bigtown"]["kind"] == "city"
        assert rows["Bigtown"]["geoid"] == "4835000"
        assert rows["Smallplace"]["kind"] == "CDP"
        assert rows["Smallplace"]["name_lsad"] == "Smallplace CDP"
        assert rows["Smallplace"]["state_name"] == "Texas"
        assert conn.execute("SELECT COUNT(*) FROM places_spatial").fetchone()[0] == 2
        meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        assert meta["source"] == cb_zip.name
        assert meta["total_places"] == "2"
        conn.close()

    def test_lookup_after_build_respects_holes(self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip)
        census_places.reset()

        # Inside Bigtown, outside its hole.
        assert census_places.lookup(30.9, -95.9)["city"] == "Bigtown"
        # Dead center of the hole — Bigtown's polygon excludes it.
        assert census_places.lookup(30.5, -95.5) is None
        # Smallplace sits inside Bigtown's bbox but is its own (smaller) polygon.
        assert census_places.lookup(30.15, -95.85)["city"] == "Smallplace"

    def test_rebuild_replaces_the_previous_db(self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip)
        first = db_path.stat().st_mtime_ns
        census_builder.build(db_path, cb_zip)
        conn = sqlite3.connect(str(db_path))
        # Still 2, not 4 — a rebuild replaces rather than appends.
        assert conn.execute("SELECT COUNT(*) FROM places").fetchone()[0] == 2
        conn.close()
        assert not db_path.with_suffix(db_path.suffix + ".tmp").exists()
        assert first is not None

    def test_rejects_an_archive_that_is_not_a_shapefile(self, tmp_path):
        import zipfile
        bad = tmp_path / "not-a-shapefile.zip"
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("readme.txt", "nope")
        with pytest.raises(ValueError, match="missing"):
            census_builder.build(tmp_path / "places.sqlite", bad)


@pytest.fixture
def zcta_zip(tmp_path):
    """A cb_*_us_zcta520_500k-shaped zip: two ZIP areas, fields named for the 2020
    vintage the real file uses."""
    import io
    import zipfile

    import shapefile

    shp, dbf, shx = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, dbf=dbf, shx=shx)
    w.field("ZCTA5CE20", "C", 5)
    w.field("GEOID20", "C", 5)
    w.field("NAME20", "C", 100)

    w.poly([[list(p) for p in _CW_BOX]])
    w.record("77070", "77070", "77070")
    small = [(-95.9, 30.1), (-95.9, 30.2), (-95.8, 30.2), (-95.8, 30.1), (-95.9, 30.1)]
    w.poly([[list(p) for p in small]])
    w.record("77429", "77429", "77429")
    w.close()

    zip_path = tmp_path / "cb_2020_us_zcta520_500k.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("cb_2020_us_zcta520_500k.shp", shp.getvalue())
        zf.writestr("cb_2020_us_zcta520_500k.dbf", dbf.getvalue())
        zf.writestr("cb_2020_us_zcta520_500k.shx", shx.getvalue())
    return zip_path


@pytest.fixture
def postal_zip(tmp_path):
    """GeoNames' US.zip shape: tab-separated US.txt, ZIP -> place/state."""
    import zipfile

    rows = [
        "US\t77070\tHouston\tTexas\tTX\tHarris\t201\t\t\t29.99\t-95.58\t4",
        "US\t77429\tCypress\tTexas\tTX\tHarris\t201\t\t\t29.96\t-95.69\t4",
        # A second name for an already-seen ZIP: GeoNames lists the USPS-preferred
        # name first, so this must not overwrite "Cypress".
        "US\t77429\tHouston\tTexas\tTX\tHarris\t201\t\t\t29.96\t-95.69\t4",
        "malformed row with no tabs",
    ]
    zip_path = tmp_path / "US.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("US.txt", "\n".join(rows) + "\n")
        zf.writestr("readme.txt", "ignore me")
    return zip_path


class TestBuildZctas:
    def test_loads_zctas_and_crosswalk(self, cb_zip, zcta_zip, postal_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        summary = census_builder.build(db_path, cb_zip, zcta_zip, postal_zip)
        assert summary["total_zctas"] == 2
        assert summary["total_zip_names"] == 2  # the duplicate ZIP row is ignored

        census_places.reset()
        got = census_places.postal_lookup(30.9, -95.9)
        assert got["postal_code"] == "77070"
        assert got["postal_city"] == "Houston"
        # First row for a ZIP wins, so 77429 keeps its preferred name.
        assert census_places.postal_lookup(30.15, -95.85)["postal_city"] == "Cypress"

    def test_places_only_build_leaves_the_zcta_layer_empty(self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        summary = census_builder.build(db_path, cb_zip)
        assert summary["total_zctas"] == 0
        census_places.reset()
        assert census_places.postal_lookup(30.9, -95.9) is None
        assert census_places.status()["places"] == 2

    def test_rebuild_without_zctas_drops_them(self, cb_zip, zcta_zip, postal_zip,
                                              tmp_path, monkeypatch):
        # A build is a full replace, so omitting a layer removes it — the reason the
        # download job always fetches all three.
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip, zcta_zip, postal_zip)
        census_builder.build(db_path, cb_zip)
        census_places.reset()
        assert census_places.status()["zctas"] == 0

    def test_rejects_a_shapefile_with_no_zcta_code_field(self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        # The *place* file has GEOID, so it isn't rejected on the field name — this is
        # about the archive having no ZCTA5CE*/GEOID* at all.
        import io
        import zipfile

        import shapefile
        shp, dbf, shx = io.BytesIO(), io.BytesIO(), io.BytesIO()
        w = shapefile.Writer(shp=shp, dbf=dbf, shx=shx)
        w.field("SOMETHING", "C", 5)
        w.poly([[list(p) for p in _CW_BOX]])
        w.record("x")
        w.close()
        bad = tmp_path / "bad_zcta.zip"
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("a.shp", shp.getvalue())
            zf.writestr("a.dbf", dbf.getvalue())
            zf.writestr("a.shx", shx.getvalue())
        with pytest.raises(ValueError, match="ZCTA5CE"):
            census_builder.build(db_path, cb_zip, bad)


class TestCbUrls:
    def test_newest_first_then_walks_back(self, monkeypatch):
        monkeypatch.setattr(config, "CENSUS_CB_YEAR", 2025)
        years = [y for y, _ in census_builder.cb_urls()]
        assert years == [2025, 2024, 2023]

    def test_url_shape(self):
        _year, url = census_builder.cb_urls(2025)[0]
        assert url.endswith("/GENZ2025/shp/cb_2025_us_place_500k.zip")

    def test_explicit_year_overrides_config(self, monkeypatch):
        monkeypatch.setattr(config, "CENSUS_CB_YEAR", 2025)
        assert [y for y, _ in census_builder.cb_urls(2020)] == [2020, 2019, 2018]

    def test_zcta_urls_use_their_own_vintage(self, monkeypatch):
        # ZCTAs are only published with the decennial series, so they don't follow the
        # yearly place-file vintage (GENZ2021..2025 have no ZCTA file at all).
        monkeypatch.setattr(config, "CENSUS_CB_YEAR", 2025)
        monkeypatch.setattr(config, "CENSUS_ZCTA_YEAR", 2020)
        year, url = census_builder.cb_zcta_urls()[0]
        assert year == 2020
        assert url.endswith("/GENZ2020/shp/cb_2020_us_zcta520_500k.zip")


# ── Lookup module ──

class TestAvailability:
    def test_unavailable_without_a_db(self):
        assert census_places.is_available() is False
        assert census_places.lookup(30.0, -95.0) is None
        st = census_places.status()
        assert st["state"] == "unavailable"
        assert st["error"] is not None
        assert st["places"] == 0

    def test_status_reports_counts_once_built(self, census_db):
        census_db([
            {"name": "Bigtown", "kind": "city", "polygons": _rect(30, 31, -96, -95)},
            {"name": "Smallplace", "kind": "CDP", "polygons": _rect(30, 30.1, -96, -95.9)},
        ])
        st = census_places.status()
        assert st["available"] is True
        assert st["state"] == "ready"
        assert st["places"] == 2
        assert st["by_kind"] == {"city": 1, "CDP": 1}

    def test_reset_reopens_whatever_is_on_disk(self, census_db):
        census_db([{"name": "Bigtown", "polygons": _rect(30, 31, -96, -95)}])
        assert census_places.lookup(30.5, -95.5)["city"] == "Bigtown"
        census_places.reset()
        assert census_places._state == "unloaded"
        assert census_places.lookup(30.5, -95.5)["city"] == "Bigtown"

    def test_load_failure_degrades_without_crashing(self, tmp_path, monkeypatch):
        broken = tmp_path / "broken.sqlite"
        broken.write_bytes(b"this is not a database")
        monkeypatch.setattr(config, "CENSUS_DB_PATH", broken)
        census_places.reset()
        assert census_places.lookup(30.0, -95.0) is None
        assert census_places.status()["state"] == "unavailable"


class TestLookup:
    def test_none_coordinates_return_none(self, census_db):
        census_db([{"name": "Bigtown", "polygons": _rect(30, 31, -96, -95)}])
        assert census_places.lookup(None, -95.0) is None
        assert census_places.lookup(30.0, None) is None

    def test_point_outside_every_place_returns_none(self, census_db):
        census_db([{"name": "Bigtown", "polygons": _rect(30, 31, -96, -95)}])
        assert census_places.lookup(40.0, -80.0) is None

    def test_returns_name_kind_and_geoid(self, census_db):
        census_db([{"name": "Cypress", "kind": "CDP", "geoid": "4818610",
                    "polygons": _rect(29.9, 30.1, -95.8, -95.6)}])
        got = census_places.lookup(30.0, -95.7)
        assert got["city"] == "Cypress"
        assert got["kind"] == "CDP"
        assert got["geoid"] == "4818610"
        assert got["state"] == "Texas"

    def test_smallest_containing_polygon_wins_an_overlap(self, census_db):
        # 1:500,000 generalization can leave two places overlapping slightly; the
        # smaller one is the more specific answer.
        census_db([
            {"name": "Big", "area": 1.0, "polygons": _rect(30, 31, -96, -95)},
            {"name": "Small", "area": 0.01, "polygons": _rect(30.4, 30.6, -95.6, -95.4)},
        ])
        assert census_places.lookup(30.5, -95.5)["city"] == "Small"

    def test_bbox_candidate_that_does_not_contain_the_point_is_rejected(self, census_db):
        # An L-shaped place: the point sits in the bbox but outside the polygon, so
        # only the exact point-in-polygon test can rule it out.
        outer = [[30.0, -96.0], [31.0, -96.0], [31.0, -95.8], [30.2, -95.8],
                 [30.2, -95.0], [30.0, -95.0]]
        census_db([{"name": "Lshape", "polygons": [[outer, []]]}])
        assert census_places.lookup(30.1, -95.5)["city"] == "Lshape"
        assert census_places.lookup(30.9, -95.4) is None


class TestPostalLookup:
    def test_none_when_no_db(self):
        assert census_places.postal_lookup(30.0, -95.0) is None

    def test_none_coordinates(self, census_db):
        census_db([], zctas=[{"zip": "77070", "polygons": _rect(30, 31, -96, -95)}])
        assert census_places.postal_lookup(None, -95.0) is None

    def test_returns_zip_and_crosswalk_city(self, census_db):
        census_db([], zctas=[{"zip": "77070", "city": "Houston",
                              "polygons": _rect(30, 31, -96, -95)}])
        got = census_places.postal_lookup(30.5, -95.5)
        assert got == {"postal_code": "77070", "postal_city": "Houston",
                       "state": "Texas", "state_code": "TX"}

    def test_zip_without_a_crosswalk_row_still_returns_the_code(self, census_db):
        census_db([], zctas=[{"zip": "99999", "polygons": _rect(30, 31, -96, -95)}])
        got = census_places.postal_lookup(30.5, -95.5)
        assert got["postal_code"] == "99999"
        assert got["postal_city"] is None

    def test_point_outside_every_zcta(self, census_db):
        census_db([], zctas=[{"zip": "77070", "polygons": _rect(30, 31, -96, -95)}])
        assert census_places.postal_lookup(45.0, -70.0) is None

    def test_smallest_zcta_wins_a_sliver_overlap(self, census_db):
        census_db([], zctas=[
            {"zip": "11111", "area": 1.0, "polygons": _rect(30, 31, -96, -95)},
            {"zip": "22222", "area": 0.01, "polygons": _rect(30.4, 30.6, -95.6, -95.4)},
        ])
        assert census_places.postal_lookup(30.5, -95.5)["postal_code"] == "22222"

    def test_places_only_db_has_no_zcta_layer(self, census_db, tmp_path, monkeypatch):
        # A DB built before ZCTAs existed: postal_lookup must return None rather than
        # raising "no such table" on every geocode.
        import sqlite3
        db_path = tmp_path / "old-census.sqlite"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE places (id INTEGER PRIMARY KEY, geoid TEXT, name TEXT, "
                     "name_lsad TEXT, lsad TEXT, kind TEXT, state_fp TEXT, state_name TEXT, "
                     "area REAL, min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL, rings TEXT)")
        conn.execute("CREATE VIRTUAL TABLE places_spatial USING rtree(id, min_lat, max_lat, min_lng, max_lng)")
        conn.commit()
        conn.close()
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_places.reset()
        assert census_places.postal_lookup(30.5, -95.5) is None
        st = census_places.status()
        assert st["state"] == "ready"
        assert st["zctas"] == 0


class _ClearConnOnFirstQuery:
    """Stands in for the module's _conn. On its first execute() it does the step of
    reset() that breaks readers (sets the module's _conn to None) just before the query
    runs, i.e. the window between a lookup's availability check and its read."""

    def __init__(self, real):
        self._real = real
        self.armed = True

    def execute(self, sql, *args):
        if self.armed:
            self.armed = False
            census_places._conn = None
        return self._real.execute(sql, *args)


class TestZctaProbeAndReset:
    def test_zcta_probe_runs_once_at_load_not_per_lookup(self, census_db):
        census_db([], zctas=[{"zip": "77070", "polygons": _rect(30, 31, -96, -95)}])
        census_places.reset()
        census_places._ensure_loaded()
        assert census_places._zctas_present is True

        statements = []
        census_places._conn.set_trace_callback(statements.append)
        try:
            for _ in range(5):
                assert census_places.postal_lookup(30.5, -95.5)["postal_code"] == "77070"
        finally:
            census_places._conn.set_trace_callback(None)
        # The trace must actually fire, or the absence check below proves nothing.
        assert any("zctas_spatial" in s for s in statements)
        assert not [s for s in statements if "sqlite_master" in s]

    def test_lookup_racing_reset_between_check_and_read_does_not_raise(self, census_db):
        census_db([], zctas=[{"zip": "77070", "city": "Houston",
                              "polygons": _rect(30, 31, -96, -95)}])
        census_places.reset()
        census_places._ensure_loaded()
        real = census_places._conn
        census_places._conn = _ClearConnOnFirstQuery(real)
        try:
            # The handle was cleared mid-lookup; the lookup holds its own reference from
            # inside the lock, so it completes with the correct answer instead of raising
            # AttributeError on None.
            got = census_places.postal_lookup(30.5, -95.5)
        finally:
            census_places._conn = real
        assert got["postal_code"] == "77070"

    @pytest.mark.parametrize("lookup, not_available", [
        (lambda: census_places.lookup(30.5, -95.5), None),
        (lambda: census_places.postal_lookup(30.5, -95.5), None),
        (lambda: census_places.places_in_bbox(30, 31, -96, -95), ([], 0)),
        (lambda: census_places.zctas_in_bbox(30, 31, -96, -95), ([], 0)),
    ], ids=["lookup", "postal_lookup", "places_in_bbox", "zctas_in_bbox"])
    def test_reset_before_locked_read_returns_not_available(
            self, census_db, monkeypatch, lookup, not_available):
        # reset() runs after _ensure_loaded() has returned, so the locked section finds
        # no connection and must return the same result as "DB absent".
        census_db([{"name": "Bigtown", "polygons": _rect(30, 31, -96, -95)}],
                  zctas=[{"zip": "77070", "polygons": _rect(30, 31, -96, -95)}])
        census_places.reset()
        real_ensure = census_places._ensure_loaded

        def ensure_then_reset():
            real_ensure()
            census_places.reset()

        monkeypatch.setattr(census_places, "_ensure_loaded", ensure_then_reset)
        assert lookup() == not_available


class TestPlacesInBbox:
    def test_empty_when_unavailable(self):
        assert census_places.places_in_bbox(30, 31, -96, -95) == ([], 0)

    def test_returns_overlapping_places_with_polygons(self, census_db):
        census_db([
            {"name": "Bigtown", "polygons": _rect(30, 31, -96, -95)},
            {"name": "Faraway", "polygons": _rect(40, 41, -80, -79)},
        ])
        places, total = census_places.places_in_bbox(30.4, 30.6, -95.6, -95.4)
        assert total == 1
        assert [p["name"] for p in places] == ["Bigtown"]
        assert places[0]["polygons"][0][0][0] == [30.0, -96.0]

    def test_caps_to_the_largest_by_area(self, census_db):
        census_db([
            {"name": "Big", "area": 5.0, "polygons": _rect(30, 31, -96, -95)},
            {"name": "Small", "area": 0.1, "polygons": _rect(30.4, 30.5, -95.6, -95.5)},
        ])
        places, total = census_places.places_in_bbox(30, 31, -96, -95, limit=1)
        assert total == 2
        assert [p["name"] for p in places] == ["Big"]

    def test_zctas_empty_when_unavailable(self):
        assert census_places.zctas_in_bbox(30, 31, -96, -95) == ([], 0)

    def test_zctas_returns_overlapping_areas_with_city(self, census_db):
        census_db([], zctas=[
            {"zip": "77070", "city": "Houston", "polygons": _rect(30, 31, -96, -95)},
            {"zip": "99999", "polygons": _rect(40, 41, -80, -79)},
        ])
        zctas, total = census_places.zctas_in_bbox(30.4, 30.6, -95.6, -95.4)
        assert total == 1
        assert zctas[0]["zip"] == "77070"
        assert zctas[0]["city"] == "Houston"
        assert zctas[0]["polygons"][0][0][0] == [30.0, -96.0]

    def test_zctas_caps_to_the_largest_by_area(self, census_db):
        census_db([], zctas=[
            {"zip": "11111", "area": 5.0, "polygons": _rect(30, 31, -96, -95)},
            {"zip": "22222", "area": 0.1, "polygons": _rect(30.4, 30.5, -95.6, -95.5)},
        ])
        zctas, total = census_places.zctas_in_bbox(30, 31, -96, -95, limit=1)
        assert total == 2
        assert [z["zip"] for z in zctas] == ["11111"]

    def test_zcta_geojson_feature_shape(self, census_db):
        census_db([], zctas=[{"zip": "77070", "city": "Houston",
                              "polygons": _rect(30, 31, -96, -95)}])
        zctas, _ = census_places.zctas_in_bbox(30, 31, -96, -95)
        feature = census_places.zcta_to_geojson_feature(zctas[0])
        assert feature["properties"]["zip"] == "77070"
        assert feature["properties"]["city"] == "Houston"
        assert feature["geometry"]["type"] == "MultiPolygon"
        ring = feature["geometry"]["coordinates"][0][0]
        assert ring[0] == [-96.0, 30.0]
        assert ring[0] == ring[-1]

    def test_geojson_feature_shape(self, census_db):
        census_db([{"name": "Bigtown", "kind": "city", "geoid": "4835000",
                    "polygons": _rect(30, 31, -96, -95)}])
        places, _ = census_places.places_in_bbox(30, 31, -96, -95)
        feature = census_places.place_to_geojson_feature(places[0])
        assert feature["type"] == "Feature"
        assert feature["properties"]["geoid"] == "4835000"
        assert feature["geometry"]["type"] == "MultiPolygon"
        ring = feature["geometry"]["coordinates"][0][0]
        # GeoJSON is lng/lat and rings must be closed.
        assert ring[0] == [-96.0, 30.0]
        assert ring[0] == ring[-1]


# ── Swapping a rebuild in under a running app (audit G4) ──

def _rename_places_during_build(monkeypatch, new_name: str, during=None):
    """Wrap census_builder._load_places so the build being written renames
    Bigtown -> new_name (telling the old DB from the new apart) and runs
    `during()` mid-build, while the .tmp is half-written and the live DB is
    still being served."""
    real = census_builder._load_places

    def load(db, zip_path, progress):
        out = real(db, zip_path, progress)
        db.execute("UPDATE places SET name=? WHERE name=?", (new_name, "Bigtown"))
        if during is not None:
            during()
        return out

    monkeypatch.setattr(census_builder, "_load_places", load)


BIGTOWN = (30.9, -95.9)


class TestSwap:
    def test_lookups_use_the_old_db_during_the_build_then_the_new_one(
            self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip)
        # The app's read connection stays open for the whole rebuild; on Windows
        # that is what used to make the final replace fail.
        assert census_places.lookup(*BIGTOWN)["city"] == "Bigtown"
        old_conn = census_places._conn
        seen = []

        def during():
            seen.append(census_places.lookup(*BIGTOWN)["city"])
            seen.append(census_places._conn is old_conn)

        _rename_places_during_build(monkeypatch, "Newbigtown", during)
        census_builder.build(db_path, cb_zip)

        assert seen == ["Bigtown", True]
        assert census_places._state == "unloaded" and census_places._conn is None
        assert census_places.lookup(*BIGTOWN)["city"] == "Newbigtown"
        assert not db_path.with_suffix(db_path.suffix + ".tmp").exists()

    def test_zcta_layer_switches_with_the_places(self, cb_zip, zcta_zip, tmp_path, monkeypatch):
        # One file holds every layer, so one swap moves them all, including the
        # _zctas_present probe, which must be redone for the new file: here the
        # rebuild drops the layer, so a stale True would query missing tables.
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip, zcta_zip)
        assert census_places.postal_lookup(*BIGTOWN)["postal_code"] == "77070"
        census_builder.build(db_path, cb_zip)
        assert census_places.postal_lookup(*BIGTOWN) is None
        assert census_places.lookup(*BIGTOWN)["city"] == "Bigtown"

    def test_swap_leaves_nothing_for_the_stat_check_to_redo(self, cb_zip, tmp_path, monkeypatch):
        # replace_db clears _sig with the handle and the next load fingerprints
        # the new file, so the G3 re-check finds no change and doesn't reset again.
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip)
        census_places.lookup(*BIGTOWN)
        census_builder.build(db_path, cb_zip)
        assert census_places.refresh_if_changed() is False
        census_places.lookup(*BIGTOWN)
        assert census_places._sig == census_places._signature()
        assert census_places.refresh_if_changed() is False

    def test_works_with_nothing_open_as_from_the_cli(self, cb_zip, tmp_path, monkeypatch):
        # scripts/get_census_places.py runs in its own process: no read handle,
        # and on a first install not even a file to replace.
        db_path = tmp_path / "out" / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        assert census_places._conn is None
        census_builder.build(db_path, cb_zip)
        assert census_places._conn is None
        _rename_places_during_build(monkeypatch, "Newbigtown")
        census_builder.build(db_path, cb_zip)
        assert census_places.lookup(*BIGTOWN)["city"] == "Newbigtown"

    def test_first_install_unlatches_unavailable(self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        assert census_places.lookup(*BIGTOWN) is None
        assert census_places._state == "unavailable"
        census_builder.build(db_path, cb_zip)
        assert census_places.lookup(*BIGTOWN)["city"] == "Bigtown"

    def test_failed_build_keeps_the_live_db_and_removes_the_tmp(
            self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip)
        assert census_places.lookup(*BIGTOWN)["city"] == "Bigtown"

        def boom():
            raise OSError("disk full")

        _rename_places_during_build(monkeypatch, "Newbigtown", boom)
        with pytest.raises(OSError, match="disk full"):
            census_builder.build(db_path, cb_zip)
        assert not db_path.with_suffix(db_path.suffix + ".tmp").exists()
        assert census_places._state == "ready"
        assert census_places.lookup(*BIGTOWN)["city"] == "Bigtown"

    @pytest.mark.skipif(sys.platform != "win32", reason="POSIX lets an open file be replaced")
    def test_another_process_holding_the_db_reports_and_keeps_the_build(
            self, cb_zip, tmp_path, monkeypatch):
        db_path = tmp_path / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        census_builder.build(db_path, cb_zip)
        before = db_path.read_bytes()
        _rename_places_during_build(monkeypatch, "Newbigtown")
        foreign = sqlite3.connect(str(db_path))  # e.g. a running app, when this is the CLI
        try:
            foreign.execute("SELECT COUNT(*) FROM places").fetchone()
            with pytest.raises(RuntimeError, match="another process"):
                census_builder.build(db_path, cb_zip)
        finally:
            foreign.close()
        tmp = db_path.with_suffix(db_path.suffix + ".tmp")
        assert tmp.exists()
        assert db_path.read_bytes() == before
        assert census_places.lookup(*BIGTOWN)["city"] == "Bigtown"
        # The kept build is complete: renaming it over, as the message says,
        # installs it.
        census_places.replace_db(tmp, db_path)
        assert census_places.lookup(*BIGTOWN)["city"] == "Newbigtown"


class TestCensusJob:
    def test_no_early_reset_and_the_version_moves_after_the_swap(
            self, cb_zip, db, tmp_path, monkeypatch):
        from geotagger import downloads, geocode
        from geotagger.services import data_service

        db_path = tmp_path / "census" / "places.sqlite"
        monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
        db_path.parent.mkdir()
        census_builder.build(db_path, cb_zip)
        for name in ("cb-place-500k.zip", "cb-zcta520-500k.zip", "geonames-us-postal.zip"):
            (db_path.parent / name).write_bytes(b"zip")
        monkeypatch.setattr(downloads, "zip_ok", lambda p: True)
        monkeypatch.setattr(census_builder, "cb_urls", lambda: [("x", "http://example.invalid")])
        assert census_places.lookup(*BIGTOWN)["city"] == "Bigtown"
        geocode.cache_version()

        events = []
        monkeypatch.setattr(census_places, "reset", lambda: events.append("reset"))
        real_replace = census_places.replace_db

        def replace_db(src, dest):
            events.append("swap")
            real_replace(src, dest)

        monkeypatch.setattr(census_places, "replace_db", replace_db)
        real_changed = geocode.datasets_changed

        def datasets_changed(*a, **k):
            # By the time the version moves, lookups must already read the new DB.
            events.append(("changed", census_places.lookup(*BIGTOWN)["city"]))
            out = real_changed(*a, **k)
            events.append(out["changed"])
            return out

        monkeypatch.setattr(geocode, "datasets_changed", datasets_changed)
        real_build = census_builder.build

        def build(db_path_, *a, **k):
            # Build the real thing from the fixture zip rather than the stub
            # archives. The live DB is still open and serving the old answer.
            events.append(("building", census_places.lookup(*BIGTOWN)["city"]))
            return real_build(db_path_, cb_zip, **k)

        monkeypatch.setattr(census_builder, "build", build)
        _rename_places_during_build(monkeypatch, "Newbigtown")
        data_service._run_census_download()

        assert data_service.census_job_status()["error"] is None
        assert events == [("building", "Bigtown"), "swap", ("changed", "Newbigtown"), True]
