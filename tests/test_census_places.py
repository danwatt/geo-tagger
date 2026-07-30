"""US Census place boundaries: the shapefile -> SQLite build (census_builder) and
the containment lookup (census_places). The place this source occupies in the city
chain (OSM -> Census -> GeoNames) is covered in test_geocode.py's TestMergedLookup."""

import sqlite3

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
