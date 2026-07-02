# MAIN_REFACTOR_PLAN.md

Handoff doc for splitting `src/geotagger/main.py` (currently ~1900 lines) into a thin app
factory plus focused router / service / serializer modules, without changing any behavior or
HTTP contract. Self-contained: implement straight from this file. Read `CLAUDE.md` first for the
house conventions this plan deliberately follows.

## Goal & non-goals

**Goal:** make `main.py` small and make the logic inside it testable.
- `main.py` → ~50 lines: an app factory that wires routers and mounts static files.
- Every route lives in a domain `APIRouter` under `src/geotagger/api/`.
- Every blocking "run in the executor" helper moves to a **framework-free `services/` package**
  so it can be unit-tested without FastAPI.
- Pure row→JSON shaping moves to `serializers.py` (dedups three copies of the photo dict).
- Add the first real endpoint tests via `fastapi.testclient.TestClient`.

**Non-goals:** no behavior/response-shape changes, no new endpoints, no DB schema changes, no
new network deps. This is a pure move-and-rewire refactor. If a response body changes, that's a
bug in the refactor.

## Hard constraints to preserve (do not break)

- **`geotagger.main:app` must keep resolving.** `__main__.py:125` passes that string to
  `uvicorn.run(...)`. Keep a module-level `app` in `main.py`.
- **The `StaticFiles` mount stays last** (`app.mount("/", …)`) — API routes register before it or
  they get shadowed. In the factory this means: include all routers, *then* mount static.
- All existing CLAUDE.md rules stay in force: sidecar-only writes, DB-only face tags, offline
  geocoding, module-singleton + lazy-getter shape, never block the event loop (push blocking work
  to the executor), `config.KEY` module-attribute access for runtime-tunable settings, Pydantic
  models **defined inline near their route** (so they move *with* their routes, not into a central
  models module), `print()` for CLI/scan output vs `logging` inside the server.
- The scan path uses **its own** local `ThreadPoolExecutor` (in `_scan_directory`); that is
  separate from the shared request executor and stays that way.

## Why this shape

- The routes all close over the module-global `_executor` (`main.py:32`). Once routes leave
  `main.py`, a `from geotagger.main import _executor` would be both **circular** (main imports the
  routers, routers import main) and **frozen at import** (the name is `None` until the lifespan
  runs). Extracting the executor into an `init_/get_` singleton — the exact idiom CLAUDE.md
  documents for `get_db()` / `get_et()` — removes that coupling.
- `_geocode_pending` is called by the **scan path** (`main.py:213`), not just a route. It must
  live in a framework-free module, or the CLI/scan layer ends up importing a web router. This is
  the concrete reason for a `services/` package rather than leaving helpers in router files.
- `APIRouter` per domain + a `create_app()` factory is idiomatic FastAPI and is what makes
  `TestClient` tests and per-router isolation possible.

## Target layout

```
src/geotagger/
  main.py              # ~50 lines: create_app() → include routers → mount static LAST; app = create_app()
  executor.py          # NEW singleton: _executor global + init_executor()/get_executor()
  lifespan.py          # lifespan(app): init executor, ET lifespan, DB/thumbs/faces init, autoscan
  scanning.py          # scan_directory() + terminal progress (was _scan_directory)
  serializers.py       # pure DB-row → JSON dict helpers
  contexts.py          # (existing geometry module) + gains the pure date/lng helpers
  services/
    __init__.py
    geocode_service.py #   geocode_pending(), export_locations_to_sidecars()
    photos_service.py  #   get_photo_metadata(), update_photo_times()
    faces_service.py   #   scan_faces_batch(), compute_clusters()  (+ CLUSTER_DISPLAY_LIMIT)
  api/
    __init__.py        # ROUTERS = [status.router, stats.router, ...]
    status.py          # /api/status, /api/settings*, /api/debug
    stats.py           # /api/stats/*
    photos.py          # /api/photos, /by-area, /thumbnail, /preview, /photo, /update-times
    geotag.py          # /api/geotag*, /api/guess
    geocode.py         # /api/geocode/*
    places.py          # /api/places*
    contexts.py        # /api/contexts*
    faces.py           # /api/faces*, /persons*, /families*, /crowds*  (largest, ~450 lines)
```

**Naming note:** `api/geocode.py`, `api/faces.py`, `api/contexts.py` sit alongside the existing
top-level `geocode.py`, `faces.py`, `contexts.py`. This is **not** a real clash — absolute imports
(`from geotagger import geocode`) resolve unambiguously — but be aware when reading tracebacks.
Inside `api/*.py`, import the domain modules absolutely (`from geotagger import faces`), never
relatively.

**Packaging:** `pyproject.toml` uses `packages = ["src/geotagger"]`; hatchling picks up new
subpackages recursively, so `api/` and `services/` just need `__init__.py` files. No pyproject
change required.

## New infrastructure modules

### `executor.py` (the linchpin — do this first)

Mirror `exiftool_session.py` / `index.py` singleton shape:

```python
from concurrent.futures import ThreadPoolExecutor

_executor: ThreadPoolExecutor | None = None

def init_executor(max_workers: int = 4) -> ThreadPoolExecutor:
    """Create the shared request thread pool. Called from the lifespan."""
    global _executor
    _executor = ThreadPoolExecutor(max_workers=max_workers)
    return _executor

def get_executor() -> ThreadPoolExecutor:
    if _executor is None:
        raise RuntimeError("Executor not initialized")
    return _executor
```

Routes change from the closed-over `_executor` to `get_executor()`:
`await loop.run_in_executor(get_executor(), fn, …)`. `set_executor_workers` is renamed
`init_executor` (only caller is the lifespan).

### `main.py` (application factory)

```python
def create_app() -> FastAPI:
    app = FastAPI(title="Geo-Tagger", lifespan=lifespan)
    for router in ROUTERS:            # from geotagger.api import ROUTERS
        app.include_router(router)
    app.mount("/", StaticFiles(directory=str(_WEB_DIR), html=True), name="web")  # MUST stay last
    return app

app = create_app()                    # keeps geotagger.main:app valid for uvicorn
```

Keep `logging.basicConfig(...)` at module import (or move into `create_app`). Keep `_WEB_DIR`
here (or in a tiny `paths.py`; not required).

### `lifespan.py`

Move `lifespan` verbatim from `main.py:222-276`. Swap `set_executor_workers` →
`executor.init_executor`, and `_scan_directory` → `scanning.scan_directory`. It keeps reading
`GEOTAGGER_WORKERS`, `GEOTAGGER_NO_SCAN`, `GEOTAGGER_SCAN_DIRS` and calling the ExifTool lifespan,
`index.init_db`, `config.apply_all_overrides`, `thumbnails.init_thumbs`, `faces.init_faces`.

### `scanning.py`

Move `_scan_directory` (`main.py:42-219`) → `scan_directory` (drop the leading underscore; it's
now a public module function). Keeps its own local `ThreadPoolExecutor` and its `print()` progress
rendering. Its one internal cross-module call `_geocode_pending()` becomes
`geocode_service.geocode_pending()`. Uses `index, scanner, sidecar, thumbnails, geocode`.

## `serializers.py` — pure row→JSON (no DB writes, no I/O)

| New function | From | Notes |
|---|---|---|
| `photo_to_dict(row)` | `main.py:657-666` and `:780-789` | Grid shape (has `geocode_ignored`, no location). **Dedups two identical inline copies.** |
| `photo_geocode_dict(row)` | `main.py:1134-1145` (next-group's inline `photo_to_dict`) | Distinct shape: has nested `location{city,state,country}`, no `geocode_ignored`. Keep separate, or make one `photo_to_dict(row, *, include_location=False)` — implementer's choice, but document it. |
| `face_item(row)` | `_face_item`, `main.py:1535-1552` | |
| `row_location(row)` | `_row_location`, `main.py:1526-1532` | |
| `person_name_map()` | `_person_name_map`, `main.py:1555-1558` | Reads DB (one SELECT) — acceptable here, or move to `index.py` if you prefer serializers to be pure. Default: leave in serializers. |
| `context_row_to_dict(row, persons=None)` | `_context_row_to_dict`, `main.py:1249-1262` | Calls `ts_to_date` (see contexts.py below). |
| `format_crowd_group_label(ts)` | `_format_crowd_group_label`, `main.py:1886-1891` | |

## `contexts.py` (existing) gains the pure date/lng helpers

Move these pure helpers out of the contexts routes into the `contexts` domain module (co-located
with the existing `point_in_polygon` / `polygon_bbox` / `polygon_centroid`, and covered by the
existing `tests/test_contexts.py`):

- `date_to_ts_start(d)` / `date_to_ts_end(d)` — `main.py:1211-1219` (keep the `calendar.timegm`
  Windows workaround comment).
- `ts_to_date(ts)` — `main.py:1221-1226`.
- `normalize_lng(lng)` — `main.py:1228-1236`.

`_validate_polygon` **stays in `api/contexts.py`** — it raises `HTTPException`, a web concern. It
will call `contexts.normalize_lng`.

## `services/` — framework-free blocking logic

Each function is a plain `def` (blocking) that a router hands to `run_in_executor`. No FastAPI
imports here.

### `services/geocode_service.py`
- `geocode_pending(limit=None)` ← `_geocode_pending`, `main.py:1035-1050`. Also called by
  `scanning.scan_directory`.
- `export_locations_to_sidecars()` ← `_export_locations_to_sidecars`, `main.py:1053-1079`. Uses
  `index`, `sidecar`, and `exiftool_session.get_et_lock`.

### `services/photos_service.py`
- `get_photo_metadata(path)` ← `_get_photo_metadata`, `main.py:849-862` (uses `get_et` +
  `get_et_lock`).
- `update_photo_times(updates)` ← `_update_photo_times`, `main.py:1375-1411` (writes sidecars via
  `sidecar.write_datetime`, bumps faces generation).

### `services/faces_service.py`
- `scan_faces_batch(photo_ids)` ← `_scan_faces_batch`, `main.py:1743-1757`.
- `compute_clusters(rows, unknowns, times, gallery, names, threshold, min_size, full)` ←
  `_compute_clusters`, `main.py:1783-1808`. Move `CLUSTER_DISPLAY_LIMIT` (`main.py:20`) here as a
  module constant. Imports `serializers.face_item` and the `faces` domain module + `Counter`.

## Route → module map

All routes keep their exact path, method, query params, and response body. Each router module:
`router = APIRouter()`, decorate with `@router.<method>`, and move the route's Pydantic model(s)
into the same file (inline, near the route, per CLAUDE.md).

| Router file | Routes (from `main.py`) | Models moved here |
|---|---|---|
| `api/status.py` | `GET /api/status`, `GET/PATCH /api/settings`, `POST /api/settings/reset`, `GET /api/debug` | `UpdateSettingsRequest`, `ResetSettingsRequest` |
| `api/stats.py` | `GET /api/stats/{months,summary,bounds,dates}` | — |
| `api/photos.py` | `GET /api/photos`, `GET /api/photos/by-area`, `GET /api/thumbnail/{id}`, `GET /api/preview/{id}`, `GET /api/photo/{id}`, `POST /api/photos/update-times` | `UpdateTimesRequest` |
| `api/geotag.py` | `POST /api/geotag`, `POST /api/geotag/ignore`, `GET /api/guess/{id}`, `POST /api/geotag/remove` | `GeotagRequest`, `RemoveGeotagRequest`, `SetGeocodeIgnoredRequest` |
| `api/geocode.py` | `GET /api/geocode/status`, `GET /api/geocode/places`, `POST /api/geocode/backfill`, `POST /api/geocode/export-sidecars`, `GET /api/geocode/next-group` | `GeocodeBackfillRequest` |
| `api/places.py` | `GET/POST /api/places`, `DELETE/PATCH /api/places/{id}` | `CreatePlaceRequest`, `UpdatePlaceRequest` |
| `api/contexts.py` | `GET/POST /api/contexts`, `PATCH/DELETE /api/contexts/{id}` | `CreateContextRequest`, `UpdateContextRequest` (+ `_validate_polygon`) |
| `api/faces.py` | `GET/POST/DELETE /api/persons*`, `PATCH /api/persons/{id}`, `GET/POST/PATCH/DELETE /api/families*`, `GET /api/faces`, `GET /api/faces/{id}/crop`, `POST /api/faces/assign`, `POST /api/faces/ignore`, `GET /api/photos/{id}/faces`, `POST /api/faces/{id}/assign`, `POST /api/faces/scan`, `GET /api/faces/scan/status`, `GET /api/faces/clusters`, `GET /api/crowds`, `POST /api/crowds/ignore-unlabeled` | `CreatePersonRequest`, `UpdatePersonRequest`, `FamilyRequest`, `AssignFaceRequest`, `BulkAssignRequest`, `IgnoreFacesRequest`, `ScanFacesRequest`, `CrowdIgnoreRequest` |

`GET /api/photos/{photo_id}/faces` lives in `api/faces.py` (it's face data) even though its path is
under `/api/photos`. Distinct path structure, no routing conflict.

`api/__init__.py`:
```python
from geotagger.api import status, stats, photos, geotag, geocode, places, contexts, faces
ROUTERS = [status.router, stats.router, photos.router, geotag.router,
           geocode.router, places.router, contexts.router, faces.router]
```
Include order among API routers doesn't affect correctness (paths are distinct), but keep this
sensible order; static is always mounted after all of them in `create_app`.

## Phasing — each phase leaves `uv run geotagger` working

Run the app (or the smoke tests from Phase 0) after every phase.

**Phase 0 — safety net first.** Add a `TestClient` fixture and a smoke test *before* moving code,
so the whole refactor has a regression guard (and this is the first deliverable of the testability
goal). See "Testing" below. Establish the green baseline here.

**Phase 1 — infra out (no route moves).** In dependency order:
1. `executor.py`; rewire `main.py` to `init_executor`/`get_executor`.
2. `services/__init__.py` + `services/geocode_service.py` (needed by scanning).
3. `scanning.py` (`scan_directory`).
4. `lifespan.py`.
Routes still live in `main.py`. Verify app boots and scans.

**Phase 2 — helpers out.** `serializers.py`, `services/photos_service.py`,
`services/faces_service.py`, and the pure date/lng helpers into `contexts.py`. Replace the inline
helper defs and the three duplicated photo-dict literals with imports. Verify.

**Phase 3 — routes out.** Create the eight `api/*.py` routers **one at a time**: move routes +
their models, swap `@app`→`@router`, swap `_executor`→`get_executor()`, and point helper calls at
`serializers` / `services`. After each router, run the smoke tests. Finally rewrite `main.py` as
the `create_app()` factory and delete the now-empty route/helper bodies. `main.py` should end
~50 lines.

**Phase 4 — per-router tests.** Expand Phase 0 into `tests/api/test_<domain>.py` and add unit
tests for the extracted `services/*` and `serializers` functions (now importable without FastAPI).

## Testing

Add to `tests/conftest.py` a client fixture. `TestClient` runs the lifespan; keep it cheap under
test with `GEOTAGGER_NO_SCAN=1` and a tmp cache dir, reusing the existing `db` fixture pattern:

```python
@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from geotagger import index, main
    monkeypatch.setenv("GEOTAGGER_NO_SCAN", "1")
    monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("GEOTAGGER_SCAN_DIRS", raising=False)
    index.init_db(tmp_path)                 # lifespan auto-load is a no-op with no last-scan root
    with TestClient(main.app) as c:         # `with` runs lifespan (inits executor)
        yield c
    index._db = None; index._db_path = None
```

Smoke coverage (Phase 0): `GET /api/status`, `GET /api/stats/summary`, `GET /api/photos` (empty
list), and a contexts create→get→delete round-trip. These exercise the executor, DB, and a
POST-with-model path. Confirm the exact response bodies so Phase 3 can't silently change them.

Service/serializer unit tests (Phase 4) need no app: e.g. `serializers.photo_to_dict` against a
`sqlite3.Row`, `contexts.date_to_ts_start` / `ts_to_date` round-trips (including a pre-1970 date
for the Windows path), `geocode_service.geocode_pending` against the `db` + `geonames_dir`
fixtures.

## Gotchas / risk log

- **Circular imports:** `services/*` and `serializers` must never import `api/*` or `main`.
  `faces_service` imports `serializers` (one-way). `scanning`/`lifespan` import `services` and
  domain modules, never `api`/`main`. `api/*` import `services`, `serializers`, `executor`, and
  domain modules.
- **Executor not initialized in tests:** only the lifespan calls `init_executor`, so tests must
  enter the `TestClient` context manager (`with TestClient(app)`) or call `init_executor()`
  themselves, or `get_executor()` raises.
- **Response drift:** the three photo-dict literals differ (`geocode_ignored` vs nested
  `location`). Don't collapse them into one shape by accident — keep both serializers.
- **Static-mount ordering:** enforced structurally by mounting in `create_app` after the router
  loop. Don't add `app.mount` anywhere else.
- **`from`-import of tunable settings:** in the new router files read `config.FACE_CLUSTER_*`,
  `config.FACE_CROWD_MIN_SIZE`, etc. as `config.KEY`, never `from geotagger.config import KEY`
  (they're runtime-mutated). Same rule the routes already follow.
- **`GET /api/next-group`** builds its response with a local `photo_to_dict` that includes
  `location` — make sure it uses `serializers.photo_geocode_dict`, not the grid `photo_to_dict`.

## Done when

- `main.py` is the factory only; `wc -l src/geotagger/main.py` ≲ 60.
- `uv run geotagger` boots, autoscans, and every page/route works as before.
- `uv run pytest` is green, including the new smoke + service tests.
- No module under `services/` or `serializers.py` imports FastAPI; `api/*` import no route logic
  from `main`.
