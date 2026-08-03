"""On-demand street (highway line) search straight out of the cached GeoFabrik
.osm.pbf extracts — no database.

Streets are deliberately *not* ingested the way places/buildings are (see
osm_builder.py): a full road network is orders of magnitude more geometry than
the named areas the reverse geocoder needs, and this is a niche "where does that
road run?" lookup, not something every photo lookup touches. So instead of a
build step, a search streams the raw extract once per query, filtered down to a
map viewport.

That only works while the raw .osm.pbf downloads are still sitting in the pbf
cache (config.get_pbf_cache_dir()); they're kept after a merge, but a user who
cleared them to reclaim disk has no streets to search until they re-download.
`cached_files()` reports that, and the UI says so rather than silently finding
nothing.

Framework-free (no FastAPI imports), per CLAUDE.md — services/streets_service.py
owns the job/threading side.

OSM data © OpenStreetMap contributors, ODbL.
"""

import logging
import time
from pathlib import Path
from typing import Callable

from geotagger import config

logger = logging.getLogger(__name__)

# highway=* values that count as "a street" — drivable roads plus the pedestrian
# ways that carry real street names (a named pedestrian mall is a street to a
# person looking at a photo). Left out: footway/path/cycleway/steps/track, which
# in OSM mostly carry trail or sidewalk names and would bury the road you asked
# for under a hundred sidewalk segments named after it.
STREET_HIGHWAY_VALUES = frozenset({
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    "unclassified", "residential", "living_street", "service", "road",
    "pedestrian",
})

# Extra highway values allowed when the caller asks for paths too (the UI's
# "include trails & paths" checkbox).
PATH_HIGHWAY_VALUES = frozenset({
    "footway", "path", "cycleway", "bridleway", "steps", "track",
})

# Coordinates are for drawing a line on a Leaflet map; 6 decimals is ~0.1 m and
# roughly halves the JSON payload versus full float repr.
_COORD_PRECISION = 6


def _region_label(stem: str) -> str:
    """Human name for a cached pbf, from its "<group>_<slug>-latest.osm.pbf" file
    name. Falls back to the raw stem for files the region table doesn't know
    (hand-dropped extracts, or a region since renamed upstream)."""
    from geotagger.services.data_service import _GEOFABRIK_REGIONS
    key = stem.replace("-latest.osm.pbf", "").replace(".osm.pbf", "")
    region = _GEOFABRIK_REGIONS.get(key)
    return region["name"] if region else key


def file_bbox(path: Path) -> tuple[float, float, float, float] | None:
    """-> (min_lat, max_lat, min_lng, max_lng) from the .pbf header, or None if the
    file carries no valid bounding box. Reading just the header costs one seek, so
    this is what lets a search skip whole extracts that can't contain the viewport
    instead of streaming them."""
    import osmium
    try:
        reader = osmium.io.Reader(str(path), osmium.osm.osm_entity_bits.NOTHING)
        try:
            box = reader.header().box()
        finally:
            reader.close()
        if not box.valid():
            return None
        return (box.bottom_left.lat, box.top_right.lat,
                box.bottom_left.lon, box.top_right.lon)
    except Exception:  # noqa: BLE001 — a corrupt/partial download shouldn't break the listing
        logger.warning("Could not read pbf header: %s", path, exc_info=True)
        return None


def cached_files() -> list[dict]:
    """Every .osm.pbf still in the download cache, newest first, with its size and
    header bbox — the raw material for both the status card and file selection."""
    cache_dir = config.get_pbf_cache_dir()
    if not cache_dir.is_dir():
        return []
    files = []
    for path in sorted(cache_dir.glob("*.osm.pbf")):
        bbox = file_bbox(path)
        files.append({
            "file": path.name,
            "label": _region_label(path.name),
            "size": path.stat().st_size,
            "bbox": None if bbox is None else {
                "min_lat": bbox[0], "max_lat": bbox[1],
                "min_lng": bbox[2], "max_lng": bbox[3],
            },
        })
    return files


def status() -> dict:
    files = cached_files()
    return {
        "available": bool(files),
        "cache_dir": str(config.get_pbf_cache_dir()),
        "files": files,
        "total_size": sum(f["size"] for f in files),
    }


def _bbox_overlaps(a: tuple[float, float, float, float],
                   b: tuple[float, float, float, float]) -> bool:
    """(min_lat, max_lat, min_lng, max_lng) overlap test."""
    return not (a[1] < b[0] or a[0] > b[1] or a[3] < b[2] or a[2] > b[3])


def files_for_bbox(min_lat: float, max_lat: float,
                   min_lng: float, max_lng: float) -> list[Path]:
    """Cached extracts whose header bbox intersects the viewport. Files with no
    header bbox are included rather than skipped — better a wasted scan than
    silently missing the one extract that had the road."""
    want = (min_lat, max_lat, min_lng, max_lng)
    cache_dir = config.get_pbf_cache_dir()
    if not cache_dir.is_dir():
        return []
    keep = []
    for path in sorted(cache_dir.glob("*.osm.pbf")):
        bbox = file_bbox(path)
        if bbox is None or _bbox_overlaps(bbox, want):
            keep.append(path)
    return keep


def _way_coords(way, min_lat: float, max_lat: float,
                min_lng: float, max_lng: float) -> tuple[list[list[float]], bool] | None:
    """-> ([[lat, lng], ...], hit) for one way, where `hit` is True if any vertex
    lands inside the viewport. Returns None if the way has fewer than two usable
    vertices. Nodes referenced but not present in the extract (ways crossing the
    region border) raise on .lat/.lon and are simply dropped, leaving a gap in the
    line rather than failing the whole way."""
    coords: list[list[float]] = []
    hit = False
    for node in way.nodes:
        try:
            lat, lng = node.lat, node.lon
        except Exception:  # osmium.InvalidLocationError — node outside the extract
            continue
        if min_lat <= lat <= max_lat and min_lng <= lng <= max_lng:
            hit = True
        coords.append([round(lat, _COORD_PRECISION), round(lng, _COORD_PRECISION)])
    if len(coords) < 2:
        return None
    return coords, hit


def search(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
           query: str, limit: int | None = None, include_paths: bool = False,
           progress_cb: Callable[[str], None] | None = None) -> dict:
    """Find named highway ways matching `query` (case-insensitive substring of the
    way's name or ref) that pass through the given viewport.

    One streaming pass per intersecting cached extract: pyosmium builds the node
    location index in C++ and the filters drop everything but tagged highway ways
    before they reach Python, so only a few tens of thousands of objects are
    materialized here (a state extract runs in seconds, DC in well under one).

    Returns {"streets": [...], "truncated": bool, "scanned": [...], "seconds": float},
    where each street is {name, ref, highway, osm_id, coords}. Ways are kept whole
    (not clipped) as long as one vertex falls in the viewport, so a road that runs
    off the edge of the map still draws as one continuous line."""
    import osmium

    query = (query or "").strip()
    if len(query) < 2:
        raise ValueError("Search text must be at least 2 characters")
    limit = limit or config.OSM_STREETS_MAX_WAYS
    needle = query.casefold()
    wanted = STREET_HIGHWAY_VALUES | PATH_HIGHWAY_VALUES if include_paths else STREET_HIGHWAY_VALUES

    paths = files_for_bbox(min_lat, max_lat, min_lng, max_lng)
    if not paths:
        return {"streets": [], "truncated": False, "scanned": [], "seconds": 0.0,
                "no_coverage": True}

    t0 = time.time()
    streets: list[dict] = []
    scanned: list[dict] = []
    truncated = False

    for path in paths:
        if truncated:
            break
        label = _region_label(path.name)
        if progress_cb:
            progress_cb(f"Scanning {label} ({path.stat().st_size / 1e6:.0f} MB)…")
        t_file = time.time()
        kept_here = 0
        seen = 0
        # Locations first, then entity/key filters: the node index is populated in
        # C++ as the nodes stream past, and only tagged highway ways ever cross into
        # Python. Order matters — filtering before with_locations would starve the
        # index and every way would come back geometry-less.
        fp = (osmium.FileProcessor(str(path))
              .with_locations(config.OSM_STREETS_LOCATION_INDEX)
              .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
              .with_filter(osmium.filter.KeyFilter("highway")))
        for way in fp:
            seen += 1
            if seen % 200_000 == 0 and progress_cb:
                progress_cb(f"Scanning {label}: {seen:,} roads checked, {len(streets):,} matched…")
            if way.tags.get("highway") not in wanted:
                continue
            name = way.tags.get("name")
            ref = way.tags.get("ref")
            if not (name or ref):
                continue
            if needle not in (name or "").casefold() and needle not in (ref or "").casefold():
                continue
            got = _way_coords(way, min_lat, max_lat, min_lng, max_lng)
            if got is None:
                continue
            coords, hit = got
            if not hit:
                continue
            streets.append({
                "name": name or ref,
                "ref": ref,
                "highway": way.tags.get("highway"),
                "osm_id": way.id,
                "coords": coords,
            })
            kept_here += 1
            if len(streets) >= limit:
                truncated = True
                break
        scanned.append({"file": path.name, "label": label, "ways": seen,
                        "matched": kept_here, "seconds": round(time.time() - t_file, 1)})

    seconds = round(time.time() - t0, 1)
    logger.info(f"Street search '{query}' over {len(paths)} extract(s): "
                f"{len(streets)} ways in {seconds}s")
    return {"streets": streets, "truncated": truncated, "scanned": scanned,
            "seconds": seconds}
