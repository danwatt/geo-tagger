"""Unit tests for the .osm.pbf compaction pass (geotagger/osm_compact.py).

Like test_osm_streets.py, each test builds a tiny real .osm.pbf with osmium's
writer and reads the result back with osmium, so the id-tracker / filter chain is
exercised for real. The property that matters most — the two consumers
(osm_builder's places merge and osm_streets' search) see exactly the same thing
before and after — is asserted against those consumers directly.
"""

import sqlite3

import osmium
import pytest

from geotagger import config, osm_builder, osm_compact, osm_streets
from geotagger.services import data_service


def _square(lat: float, lng: float, first_id: int) -> dict[int, tuple[float, float]]:
    """Four corner nodes of a ~100 m square, ids first_id..first_id+3."""
    d = 0.001
    return {first_id: (lat, lng), first_id + 1: (lat, lng + d),
            first_id + 2: (lat + d, lng + d), first_id + 3: (lat + d, lng)}


NODES: dict[int, tuple[float, float]] = {
    **_square(30.000, -96.000, 1),      # named park (closed way)
    **_square(30.010, -96.000, 11),     # unnamed building
    **_square(30.020, -96.000, 21),     # city boundary relation, two member ways
    **_square(30.030, -96.000, 31),     # named lake
    41: (30.040, -96.000), 42: (30.041, -96.000), 43: (30.042, -96.000),  # named street
    51: (30.050, -96.000), 52: (30.051, -96.000),                         # unnamed service road
    61: (30.060, -96.000), 62: (30.061, -96.000),                         # named creek
    71: (30.070, -96.000),   # named peak
    72: (30.071, -96.000),   # named cafe
    73: (30.072, -96.000),   # unnamed tree
    74: (30.073, -96.000),   # address point
}
NODE_TAGS: dict[int, dict[str, str]] = {
    42: {"highway": "crossing", "crossing": "marked"},   # vertex of the named street
    71: {"natural": "peak", "name": "Mount Test", "ele": "4000", "wikidata": "Q1"},
    72: {"amenity": "cafe", "name": "Bean There", "opening_hours": "24/7"},
    73: {"natural": "tree"},
    74: {"addr:housenumber": "12", "addr:street": "Main Street"},
}
WAYS: list[tuple[int, list[int], dict[str, str]]] = [
    (100, [1, 2, 3, 4, 1], {"leisure": "park", "name": "Test Park", "operator": "City"}),
    (101, [11, 12, 13, 14, 11], {"building": "yes"}),
    (102, [21, 22, 23], {"barrier": "fence"}),           # relation member, own tags irrelevant
    (103, [23, 24, 21], {}),                             # relation member, untagged
    (104, [31, 32, 33, 34, 31], {"natural": "water", "water": "lake", "name": "Test Lake"}),
    (105, [41, 42, 43], {"highway": "residential", "name": "Main Street",
                         "surface": "asphalt", "tiger:county": "Brazos, TX"}),
    (106, [51, 52], {"highway": "service"}),
    (107, [61, 62], {"waterway": "stream", "name": "Test Creek"}),
]
RELATIONS: list[tuple[int, list[tuple[str, int, str]], dict[str, str]]] = [
    (200, [("w", 102, "outer"), ("w", 103, "outer")],
     {"type": "boundary", "boundary": "administrative", "admin_level": "8",
      "name": "Testville", "population": "1234"}),
    (201, [("w", 105, "from"), ("n", 43, "via"), ("w", 106, "to")],
     {"type": "restriction", "restriction": "no_left_turn"}),
]


def _write_pbf(path) -> None:
    header = osmium.io.Header()
    header.add_box(osmium.osm.Box(-96.5, 29.5, -95.5, 30.5))
    writer = osmium.SimpleWriter(str(path), header=header)
    for node_id, (lat, lng) in sorted(NODES.items()):
        writer.add_node(osmium.osm.mutable.Node(
            id=node_id, location=(lng, lat), tags=NODE_TAGS.get(node_id, {}),
            version=3, changeset=99))
    for way_id, refs, tags in WAYS:
        writer.add_way(osmium.osm.mutable.Way(id=way_id, nodes=refs, tags=tags, version=2))
    for rel_id, members, tags in RELATIONS:
        writer.add_relation(osmium.osm.mutable.Relation(id=rel_id, members=members, tags=tags))
    writer.close()


def _read(path) -> dict[str, dict[int, dict[str, str]]]:
    """{"n"|"w"|"r": {id: tags}} for everything in the file."""
    out: dict[str, dict[int, dict[str, str]]] = {"n": {}, "w": {}, "r": {}}
    for obj in osmium.FileProcessor(str(path)):
        kind = "n" if obj.is_node() else "w" if obj.is_way() else "r"
        out[kind][obj.id] = {tag.k: tag.v for tag in obj.tags}
    return out


def _places(pbf, tmp_path) -> list[tuple]:
    db_path = tmp_path / f"{pbf.name}.sqlite"
    osm_builder.build_or_append(db_path, [pbf], append=False)
    db = sqlite3.connect(str(db_path))
    try:
        return db.execute(
            "SELECT osm_type, osm_id, name, category, area, rings FROM places "
            "ORDER BY osm_type, osm_id").fetchall()
    finally:
        db.close()


@pytest.fixture
def pbf(tmp_path, monkeypatch):
    cache = tmp_path / "osm" / "pbf-cache"
    cache.mkdir(parents=True)
    monkeypatch.setattr(config, "OSM_DB_PATH", tmp_path / "osm" / "places.sqlite")
    path = cache / "us_texas-latest.osm.pbf"
    _write_pbf(path)
    return path


def test_compact_keeps_what_the_app_reads_and_drops_the_rest(pbf):
    result = osm_compact.compact(pbf)
    assert result["skipped"] is False
    got = _read(pbf)

    # Park, both relation members, lake, street, creek — not the building or driveway.
    assert sorted(got["w"]) == [100, 102, 103, 104, 105, 107]
    assert sorted(got["r"]) == [200]
    # Every vertex of a kept way, plus the named peak and cafe; not the unnamed
    # building's corners, the driveway's ends, the tree or the address point.
    expected_nodes = ({1, 2, 3, 4} | {21, 22, 23, 24} | {31, 32, 33, 34}
                      | {41, 42, 43} | {61, 62} | {71, 72})
    assert set(got["n"]) == expected_nodes


def test_compact_trims_tags_to_the_keep_list(pbf):
    osm_compact.compact(pbf)
    got = _read(pbf)
    assert got["w"][100] == {"leisure": "park", "name": "Test Park"}
    assert got["w"][105] == {"highway": "residential", "name": "Main Street"}
    assert got["w"][104] == {"natural": "water", "water": "lake", "name": "Test Lake"}
    assert got["r"][200] == {"type": "boundary", "boundary": "administrative",
                             "admin_level": "8", "name": "Testville"}
    # A bare relation member loses its own tags — it's geometry, not a feature.
    assert got["w"][102] == {}
    # Named points keep their useful tags; a tagged street vertex keeps none.
    assert got["n"][71] == {"natural": "peak", "name": "Mount Test", "ele": "4000"}
    assert got["n"][72] == {"amenity": "cafe", "name": "Bean There"}
    assert got["n"][42] == {}


def test_compact_leaves_both_consumers_output_unchanged(pbf, tmp_path):
    viewport = (29.9, 30.1, -96.1, -95.9)
    places_before = _places(pbf, tmp_path)
    streets_before = osm_streets.search(*viewport, "main")["streets"]
    bbox_before = osm_streets.file_bbox(pbf)
    assert {p[2] for p in places_before} == {"Test Park", "Testville"}
    assert len(streets_before) == 1

    osm_compact.compact(pbf)

    assert _places(pbf, tmp_path) == places_before
    assert osm_streets.search(*viewport, "main")["streets"] == streets_before
    # The header bbox is what lets a street search skip a whole extract.
    assert osm_streets.file_bbox(pbf) == bbox_before
    assert bbox_before is not None


def test_compact_is_idempotent_and_marks_the_file(pbf):
    assert osm_compact.is_compacted(pbf) is False
    osm_compact.compact(pbf)
    assert osm_compact.is_compacted(pbf) is True
    size = pbf.stat().st_size
    again = osm_compact.compact(pbf)
    assert again["skipped"] is True
    assert pbf.stat().st_size == size
    # No leftover temp file for the cache's "*.osm.pbf" consumers to trip over.
    assert [p.name for p in pbf.parent.iterdir()] == [pbf.name]


def test_compact_failure_leaves_the_original_untouched(pbf, monkeypatch):
    original = pbf.read_bytes()

    def boom(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(osm_compact.os, "replace", boom)
    with pytest.raises(OSError):
        osm_compact.compact(pbf)
    assert pbf.read_bytes() == original
    assert [p.name for p in pbf.parent.iterdir()] == [pbf.name]


# ── download-job hook (services/data_service._compact_pbf) ──

def test_download_hook_compacts_and_reports_progress(pbf):
    messages: list[str] = []
    data_service._compact_pbf(pbf, messages.append)
    assert osm_compact.is_compacted(pbf) is True
    assert any("Compacted" in m for m in messages)


def test_download_hook_respects_the_config_switch(pbf, monkeypatch):
    monkeypatch.setattr(config, "OSM_COMPACT_PBF", False)
    data_service._compact_pbf(pbf, lambda _m: None)
    assert osm_compact.is_compacted(pbf) is False


def test_download_hook_swallows_a_compaction_failure(pbf, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("nope")

    monkeypatch.setattr(osm_compact, "compact", boom)
    messages: list[str] = []
    data_service._compact_pbf(pbf, messages.append)   # must not raise
    assert pbf.exists()
    assert any("compaction failed" in m for m in messages)
