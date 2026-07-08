"""
Build (or extend) the offline OSM places database used for polygon-based reverse
geocoding — the "what city / park / stadium / campus is this coordinate inside?"
lookup that replaces the nearest-point GeoNames city lookup.

Run:  uv run python scripts/build_osm_places.py <region>.osm.pbf [more.osm.pbf ...]
      uv run python scripts/build_osm_places.py --append california.osm.pbf

Input is a GeoFabrik OpenStreetMap extract (.osm.pbf). Download the region(s)
where your photos are from:
    https://download.geofabrik.de/north-america/us/<state>-latest.osm.pbf
(e.g. .../us/texas-latest.osm.pbf). Downloading is a network action — do it
yourself, then point this script at the local file. Start small: a single state
is ~0.3-2 GB and builds in minutes; the whole North America extract is ~13 GB
and takes hours (same pipeline — just pass that file instead).

We assemble every named **area** (closed way or multipolygon relation) whose tags
mark it as a place we care about, and store its polygon rings + bbox in the OSM
places DB (see geotagger.config.get_osm_db — by default alongside the database,
under the primary scan root's cache dir, or ~/.geotagger before any root is
configured; override with GEOTAGGER_CACHE_DIR or GEOTAGGER_OSM_DB). Streets and
other linear features are ignored (we only look at areas, and only allow-listed
categories). The app's osm_places.py opens this DB read-only and does an R*Tree
bbox prefilter + point-in-polygon test.

OSM data © OpenStreetMap contributors, ODbL.
"""

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

import osmium

from geotagger.config import get_osm_db

DEFAULT_DB = get_osm_db()  # overridden by --root/--db in main()

# US admin_level for a city/town/municipality boundary (the "primary" place).
# Configurable because admin_level meaning varies by country; 8 is the US city.
CITY_ADMIN_LEVELS = {8}
NEIGHBOURHOOD_ADMIN_LEVEL = 10

# Category display/scale hint. Lower rank = broader (primary); higher = more
# specific (preferred sub-location). Used only as a coarse tiebreak alongside the
# stored polygon area; the lookup mostly relies on "smallest containing area".
CATEGORY_RANK = {
    "city": 1,
    "neighbourhood": 2,
    "park": 3,
    "campus": 3,
    "venue": 3,
    "attraction": 3,
    "building": 4,
}


def classify(tags) -> tuple[str, int | None] | None:
    """Map an OSM area's tags to (category, admin_level) or None to skip it.

    Allow-list only: an area matches at most one category, checked broadest-first
    so a stadium inside a campus inside a city still resolves to the right thing
    at lookup time (we keep all of them; the lookup picks primary vs sub-location
    by area). Anything without a `name`, and any feature not matching a branch
    below (streets, water, generic landuse, unnamed buildings), is dropped."""
    name = tags.get("name")
    if not name:
        return None

    admin_level = None
    al_raw = tags.get("admin_level")
    if al_raw and al_raw.isdigit():
        admin_level = int(al_raw)

    boundary = tags.get("boundary")
    place = tags.get("place")
    leisure = tags.get("leisure")
    amenity = tags.get("amenity")
    tourism = tags.get("tourism")
    building = tags.get("building")

    # City / town (primary location) — authoritative admin boundary.
    if boundary == "administrative" and admin_level in CITY_ADMIN_LEVELS:
        return "city", admin_level

    # Neighborhood / suburb (sub-location).
    if place in ("neighbourhood", "suburb", "quarter", "borough", "city_block"):
        return "neighbourhood", admin_level
    if boundary == "administrative" and admin_level == NEIGHBOURHOOD_ADMIN_LEVEL:
        return "neighbourhood", admin_level

    # Parks & natural attractions.
    if (leisure in ("park", "nature_reserve", "garden")
            or boundary in ("national_park", "protected_area")
            or tourism in ("zoo", "theme_park")):
        return "park", admin_level

    # Sports & event venues.
    if leisure in ("stadium", "sports_centre") or building == "stadium":
        return "venue", admin_level

    # Campuses & institutions.
    if amenity in ("university", "college", "hospital"):
        return "campus", admin_level

    # Other tourist attractions.
    if tourism in ("attraction", "museum", "water_park", "aquarium"):
        return "attraction", admin_level

    # Named building (most specific sub-location). Kept last so a named building
    # that is also e.g. a stadium is caught by the venue branch above.
    if building and building not in ("no",):
        return "building", admin_level

    return None


# Priority order for bucketing *why* a named area didn't match any category in
# classify(), for the run summary's skip report — checks the same tag keys
# classify() reads, so unmatched values (e.g. leisure=pitch, amenity=parking)
# show up under the key that "almost" matched.
_SKIP_TAG_PRIORITY = (
    "highway", "waterway", "railway", "natural", "landuse", "amenity",
    "shop", "leisure", "tourism", "boundary", "place", "building",
    "man_made", "aeroway", "power",
)


def _skip_reason(tags) -> str:
    """Bucket an area classify() rejected, for the run summary's skip report.
    Diagnostic only — doesn't affect classify()'s decision. Reports the
    highest-priority tag key present (an area can carry several of these, so
    this is a simplification, not an exhaustive per-tag breakdown); "no name"
    dominates in practice, since most OSM areas (building footprints, generic
    landuse) don't carry one."""
    if not tags.get("name"):
        return "no name"
    for key in _SKIP_TAG_PRIORITY:
        if tags.get(key):
            return key
    return "other (named, no recognized tag)"


def _geojson_to_polygons(area) -> list | None:
    """Assemble the area geometry into our compact ring format:
        [[outer, [hole, ...]], ...]                      (one entry per polygon)
    where each ring is [[lat, lng], ...]. Returns None if the geometry can't be
    built (self-intersecting / broken multipolygons happen in raw OSM data)."""
    try:
        gj = json.loads(_FACTORY.create_multipolygon(area))
    except Exception:
        return None
    coords = gj.get("coordinates") or []
    polygons = []
    for poly in coords:  # poly = [outer_ring, hole1, hole2, ...]; ring = [[lng,lat],...]
        if not poly:
            continue
        outer = [[pt[1], pt[0]] for pt in poly[0]]
        holes = [[[pt[1], pt[0]] for pt in ring] for ring in poly[1:]]
        polygons.append([outer, holes])
    return polygons or None


def _ring_area(ring: list) -> float:
    """|shoelace| of a [[lat,lng],...] ring, in degrees². Only ever compared
    between polygons that contain the same point (≈ same latitude), so raw
    lat/lng area is a fine "which is smaller / more specific" tiebreak."""
    n = len(ring)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        y0, x0 = ring[i]
        y1, x1 = ring[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2.0


def _polygons_area(polygons: list) -> float:
    total = 0.0
    for outer, holes in polygons:
        total += _ring_area(outer)
        for h in holes:
            total -= _ring_area(h)
    return max(total, 0.0)


def _polygons_bbox(polygons: list) -> tuple[float, float, float, float]:
    lats = [pt[0] for outer, _ in polygons for pt in outer]
    lngs = [pt[1] for outer, _ in polygons for pt in outer]
    return min(lats), max(lats), min(lngs), max(lngs)


_FACTORY = osmium.geom.GeoJSONFactory()


def _init_db(db: sqlite3.Connection):
    # Deliberately NOT WAL: this DB is built once and then opened read-only by the
    # app (osm_places.py). A rollback journal leaves a clean single file that a
    # read-only connection can always open, with no -wal recovery to worry about.
    db.execute("""
        CREATE TABLE IF NOT EXISTS places (
            id INTEGER PRIMARY KEY,
            osm_type TEXT NOT NULL,        -- 'way' | 'relation'
            osm_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            category TEXT NOT NULL,        -- city|neighbourhood|park|venue|campus|attraction|building
            admin_level INTEGER,
            rank INTEGER NOT NULL,         -- CATEGORY_RANK, coarse scale hint
            area REAL NOT NULL,            -- polygon area (deg²) for smallest-containing tiebreak
            min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL,
            rings TEXT NOT NULL,           -- JSON [[outer, [hole,...]], ...], ring = [[lat,lng],...]
            UNIQUE(osm_type, osm_id)       -- dedupe when regions overlap on --append
        )
    """)
    db.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS places_spatial USING rtree(
            id, min_lat, max_lat, min_lng, max_lng
        )
    """)
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    db.commit()


def _process_file(db: sqlite3.Connection, pbf: Path, index: str) -> dict:
    """Stream one .osm.pbf, insert matching named areas. Returns kept counts per
    category (`kept`), skipped counts per reason (`skipped`), geometry-error
    count (`errors`), and elapsed seconds (`seconds`)."""
    counts: dict[str, int] = {}
    skipped: dict[str, int] = {}
    errors = 0
    seen = 0
    t0 = time.time()

    fp = (osmium.FileProcessor(str(pbf))
          .with_locations(index)
          .with_areas()
          .with_filter(osmium.filter.EntityFilter(osmium.osm.AREA)))

    cur = db.cursor()
    batch = 0
    for area in fp:
        seen += 1
        if seen % 500_000 == 0:
            print(f"    …scanned {seen:,} areas, kept {sum(counts.values()):,} "
                  f"({time.time() - t0:.0f}s)", flush=True)
        cls = classify(area.tags)
        if cls is None:
            reason = _skip_reason(area.tags)
            skipped[reason] = skipped.get(reason, 0) + 1
            continue
        category, admin_level = cls
        polygons = _geojson_to_polygons(area)
        if not polygons:
            errors += 1
            continue
        min_lat, max_lat, min_lng, max_lng = _polygons_bbox(polygons)
        osm_type = "way" if area.from_way() else "relation"
        cur.execute(
            "INSERT OR IGNORE INTO places "
            "(osm_type, osm_id, name, category, admin_level, rank, area, "
            " min_lat, max_lat, min_lng, max_lng, rings) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (osm_type, area.orig_id(), area.tags.get("name"), category, admin_level,
             CATEGORY_RANK[category], _polygons_area(polygons),
             min_lat, max_lat, min_lng, max_lng, json.dumps(polygons)),
        )
        if cur.rowcount == 1:  # not a duplicate that got IGNOREd
            cur.execute(
                "INSERT INTO places_spatial (id, min_lat, max_lat, min_lng, max_lng) "
                "VALUES (?,?,?,?,?)",
                (cur.lastrowid, min_lat, max_lat, min_lng, max_lng),
            )
            counts[category] = counts.get(category, 0) + 1
        batch += 1
        if batch % 20_000 == 0:
            db.commit()
    db.commit()

    return {"kept": counts, "skipped": skipped, "errors": errors,
            "seconds": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser(description="Build the offline OSM places DB from GeoFabrik .osm.pbf extract(s).")
    ap.add_argument("pbf", nargs="+", type=Path, help="One or more GeoFabrik .osm.pbf files")
    ap.add_argument("--db", type=Path, default=None,
                    help=f"Output SQLite DB (default: {DEFAULT_DB}, or <root>/.geotagger/data/osm/places.sqlite if --root is given)")
    ap.add_argument("--root", type=Path,
                    help="The directory you'll pass as --scan-dir. Builds into "
                         "<root>/.geotagger/data/osm/places.sqlite instead of the global default, "
                         "matching where the app looks once it's configured with this root. "
                         "Ignored if --db is also given.")
    ap.add_argument("--append", action="store_true",
                    help="Add to an existing DB instead of rebuilding from scratch")
    ap.add_argument("--index", default="flex_mem",
                    help="osmium node-location storage. 'flex_mem' (default) is fine for a state; "
                         "use e.g. 'sparse_file_array,osm-nodes.cache' for the full North America extract.")
    args = ap.parse_args()
    if args.db is None:
        args.db = get_osm_db(args.root) if args.root else DEFAULT_DB

    for p in args.pbf:
        if not p.exists():
            print(f"ERROR: {p} not found. Download it from GeoFabrik first.", file=sys.stderr)
            sys.exit(1)

    args.db.parent.mkdir(parents=True, exist_ok=True)
    if args.db.exists() and not args.append:
        print(f"Rebuilding {args.db} (removing existing). Use --append to add to it instead.")
        args.db.unlink()
        for suffix in ("-wal", "-shm"):
            wal = args.db.with_name(args.db.name + suffix)
            if wal.exists():
                wal.unlink()

    db = sqlite3.connect(str(args.db))
    _init_db(db)

    total: dict[str, int] = {}
    for pbf in args.pbf:
        print(f"\nProcessing {pbf} ({pbf.stat().st_size / 1e6:.0f} MB)…", flush=True)
        result = _process_file(db, pbf, args.index)
        counts, skipped, errors, secs = (
            result["kept"], result["skipped"], result["errors"], result["seconds"])
        kept = sum(counts.values())
        skipped_total = sum(skipped.values())
        print(f"  kept {kept:,} places in {secs}s ({errors:,} geometry errors skipped)")
        for cat in sorted(counts):
            print(f"    {cat:14s} {counts[cat]:>8,}")
        print(f"  skipped {skipped_total:,} areas that didn't match a category:")
        for reason in sorted(skipped, key=lambda r: -skipped[r]):
            print(f"    {reason:14s} {skipped[reason]:>8,}")
        for cat, n in counts.items():
            total[cat] = total.get(cat, 0) + n
        # Record ingested regions (append-friendly).
        cur = db.execute("SELECT value FROM meta WHERE key='regions'")
        row = cur.fetchone()
        regions = json.loads(row[0]) if row else []
        regions.append({"file": pbf.name, "kept": kept, "built_at": time.time()})
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('regions', ?)",
                   (json.dumps(regions),))
        db.commit()

    grand = db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_places', ?)", (str(grand),))
    db.commit()
    db.close()
    print(f"\nDone. {grand:,} total places in {args.db}. Polygon reverse geocoding enabled.")


if __name__ == "__main__":
    main()
