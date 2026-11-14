"""Core pipeline for building/extending the offline OSM places DB from GeoFabrik
.osm.pbf extracts. Framework-free (no FastAPI imports) so it's usable from both
scripts/build_osm_places.py (CLI) and services/data_service.py (the Data
Management UI's background download+merge job). See osm_places.py for the
read side (lookup/status) and CLAUDE.md for the module-singleton conventions
this follows.

OSM data © OpenStreetMap contributors, ODbL.
"""

import json
import sqlite3
import time
from pathlib import Path
from typing import Callable

import osmium

# US admin_level for a city/town/municipality boundary (the "primary" place).
# Configurable because admin_level meaning varies by country; 8 is the US city.
# Not sufficient on its own, though — see CITY_PLACE_VALUES below.
CITY_ADMIN_LEVELS = {8}
NEIGHBOURHOOD_ADMIN_LEVEL = 10

# admin_level alone misses some real cities: Ontario's single-tier "separated
# cities" (e.g. London, Stratford) are tagged admin_level=6 — the same level as
# the counties that don't contain them, since they sit outside the two-tier
# county system entirely — while an admin_level=6 area lacking place=city/town
# really is a county/region. place is the more reliable cross-country signal, so
# it's accepted alongside admin_level rather than instead of it (still checked
# first below, since CITY_ADMIN_LEVELS alone is right most of the time and this
# only broadens the match).
CITY_PLACE_VALUES = {"city", "town", "village"}

# England/Wales unitary authorities are also admin_level=6 with no place tag at
# all (e.g. "City of Bristol": boundary=administrative, admin_level=6,
# council_style=city_and_county, no place tag) — council_style is the signal
# there. Deliberately narrow: "city"/"city_and_county" (Bristol, Cardiff,
# Swansea, Nottingham, Derby, York, Plymouth, Edinburgh, London, Newport) are
# genuinely single named cities; "borough"/"county_borough"/"county" cover
# larger multi-town regions (North Lincolnshire, Wrexham, Rutland, ...) that
# would misrepresent a whole county as one "city", so those are left alone.
CITY_COUNCIL_STYLES = {"city", "city_and_county"}

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
    if boundary == "administrative" and (
        admin_level in CITY_ADMIN_LEVELS
        or place in CITY_PLACE_VALUES
        or tags.get("council_style") in CITY_COUNCIL_STYLES
    ):
        return "city", admin_level

    # Neighborhood / suburb (sub-location).
    if place in ("neighbourhood", "suburb", "quarter", "borough", "city_block"):
        return "neighbourhood", admin_level
    if boundary == "administrative" and admin_level == NEIGHBOURHOOD_ADMIN_LEVEL:
        return "neighbourhood", admin_level
    # Named residential subdivision — a landuse polygon, not an admin boundary,
    # but still a useful sub-location, so it counts regardless of place tag.
    if tags.get("landuse") == "residential":
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
    if amenity in ("university", "college", "hospital", "school"):
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


def init_db(db: sqlite3.Connection):
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


def process_file(db: sqlite3.Connection, pbf: Path, index: str,
                  progress_cb: Callable[[int, int], None] | None = None) -> dict:
    """Stream one .osm.pbf, insert matching named areas. Returns kept counts per
    category (`kept`), skipped counts per reason (`skipped`), geometry-error
    count (`errors`), and elapsed seconds (`seconds`). progress_cb(seen, kept),
    if given, is called every 500k areas scanned (for job-status reporting)."""
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
            if progress_cb:
                progress_cb(seen, sum(counts.values()))
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


def _remove_db_files(path: Path) -> None:
    """Delete a SQLite file and any journal it left behind."""
    for suffix in ("", "-journal", "-wal", "-shm"):
        path.with_name(path.name + suffix).unlink(missing_ok=True)


def _copy_db(src: Path, dest: Path) -> None:
    """Copy the live DB into the build file with SQLite's backup API: a consistent
    snapshot even while the app has it open read-only, unlike a byte copy."""
    src_conn = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    try:
        dest_conn = sqlite3.connect(str(dest))
        try:
            src_conn.backup(dest_conn)
        finally:
            dest_conn.close()
    finally:
        src_conn.close()


def build_or_append(db_path: Path, pbf_paths: list[Path], append: bool,
                     index: str = "flex_mem",
                     progress_cb: Callable[[str], None] | None = None) -> dict:
    """Build (append=False) or extend (append=True) the OSM places DB at db_path
    from one or more GeoFabrik .osm.pbf extracts. progress_cb(message), if given,
    is called with a short human-readable status line as each file is processed —
    used to drive a polling job-status endpoint.

    The work happens in a "<db>.tmp" file next to db_path (a copy of the live DB
    when appending, since a merge is additive across regions), which is swapped in
    only once complete (audit G2). Merging into the live file meant lookups during
    a multi-minute merge saw a half-inserted region: a point whose city polygon
    wasn't in yet resolved, and was cached, as "no city". The swap goes through
    osm_places.replace_db, which closes the app's read handle under its lock.

    Returns a summary: {"total_places": int, "regions": [{"file", "kept"}, ...]}."""
    from geotagger import osm_places

    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = db_path.with_name(db_path.name + ".tmp")
    _remove_db_files(tmp_path)  # a build a crash or failed swap left behind
    try:
        if append and db_path.exists():
            if progress_cb:
                progress_cb(f"Copying {db_path.name} to merge into…")
            _copy_db(db_path, tmp_path)
        summary = _build_into(tmp_path, pbf_paths, index, progress_cb)
    except BaseException:
        # A half-built file is useless and can be GBs; the live DB is untouched.
        _remove_db_files(tmp_path)
        raise
    osm_places.replace_db(tmp_path, db_path)
    return summary


def _build_into(db_path: Path, pbf_paths: list[Path], index: str,
                progress_cb: Callable[[str], None] | None) -> dict:
    """Run the merge into the (temp) DB at db_path. See build_or_append."""
    db = sqlite3.connect(str(db_path))
    try:
        init_db(db)
        regions = []
        for pbf in pbf_paths:
            if progress_cb:
                progress_cb(f"Processing {pbf.name} ({pbf.stat().st_size / 1e6:.0f} MB)…")

            def _cb(seen, kept, _pbf=pbf):
                if progress_cb:
                    progress_cb(f"{_pbf.name}: scanned {seen:,} areas, kept {kept:,}…")

            result = process_file(db, pbf, index, progress_cb=_cb)
            kept = sum(result["kept"].values())
            if progress_cb:
                progress_cb(f"{pbf.name}: kept {kept:,} places in {result['seconds']}s "
                            f"({result['errors']:,} geometry errors skipped)")
            regions.append({"file": pbf.name, "kept": kept, "built_at": time.time()})

            cur = db.execute("SELECT value FROM meta WHERE key='regions'")
            row = cur.fetchone()
            all_regions = json.loads(row[0]) if row else []
            all_regions.append(regions[-1])
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('regions', ?)",
                       (json.dumps(all_regions),))
            db.commit()

        grand = db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_places', ?)", (str(grand),))
        db.commit()
        return {"total_places": grand, "regions": regions}
    finally:
        db.close()
