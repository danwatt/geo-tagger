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
