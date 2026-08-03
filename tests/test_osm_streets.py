"""Unit tests for the on-demand street search over cached .osm.pbf extracts
(geotagger/osm_streets.py).

Each test builds a tiny real .osm.pbf with osmium's writer rather than mocking
pyosmium, so the filter chain (locations -> entity -> key), the tag rules, and the
viewport test are all exercised for real.
"""

import osmium
import pytest

from geotagger import config, osm_streets


def _write_pbf(path, nodes, ways):
    """nodes: {id: (lat, lng)}; ways: [(id, [node_ids], {tags})]. Nodes must come
    before the ways referencing them, which is also what a real extract does."""
    writer = osmium.SimpleWriter(str(path))
    for node_id, (lat, lng) in sorted(nodes.items()):
        writer.add_node(osmium.osm.mutable.Node(id=node_id, location=(lng, lat)))
    for way_id, refs, tags in ways:
        writer.add_way(osmium.osm.mutable.Way(id=way_id, nodes=refs, tags=tags))
    writer.close()


@pytest.fixture
def pbf_cache(tmp_path, monkeypatch):
    """Point config's pbf cache at an empty tmp dir; yields a helper that writes an
    extract into it."""
    cache = tmp_path / "osm" / "pbf-cache"
    cache.mkdir(parents=True)
    monkeypatch.setattr(config, "OSM_DB_PATH", tmp_path / "osm" / "places.sqlite")

    def _add(name, nodes, ways):
        path = cache / name
        _write_pbf(path, nodes, ways)
        return path

    return _add


# A short north-south residential street around (30.00, -96.00), a named footway a
# whole degree away, and an unnamed road on top of the first one.
NODES = {
    1: (30.000, -96.000), 2: (30.001, -96.000), 3: (30.002, -96.000),
    4: (31.000, -95.000), 5: (31.001, -95.000),
    6: (30.000, -96.010), 7: (30.001, -96.010),
}
WAYS = [
    (100, [1, 2, 3], {"highway": "residential", "name": "Main Street"}),
    (101, [4, 5], {"highway": "footway", "name": "Main Trail"}),
    (102, [6, 7], {"highway": "residential"}),
    (103, [1, 2], {"highway": "primary", "name": "State Highway 6", "ref": "SH 6"}),
]

VIEWPORT = (29.99, 30.01, -96.02, -95.98)  # min_lat, max_lat, min_lng, max_lng


def test_status_reports_nothing_when_the_cache_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OSM_DB_PATH", tmp_path / "osm" / "places.sqlite")
    status = osm_streets.status()
    assert status["available"] is False
    assert status["files"] == []


def test_status_lists_cached_extracts(pbf_cache):
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    status = osm_streets.status()
    assert status["available"] is True
    assert len(status["files"]) == 1
    entry = status["files"][0]
    assert entry["file"] == "us_texas-latest.osm.pbf"
    assert entry["label"] == "Texas"          # resolved via the GeoFabrik region table
    assert entry["size"] > 0


def test_search_matches_by_substring_and_returns_geometry(pbf_cache):
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    result = osm_streets.search(*VIEWPORT, "main")
    assert [s["name"] for s in result["streets"]] == ["Main Street"]
    street = result["streets"][0]
    assert street["osm_id"] == 100
    assert street["highway"] == "residential"
    assert street["coords"] == [[30.0, -96.0], [30.001, -96.0], [30.002, -96.0]]
    assert result["truncated"] is False


def test_search_is_case_insensitive_and_matches_ref(pbf_cache):
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    assert [s["osm_id"] for s in osm_streets.search(*VIEWPORT, "MAIN STREET")["streets"]] == [100]
    # "SH 6" is only in the ref tag, not the name.
    assert [s["osm_id"] for s in osm_streets.search(*VIEWPORT, "sh 6")["streets"]] == [103]


def test_search_ignores_ways_outside_the_viewport(pbf_cache):
    """Main Trail is a degree away — and a footway, so it needs include_paths too."""
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    wide = (29.9, 31.1, -96.1, -94.9)
    assert [s["name"] for s in osm_streets.search(*wide, "main", include_paths=True)["streets"]] \
        == ["Main Street", "Main Trail"]
    assert [s["name"] for s in osm_streets.search(*VIEWPORT, "main", include_paths=True)["streets"]] \
        == ["Main Street"]


def test_paths_are_excluded_by_default(pbf_cache):
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    wide = (29.9, 31.1, -96.1, -94.9)
    assert [s["name"] for s in osm_streets.search(*wide, "main")["streets"]] == ["Main Street"]


def test_unnamed_roads_never_match(pbf_cache):
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    assert osm_streets.search(*VIEWPORT, "residential")["streets"] == []


def test_limit_truncates(pbf_cache):
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    result = osm_streets.search(29.9, 31.1, -96.1, -94.9, "main",
                                limit=1, include_paths=True)
    assert len(result["streets"]) == 1
    assert result["truncated"] is True


def test_short_query_is_rejected(pbf_cache):
    pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    with pytest.raises(ValueError):
        osm_streets.search(*VIEWPORT, "m")


def test_no_cached_extract_covering_the_viewport(pbf_cache, monkeypatch):
    """A file whose header bbox misses the viewport is skipped entirely; with none
    left the caller gets no_coverage rather than a silent empty result."""
    path = pbf_cache("us_texas-latest.osm.pbf", NODES, WAYS)
    # SimpleWriter doesn't emit a header bbox, so stand one in.
    monkeypatch.setattr(osm_streets, "file_bbox",
                        lambda p: (30.0, 31.0, -97.0, -96.0) if p == path else None)
    result = osm_streets.search(10.0, 10.1, 10.0, 10.1, "main")
    assert result["no_coverage"] is True
    assert result["streets"] == []


def test_bbox_overlap_helper():
    a = (30.0, 31.0, -97.0, -96.0)
    assert osm_streets._bbox_overlaps(a, (30.5, 32.0, -96.5, -95.0))
    assert not osm_streets._bbox_overlaps(a, (31.5, 32.0, -97.0, -96.0))  # north of it
    assert not osm_streets._bbox_overlaps(a, (30.0, 31.0, -95.9, -95.0))  # east of it
