"""
Fetch named landmarks (parks, named buildings, sports venues/monuments) from
Overture Maps, scoped to bboxes around the user's own photo library coordinates.

Run:  uv run --group scripts python scripts/get_overture_landmarks.py
      uv run --group scripts python scripts/get_overture_landmarks.py --cache-dir D:/path/.geotagger
      uv run --group scripts python scripts/get_overture_landmarks.py --radius-miles 0.5

Overture Maps data is read directly from its public S3 bucket (anonymous, no API
key) via the `overturemaps` package's record_batch_reader(), which — because bbox
extents are stored in the underlying Parquet file/row-group statistics — only
transfers the row groups that actually intersect each requested bbox. One small
query per unique photo-cluster location, not a country-wide download. Requires
internet access; installed via the `scripts` dependency group
(`uv add --group scripts overturemaps`), not the app's runtime dependencies.

Rerunnable: rebuilds data/overture/landmarks.jsonl from scratch each run, so it's
safe to call again after adding photos to the library.
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index  # noqa: E402
from geotagger.config import OVERTURE_DIR  # noqa: E402

S3_BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
OUT_FILE = OVERTURE_DIR / "landmarks.jsonl"

# Simplification tolerance (degrees) applied to fetched polygons before storing,
# so point-in-polygon stays fast at lookup time even for complex park boundaries.
# ~3m at the equator — small relative to building/park footprints.
SIMPLIFY_TOLERANCE_DEG = 0.00003

# land_use subtypes that count as a "park" for our purposes (not lakes, not
# farmland — see CLAUDE.md's note on why the old GeoNames feature-code dump
# was a dead end here).
PARK_SUBTYPES = {"park", "protected"}

# Curated `place` category taxonomy to keep: landmarks, monuments, museums,
# sports venues — not the thousands of restaurants/shops/clinics also in the
# `place` theme. Checked against a real dense-urban bbox pull (18k places ->
# 698 matches here) before picking these. Short and tunable, same spirit as the
# old GeoNames feature-code filter — edit and rerun if the mix looks off for
# your library. The script prints every category it actually saw (kept or not)
# so this list can be refined from real data.
PLACE_CATEGORY_WHITELIST = {
    "landmark_and_historical_building", "monument", "sculpture_statue", "castle",
    "palace", "national_park", "zoo", "aquarium", "bridge", "historical_tours",
    "stadium_arena", "football_stadium", "tennis_stadium", "track_stadium",
    "music_venue", "topic_concert_venue", "theaters_and_performance_venues",
    "venue_and_event_space",
    "museum", "art_museum", "history_museum", "science_museum", "state_museum",
    "asian_art_museum", "civilization_museum", "contemporary_art_museum",
    "modern_art_museum",
}


def resolve_root(args) -> Path | None:
    """Pick the cache location the same way the server does."""
    if args.cache_dir:
        os.environ["GEOTAGGER_CACHE_DIR"] = str(Path(args.cache_dir).resolve())
        return None
    if os.environ.get("GEOTAGGER_CACHE_DIR"):
        return None
    last = index.get_last_scan_root() if hasattr(index, "get_last_scan_root") else None
    if not last:
        sys.exit("No cache directory found. Pass --cache-dir or run a scan first.")
    return Path(last)


def _latest_release() -> str:
    """Find the latest Overture release directly from the public S3 bucket's
    listing. The overturemaps package normally resolves this by fetching a STAC
    catalog from labs.overturemaps.org, but some networks block that domain
    while still allowing the S3 bucket itself — which is all a bbox query
    actually needs — so resolve it ourselves and pass `release=` explicitly."""
    url = f"{S3_BUCKET}/?list-type=2&prefix=release/&delimiter=/"
    with urllib.request.urlopen(url, timeout=30) as r:
        body = r.read()
    root = ET.fromstring(body)
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    prefixes = [p.text for p in root.findall(".//s3:CommonPrefixes/s3:Prefix", ns) if p.text]
    releases = sorted(p.strip("/").rsplit("/", 1)[-1] for p in prefixes)
    if not releases:
        sys.exit("Could not determine latest Overture release from the S3 bucket listing.")
    return releases[-1]


def _bbox_for_cell(lat: float, lng: float, radius_m: float) -> tuple[float, float, float, float]:
    """(xmin, ymin, xmax, ymax) box `radius_m` meters around (lat, lng) — same
    meters->degrees math as api/photos.py's api_photos_by_area."""
    lat_offset = radius_m / 111000.0
    lng_offset = radius_m / (111000.0 * math.cos(math.radians(lat)))
    return (lng - lng_offset, lat - lat_offset, lng + lng_offset, lat + lat_offset)


def _grid_cells(coords, grid_size_deg: float) -> list[tuple[float, float]]:
    """Snap coordinates to a coarse grid and dedupe, so one vacation's worth of
    photos collapses into a single query instead of hundreds."""
    seen = set()
    cells = []
    for row in coords:
        cell = (round(row["lat"] / grid_size_deg) * grid_size_deg,
                round(row["lng"] / grid_size_deg) * grid_size_deg)
        if cell not in seen:
            seen.add(cell)
            cells.append(cell)
    return cells


def _polygon_from_wkb(wkb_bytes) -> list[list[float]]:
    """WKB -> [[lat, lng], ...]. Picks the largest ring for a MultiPolygon, and
    simplifies so point-in-polygon stays fast at lookup time. Overture geometry
    is (lng, lat) order (standard WKB/GeoJSON); the app's polygon convention is
    [lat, lng] (see contexts.point_in_polygon), so the coordinates are swapped."""
    import shapely.wkb
    from shapely.geometry import MultiPolygon

    geom = shapely.wkb.loads(bytes(wkb_bytes))
    if isinstance(geom, MultiPolygon):
        geom = max(geom.geoms, key=lambda g: g.area)
    geom = geom.simplify(SIMPLIFY_TOLERANCE_DEG)
    return [[lat, lng] for lng, lat in geom.exterior.coords]


def _point_from_wkb(wkb_bytes) -> list[float]:
    import shapely.wkb
    point = shapely.wkb.loads(bytes(wkb_bytes))
    return [point.y, point.x]  # [lat, lng]


def _name_of(row: dict) -> str | None:
    names = row.get("names")
    return names.get("primary") if names else None


def fetch_landmarks(cells: list[tuple[float, float]], radius_miles: float, release: str):
    from overturemaps import core

    radius_m = radius_miles * 1609.34
    buildings: dict[str, dict] = {}
    parks: dict[str, dict] = {}
    places: dict[str, dict] = {}
    place_categories_seen: dict[str | None, int] = {}

    for i, (lat, lng) in enumerate(cells, 1):
        bbox = _bbox_for_cell(lat, lng, radius_m)
        print(f"  [{i}/{len(cells)}] bbox around ({lat:.4f}, {lng:.4f})...")

        try:
            reader = core.record_batch_reader("building", bbox=bbox, release=release)
            for row in (reader.read_all().to_pylist() if reader is not None else []):
                if row["id"] in buildings:
                    continue
                name = _name_of(row)
                if not name:
                    continue
                try:
                    poly = _polygon_from_wkb(row["geometry"])
                except Exception:
                    continue
                if len(poly) < 3:
                    continue
                buildings[row["id"]] = {"kind": "building", "name": name,
                                         "category": row.get("subtype"), "polygon": poly}
        except Exception as e:
            print(f"    building query failed: {e}", file=sys.stderr)

        try:
            reader = core.record_batch_reader("land_use", bbox=bbox, release=release)
            for row in (reader.read_all().to_pylist() if reader is not None else []):
                if row["id"] in parks or row.get("subtype") not in PARK_SUBTYPES:
                    continue
                name = _name_of(row)
                if not name:
                    continue
                try:
                    poly = _polygon_from_wkb(row["geometry"])
                except Exception:
                    continue
                if len(poly) < 3:
                    continue
                parks[row["id"]] = {"kind": "park", "name": name,
                                     "category": row.get("class") or row.get("subtype"),
                                     "polygon": poly}
        except Exception as e:
            print(f"    land_use query failed: {e}", file=sys.stderr)

        try:
            reader = core.record_batch_reader("place", bbox=bbox, release=release)
            for row in (reader.read_all().to_pylist() if reader is not None else []):
                categories = row.get("categories")
                category = categories.get("primary") if categories else None
                place_categories_seen[category] = place_categories_seen.get(category, 0) + 1
                if row["id"] in places or category not in PLACE_CATEGORY_WHITELIST:
                    continue
                name = _name_of(row)
                if not name:
                    continue
                try:
                    point = _point_from_wkb(row["geometry"])
                except Exception:
                    continue
                places[row["id"]] = {"kind": "place", "name": name, "category": category,
                                      "point": point}
        except Exception as e:
            print(f"    place query failed: {e}", file=sys.stderr)

    return buildings, parks, places, place_categories_seen


def main():
    parser = argparse.ArgumentParser(
        description="Fetch named landmarks (parks/buildings/POIs) from Overture Maps, "
                    "scoped to areas around this library's photos")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--radius-miles", type=float, default=1.0,
                        help="Bbox radius around each photo cluster (default: 1 mile)")
    parser.add_argument("--grid-size-deg", type=float, default=0.02,
                        help="Grid size (degrees) coords are snapped to before deduping into "
                             "one query per cluster (default: 0.02, ~2.2km)")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)

    coords = index.get_all_geotagged_coords()
    if not coords:
        sys.exit("No geotagged photos found in this library — nothing to fetch.")
    cells = _grid_cells(coords, args.grid_size_deg)
    print(f"{len(coords)} distinct coordinate(s) -> {len(cells)} query cell(s) "
          f"({args.radius_miles} mi radius each)")

    print("Resolving latest Overture release...")
    release = _latest_release()
    print(f"Using release {release}")

    t0 = time.time()
    buildings, parks, places, place_categories_seen = fetch_landmarks(
        cells, args.radius_miles, release)
    dt = time.time() - t0

    OVERTURE_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("w", encoding="utf-8") as f:
        for group in (buildings, parks, places):
            for entry in group.values():
                f.write(json.dumps(entry) + "\n")

    print(f"\nDone in {dt:.1f}s: {len(buildings)} named building(s), {len(parks)} park(s), "
          f"{len(places)} curated place(s) -> {OUT_FILE}")
    print("\nPlace categories seen (not all kept — see PLACE_CATEGORY_WHITELIST):")
    for cat, n in sorted(place_categories_seen.items(), key=lambda kv: -kv[1])[:30]:
        kept = "kept" if cat in PLACE_CATEGORY_WHITELIST else "skipped"
        print(f"  {n:>6}  {cat!r:45} {kept}")


if __name__ == "__main__":
    main()
