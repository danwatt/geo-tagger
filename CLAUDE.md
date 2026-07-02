# CLAUDE.md

Guidance for working in this repo. Read `README.md` for setup/usage; this file is about
**how the code is written** so new code matches. Also see the `*_PLAN.md` handoff docs and
`IDEAS.md` backlog.

## What this is

A local web app for geotagging a photo/video library. Python (FastAPI)
backend + vanilla-JS/Leaflet frontend served as static files. No build step, no Node. The
backend and all data (SQLite DB, thumbnails, models) are fully local; the only network
dependencies are the Leaflet library + OpenStreetMap map tiles, loaded from CDNs
(`unpkg.com`, `tile.openstreetmap.org`) in the HTML — the map UI needs internet, the rest
doesn't.

## Stack & tooling

- **Python 3.13+**, managed by **`uv`**. Always use it — `uv run …`, `uv sync`, `uv add <pkg>`.
  Never invoke `pip` or a bare `python`; there's no global venv.
- Run the app: `uv run geotagger` (entry point) or `uv run python -m geotagger`.
- **src layout**: package is `src/geotagger/`, built with hatchling. Import as `from geotagger …`.
- Backend: **FastAPI + uvicorn**. DB: stdlib **`sqlite3`** (no ORM). Metadata I/O: **ExifTool**
  via `pyexiftool`. Faces: **InsightFace + onnxruntime + numpy**. Thumbnails: **Pillow / pillow-heif / av**.
- Frontend: **vanilla JS + Leaflet**, plain `<script>` tags. No framework, no bundler, no npm.
- **Tests**: `uv run pytest` (suite under `tests/`, incl. `TestClient` endpoint smoke tests via
  the `client` fixture in `conftest.py`). `network_test.py` is a separate manual probe script.
  Still worth running the app to exercise UI changes the tests don't cover.

## Hard constraints (do not violate)

- **Original media files are immutable.** All geolocation/metadata writes go to **XMP sidecar
  files** (`.xmp`) next to the image, via `sidecar.py`. Never write EXIF into an original.
- **Face/person tags are DB-only** by design (sidecar export is deferred). Don't add sidecar
  writes for face data without checking the memory note / asking.
- **Reverse geocoding is offline**: it uses bundled GeoNames data (`data/geonames/`), not a
  network API. Don't add calls to online geocoders. Leaflet + OSM tiles are the only sanctioned
  network deps (and load from a CDN, not vendored locally) — don't add more.

## Python conventions

- **Backend layout**: `main.py` is a thin `create_app()` factory only. Routes live in per-domain
  `APIRouter`s under `geotagger/api/` (each `router = APIRouter()`, request models defined inline
  near their route); blocking "run in the executor" logic lives in `geotagger/services/`
  (framework-free — never import FastAPI or `geotagger.api` there); pure DB-row→JSON shaping lives
  in `geotagger/serializers.py`; startup wiring is `lifespan.py`, the scan pipeline is
  `scanning.py`. Add a new page/route by creating/extending a router and listing it in
  `api/__init__.py`'s `ROUTERS`.
- **Module-level singletons** guarded by module globals + lazy getters: `index.get_db()`,
  `exiftool_session.get_et()`, the face model in `faces.py`, the executor in `executor.py`. Follow
  this shape — a `_thing` global, an `init_*`/`start_*` that populates it, a `get_*` that raises
  if unset. Mutating them uses an explicit `global` statement.
- **Thread safety**: shared native resources (ExifTool session, InsightFace app) are guarded by a
  `threading.Lock()`. Hold the lock around the native call, keep it as short as possible.
- **Never block the event loop.** In async routes, push blocking work (ExifTool, thumbnailing,
  face detection, geocoding, sidecar writes) to the shared executor:
  `await loop.run_in_executor(_executor, fn, …)`. The blocking helper is a plain `def` (often
  prefixed `_`) that does DB + I/O; the route stays thin.
- **Config** lives in `config.py`: every knob is an env var named `GEOTAGGER_*` resolved at import
  time into a module constant, sometimes via a `get_*()` helper. Add new knobs there.
  - **Runtime-tunable settings** (see `SETTINGS_SPEC`) are the subset persisted in the DB
    `settings` table and applied live. Consumers MUST read these as `config.KEY` (module-attribute
    access), **not** `from geotagger.config import KEY` — overrides mutate the module attribute, and
    a `from`-import would freeze the startup value. Use the `_cfg(value, "KEY")` fallback idiom for
    optional override params (see `faces.py`).
- **SQLite**: `sqlite3.Row` row factory (access columns by name), always parameterized queries
  (`?` placeholders — never f-string user data into SQL; the f-strings you see only interpolate
  fixed clause fragments), explicit `db.commit()` after writes, WAL mode. Schema lives in
  `index.init_db()`; **migrations are additive**, done in-code via `PRAGMA table_info` +
  `ALTER TABLE ADD COLUMN` guards. Add columns the same way — never assume a fresh DB.
- **Local imports**: heavy or rarely-used modules (`bisect`, `json as _json`, `datetime`,
  submodules like `geotagger.contexts`) are imported **inside the function** that needs them, to
  keep module import light. This is intentional; keep doing it for the same cases.
- **Type hints** everywhere, modern syntax: `int | None`, `list[int]`, `dict[str, float]`,
  `tuple[int, int, list[str]]`. Pydantic `BaseModel`s for request bodies, defined inline near
  their route.
- **Error handling in routes**: wrap in `try/except`; re-raise `HTTPException` before catching
  generic `Exception` (so a deliberate 4xx isn't swallowed into a 500); surface `ValueError` as
  `HTTPException(400, …)`.
- **Comments explain _why_**, and there are many — performance rationale, edge cases, Windows
  quirks. Match that density on non-obvious code. Use `# ── Section label ──` separators to group
  routes/functions, as the existing files do.
- **Performance is a first-class concern** here: R*Tree spatial prefilter → exact Python
  point-in-polygon/haversine post-filter; `bisect` for O(n log m) time-window joins; coordinate
  quantization for the geocode cache; timing logs (`t0 = time.time(); logger.info(f"… {(…)*1000:.2f}ms")`).
  Prefer an indexed/batched approach over a per-row query in a loop.
- **Output**: `print()` for CLI/startup/scan progress; the `logging` module (`logger =
  logging.getLogger(__name__)`) inside the server.
- **Windows gotchas** already handled — follow suit: ExifTool is started with UTF-8 charset args
  for non-Latin paths/place names; pre-1970 dates use `calendar.timegm` (not
  `datetime.timestamp()`, which raises `OSError` on Windows).

## Frontend conventions

- Each view is a **`name.html` + `name.css` + `name.js` triple** under `web/`. Pages share
  `style.css` (dark theme, hex colors, reset at top) and `nav.js`.
- The top nav is data-driven: `nav.js` renders the `ITEMS` array into
  `<div id="app-nav" data-active="…">`. To add a page, add an `ITEMS` entry and set `data-active`
  on the new page's nav div.
- Vanilla DOM only: `getElementById`, `createElement`, `innerHTML` with template literals. Shared
  page scripts wrap in an **IIFE** (`(function(){ … })()`); per-page scripts run at top level.
- Data access is `fetch()` + `async/await`: check `res.ok`, `throw new Error(\`HTTP ${res.status}\`)`,
  then `res.json()`. POST JSON with `headers: {"Content-Type": "application/json"}` and
  `JSON.stringify(body)`.
- **Long-running server work is driven as a client loop**: POST a batch with a `limit`, read
  `remaining` from the response, repeat until `0`, updating the button label as you go (see
  `runBackfill` / `runFacesScan` in `home.js`). Match this pattern for new batch operations.
- The **`StaticFiles` mount must be applied last in `create_app()`** (`app.mount("/", …)`), after
  every `app.include_router(...)`; the SPA catch-all shadows API routes registered after it.

## Workflow

- Larger features are handed off via self-contained `*_PLAN.md` docs; `IDEAS.md` is the backlog.
  If asked to implement from a plan, follow that doc.
- After a nontrivial change, **run `uv run pytest`** and, for UI-affecting work, **run the app and
  exercise the affected route/UI**. The server binds `127.0.0.1:8000` by default; a live test boot
  should use a random port other than 8000.
