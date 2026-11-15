# CLAUDE.md

Guidance for work in repo. Read `README.md` for setup/usage; this file about
**how code written** so new code match. Also see `*_PLAN.md` handoff docs and
`IDEAS.md` backlog.

## What this is

Local web app, geotag photo/video library. Python (FastAPI)
backend + React + TypeScript web frontend (`frontend/`, Vite build; Node needed to build,
not to run). Backend + all data (SQLite DB, thumbnails, models) fully local; JS libraries
(Leaflet, markercluster, vis-timeline) bundled as npm deps. Only runtime network dependency:
map tiles from `tile.openstreetmap.org` / `server.arcgisonline.com` (see Hard constraints) —
map UI needs internet, rest don't.

## Stack & tooling

- **Python 3.13+**, managed by **`uv`**. Always use it — `uv run …`, `uv sync`, `uv add <pkg>`.
  Never invoke `pip` or bare `python`; no global venv.
- Run app: `uv run geotagger` (entry point) or `uv run python -m geotagger`.
- **src layout**: package `src/geotagger/`, built with hatchling. Import as `from geotagger …`.
- Backend: **FastAPI + uvicorn**. DB: stdlib **`sqlite3`** (no ORM). Metadata I/O: **ExifTool**
  via `pyexiftool`. Faces: **InsightFace + onnxruntime + numpy**. Thumbnails: **Pillow / pillow-heif / av**.
- Frontend: **React 19 + TypeScript + Vite** under `frontend/`, data via
  **TanStack Query** + **openapi-fetch** with types generated from the FastAPI schema. Tests:
  **Vitest + Testing Library** (`npm --prefix frontend test`). Build output goes to
  `src/geotagger/web_dist/` (gitignored, shipped in the wheel).
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
  `geocode._merged_lookup`). Not a network API — don't add calls to online geocoders
  (Nominatim included). Forward place search offline too: geocode page's "jump to location"
  box uses `/api/search/locations` (saved places + library photo locations, with `bounds`).
  Downloading a dataset is a one-shot admin action (`scripts/get_*.py` + Data Management
  page), never a per-lookup fetch.
- **Sanctioned runtime network deps — only these, don't add more:** map tiles from OSM
  (`{s}.tile.openstreetmap.org`) and Esri World Imagery + World Boundaries and Places
  reference overlay (`server.arcgisonline.com`, satellite/hybrid basemaps in
  `frontend/src/map/basemaps.ts`). Tiles are images; no SRI possible. No CDN scripts or
  stylesheets: JS libraries are npm deps, pinned to exact versions, bundled by Vite.

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
  fixed clause fragments), WAL mode. **Every write goes through
  `with index.transaction() as db:`** — one shared connection, so block holds global write lock,
  commits on exit, rolls back on exception; never call `db.commit()` yourself. Re-entrant
  (nested = savepoint; wrap several `index.*` writes to make one unit). DB work only inside —
  no ExifTool/hashing/detection under it. Reads stay plain `get_db().execute(…)`. Schema lives in
  `index.init_db()`; **migrations additive**, done in-code via `PRAGMA table_info` +
  `ALTER TABLE ADD COLUMN` guards. Add columns same way — never assume fresh DB.
- **Local imports**: heavy or rarely-used modules (`bisect`, `json as _json`, `datetime`,
  submodules like `geotagger.geometry`) imported **inside function** that needs them, keep
  module import light. Intentional; keep doing for same cases.
- **Type hints** everywhere, modern syntax: `int | None`, `list[int]`, `dict[str, float]`,
  `tuple[int, int, list[str]]`. Pydantic `BaseModel`s for request bodies, defined inline near
  route. Routes a React page calls also declare `response_model=` (models inline near the
  route), so the generated TypeScript types describe the response; then run
  `npm --prefix frontend run gen:api` and commit `frontend/openapi.json` + `schema.d.ts`
  (`tests/test_frontend_contract.py` fails while they're stale).
- **Error handling in routes**: wrap in `try/except`; re-raise `HTTPException` before catching
  generic `Exception` (so deliberate 4xx not swallowed into 500); surface `ValueError` as
  `HTTPException(400, …)`.
- **Response shapes**: failure always non-2xx with `detail` — never 200 + `"error"` (status
  reports: per-component `{"available": false, "reason": …}`; background-job polls may carry
  the job's `error`). Single-resource mutation returns `{"ok": true, "id": …}` + changed
  fields (`success` = legacy alias, don't drop); bulk ops return named counts
  (`updated`/`assigned`/…) + `undo` where reversible; per-photo batch writes use
  `{results, written, failed, not_found}` via `geotag._batch_response`. Paths plural:
  `/api/photos/{id:int}/…` (`:int` so it can't shadow `/api/photos/dirs` etc.);
  `/api/photo/{id}` is a deprecated alias.
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

## Frontend conventions — React (`frontend/`)

- **Adding a page**: add `frontend/<name>.html` (just `<div id="root">` + module script),
  `src/pages/<name>/main.tsx` calling `mountPage(<Page />)`, add `<name>` to `PAGES` in
  `vite.config.ts`. It builds to `/<name>.html`; `static.LayeredStaticFiles` serves `web_dist/`
  ahead of `web/` (which now holds only `theme.css` and the static `design-artifacts.html`).
- Every page renders inside `<AppShell active="<nav key>">` (nav, scan banner); pages with a
  status line render `<StatusBar>` last. Nav entries live in `src/shell/navItems.ts`.
- **Styling**: `src/geotagger/web/theme.css` (imported by `mountPage`) stays the design system — its
  tokens, controls and chrome ids/classes (`#toolbar`, `.settings-group`, `.button`). Page CSS
  sits next to the page (`src/pages/<name>/<name>.css`) and uses `var(--token)`, never raw hex.
- **Data**: `api.GET/POST/…` from `src/api/client.ts` wrapped in `unwrap()` (throws `ApiError`
  with the server's `detail`), inside `useQuery` / `useMutation`. After a mutation, patch the
  cache with `setQueryData` or `invalidateQueries` — no manual refetch plumbing.
- **Accessibility is required** (audit Y1–Y4): real `<button>`/`<a>` for anything
  clickable, labels tied to inputs, `aria-expanded` on toggles, `aria-live` status, visible focus.
- **Tests**: Vitest + Testing Library next to the component (`X.test.tsx`). Test behaviour
  through roles/labels; pull pure logic (e.g. `bannerView`) into exported functions and test
  those directly.
- No `innerHTML` / `dangerouslySetInnerHTML` (`tests/test_web_assets.py` guards it); no
  `confirm()` / `prompt()` / `alert()` — use `Dialog` / `ConfirmDialog` / inline confirmation.
- **Long-running server work driven as client loop**: POST batch with `limit`, read
  `remaining` from response, repeat until `0`, updating button label as you go
  (`lib/useBatchLoop.ts`). Match this pattern for new batch operations.
- **`StaticFiles` mount must be applied last in `create_app()`** (`app.mount("/", …)`), after
  every `app.include_router(...)`; SPA catch-all shadows API routes registered after it.

## Workflow

- Larger features handed off via self-contained `*_PLAN.md` docs; `IDEAS.md` backlog.
  If asked implement from plan, follow that doc.
- After nontrivial change, **run `uv run pytest`** (and for `frontend/` changes
  `npm --prefix frontend run typecheck` + `npm --prefix frontend test`) and, for UI-affecting
  work, **build (`npm --prefix frontend run build`), run app and
  exercise affected route/UI**. Server binds `127.0.0.1:8000` by default; live test boot
  should use random port other than 8000.