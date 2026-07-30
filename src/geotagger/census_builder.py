"""Core pipeline for building the offline US Census places DB from a Cartographic
Boundary shapefile. Shared by scripts/get_census_places.py (CLI) and
services/data_service.py (the Data Management UI's download job). See
census_places.py for the lookup side.

Source is the Census Bureau's national 1:500,000 "places" Cartographic Boundary
file — one polygon per incorporated place *and* per census designated place (CDP):

    https://www2.census.gov/geo/tiger/GENZ<year>/shp/cb_<year>_us_place_500k.zip

CDPs are the point of it. OSM only has boundary=administrative city polygons, so
the unincorporated suburbia that dominates US metro fringes (Cypress TX, Spring TX,
…) falls through OSM entirely and lands on the GeoNames nearest-point guess. The
Census file covers those areas with real boundaries.

Coordinates in these files are NAD83 geographic degrees (EPSG:4269), i.e. already
lat/lng — no reprojection needed, and within a few cm of WGS84 for our purposes.
Rings are stored in the same format as the OSM places DB ([[outer, [hole, …]], …],
ring = [[lat, lng], …]) so census_places can reuse osm_places' containment test.

Census data is public domain (US Census Bureau, TIGER/Cartographic Boundary Files).
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
# How many vintages back the downloader will walk if the configured year isn't
# posted yet (the Census publishes the new one partway through the following year).
CB_YEAR_FALLBACKS = 3


def cb_urls(year: int | None = None) -> list[tuple[int, str]]:
    """(year, url) candidates newest-first: the configured vintage, then a couple
    of earlier ones so a not-yet-published year degrades to the latest that exists."""
    from geotagger import config
    start = config.CENSUS_CB_YEAR if year is None else year
    return [(y, CB_URL_TEMPLATE.format(year=y)) for y in range(start, start - CB_YEAR_FALLBACKS, -1)]


def download_cb_zip(dest: Path, year: int | None = None,
                    progress_cb: Callable[[str], None] | None = None) -> tuple[int, str]:
    """Download the national 1:500,000 places Cartographic Boundary zip to `dest`,
    trying cb_urls() in order. Returns (year, url) of the one that worked; raises the
    last error if none did. ~10 MB, so it's read in one shot rather than streamed."""
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen

    def progress(msg: str):
        if progress_cb:
            progress_cb(msg)

    last: Exception | None = None
    for y, url in cb_urls(year):
        progress(f"Downloading Census {y} place boundaries…")
        try:
            req = Request(url, headers={"User-Agent": "geo-tagger-data-mgmt/1.0"})
            with urlopen(req, timeout=300) as r:
                data = r.read()
        except (HTTPError, URLError) as e:
            logger.info("Census CB %s not available (%s)", y, e)
            last = e
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        progress(f"Downloaded {dest.name} ({len(data) / 1e6:.1f} MB)")
        return y, url
    raise RuntimeError(
        f"Could not download the Census place boundary file (tried "
        f"{', '.join(str(y) for y, _ in cb_urls(year))}): {last}"
    )


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


def build(db_path: Path, zip_path: Path,
          progress_cb: Callable[[str], None] | None = None) -> dict:
    """Build the census places DB at db_path from a cb_<year>_us_place_500k.zip.

    Always a full rebuild (the file is national and self-contained — there's no
    append story like OSM's per-region extracts), so an existing DB is replaced only
    once the new one is complete: it's written to a .tmp sibling and swapped in at the
    end, leaving the live DB intact if anything fails halfway.

    Returns {"total_places": int, "by_kind": {kind: n}, "seconds": float}.
    """
    def progress(msg: str):
        if progress_cb:
            progress_cb(msg)

    t0 = time.time()
    reader, zf = _open_reader(zip_path)
    try:
        field_names = [f[0] for f in reader.fields[1:]]  # [0] is the deletion flag
        missing = [f for f in _REQUIRED_FIELDS if f not in field_names]
        if missing:
            raise ValueError(f"{zip_path.name} has no {', '.join(missing)} field — "
                             "is this the 'place' Cartographic Boundary file?")

        db_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = db_path.with_suffix(db_path.suffix + ".tmp")
        tmp_path.unlink(missing_ok=True)
        db = sqlite3.connect(str(tmp_path))
        try:
            init_db(db)
            cur = db.cursor()
            by_kind: dict[str, int] = {}
            errors = 0
            kept = 0
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
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('source', ?)",
                       (zip_path.name,))
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_places', ?)",
                       (str(kept),))
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('by_kind', ?)",
                       (json.dumps(by_kind),))
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)",
                       (str(time.time()),))
            db.commit()
        finally:
            db.close()
    finally:
        reader.close()
        zf.close()

    # Swap the finished build in. The app holds a read-only handle on the old file;
    # on Windows a replace under an open reader can fail, so census_places.reset()
    # is called by the callers that own that handle before getting here.
    db_path.unlink(missing_ok=True)
    tmp_path.replace(db_path)

    seconds = round(time.time() - t0, 1)
    progress(f"Done. {kept:,} places ({errors} geometry errors) in {seconds}s.")
    return {"total_places": kept, "by_kind": by_kind, "errors": errors, "seconds": seconds}
