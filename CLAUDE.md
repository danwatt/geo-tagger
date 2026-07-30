# CLAUDE.md

Guidance for work in repo. Read `README.md` for setup/usage; this file about
**how code written** so new code match. Also see `*_PLAN.md` handoff docs and
`IDEAS.md` backlog.

## What this is

Local web app, geotag photo/video library. Python (FastAPI)
backend + vanilla-JS/Leaflet frontend served static files. No build step, no Node. Backend +
all data (SQLite DB, thumbnails, models) fully local; only network
dependencies: Leaflet library + OpenStreetMap map tiles, loaded from CDNs
(`unpkg.com`, `tile.openstreetmap.org`) in HTML — map UI need internet, rest
don't.

## Stack & tooling

- **Python 3.13+**, managed by **`uv`**. Always use it — `uv run …`, `uv sync`, `uv add <pkg>`.
  Never invoke `pip` or bare `python`; no global venv.
- Run app: `uv run geotagger` (entry point) or `uv run python -m geotagger`.
- **src layout**: package `src/geotagger/`, built with hatchling. Import as `from geotagger …`.
- Backend: **FastAPI + uvicorn**. DB: stdlib **`sqlite3`** (no ORM). Metadata I/O: **ExifTool**
  via `pyexiftool`. Faces: **InsightFace + onnxruntime + numpy**. Thumbnails: **Pillow / pillow-heif / av**.
- Frontend: **vanilla JS + Leaflet**, plain `<script>` tags. No framework, no bundler, no npm.
- **Tests**: `uv run pytest` (suite under `tests/`, incl. `TestClient` endpoint smoke tests via
  `client` fixture in `conftest.py`). `network_test.py` separate manual probe script.
  Still worth running app to exercise UI changes tests don't cover.

## Hard constraints (do not violate)

- **Original media files immutable.** All geolocation/metadata writes go to **XMP sidecar
  files** (`.xmp`) next to image, via `sidecar.py`. Never write EXIF into original.
- **Face/person tags DB-only** by design (sidecar export deferred). Don't add sidecar
  writes for face data without checking memory note / asking.
- **Reverse geocoding offline**: bundled datasets only — OSM polygons (`data/osm/`), US
  Census places (`data/census/`), GeoNames (`data/geonames/`), in that lookup order (see
  `geocode._merged_lookup`). Not a network API — don't add calls to online geocoders.
  Downloading a dataset is a one-shot admin action (`scripts/get_*.py` + Data Management
  page), never a per-lookup fetch. Leaflet + OSM tiles only sanctioned runtime network deps
  (load from CDN, not vendored locally) — don't add more.

## Python conventions

- **Backend layout**: `main.py` thin `create_app()` factory only. Routes live in per-domain
  `APIRouter`s under `geotagger/api/` (each `router = APIRouter()`, request models defined inline
  near route); blocking "run in executor" logic lives in `geotagger/services/`
  (framework-free — never import FastAPI or `geotagger.api` there); pure DB-row→JSON shaping lives
  in `geotagger/serializers.py`; startup wiring `lifespan.py`, scan pipeline
  `scanning.py`. Add new page/route by creating/extending router and listing it in
  `api/__init__.py`'s `ROUTERS`.
- **Module-level singletons** guarded by module globals + lazy getters: `index.get_db()`,
  `exiftool_session.get_et()`, face model in `faces.py`, executor in `executor.py`. Follow
  this shape — `_thing` global, `init_*`/`start_*` that populates it, `get_*` that raises
  if unset. Mutating uses explicit `global` statement.
- **Thread safety**: shared native resources (ExifTool session, InsightFace app) guarded by
  `threading.Lock()`. Hold lock around native call, keep short as possible.
- **Never block event loop.** In async routes, push blocking work (ExifTool, thumbnailing,
  face detection, geocoding, sidecar writes) to shared executor:
  `await loop.run_in_executor(_executor, fn, …)`. Blocking helper plain `def` (often
  prefixed `_`) that does DB + I/O; route stays thin.
- **Config** lives in `config.py`: every knob env var named `GEOTAGGER_*` resolved at import
  time into module constant, sometimes via `get_*()` helper. Add new knobs there.
  - **Runtime-tunable settings** (see `SETTINGS_SPEC`) subset persisted in DB
    `settings` table, applied live. Consumers MUST read as `config.KEY` (module-attribute
    access), **not** `from geotagger.config import KEY` — overrides mutate module attribute, and
    `from`-import would freeze startup value. Use `_cfg(value, "KEY")` fallback idiom for
    optional override params (see `faces.py`).
- **SQLite**: `sqlite3.Row` row factory (access columns by name), always parameterized queries
  (`?` placeholders — never f-string user data into SQL; f-strings you see only interpolate
  fixed clause fragments), explicit `db.commit()` after writes, WAL mode. Schema lives in
  `index.init_db()`; **migrations additive**, done in-code via `PRAGMA table_info` +
  `ALTER TABLE ADD COLUMN` guards. Add columns same way — never assume fresh DB.
- **Local imports**: heavy or rarely-used modules (`bisect`, `json as _json`, `datetime`,
  submodules like `geotagger.geometry`) imported **inside function** that needs them, keep
  module import light. Intentional; keep doing for same cases.
- **Type hints** everywhere, modern syntax: `int | None`, `list[int]`, `dict[str, float]`,
  `tuple[int, int, list[str]]`. Pydantic `BaseModel`s for request bodies, defined inline near
  route.
- **Error handling in routes**: wrap in `try/except`; re-raise `HTTPException` before catching
  generic `Exception` (so deliberate 4xx not swallowed into 500); surface `ValueError` as
  `HTTPException(400, …)`.
- **Comments explain _why_**, many exist — performance rationale, edge cases, Windows
  quirks. Match density on non-obvious code. Use `# ── Section label ──` separators to group
  routes/functions, as existing files do.
- **Performance first-class concern** here: R*Tree spatial prefilter → exact Python
  point-in-polygon/haversine post-filter; `bisect` for O(n log m) time-window joins; coordinate
  quantization for geocode cache; timing logs (`t0 = time.time(); logger.info(f"… {(…)*1000:.2f}ms")`).
  Prefer indexed/batched approach over per-row query in loop.
- **Output**: `print()` for CLI/startup/scan progress; `logging` module (`logger =
  logging.getLogger(__name__)`) inside server.
- **Windows gotchas** already handled — follow suit: ExifTool started with UTF-8 charset args
  for non-Latin paths/place names; pre-1970 dates use `calendar.timegm` (not
  `datetime.timestamp()`, raises `OSError` on Windows).

## Frontend conventions

- Each view **`name.html` + `name.css` + `name.js` triple** under `web/`. Pages share
  `style.css` (dark theme, hex colors, reset at top) and `nav.js`.
- Top nav data-driven: `nav.js` renders `ITEMS` array into
  `<div id="app-nav" data-active="…">`. To add page, add `ITEMS` entry and set `data-active`
  on new page's nav div.
- Vanilla DOM only: `getElementById`, `createElement`, `innerHTML` with template literals. Shared
  page scripts wrap in **IIFE** (`(function(){ … })()`); per-page scripts run at top level.
- Data access is `fetch()` + `async/await`: check `res.ok`, `throw new Error(\`HTTP ${res.status}\`)`,
  then `res.json()`. POST JSON with `headers: {"Content-Type": "application/json"}` and
  `JSON.stringify(body)`.
- **Long-running server work driven as client loop**: POST batch with `limit`, read
  `remaining` from response, repeat until `0`, updating button label as you go (see
  `runBackfill` / `runFacesScan` in `home.js`). Match this pattern for new batch operations.
- **`StaticFiles` mount must be applied last in `create_app()`** (`app.mount("/", …)`), after
  every `app.include_router(...)`; SPA catch-all shadows API routes registered after it.

## Workflow

- Larger features handed off via self-contained `*_PLAN.md` docs; `IDEAS.md` backlog.
  If asked implement from plan, follow that doc.
- After nontrivial change, **run `uv run pytest`** and, for UI-affecting work, **run app and
  exercise affected route/UI**. Server binds `127.0.0.1:8000` by default; live test boot
  should use random port other than 8000.