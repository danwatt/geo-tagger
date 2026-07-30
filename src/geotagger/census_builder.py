"""Core pipeline for building the offline US Census DB from Cartographic Boundary
shapefiles. Shared by scripts/get_census_places.py (CLI) and
services/data_service.py (the Data Management UI's download job). See
census_places.py for the lookup side.

Three layers, all built into one SQLite file in a single pass (a build is always a
full rebuild, so they have to be written together or the previous ones are lost):

1. **places** — the national 1:500,000 "places" file, one polygon per incorporated
   place *and* per census designated place (CDP):
       https://www2.census.gov/geo/tiger/GENZ<year>/shp/cb_<year>_us_place_500k.zip
   CDPs are the point of it. OSM only has boundary=administrative city polygons, so
   the unincorporated suburbia that dominates US metro fringes (Cypress TX, Spring
   TX, …) falls through OSM entirely and lands on the GeoNames nearest-point guess.
2. **zctas** — the matching ZIP Code Tabulation Area file:
       https://www2.census.gov/geo/tiger/GENZ<year>/shp/cb_<year>_us_zcta520_500k.zip
   Approximates USPS ZIP delivery areas as polygons. Carries only the 5-digit code —
   no name, no state (ZCTAs cross state lines).
3. **zip_places** — GeoNames' free US postal-code table, which is what turns a bare
   ZCTA code into "Houston, TX": the USPS-preferred city name per ZIP.
       https://download.geonames.org/export/zip/US.zip   (CC BY 4.0)

Coordinates in the Census files are NAD83 geographic degrees (EPSG:4269), i.e.
already lat/lng — no reprojection needed, and within a few cm of WGS84 for our
purposes. Rings are stored in the same format as the OSM places DB
([[outer, [hole, …]], …], ring = [[lat, lng], …]) so census_places can reuse
osm_places' containment test.

Census data is public domain (US Census Bureau, TIGER/Cartographic Boundary Files);
the postal-code crosswalk is GeoNames, CC BY 4.0.
"""

import json
import logging
import sqlite3
import time
import zipfile
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

# LSAD (legal/statistical area description) codes the place file uses, mapped to the
# `kind` we store. Only used for display/diagnostics — every one of these is a
# "place" for lookup purposes. See census.gov's LSAD code list.
LSAD_KINDS = {
    "21": "borough", "25": "city", "43": "town", "44": "town", "45": "town",
    "46": "town", "47": "village", "49": "village", "53": "city and borough",
    "55": "comunidad", "57": "CDP", "62": "zona urbana", "68": "municipality",
}

# Fields we read out of the shapefile's .dbf. GEOID is the stable 7-digit
# state+place FIPS code; NAME is the bare name ("Cypress"), NAMELSAD the
# qualified one ("Cypress CDP").
_REQUIRED_FIELDS = ("GEOID", "NAME")


CB_URL_TEMPLATE = "https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_place_500k.zip"
# ZCTA vintages are named for the decennial census they're tabulated from, not the
# file year — "520" is the 2020 ZCTA5 series, which every year from 2020 on uses.
CB_ZCTA_URL_TEMPLATE = "https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_zcta520_500k.zip"
# How many vintages back the downloader will walk if the configured year isn't
# posted yet (the Census publishes the new one partway through the following year).
CB_YEAR_FALLBACKS = 3

# GeoNames' US postal-code export: the ZIP -> USPS-preferred city/state crosswalk.
GEONAMES_ZIP_URL = "https://download.geonames.org/export/zip/US.zip"


def cb_urls(year: int | None = None, template: str = CB_URL_TEMPLATE) -> list[tuple[int, str]]:
    """(year, url) candidates newest-first: the configured vintage, then a couple
    of earlier ones so a not-yet-published year degrades to the latest that exists."""
    from geotagger import config
    start = config.CENSUS_CB_YEAR if year is None else year
    return [(y, template.format(year=y)) for y in range(start, start - CB_YEAR_FALLBACKS, -1)]


def cb_zcta_urls(year: int | None = None) -> list[tuple[int, str]]:
    """Candidate (year, url) list for the ZCTA file, off its own vintage
    (config.CENSUS_ZCTA_YEAR) — the yearly place-file vintage doesn't apply, since
    ZCTAs are only published once per decennial series."""
    from geotagger import config
    start = config.CENSUS_ZCTA_YEAR if year is None else year
    return [(y, CB_ZCTA_URL_TEMPLATE.format(year=y))
            for y in range(start, start - CB_YEAR_FALLBACKS, -1)]


def download_cb_zip(dest: Path, year: int | None = None,
                    progress_cb: Callable[[str], None] | None = None,
                    template: str = CB_URL_TEMPLATE) -> tuple[int, str]:
    """Download a national 1:500,000 Cartographic Boundary zip (places by default,
    or the ZCTA file via `template`) to `dest`, trying cb_urls() in order. Returns
    (year, url) of the one that worked; raises the last error if none did. Tens of MB
    at most, so it's read in one shot rather than streamed."""
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen

    def progress(msg: str):
        if progress_cb:
            progress_cb(msg)

    is_zcta = "zcta" in template
    candidates = cb_zcta_urls(year) if is_zcta else cb_urls(year, template)
    label = "ZCTA" if is_zcta else "place"
    last: Exception | None = None
    for y, url in candidates:
        progress(f"Downloading Census {y} {label} boundaries…")
        try:
            req = Request(url, headers={"User-Agent": "geo-tagger-data-mgmt/1.0"})
            with urlopen(req, timeout=300) as r:
                data = r.read()
        except (HTTPError, URLError) as e:
            logger.info("Census CB %s %s not available (%s)", y, label, e)
            last = e
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        progress(f"Downloaded {dest.name} ({len(data) / 1e6:.1f} MB)")
        return y, url
    raise RuntimeError(
        f"Could not download the Census {label} boundary file (tried "
        f"{', '.join(str(y) for y, _ in candidates)}): {last}"
    )


def download_zcta_zip(dest: Path, year: int | None = None,
                      progress_cb: Callable[[str], None] | None = None) -> tuple[int, str]:
    """Download the national 1:500,000 ZCTA Cartographic Boundary zip (~60 MB)."""
    return download_cb_zip(dest, year, progress_cb, template=CB_ZCTA_URL_TEMPLATE)


def download_geonames_zip_codes(dest: Path,
                                progress_cb: Callable[[str], None] | None = None) -> str:
    """Download GeoNames' US postal-code archive (~1 MB) to `dest`. Returns the URL."""
    from urllib.request import Request, urlopen

    if progress_cb:
        progress_cb("Downloading GeoNames US postal codes…")
    req = Request(GEONAMES_ZIP_URL, headers={"User-Agent": "geo-tagger-data-mgmt/1.0"})
    with urlopen(req, timeout=300) as r:
        data = r.read()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    if progress_cb:
        progress_cb(f"Downloaded {dest.name} ({len(data) / 1e6:.1f} MB)")
    return GEONAMES_ZIP_URL


def _ring_area(ring: list) -> float:
    """Shoelace area in squared degrees — same crude measure osm_builder uses, only
    ever compared between candidate polygons to pick the smallest containing one."""
    n = len(ring)
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


def _shape_to_polygons(shape) -> list:
    """A pyshp polygon shape -> [[outer, [hole, …]], …] with rings as [lat, lng].

    Shapefile polygons are a flat point list split by `parts`, with ring winding
    carrying the meaning: clockwise = outer ring, counter-clockwise = hole (the
    ESRI shapefile spec's rule). Holes attach to the most recently seen outer
    ring, which is how the format expresses a multipolygon with holes.
    """
    points = shape.points
    if not points:
        return []
    parts = list(shape.parts) + [len(points)]
    polygons: list = []
    for i in range(len(parts) - 1):
        ring_pts = points[parts[i]:parts[i + 1]]
        if len(ring_pts) < 4:  # a closed ring needs 3 distinct points + repeat
            continue
        # Signed shoelace in (x=lng, y=lat) order: negative = clockwise = outer.
        signed = 0.0
        for j in range(len(ring_pts) - 1):
            x0, y0 = ring_pts[j]
            x1, y1 = ring_pts[j + 1]
            signed += x0 * y1 - x1 * y0
        ring = [[float(y), float(x)] for x, y in ring_pts]
        if signed < 0 or not polygons:
            # Outer ring — or a leading hole in malformed data, which we'd rather
            # keep as an outer ring than silently drop.
            polygons.append([ring, []])
        else:
            polygons[-1][1].append(ring)
    return polygons


def init_db(db: sqlite3.Connection):
    # Deliberately NOT WAL, same rationale as osm_builder.init_db: built once, then
    # opened read-only by the app, so a rollback journal keeps it a clean single file.
    db.execute("""
        CREATE TABLE IF NOT EXISTS places (
            id INTEGER PRIMARY KEY,
            geoid TEXT NOT NULL UNIQUE,    -- state+place FIPS, stable across vintages
            name TEXT NOT NULL,            -- "Cypress"
            name_lsad TEXT,                -- "Cypress CDP"
            lsad TEXT,                     -- raw LSAD code
            kind TEXT,                     -- LSAD_KINDS[lsad], e.g. 'city' | 'CDP'
            state_fp TEXT,
            state_name TEXT,
            area REAL NOT NULL,            -- polygon area (deg²), smallest-containing tiebreak
            min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL,
            rings TEXT NOT NULL            -- JSON [[outer, [hole,...]], ...], ring = [[lat,lng],...]
        )
    """)
    db.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS places_spatial USING rtree(
            id, min_lat, max_lat, min_lng, max_lng
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS zctas (
            id INTEGER PRIMARY KEY,
            zip TEXT NOT NULL UNIQUE,      -- 5-digit ZCTA code; no name/state in the source
            area REAL NOT NULL,
            min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL,
            rings TEXT NOT NULL            -- JSON, same format as places.rings
        )
    """)
    db.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS zctas_spatial USING rtree(
            id, min_lat, max_lat, min_lng, max_lng
        )
    """)
    # ZIP -> USPS-preferred city/state, from GeoNames. Separate from `zctas` because
    # it's a different source with different coverage: a ZCTA with no crosswalk row
    # still resolves to its bare code, and a ZIP with no polygon is simply unused.
    db.execute("""
        CREATE TABLE IF NOT EXISTS zip_places (
            zip TEXT PRIMARY KEY,
            city TEXT NOT NULL,
            state TEXT,
            state_code TEXT
        )
    """)
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    db.commit()


def _open_reader(zip_path: Path):
    """A pyshp Reader over the .shp/.dbf/.shx inside the downloaded CB zip, without
    unpacking it to disk (the archive is ~10 MB packed, ~90 MB unpacked)."""
    import shapefile

    zf = zipfile.ZipFile(zip_path)
    names = {Path(n).suffix.lower(): n for n in zf.namelist()}
    missing = [ext for ext in (".shp", ".dbf", ".shx") if ext not in names]
    if missing:
        zf.close()
        raise ValueError(f"{zip_path.name} is missing {', '.join(missing)} — not a shapefile archive?")
    reader = shapefile.Reader(
        shp=zf.open(names[".shp"]), dbf=zf.open(names[".dbf"]), shx=zf.open(names[".shx"])
    )
    return reader, zf


def _load_places(db: sqlite3.Connection, zip_path: Path, progress) -> dict:
    """Load the place polygons into an already-initialized DB. Returns
    {"total": n, "by_kind": {...}, "errors": n}."""
    reader, zf = _open_reader(zip_path)
    try:
        field_names = [f[0] for f in reader.fields[1:]]  # [0] is the deletion flag
        missing = [f for f in _REQUIRED_FIELDS if f not in field_names]
        if missing:
            raise ValueError(f"{zip_path.name} has no {', '.join(missing)} field — "
                             "is this the 'place' Cartographic Boundary file?")
        cur = db.cursor()
        by_kind: dict[str, int] = {}
        errors = kept = 0
        for i, rec in enumerate(reader.iterShapeRecords(), 1):
            row = dict(zip(field_names, rec.record))
            polygons = _shape_to_polygons(rec.shape)
            if not polygons:
                errors += 1
                continue
            lsad = (row.get("LSAD") or "").strip()
            kind = LSAD_KINDS.get(lsad)
            min_lat, max_lat, min_lng, max_lng = _polygons_bbox(polygons)
            cur.execute(
                "INSERT OR IGNORE INTO places "
                "(geoid, name, name_lsad, lsad, kind, state_fp, state_name, area, "
                " min_lat, max_lat, min_lng, max_lng, rings) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (row.get("GEOID"), row.get("NAME"), row.get("NAMELSAD"), lsad or None,
                 kind, row.get("STATEFP"), row.get("STATE_NAME"),
                 _polygons_area(polygons), min_lat, max_lat, min_lng, max_lng,
                 json.dumps(polygons)),
            )
            if cur.rowcount == 1:
                cur.execute(
                    "INSERT INTO places_spatial (id, min_lat, max_lat, min_lng, max_lng) "
                    "VALUES (?,?,?,?,?)",
                    (cur.lastrowid, min_lat, max_lat, min_lng, max_lng),
                )
                kept += 1
                by_kind[kind or "other"] = by_kind.get(kind or "other", 0) + 1
            if i % 5_000 == 0:
                db.commit()
                progress(f"Loaded {kept:,} places…")
        db.commit()
        return {"total": kept, "by_kind": by_kind, "errors": errors}
    finally:
        reader.close()
        zf.close()


def _load_zctas(db: sqlite3.Connection, zip_path: Path, progress) -> dict:
    """Load the ZCTA polygons. The code field is named for its decennial vintage
    (ZCTA5CE20/GEOID20 in the 2020 series, ...CE10 before it), so it's matched by
    prefix rather than hardcoded. Returns {"total": n, "errors": n}."""
    reader, zf = _open_reader(zip_path)
    try:
        field_names = [f[0] for f in reader.fields[1:]]
        code_field = next((f for f in field_names
                           if f.startswith("ZCTA5CE") or f.startswith("GEOID")), None)
        if code_field is None:
            raise ValueError(f"{zip_path.name} has no ZCTA5CE*/GEOID* field — "
                             "is this the ZCTA Cartographic Boundary file?")
        cur = db.cursor()
        errors = kept = 0
        for i, rec in enumerate(reader.iterShapeRecords(), 1):
            row = dict(zip(field_names, rec.record))
            polygons = _shape_to_polygons(rec.shape)
            if not polygons:
                errors += 1
                continue
            zip_code = (row.get(code_field) or "").strip()
            if not zip_code:
                errors += 1
                continue
            min_lat, max_lat, min_lng, max_lng = _polygons_bbox(polygons)
            cur.execute(
                "INSERT OR IGNORE INTO zctas (zip, area, min_lat, max_lat, min_lng, max_lng, rings) "
                "VALUES (?,?,?,?,?,?,?)",
                (zip_code, _polygons_area(polygons), min_lat, max_lat, min_lng, max_lng,
                 json.dumps(polygons)),
            )
            if cur.rowcount == 1:
                cur.execute(
                    "INSERT INTO zctas_spatial (id, min_lat, max_lat, min_lng, max_lng) "
                    "VALUES (?,?,?,?,?)",
                    (cur.lastrowid, min_lat, max_lat, min_lng, max_lng),
                )
                kept += 1
            if i % 5_000 == 0:
                db.commit()
                progress(f"Loaded {kept:,} ZCTAs…")
        db.commit()
        return {"total": kept, "errors": errors}
    finally:
        reader.close()
        zf.close()


def _load_zip_places(db: sqlite3.Connection, zip_path: Path, progress) -> int:
    """Load GeoNames' US.zip postal-code table (ZIP -> city/state). Returns the row
    count. Tab-separated, one row per ZIP *per place name* — a ZIP serving several
    named communities repeats, and GeoNames lists the USPS-preferred name first, so
    the first row for a ZIP wins (INSERT OR IGNORE)."""
    with zipfile.ZipFile(zip_path) as zf:
        member = next((n for n in zf.namelist()
                       if n.upper().endswith(".TXT") and "readme" not in n.lower()), None)
        if member is None:
            raise ValueError(f"{zip_path.name} has no .txt member — not the GeoNames postal archive?")
        raw = zf.read(member).decode("utf-8")

    cur = db.cursor()
    n = 0
    for line in raw.splitlines():
        parts = line.split("\t")
        # country(0) postal_code(1) place(2) admin1_name(3) admin1_code(4) ...
        if len(parts) < 5 or not parts[1] or not parts[2]:
            continue
        cur.execute(
            "INSERT OR IGNORE INTO zip_places (zip, city, state, state_code) VALUES (?,?,?,?)",
            (parts[1].strip(), parts[2].strip(), parts[3].strip() or None, parts[4].strip() or None),
        )
        n += cur.rowcount
    db.commit()
    progress(f"Loaded {n:,} ZIP -> city rows")
    return n


def build(db_path: Path, zip_path: Path, zcta_zip_path: Path | None = None,
          postal_zip_path: Path | None = None,
          progress_cb: Callable[[str], None] | None = None) -> dict:
    """Build the census DB at db_path from a cb_<year>_us_place_500k.zip, optionally
    also loading the ZCTA boundary file and GeoNames' ZIP -> city crosswalk.

    Always a full rebuild (these files are national and self-contained — there's no
    append story like OSM's per-region extracts), so all layers are written in one
    pass, and an existing DB is replaced only once the new one is complete: it's
    written to a .tmp sibling and swapped in at the end, leaving the live DB intact if
    anything fails halfway. Omitting a layer therefore *drops* it, rather than keeping
    whatever the previous build had.

    Returns {"total_places", "by_kind", "total_zctas", "total_zip_names", "errors",
    "seconds"}.
    """
    def progress(msg: str):
        if progress_cb:
            progress_cb(msg)

    t0 = time.time()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = db_path.with_suffix(db_path.suffix + ".tmp")
    tmp_path.unlink(missing_ok=True)
    db = sqlite3.connect(str(tmp_path))
    try:
        init_db(db)
        places = _load_places(db, zip_path, progress)
        zctas = {"total": 0, "errors": 0}
        zip_names = 0
        if zcta_zip_path is not None:
            zctas = _load_zctas(db, zcta_zip_path, progress)
        if postal_zip_path is not None:
            zip_names = _load_zip_places(db, postal_zip_path, progress)

        meta = {
            "source": zip_path.name,
            "zcta_source": zcta_zip_path.name if zcta_zip_path else None,
            "postal_source": postal_zip_path.name if postal_zip_path else None,
            "total_places": str(places["total"]),
            "total_zctas": str(zctas["total"]),
            "total_zip_names": str(zip_names),
            "by_kind": json.dumps(places["by_kind"]),
            "built_at": str(time.time()),
        }
        for key, value in meta.items():
            if value is not None:
                db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
        db.commit()
    finally:
        db.close()

    # Swap the finished build in. In-process, census_places.reset() (called by the
    # Data Management job) drops our own read-only handle first. A *separate* process
    # holding it — a running app instance — can't be reset from here, and Windows
    # refuses to replace a file that's open, so say so instead of surfacing a bare
    # WinError 32. The completed build is left in place as .tmp either way.
    try:
        db_path.unlink(missing_ok=True)
        tmp_path.replace(db_path)
    except PermissionError as e:
        raise RuntimeError(
            f"Built {tmp_path.name} but could not replace {db_path.name} — another "
            "process has it open (a running geotagger instance?). Stop it and rename "
            "the .tmp file over the old one, or run this from the app's Data "
            f"Management page instead. ({e})"
        ) from e

    errors = places["errors"] + zctas["errors"]
    seconds = round(time.time() - t0, 1)
    progress(f"Done. {places['total']:,} places, {zctas['total']:,} ZCTAs "
             f"({errors} geometry errors) in {seconds}s.")
    return {"total_places": places["total"], "by_kind": places["by_kind"],
            "total_zctas": zctas["total"], "total_zip_names": zip_names,
            "errors": errors, "seconds": seconds}
