# Geo-Tagger — Implementation Plan

> Handoff document. A fresh Claude session should be able to execute this end-to-end.
> Working dir: `C:\Users\danwa\PycharmProjects\geo-tagger`. Windows 11, `bash` shell, `uv` available.

## Context

The user has a large mixed photo/video collection (JPEG, HEIC, RAW: NEF/DNG; plus videos) spread
across nested directories. Some files are already geotagged, most are not. They want a local
web app to:

1. Recursively scan a chosen directory and index the media.
2. Show a 3-pane web UI: **map** (left), **thumbnail grid** (center), **single-photo view** (right).
3. Plot pushpins on the map for already-geotagged photos.
4. Let the user multi-select thumbnails and **drag them onto the map** to geotag them at the drop point.

**Hard constraint: original image files are immutable.** All new geolocation metadata is written to
**XMP sidecar files** (`.xmp`) next to each image — never into the image itself. Sidecars may already
exist and must be respected/merged.

### Decisions already made (do not re-litigate)
- **Metadata engine: ExifTool** (standalone Windows binary) driven from Python via **PyExifTool**.
  It is the only tool that cleanly reads GPS across JPEG/HEIC/NEF/DNG *and* writes GPS to XMP sidecars
  without touching originals *and* extracts embedded previews/thumbnails from RAW/HEIC.
- **Frontend: Vanilla JS + Leaflet**, served as static files by the Python backend. No Node/build step.
  Map tiles + Leaflet assets come from the internet (OSM tiles via CDN); note this requires connectivity.
- **Backend: Python 3.13 + FastAPI + uvicorn**, managed with `uv`.
- **Index/cache: SQLite** (a `.geotagger/` cache dir), so re-scans and thumbnail serving are fast.

### v1 tagging features (scope)
Included: drag-thumbnails-onto-map; manual lat/lng entry + place-name search (Nominatim);
edit (drag an existing pushpin to move it) and remove a geotag; copy one photo's location to other
selected photos.
**Deferred (fast-follow):** reverse geocoding (storing city/country place names) — depends on an
online service; wire the hook but leave off by default.

---

## Tech stack & dependencies

Add to `pyproject.toml` `dependencies`:
- `fastapi`
- `uvicorn[standard]`
- `pyexiftool` (PyExifTool; requires the exiftool binary, min v12.15)
- `pillow` (resize previews to thumbnails)
- `pillow-heif` (fallback HEIC decode when no embedded preview exists)

Run everything via uv with the 3.13 interpreter (uv already has cpython-3.13.6 installed):
```bash
uv sync            # creates .venv, installs deps
uv run geotagger   # or: uv run python -m geotagger
```

### ExifTool acquisition (one-time)
ExifTool is **not installed**. Provide `scripts/get_exiftool.py` that downloads the Windows zip from
exiftool.org, extracts `exiftool.exe` **and** the `exiftool_files/` folder into `tools/`, and verifies
`tools/exiftool.exe -ver`. (Both must sit together or the exe won't run.) The app resolves the binary
in this order: `GEOTAGGER_EXIFTOOL` env var → `tools/exiftool.exe` → `exiftool` on PATH.
Document the manual fallback in the README (download, unzip, rename `exiftool(-k).exe` → `exiftool.exe`).
Downloading is a network action — confirm with the user before running the script.

---

## Project structure

```
geo-tagger/
  pyproject.toml
  README.md
  PLAN.md
  scripts/
    get_exiftool.py          # download+extract exiftool into tools/
  tools/                     # exiftool.exe + exiftool_files/ (gitignored)
  src/geotagger/
    __init__.py
    __main__.py              # `python -m geotagger` -> launches uvicorn
    main.py                  # FastAPI app, route wiring, static mount
    config.py                # settings: exiftool path, cache dir, sidecar naming, thumb size
    exiftool_session.py      # one persistent ExifToolHelper, lifecycle managed by app
    scanner.py               # recursive walk, supported-extension filter
    sidecar.py               # sidecar path resolution; read/write/remove GPS via exiftool
    index.py                 # SQLite schema + queries (photo rows, geotag state)
    thumbnails.py            # lazy thumbnail + preview generation, disk cache
    geocode.py               # (stub) reverse-geocoding hook, off by default
  src/geotagger/web/
    index.html               # 3-pane layout
    style.css
    app.js                   # state, selection, drag-drop, Leaflet, fetch calls
```

---

## Backend design

### Supported file types (`scanner.py`)
- Images (taggable): `.jpg .jpeg .heic .heif .nef .dng .tif .tiff .png`
- Videos (index + show, geotag optional in v1 via sidecar): `.mp4 .mov .m4v .avi`
- Recursive `os.scandir`/`Path.rglob`. Skip the `.geotagger/` cache dir and existing `.xmp` files.

### ExifTool session (`exiftool_session.py`)
- Hold a single `exiftool.ExifToolHelper(executable=<resolved path>)` for the app lifetime
  (PyExifTool runs the binary in persistent `-stay_open` batch mode — fast across thousands of files).
- Create on FastAPI startup, terminate on shutdown (lifespan handler).

### Sidecar rules (`sidecar.py`) — the core of the immutability constraint
- **Sidecar path:** Adobe/Lightroom convention `basename.xmp` (e.g. `IMG_1234.NEF` → `IMG_1234.xmp`),
  configurable to `fullname.xmp` (`IMG_1234.NEF.xmp`) in `config.py`.
  ⚠️ Document the collision caveat: with `basename.xmp`, `IMG.JPG` and `IMG.NEF` in the same folder
  would share one sidecar. Detect this on scan and warn; recommend `fullname.xmp` for such collections.
- **Read effective GPS for a photo:** if a sidecar exists, read GPS from the sidecar (sidecar wins);
  otherwise read embedded GPS from the image. Command (numeric output):
  `exiftool -n -j -GPSLatitude -GPSLongitude <target>`
- **Write geotag (create or update sidecar, image untouched):**
  `exiftool -overwrite_original -XMP:GPSLatitude=<dec> -XMP:GPSLongitude=<dec> <basename>.xmp`
  ExifTool stores the signed decimal in proper XMP-exif format and derives the hemisphere refs.
  Writing to a non-existent `.xmp` **creates** it. `-overwrite_original` avoids `.xmp_original` backups
  (we're writing the sidecar, not the photo). **Round-trip verify** after writing in tests.
- **Remove geotag:** `exiftool -overwrite_original -XMP:GPSLatitude= -XMP:GPSLongitude= <basename>.xmp`
  (leaves any other sidecar metadata intact).

### SQLite index (`index.py`)
Table `photos`: `id` (pk), `path` (unique), `filename`, `dir`, `ext`, `media_type` (image|video),
`mtime`, `size`, `lat`, `lng`, `geotag_source` (none|embedded|sidecar), `sidecar_path`, `sidecar_mtime`,
`scanned_at`. Cache invalidation by `(path, mtime)` and `(sidecar_path, sidecar_mtime)`.
A `scans` table can store the last scanned root. Cache dir: `<root>/.geotagger/` (db + thumbs).

### Thumbnails & previews (`thumbnails.py`)
- **Lazy generation**, cached to disk under `.geotagger/thumbs/` keyed by `path+mtime` hash. Don't
  generate everything during scan (keeps scan fast); generate on first request per image.
- **Thumbnail (~256px, grid):**
  - JPEG/PNG/TIFF → Pillow open + `thumbnail()`.
  - HEIC/RAW (NEF/DNG) → extract embedded preview JPEG via exiftool
    (`exiftool -b -PreviewImage` / `-JpgFromRaw` / `-ThumbnailImage`, first that exists), then Pillow resize.
    HEIC fallback: `pillow-heif` decode if no embedded preview.
- **Preview (~1600px, single-photo pane):** larger embedded preview where available, else downscaled decode.
- Videos: serve a poster frame from the embedded thumbnail if exiftool exposes one; otherwise a placeholder icon (no ffmpeg dependency in v1).

### API contract (`main.py`)
- `POST /api/scan` `{ "directory": "<abs path>" }` → `{ root, count, warnings[] }`. Walks, refreshes index.
- `GET  /api/photos?geotagged=all|yes|no&bbox=...` → `[{ id, filename, media_type, lat, lng, geotag_source }]`.
- `GET  /api/thumbnail/{id}` → `image/jpeg` (lazy + cached).
- `GET  /api/preview/{id}` → `image/jpeg`.
- `GET  /api/photo/{id}` → full metadata detail (camera, datetime, dimensions, gps, sidecar path/state).
- `POST /api/geotag` `{ ids:[...], lat, lng }` → writes sidecars for each id, updates index, returns updated rows.
  (Backs both drag-drop and "copy location to selection".)
- `POST /api/geotag/remove` `{ ids:[...] }` → removes GPS from sidecars, updates index.
- Static: mount `src/geotagger/web/` at `/`; `index.html` is the app.

---

## Frontend design (`web/`)

### Layout (`index.html` + `style.css`)
CSS grid, full-viewport: top toolbar + 3 columns.
- **Toolbar:** directory text input + **Scan** button; filter toggle (All / Geotagged / Not geotagged);
  place-search box; manual lat/lng inputs + "Apply to selection"; "Copy location to selection";
  "Remove geotag" button.
- **Left — Map:** Leaflet map, OSM tiles. One marker per geotagged photo. Markers draggable (edit:
  `dragend` → `POST /api/geotag`). The map div is the **drop target**.
- **Center — Grid:** responsive thumbnail grid (`/api/thumbnail/{id}`). Click = select+show in right pane;
  Ctrl/Cmd+click = toggle into multi-selection; Shift+click = range select. Selected thumbnails get a
  visible outline. Selected items are HTML5-draggable.
- **Right — Single photo:** larger `/api/preview/{id}` + a metadata table from `/api/photo/{id}`,
  including current GPS and whether it came from a sidecar.

### Interactions (`app.js`)
- App state: `photos[]`, `selectedIds Set`, `lastClickedIndex` (for shift-range), `markersById`.
- **Drag-to-map (the headline feature):**
  - `dragstart` on a thumbnail: if it isn't in the selection, make it the sole selection;
    set `dataTransfer` payload = selected ids.
  - Map container `dragover` → `preventDefault()` (enable drop); `drop` → read pointer position,
    `latlng = map.containerPointToLatLng(L.point(offsetX, offsetY))`, `POST /api/geotag {ids, lat, lng}`,
    then add/refresh markers and update grid badges.
- **Place search:** query Nominatim (`https://nominatim.openstreetmap.org/search?format=json&q=`),
  fly map to result. Online; include a 1-req/sec courtesy + User-Agent note.
- **Manual entry:** lat/lng fields → "Apply to selection" → `POST /api/geotag`.
- **Copy location:** take GPS of the photo shown in the right pane, apply to the rest of the selection.
- **Remove geotag:** `POST /api/geotag/remove` for the selection; drop their markers.

---

## Build order (suggested task breakdown)

1. **Scaffold:** deps in `pyproject.toml`, `uv sync`, `config.py`, `__main__.py`, minimal FastAPI app
   serving a placeholder `index.html`. Confirm `uv run python -m geotagger` opens the page.
2. **ExifTool wiring:** `scripts/get_exiftool.py` (confirm with user before downloading), binary
   resolution in `config.py`, persistent `ExifToolHelper` in `exiftool_session.py`, `-ver` healthcheck.
3. **Scan + index:** `scanner.py` + `index.py` + `POST /api/scan` + `GET /api/photos`. Read effective
   GPS (sidecar-wins). Verify against a known geotagged file.
4. **Sidecar write/remove:** `sidecar.py` + `POST /api/geotag` + `/api/geotag/remove`. **Round-trip test.**
5. **Thumbnails/previews:** `thumbnails.py` + endpoints, disk cache. Verify HEIC + NEF + DNG render.
6. **Frontend shell:** 3-pane layout, scan flow, grid, Leaflet map with existing pushpins.
7. **Selection + drag-to-map:** multi-select, HTML5 drag, drop→geotag, live marker/badge updates.
8. **Edit/remove/manual/search/copy-location.** Polish.
9. **(Deferred)** reverse geocoding in `geocode.py`, behind a config flag.

---

## Verification (end-to-end)

Prep a small test tree with: a geotagged JPEG, a non-geotagged JPEG, a HEIC, a NEF, a DNG, and one
image that already has a `.xmp` sidecar.

- **Binary:** `tools/exiftool.exe -ver` prints a version ≥ 12.15.
- **Immutability:** record sha256 of every original before/after a full session — **must be identical**.
  Geotag changes appear only in `.xmp` files.
- **Read:** `POST /api/scan` then `GET /api/photos` — the pre-geotagged JPEG and the sidecar image show
  `lat/lng` with correct `geotag_source`; others show none.
- **Write/round-trip:** `POST /api/geotag` a non-tagged NEF, confirm `IMG.xmp` is created, and
  `exiftool -n -GPSLatitude -GPSLongitude IMG.xmp` returns the values sent (±rounding). Pin appears on map.
- **Remove:** `POST /api/geotag/remove`, confirm GPS gone from sidecar, pin removed.
- **Thumbnails:** grid renders thumbnails for JPEG, HEIC, NEF, DNG.
- **Drag-to-map:** select 3 thumbnails, drag onto a map point → 3 new pins at the drop location;
  reload page → pins persist (read back from sidecars).

## Open items / notes for the implementer
- Confirm `pillow-heif` has a Windows cp313 wheel at build time; if not, rely on exiftool embedded
  previews for HEIC and skip full HEIC decode in v1.
- Sidecar naming default is `basename.xmp`; switch to `fullname.xmp` if the collection has
  same-stem/different-extension collisions (scan should warn).
- Nominatim usage policy: set a descriptive User-Agent and throttle to ≤1 req/s.
