"""Audit G8: re-merging a region replaces that region's OSM places.

Each test writes tiny real .osm.pbf extracts with osmium's writer and merges them
with the real builder (osm_builder.build_or_append, append=True — what the Data
Management job does), then reads back through osm_places like the app does.
Features from a re-merged extract update in place; features gone from it are
deleted unless another ingested extract (adjacent GeoFabrik extracts overlap at
the border) still has them.
"""

import json
import sqlite3

import osmium

from geotagger import config, geocode, osm_builder, osm_places

D = 0.01  # square side, degrees


def _park(way_id: int, name: str, lat: float, lng: float, **tags) -> tuple:
    return way_id, name, lat, lng, {"leisure": "park", "name": name, **tags}


def _write_pbf(path, features: list[tuple]) -> None:
    """One closed-way area per feature: a D x D square with its SW corner at
    (lat, lng). Node ids derive from the way id, so the same feature written to
    two extracts is the same OSM object."""
    writer = osmium.SimpleWriter(str(path))
    nodes, ways = [], []
    for way_id, _name, lat, lng, tags in features:
        corners = [(lat, lng), (lat, lng + D), (lat + D, lng + D), (lat + D, lng)]
        ids = [way_id * 10 + i for i in range(4)]
        nodes += [(nid, c) for nid, c in zip(ids, corners)]
        ways.append((way_id, ids + ids[:1], tags))
    for nid, (lat, lng) in sorted(nodes):
        writer.add_node(osmium.osm.mutable.Node(id=nid, location=(lng, lat)))
    for way_id, refs, tags in sorted(ways):
        writer.add_way(osmium.osm.mutable.Way(id=way_id, nodes=refs, tags=tags))
    writer.close()


def _merge(tmp_path, file: str, features: list[tuple], version: int) -> dict:
    """Write `file` (a fresh copy each call, like a new GeoFabrik download) and
    merge it into the configured OSM DB."""
    d = tmp_path / f"v{version}"
    d.mkdir(exist_ok=True)
    pbf = d / file
    _write_pbf(pbf, features)
    return osm_builder.build_or_append(config.OSM_DB_PATH, [pbf], append=True)


def _rows(sql: str, *args) -> list[tuple]:
    conn = sqlite3.connect(str(config.OSM_DB_PATH))
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _names() -> set[str]:
    return {r[0] for r in _rows("SELECT name FROM places")}


def _spatial_in_sync() -> bool:
    """Every place has exactly one R*Tree entry and vice versa, with its bbox
    (the R*Tree stores 32-bit floats, hence the tolerance)."""
    rows = _rows("""SELECT p.id, s.id, p.min_lat, s.min_lat, p.max_lat, s.max_lat,
                           p.min_lng, s.min_lng, p.max_lng, s.max_lng
                    FROM places p LEFT JOIN places_spatial s ON s.id = p.id""")
    n_spatial = _rows("SELECT COUNT(*) FROM places_spatial")[0][0]
    if n_spatial != len(rows):
        return False
    return all(r[1] is not None and all(abs(r[i] - r[i + 1]) < 1e-5 for i in (2, 4, 6, 8))
               for r in rows)


A, B = "us_alpha-latest.osm.pbf", "us_beta-latest.osm.pbf"


class TestRemerge:
    def test_renamed_feature_serves_the_new_name(self, osm_db, tmp_path):
        _merge(tmp_path, A, [_park(1, "Old Name Park", 40.0, -75.0)], 1)
        assert osm_places.lookup(40.005, -74.995)["sublocation"] == "Old Name Park"
        summary = _merge(tmp_path, A, [_park(1, "New Name Park", 40.0, -75.0)], 2)
        assert osm_places.lookup(40.005, -74.995)["sublocation"] == "New Name Park"
        assert _names() == {"New Name Park"}
        assert summary["total_places"] == 1

    def test_moved_geometry_updates_rtree_and_containment(self, osm_db, tmp_path):
        _merge(tmp_path, A, [_park(1, "Drifting Park", 40.0, -75.0)], 1)
        old_id = _rows("SELECT id FROM places")[0][0]
        _merge(tmp_path, A, [_park(1, "Drifting Park", 41.0, -76.0)], 2)
        assert osm_places.lookup(40.005, -74.995) is None
        assert osm_places.lookup(41.005, -75.995)["sublocation"] == "Drifting Park"
        # Updated in place (stable id), with its R*Tree box moved — not a second entry.
        assert _rows("SELECT id FROM places") == [(old_id,)]
        assert _spatial_in_sync()
        box = _rows("SELECT min_lat, max_lat FROM places_spatial")[0]
        assert abs(box[0] - 41.0) < 1e-5 and abs(box[1] - 41.01) < 1e-5

    def test_feature_removed_from_extract_is_deleted(self, osm_db, tmp_path):
        _merge(tmp_path, A, [_park(1, "Stays Park", 40.0, -75.0),
                             _park(2, "Gone Park", 40.1, -75.0)], 1)
        summary = _merge(tmp_path, A, [_park(1, "Stays Park", 40.0, -75.0)], 2)
        assert _names() == {"Stays Park"}
        assert osm_places.lookup(40.105, -74.995) is None
        assert _spatial_in_sync()
        assert summary["total_places"] == 1

    def test_feature_shared_by_two_regions_survives_removal_from_one(self, osm_db, tmp_path):
        border = _park(5, "Border Park", 40.0, -75.0)
        _merge(tmp_path, A, [border, _park(1, "Alpha Park", 40.1, -75.0)], 1)
        _merge(tmp_path, B, [border, _park(2, "Beta Park", 40.2, -75.0)], 1)
        _merge(tmp_path, A, [_park(1, "Alpha Park", 40.1, -75.0)], 2)
        assert _names() == {"Border Park", "Alpha Park", "Beta Park"}
        assert osm_places.lookup(40.005, -74.995)["sublocation"] == "Border Park"
        # Once the last extract that had it drops it too, it goes.
        _merge(tmp_path, B, [_park(2, "Beta Park", 40.2, -75.0)], 2)
        assert _names() == {"Alpha Park", "Beta Park"}
        assert _spatial_in_sync()

    def test_region_is_listed_once_after_a_remerge(self, osm_db, tmp_path):
        _merge(tmp_path, A, [_park(1, "P", 40.0, -75.0)], 1)
        _merge(tmp_path, B, [_park(2, "Q", 40.1, -75.0)], 1)
        _merge(tmp_path, A, [_park(1, "P", 40.0, -75.0)], 2)
        regions = json.loads(_rows("SELECT value FROM meta WHERE key='regions'")[0][0])
        assert sorted(r["file"] for r in regions) == [A, B]

    def test_remerge_moves_the_geocode_cache_version(self, osm_db, tmp_path):
        # G2/G3 retire cached answers on a file size/mtime change; a re-merge
        # always swaps in a newly written file, so the version moves.
        _merge(tmp_path, A, [_park(1, "Old Name Park", 40.0, -75.0)], 1)
        before = geocode._compute_cache_version()
        _merge(tmp_path, A, [_park(1, "New Name Park", 40.0, -75.0)], 2)
        assert geocode._compute_cache_version() != before


def _strip_membership() -> None:
    """Turn the DB into one built before G8: no region membership tables."""
    conn = sqlite3.connect(str(config.OSM_DB_PATH))
    conn.execute("DROP TABLE place_regions")
    conn.execute("DROP TABLE osm_regions")
    conn.commit()
    conn.close()


class TestLegacyDb:
    def test_legacy_rows_belong_to_every_region_ingested_before(self, osm_db, tmp_path):
        # Old DB from two regions; which one each row came from is unknown.
        _merge(tmp_path, A, [_park(1, "Alpha Park", 40.0, -75.0),
                             _park(3, "Retired Park", 40.3, -75.0)], 1)
        _merge(tmp_path, B, [_park(2, "Beta Park", 40.1, -75.0)], 1)
        _strip_membership()

        # Re-merging A alone can't delete a row B might still have.
        _merge(tmp_path, A, [_park(1, "Alpha Park", 40.0, -75.0)], 2)
        assert _names() == {"Alpha Park", "Beta Park", "Retired Park"}
        # Once every legacy region has been re-merged, membership is exact and a
        # row no extract has any more is gone.
        _merge(tmp_path, B, [_park(2, "Beta Park", 40.1, -75.0)], 2)
        assert _names() == {"Alpha Park", "Beta Park"}
        assert _rows("SELECT COUNT(*) FROM place_regions WHERE region_id = 0") == [(0,)]
        assert json.loads(_rows("SELECT value FROM meta WHERE key='legacy_regions'")[0][0]) == []
        assert _spatial_in_sync()
        # ...and from here on a removal is applied on the first re-merge.
        _merge(tmp_path, A, [], 3)
        assert _names() == {"Beta Park"}

    def test_rows_with_no_recorded_region_are_kept(self, osm_db, tmp_path):
        # A DB with places but no meta 'regions' (provenance unknown): a re-merge
        # updates what it has and never deletes the rest.
        park = dict(name="Mystery Park", category="park", area=0.0001,
                    polygons=[[[[41.0, -76.0], [41.01, -76.0], [41.01, -75.99],
                                [41.0, -75.99]], []]])
        osm_db([park])  # stored as way 1, so the extract uses other ids
        _merge(tmp_path, A, [_park(101, "Alpha Park", 40.0, -75.0)], 1)
        _merge(tmp_path, A, [], 2)
        assert _names() == {"Mystery Park"}
        assert osm_places.lookup(41.005, -75.995)["sublocation"] == "Mystery Park"
