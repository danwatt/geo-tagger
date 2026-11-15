"""The seams between the Python app and the React frontend (frontend/):
the committed OpenAPI schema it generates types from, and static serving that
layers the Vite build over the legacy pages."""

import importlib.util
from pathlib import Path

from starlette.applications import Starlette
from starlette.testclient import TestClient

from geotagger.static import LayeredStaticFiles

ROOT = Path(__file__).resolve().parent.parent


def _load_export_script():
    spec = importlib.util.spec_from_file_location("export_openapi", ROOT / "scripts" / "export_openapi.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_openapi_schema_is_current():
    """frontend/openapi.json must match the routes, or the TypeScript types
    drift from the API. Fix: `npm --prefix frontend run gen:api`."""
    export = _load_export_script()
    committed = export.OUT.read_text(encoding="utf-8")
    assert committed == export.render(), "frontend/openapi.json is stale; run `npm --prefix frontend run gen:api`"


def test_settings_schema_keeps_int_values_as_ints(client):
    """SettingValue's `bool | int | float` order keeps 14400 an int and bools bools."""
    settings = client.get("/api/settings").json()["settings"]
    by_type = {s["type"]: s for s in settings}
    assert isinstance(by_type["int"]["value"], int) and not isinstance(by_type["int"]["value"], bool)
    assert isinstance(by_type["bool"]["value"], bool)
    assert isinstance(by_type["float"]["value"], float)


def _static_client(tmp_path: Path) -> TestClient:
    dist, web = tmp_path / "dist", tmp_path / "web"
    dist.mkdir()
    web.mkdir()
    (dist / "settings.html").write_text("react settings")
    (web / "settings.html").write_text("legacy settings")
    (web / "design-artifacts.html").write_text("legacy design reference")
    (web / "index.html").write_text("legacy home")
    app = Starlette()
    app.mount("/", LayeredStaticFiles([dist, web], html=True))
    return TestClient(app)


def test_built_page_shadows_legacy_page(tmp_path):
    client = _static_client(tmp_path)
    assert client.get("/settings.html").text == "react settings"


def test_files_only_in_legacy_tree_fall_back_to_it(tmp_path):
    # Every page is built now, but web/ still serves what the build doesn't
    # have (theme.css, the design reference page).
    client = _static_client(tmp_path)
    assert client.get("/design-artifacts.html").text == "legacy design reference"
    assert client.get("/").text == "legacy home"
    assert client.get("/missing.html").status_code == 404


def test_missing_build_dir_serves_legacy_only(tmp_path):
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("legacy home")
    app = Starlette()
    app.mount("/", LayeredStaticFiles([tmp_path / "dist", web], html=True))
    assert TestClient(app).get("/").text == "legacy home"
