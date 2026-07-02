import pytest

from geotagger import index, exiftool_session


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A fresh, isolated SQLite index DB for one test."""
    monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
    conn = index.init_db(tmp_path)
    yield conn
    conn.close()
    index._db = None
    index._db_path = None


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
