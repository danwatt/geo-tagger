import os
import shutil
from pathlib import Path

import pytest

from geotagger import index, exiftool_session, thumbnails, geocode, osm_places, config


def _find_dev_exiftool() -> str | None:
    """Best-effort locate a locally available ExifTool binary for the whole test
    session. Tests isolate GEOTAGGER_CACHE_DIR per test (see the `client`
    fixture), so config.get_exiftool_path()'s "alongside the cache dir" default
    can't find a bundled binary downloaded there — set GEOTAGGER_EXIFTOOL (which
    always takes priority) once so the session doesn't depend on which cache dir
    a given test happens to use."""
    if shutil.which("exiftool"):
        return "exiftool"
    legacy_repo_tools = Path(__file__).parent.parent / "tools" / config.BUNDLED_EXIFTOOL_NAME
    for candidate in (config.get_state_dir() / "tools" / config.BUNDLED_EXIFTOOL_NAME, legacy_repo_tools):
        if candidate.exists():
            return str(candidate)
    return None


if not os.environ.get("GEOTAGGER_EXIFTOOL"):
    if _dev_exiftool := _find_dev_exiftool():
        os.environ["GEOTAGGER_EXIFTOOL"] = _dev_exiftool
        config.EXIFTOOL_PATH = _dev_exiftool


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A fresh, isolated SQLite index DB for one test."""
    monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
    conn = index.init_db(tmp_path)
    yield conn
    conn.close()
    index._db = None
    index._db_path = None
    # Recognition caches are module globals keyed on the faces generation; drop
    # them so the next test's fresh DB isn't shadowed by a Gallery built here.
    from geotagger import faces
    faces._gallery_cache = None
    faces._unlabeled_cache = None
    faces._suggested_scores_cache = None


@pytest.fixture
def thumbs_dir(tmp_path, monkeypatch):
    """A fresh, isolated thumbnail cache directory for one test."""
    monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
    thumbnails.init_thumbs(tmp_path)
    yield thumbnails._get_thumbs_dir()
    thumbnails._thumbs_dir = None


def _reset_geocode_state():
    geocode._state = "unloaded"
    geocode._error = None
    geocode._tree = None
    geocode._names = []
    geocode._ccs = []
    geocode._admin1 = []
    geocode._admin2 = []
    geocode._lats = None
    geocode._lngs = None
    geocode._populations = None
    geocode._admin1_names = {}
    geocode._admin2_names = {}
    geocode._country_names = {}


@pytest.fixture
def geonames_dir(tmp_path, monkeypatch):
    """Point the geocoder at an isolated (initially empty) GeoNames directory
    and reset its load-state singleton before and after the test."""
    monkeypatch.setattr(config, "GEONAMES_DIR", tmp_path)
    _reset_geocode_state()
    yield tmp_path
    _reset_geocode_state()


def _reset_osm_places_state():
    if osm_places._conn is not None:
        try:
            osm_places._conn.close()
        except Exception:
            pass
    osm_places._state = "unloaded"
    osm_places._error = None
    osm_places._conn = None


@pytest.fixture(autouse=True)
def _isolate_osm_places(tmp_path, monkeypatch):
    """Default every test to 'OSM places not installed' (points config.OSM_DB_PATH
    at an absent file + resets the singleton), so geocoding falls back to GeoNames
    and tests don't depend on whether a real data/osm/places.sqlite exists locally.
    Tests that want OSM data use the `osm_db` fixture, which repoints this."""
    monkeypatch.setattr(config, "OSM_DB_PATH", tmp_path / "__no_osm__.sqlite")
    _reset_osm_places_state()
    yield
    _reset_osm_places_state()


@pytest.fixture
def osm_db(tmp_path, monkeypatch):
    """Point osm_places at an isolated (initially absent) places.sqlite and reset
    its load-state singleton around the test. Yields a `build(rows)` callable that
    writes the real schema + the given place rows.

    A row is a dict: {name, category, admin_level?, area?, polygons}, where
    polygons is the stored ring format [[outer, [hole,...]], ...] (ring=[[lat,lng],...])."""
    import json as _json

    db_path = tmp_path / "places.sqlite"
    monkeypatch.setattr(config, "OSM_DB_PATH", db_path)
    _reset_osm_places_state()

    def build(rows):
        conn = __import__("sqlite3").connect(str(db_path))
        conn.execute("""CREATE TABLE places (
            id INTEGER PRIMARY KEY, osm_type TEXT, osm_id INTEGER, name TEXT, category TEXT,
            admin_level INTEGER, rank INTEGER, area REAL,
            min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL, rings TEXT)""")
        conn.execute("""CREATE VIRTUAL TABLE places_spatial USING rtree(
            id, min_lat, max_lat, min_lng, max_lng)""")
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        for i, r in enumerate(rows, start=1):
            polys = r["polygons"]
            lats = [pt[0] for outer, _ in polys for pt in outer]
            lngs = [pt[1] for outer, _ in polys for pt in outer]
            bbox = (min(lats), max(lats), min(lngs), max(lngs))
            conn.execute(
                "INSERT INTO places (id, osm_type, osm_id, name, category, admin_level, "
                "rank, area, min_lat, max_lat, min_lng, max_lng, rings) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (i, "way", i, r["name"], r["category"], r.get("admin_level"),
                 r.get("rank", 3), r.get("area", 1.0), *bbox, _json.dumps(polys)))
            conn.execute("INSERT INTO places_spatial VALUES (?,?,?,?,?)", (i, *bbox))
        conn.commit()
        conn.close()
        return db_path

    yield build
    _reset_osm_places_state()


def _reset_census_places_state():
    from geotagger import census_places
    census_places.reset()


@pytest.fixture(autouse=True)
def _isolate_census_places(tmp_path, monkeypatch):
    """Default every test to 'Census places not installed' (points
    config.CENSUS_DB_PATH at an absent file + resets the singleton), so the city
    chain stays OSM -> GeoNames unless a test opts in via the `census_db` fixture."""
    monkeypatch.setattr(config, "CENSUS_DB_PATH", tmp_path / "__no_census__.sqlite")
    _reset_census_places_state()
    yield
    _reset_census_places_state()


@pytest.fixture
def census_db(tmp_path, monkeypatch):
    """Point census_places at an isolated (initially absent) places.sqlite and reset
    its load-state singleton around the test. Yields a `build(rows)` callable that
    writes the real schema (census_builder.init_db) + the given place rows.

    A row is a dict: {name, kind?, geoid?, area?, state?, polygons}, where polygons is
    the stored ring format [[outer, [hole,...]], ...] (ring=[[lat,lng],...]).

    `build(rows, zctas=[...])` also loads ZIP areas — {zip, polygons, area?, city?,
    state?}, with `city` writing the ZIP -> city crosswalk row the real build gets
    from GeoNames."""
    import json as _json
    import sqlite3

    from geotagger import census_builder

    db_path = tmp_path / "census-places.sqlite"
    monkeypatch.setattr(config, "CENSUS_DB_PATH", db_path)
    _reset_census_places_state()

    def build(rows, zctas=()):
        conn = sqlite3.connect(str(db_path))
        census_builder.init_db(conn)
        for i, z in enumerate(zctas, start=1):
            polys = z["polygons"]
            lats = [pt[0] for outer, _ in polys for pt in outer]
            lngs = [pt[1] for outer, _ in polys for pt in outer]
            bbox = (min(lats), max(lats), min(lngs), max(lngs))
            conn.execute(
                "INSERT INTO zctas (id, zip, area, min_lat, max_lat, min_lng, max_lng, rings) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (i, z["zip"], z.get("area", 1.0), *bbox, _json.dumps(polys)))
            conn.execute("INSERT INTO zctas_spatial VALUES (?,?,?,?,?)", (i, *bbox))
            if z.get("city"):
                conn.execute(
                    "INSERT OR IGNORE INTO zip_places (zip, city, state, state_code) "
                    "VALUES (?,?,?,?)",
                    (z["zip"], z["city"], z.get("state", "Texas"), z.get("state_code", "TX")))
        for i, r in enumerate(rows, start=1):
            polys = r["polygons"]
            lats = [pt[0] for outer, _ in polys for pt in outer]
            lngs = [pt[1] for outer, _ in polys for pt in outer]
            bbox = (min(lats), max(lats), min(lngs), max(lngs))
            conn.execute(
                "INSERT INTO places (id, geoid, name, name_lsad, lsad, kind, state_fp, "
                "state_name, area, min_lat, max_lat, min_lng, max_lng, rings) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (i, r.get("geoid", f"48{i:05d}"), r["name"],
                 r.get("name_lsad", r["name"]), r.get("lsad", "25"), r.get("kind", "city"),
                 r.get("state_fp", "48"), r.get("state", "Texas"),
                 r.get("area", 1.0), *bbox, _json.dumps(polys)))
            conn.execute("INSERT INTO places_spatial VALUES (?,?,?,?,?)", (i, *bbox))
        conn.commit()
        conn.close()
        return db_path

    yield build
    _reset_census_places_state()


@pytest.fixture(scope="session")
def et_session():
    """Shared ExifTool process for sidecar round-trip tests. Skips the tests
    that need it if the bundled/PATH exiftool binary isn't available."""
    if not exiftool_session.start_et():
        pytest.skip(f"ExifTool unavailable: {exiftool_session._et_error}")
    yield
    exiftool_session.stop_et()


@pytest.fixture
def sample_image(tmp_path):
    """A minimal real JPEG on disk, so exiftool has a valid file to read/write
    sidecars for."""
    from PIL import Image
    path = tmp_path / "photo.jpg"
    Image.new("RGB", (4, 4), color="red").save(path, "JPEG")
    return path


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient wired to a fresh, isolated DB. Entering the TestClient context
    runs the app lifespan (which initializes the request executor); GEOTAGGER_NO_SCAN
    + an empty cache dir keep startup from scanning or auto-loading a prior root."""
    from fastapi.testclient import TestClient
    from geotagger import index, main

    monkeypatch.setenv("GEOTAGGER_NO_SCAN", "1")
    monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("GEOTAGGER_SCAN_DIRS", raising=False)

    # Pre-create the DB; with no last-scan sentinel in the empty cache dir the
    # lifespan's auto-load path is a no-op, so this connection is the one served.
    conn = index.init_db(tmp_path)
    # The app lifespan stops the shared ExifTool session on shutdown. If a
    # session-scoped et_session fixture already had it running, restart it after
    # teardown so later et_session-based tests still find a live process.
    et_was_running = exiftool_session._et is not None
    with TestClient(main.app) as c:
        yield c
    if et_was_running:
        exiftool_session.start_et()

    conn.close()
    index._db = None
    index._db_path = None
    from geotagger import faces
    faces._gallery_cache = None
    faces._unlabeled_cache = None
    faces._suggested_scores_cache = None
