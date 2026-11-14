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


# Sentinel place_regions.region_id for rows that predate per-region membership
# (audit G8): "a member of every region still listed in meta 'legacy_regions'".
# See _migrate_region_membership.
LEGACY_REGION_ID = 0

# Rows staged before being applied to places as one set of joins. Large enough to
# amortise the per-batch statements, small enough that the staged rings (the bulk
# of each row) stay a few MB of temp memory.
_BATCH_ROWS = 5_000


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
            UNIQUE(osm_type, osm_id)       -- one row per feature when regions overlap on --append
        )
    """)
    db.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS places_spatial USING rtree(
            id, min_lat, max_lat, min_lng, max_lng
        )
    """)
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    # Which extract(s) each place came from (audit G8), so re-merging a region can
    # delete the features its new extract no longer has — but only once no other
    # ingested extract still has them: adjacent GeoFabrik extracts overlap at the
    # border, so e.g. a park straddling a state line is in both.
    db.execute("""
        CREATE TABLE IF NOT EXISTS osm_regions (
            id INTEGER PRIMARY KEY,        -- 1.. (0 is LEGACY_REGION_ID)
            file TEXT NOT NULL UNIQUE      -- extract file name, as in meta 'regions'
        )
    """)
    legacy = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='place_regions'"
    ).fetchone() is None
    # region_id first: a re-merge reads one region's members; the place_id index
    # serves the "is it still in any region?" check before a delete.
    db.execute("""
        CREATE TABLE IF NOT EXISTS place_regions (
            region_id INTEGER NOT NULL,
            place_id INTEGER NOT NULL,
            PRIMARY KEY (region_id, place_id)
        ) WITHOUT ROWID
    """)
    db.execute("CREATE INDEX IF NOT EXISTS place_regions_place ON place_regions(place_id)")
    if legacy:
        _migrate_region_membership(db)
    db.commit()


def _meta_json(db: sqlite3.Connection, key: str, default):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def _set_meta_json(db: sqlite3.Connection, key: str, value) -> None:
    db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, json.dumps(value)))


def _migrate_region_membership(db: sqlite3.Connection) -> None:
    """Give the rows of a DB built before per-region membership a provenance.

    Which extract each old row came from is unknown, so every one is treated as
    belonging to every region ingested so far (meta 'regions'), stored as a single
    LEGACY_REGION_ID row per place rather than places x regions rows. That is the
    conservative reading — a stale row can outlive a re-merge, a live one is never
    deleted — and it converges without a forced rebuild: re-merging a legacy
    region gives the rows it still has explicit membership and drops it from
    'legacy_regions'; once the last one has been re-merged, legacy rows no
    extract claimed are deleted.

    Rows with no recorded region at all (no meta 'regions') get no membership and
    are never deleted by a re-merge — only a full rebuild clears them."""
    files = list(dict.fromkeys(r["file"] for r in _meta_json(db, "regions", [])))
    if not files or db.execute("SELECT 1 FROM places LIMIT 1").fetchone() is None:
        return
    db.execute("INSERT OR IGNORE INTO place_regions (region_id, place_id) SELECT ?, id FROM places",
               (LEGACY_REGION_ID,))
    _set_meta_json(db, "legacy_regions", files)


def _region_id(db: sqlite3.Connection, file: str) -> int:
    db.execute("INSERT OR IGNORE INTO osm_regions (file) VALUES (?)", (file,))
    return db.execute("SELECT id FROM osm_regions WHERE file=?", (file,)).fetchone()[0]


def _create_staging(db: sqlite3.Connection) -> None:
    """Temp tables for one extract's merge: `_batch` (the rows being applied now)
    and `_seen` (every place id this extract has, for the end-of-region diff).
    TEMP, so none of it lands in the DB file that gets swapped in."""
    db.execute("PRAGMA temp_store = MEMORY")
    db.execute("DROP TABLE IF EXISTS temp._batch")
    db.execute("DROP TABLE IF EXISTS temp._seen")
    db.execute("""
        CREATE TEMP TABLE _batch (
            osm_type TEXT NOT NULL, osm_id INTEGER NOT NULL, name TEXT NOT NULL,
            category TEXT NOT NULL, admin_level INTEGER, rank INTEGER NOT NULL,
            area REAL NOT NULL, min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL,
            rings TEXT NOT NULL,
            place_id INTEGER, is_new INTEGER NOT NULL DEFAULT 0,
            moved INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
            UNIQUE (osm_type, osm_id)
        )
    """)
    db.execute("CREATE TEMP TABLE _seen (place_id INTEGER PRIMARY KEY)")


def _apply_batch(db: sqlite3.Connection, rows: list[tuple]) -> tuple[int, int]:
    """Upsert one batch of extracted features into places + places_spatial as a
    handful of set-based statements (no per-row queries). An existing feature
    (same osm_type/osm_id) takes the new name/category/geometry in place, keeping
    its id; its R*Tree entry is rewritten only if its bbox moved. Returns
    (added, updated)."""
    # OR REPLACE: a feature repeated within one batch keeps its last occurrence.
    db.executemany(
        "INSERT OR REPLACE INTO _batch (osm_type, osm_id, name, category, admin_level, rank, "
        "area, min_lat, max_lat, min_lng, max_lng, rings) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        rows)
    # Match on places' UNIQUE(osm_type, osm_id) index and flag what differs,
    # comparing with the *old* row before places is overwritten.
    db.execute("""
        UPDATE _batch SET place_id = p.id,
            moved = (p.min_lat IS NOT _batch.min_lat OR p.max_lat IS NOT _batch.max_lat
                     OR p.min_lng IS NOT _batch.min_lng OR p.max_lng IS NOT _batch.max_lng),
            changed = (p.name IS NOT _batch.name OR p.category IS NOT _batch.category
                       OR p.admin_level IS NOT _batch.admin_level OR p.rank IS NOT _batch.rank
                       OR p.area IS NOT _batch.area OR p.rings IS NOT _batch.rings
                       OR p.min_lat IS NOT _batch.min_lat OR p.max_lat IS NOT _batch.max_lat
                       OR p.min_lng IS NOT _batch.min_lng OR p.max_lng IS NOT _batch.max_lng)
        FROM places p WHERE p.osm_type = _batch.osm_type AND p.osm_id = _batch.osm_id
    """)
    # Skipping unchanged rows matters: re-merging a region rewrites only what OSM
    # actually edited, not every rings blob in the extract.
    updated = db.execute("""
        UPDATE places SET name = b.name, category = b.category, admin_level = b.admin_level,
            rank = b.rank, area = b.area, min_lat = b.min_lat, max_lat = b.max_lat,
            min_lng = b.min_lng, max_lng = b.max_lng, rings = b.rings
        FROM _batch b WHERE places.id = b.place_id AND b.changed
    """).rowcount
    db.execute("DELETE FROM places_spatial WHERE id IN (SELECT place_id FROM _batch WHERE moved)")
    db.execute("UPDATE _batch SET is_new = 1 WHERE place_id IS NULL")
    added = db.execute("""
        INSERT INTO places (osm_type, osm_id, name, category, admin_level, rank, area,
                            min_lat, max_lat, min_lng, max_lng, rings)
        SELECT osm_type, osm_id, name, category, admin_level, rank, area,
               min_lat, max_lat, min_lng, max_lng, rings FROM _batch WHERE is_new
    """).rowcount
    if added:
        db.execute("""
            UPDATE _batch SET place_id = p.id FROM places p
            WHERE _batch.is_new AND p.osm_type = _batch.osm_type AND p.osm_id = _batch.osm_id
        """)
    db.execute("""
        INSERT INTO places_spatial (id, min_lat, max_lat, min_lng, max_lng)
        SELECT place_id, min_lat, max_lat, min_lng, max_lng FROM _batch WHERE moved OR is_new
    """)
    db.execute("INSERT OR IGNORE INTO _seen (place_id) SELECT place_id FROM _batch")
    db.execute("DELETE FROM _batch")
    return added, updated


def _finish_region(db: sqlite3.Connection, file: str) -> int:
    """Once an extract has been fully applied: make `_seen` that region's exact
    membership, and delete the places it used to have, now gone from it, that no
    other ingested region still has (audit G8). Returns the number deleted."""
    region_id = _region_id(db, file)
    db.execute("DROP TABLE IF EXISTS temp._dropped")
    db.execute("""
        CREATE TEMP TABLE _dropped AS
        SELECT place_id FROM place_regions
        WHERE region_id = ? AND place_id NOT IN (SELECT place_id FROM _seen)
    """, (region_id,))
    legacy = _meta_json(db, "legacy_regions", [])
    if file in legacy:
        # Legacy rows "belong" to this region too; the ones it no longer has are
        # gone unless another region still claims them (checked below).
        db.execute("""
            INSERT INTO _dropped SELECT place_id FROM place_regions
            WHERE region_id = ? AND place_id NOT IN (SELECT place_id FROM _seen)
        """, (LEGACY_REGION_ID,))
        legacy.remove(file)
        _set_meta_json(db, "legacy_regions", legacy)
        if not legacy:
            # Every legacy region has been re-merged, so each row still claimed
            # has explicit membership; the sentinel no longer means anything.
            db.execute("DELETE FROM place_regions WHERE region_id = ?", (LEGACY_REGION_ID,))
    db.execute("""
        DELETE FROM place_regions
        WHERE region_id = ? AND place_id NOT IN (SELECT place_id FROM _seen)
    """, (region_id,))
    db.execute("INSERT OR IGNORE INTO place_regions (region_id, place_id) "
               "SELECT ?, place_id FROM _seen", (region_id,))
    db.execute("""
        DELETE FROM _dropped WHERE EXISTS
            (SELECT 1 FROM place_regions r WHERE r.place_id = _dropped.place_id)
    """)
    # Both tables, so no R*Tree entry is left pointing at a deleted place.
    db.execute("DELETE FROM places_spatial WHERE id IN (SELECT place_id FROM _dropped)")
    removed = db.execute("DELETE FROM places WHERE id IN (SELECT place_id FROM _dropped)").rowcount
    db.execute("DROP TABLE temp._dropped")
    return removed


def process_file(db: sqlite3.Connection, pbf: Path, index: str,
                  progress_cb: Callable[[int, int], None] | None = None) -> dict:
    """Stream one .osm.pbf and merge its matching named areas, with the file name
    as the region key. Re-merging a region replaces its features (audit G8): ones
    still in the extract are updated in place, ones gone from it are deleted
    unless another ingested region still has them.

    Returns per-category counts of the extract's places (`kept`), skipped counts
    per reason (`skipped`), geometry-error count (`errors`), `added` / `updated` /
    `removed` row counts, and elapsed seconds (`seconds`). progress_cb(seen, kept),
    if given, is called every 500k areas scanned (for job-status reporting)."""
    counts: dict[str, int] = {}
    skipped: dict[str, int] = {}
    errors = 0
    seen = 0
    added = updated = applied = 0
    t0 = time.time()

    fp = (osmium.FileProcessor(str(pbf))
          .with_locations(index)
          .with_areas()
          .with_filter(osmium.filter.EntityFilter(osmium.osm.AREA)))

    _create_staging(db)
    rows: list[tuple] = []

    def flush():
        nonlocal added, updated, applied
        a, u = _apply_batch(db, rows)
        added += a
        updated += u
        applied += len(rows)
        rows.clear()
        # Bounds the rollback journal on a big append. It's the temp build file,
        # so a partial commit is harmless: a failure deletes the whole file.
        if applied % 20_000 < _BATCH_ROWS:
            db.commit()

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
        rows.append((osm_type, area.orig_id(), area.tags.get("name"), category, admin_level,
                     CATEGORY_RANK[category], _polygons_area(polygons),
                     min_lat, max_lat, min_lng, max_lng, json.dumps(polygons)))
        counts[category] = counts.get(category, 0) + 1
        if len(rows) >= _BATCH_ROWS:
            flush()
    if rows:
        flush()
    removed = _finish_region(db, pbf.name)
    db.commit()
    db.execute("DROP TABLE temp._batch")
    db.execute("DROP TABLE temp._seen")

    return {"kept": counts, "skipped": skipped, "errors": errors,
            "added": added, "updated": updated, "removed": removed,
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
    when appending: a merge adds regions, and re-merging one replaces only that
    region's features — see process_file), which is swapped in
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
                            f"({result.get('added', 0):,} added, {result.get('updated', 0):,} "
                            f"updated, {result.get('removed', 0):,} removed; "
                            f"{result['errors']:,} geometry errors skipped)")
            regions.append({"file": pbf.name, "kept": kept, "built_at": time.time()})

            # One entry per file: a re-merge replaces the region's entry instead
            # of listing it twice.
            all_regions = [r for r in _meta_json(db, "regions", []) if r["file"] != pbf.name]
            all_regions.append(regions[-1])
            _set_meta_json(db, "regions", all_regions)
            db.commit()

        grand = db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_places', ?)", (str(grand),))
        db.commit()
        return {"total_places": grand, "regions": regions}
    finally:
        db.close()
