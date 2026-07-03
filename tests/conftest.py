import pytest

from geotagger import index, exiftool_session, thumbnails, geocode


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
    monkeypatch.setattr(geocode, "GEONAMES_DIR", tmp_path)
    _reset_geocode_state()
    yield tmp_path
    _reset_geocode_state()


def _reset_landmark_state():
    geocode._landmark_state = "unloaded"
    geocode._landmark_error = None
    geocode._building_polygons = []
    geocode._park_polygons = []
    geocode._place_tree = None
    geocode._place_names = []
    geocode._place_categories = []
    geocode._place_lats = None
    geocode._place_lngs = None


@pytest.fixture(autouse=True)
def _isolate_landmark_data(tmp_path_factory, monkeypatch):
    """geocode.lookup() unconditionally calls resolve_landmark() now, so every
    test — even ones that never touch landmark data on purpose — must not be
    able to see a developer's real local data/overture/landmarks.jsonl. Points
    OVERTURE_DIR at an empty directory by default; tests that want to exercise
    real landmark data use the `overture_dir` fixture below, which re-points it
    at its own tmp_path (this fixture's patch is simply superseded for those)."""
    empty_dir = tmp_path_factory.mktemp("empty_overture")
    monkeypatch.setattr(geocode, "OVERTURE_DIR", empty_dir)
    _reset_landmark_state()
    yield
    _reset_landmark_state()


@pytest.fixture
def overture_dir(tmp_path, monkeypatch):
    """Point the landmark resolver at an isolated (initially empty) Overture
    directory and reset its load-state singleton before and after the test."""
    monkeypatch.setattr(geocode, "OVERTURE_DIR", tmp_path)
    _reset_landmark_state()
    yield tmp_path
    _reset_landmark_state()


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
