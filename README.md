# Geo-Tagger

Local web app for organizing a photo/video library: geotag photos on a map, reverse-geocode
them offline, detect and tag faces, sync camera clocks, and search across it all. Backend +
all data (SQLite DB, thumbnails, models) stay fully local; the only network dependencies are
the Leaflet library and OpenStreetMap map tiles (loaded from CDNs in the page HTML — the map
UI needs internet, nothing else does).

**Original media files are never modified.** Geolocation and other metadata are written to
**XMP sidecar files** next to each photo, as an explicit export step — see
[Data model: DB vs. sidecars](#data-model-db-vs-sidecars).

> Developed and tested on Windows. The dependency stack (Pillow, av, onnxruntime, osmium,
> etc.) ships cross-platform wheels and *should* run on macOS/Linux via a source install
> (see [Cross-platform notes](#cross-platform-notes)), but that path hasn't been verified —
> reports welcome.

## Prerequisites

- **[uv](https://docs.astral.sh/uv/)** — install it first (`uv` manages Python itself, so you
  don't need a matching Python already installed):
  ```bash
  # macOS/Linux
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # Windows (PowerShell)
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  ```
- **git**, to clone this repo.
- Windows, for the automatic ExifTool download in setup step 2 (macOS/Linux: install ExifTool
  yourself, see that step).

This project is clone-and-run only (not published as an installable package) — everything
below assumes a source checkout.

<details>
<summary>Don't want to install uv? Use a plain venv + pip instead</summary>

Every `uv run <cmd>` below is equivalent to activating a venv and running `<cmd>` directly.
Requires Python 3.13+ already installed and on `PATH`.

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -e .                          # runtime deps
pip install httpx pytest pytest-cov       # only if you want to run the test suite (optional)
```

Then replace `uv run <cmd>` with just `<cmd>` (e.g. `uv run geotagger` → `geotagger`,
`uv run python scripts/get_exiftool.py` → `python scripts/get_exiftool.py`) for every command
in this doc.
</details>

## Setup

### 1. Install Python dependencies

```bash
uv sync
```

### Where downloaded tools/data end up

Steps 2–4 below download a chunk of shared, one-time setup data: the ExifTool binary,
GeoNames, and OSM place boundaries. By default they land next to the database — i.e.
alongside whichever `--cache-dir`/`--scan-dir` you end up running the app with (see
[Cache location](#cache-location)) — but that root isn't known yet if you're doing setup
before your first run. Each script accepts `--root <dir>` (same value as the `--scan-dir`
you're about to use) so setup data lands in the same place the app will look for it:

```bash
uv run python scripts/get_exiftool.py --root "D:\Photos"
```

Skip `--root` and they fall back to a global location (`GEOTAGGER_CACHE_DIR` if set,
otherwise `~/.geotagger`) — fine if you only ever use one photo library, or if you set
`GEOTAGGER_CACHE_DIR` for every run anyway.

### 2. Install ExifTool (required)

**Automatic, recommended (Windows, macOS, Linux):**
```bash
uv run python scripts/get_exiftool.py
```
Downloads the platform-appropriate ExifTool distribution from SourceForge, verifies it
against the SHA-256 checksums ExifTool publishes, and extracts it into `tools/` under the
resolved location above — `tools/exiftool.exe` on Windows, or `tools/exiftool` (+
`tools/lib/`) on macOS/Linux. The Unix distribution is a Perl script and needs `perl` on
`PATH`, which macOS and most Linux distros already ship.

**Windows manual fallback:**
1. Download the Windows zip from <https://exiftool.org>
2. Unzip — you get `exiftool(-k).exe` and an `exiftool_files/` folder
3. Rename `exiftool(-k).exe` → `exiftool.exe`
4. Place both `exiftool.exe` **and** `exiftool_files/` inside the resolved `tools/` directory

> Both must sit together or ExifTool won't run.

**macOS/Linux manual fallback:** install ExifTool via your package manager
(`brew install exiftool`, `apt install libimage-exiftool-perl`, etc.) — the app falls back
to `exiftool` on `PATH` if nothing is bundled in `tools/`.

You can also point to an existing ExifTool install via:
```
GEOTAGGER_EXIFTOOL=/path/to/exiftool
```

### 3. Install GeoNames data (optional — enables reverse geocoding)

```bash
uv run python scripts/get_geonames.py
```

This downloads ~48 MB of [GeoNames](https://www.geonames.org) data (CC BY 4.0) into
`data/geonames/` under the resolved location above, enabling fully-offline reverse
geocoding (city / state / country from coordinates). If you skip this step, everything
else still works — photos just won't get place names.

### 4. Install OSM place boundaries (optional — polygon reverse geocoding)

For accurate cities and **sub-locations** (parks, stadiums, campuses, neighborhoods, named
buildings) a photo falls *inside*, build a place database from an OpenStreetMap extract.
Download the region(s) where your photos are from [GeoFabrik](https://download.geofabrik.de/north-america.html)
— start with a single US state (`https://download.geofabrik.de/north-america/us/<state>-latest.osm.pbf`,
~0.3–2 GB) — then:

```bash
uv run python scripts/build_osm_places.py path/to/<state>-latest.osm.pbf --root "D:\Photos"
# add more regions later without rebuilding:
uv run python scripts/build_osm_places.py path/to/<another>.osm.pbf --append --root "D:\Photos"
```

This assembles named area polygons into `data/osm/places.sqlite` under the resolved
location above (or pass `--db` for an exact path). When present, polygon containment
becomes the source of a photo's **city + sub-location**; GeoNames then only supplies
state/county/country. Skip it and geocoding falls back to GeoNames city names. OSM data
© OpenStreetMap contributors (ODbL). View the boundaries on the **Places DB** map
(`/map.html`) via the "OSM places" toggle.

### 5. Point it at your photos and run

The app needs at least one photo directory before any page will work — either pass it on
the command line every run:

```bash
uv run geotagger --scan-dir "D:\Photos"
# multiple libraries:
uv run geotagger --scan-dir "D:\Photos" --scan-dir "D:\More Photos"
```

or run it once with `--scan-dir` and it remembers that directory for future runs with no
flags:

```bash
uv run geotagger
```

> Multiple `--scan-dir` values are scanned every time you pass them, but only the *first*
> one is remembered for a flag-less restart — pass `--scan-dir` again (all of them) if you
> use more than one library and want them all picked up automatically.

> Running `uv run geotagger` with **no** `--scan-dir` and no prior run is a dead end — every
> page loads but every API call fails, since there's no library configured yet. Always pass
> `--scan-dir` the first time.

Opens at <http://127.0.0.1:8000>, showing the home dashboard with library health and links
into each tool.

**First scan expectations:** the first run walks every configured directory, generates a
thumbnail for each new photo/video, and reverse-geocodes anything with coordinates (if
GeoNames/OSM data is installed) — expect noticeable time on a large library, with
console-only progress. Use `--workers N` to raise/lower thumbnail-generation parallelism
(default 4), or `--no-scan` to boot straight from the existing database without rescanning.

**Face detection first-use download:** the first time any face-related feature runs, it
downloads InsightFace's `buffalo_l` model pack (~275 MB) from the internet into
`~/.insightface`. This happens lazily, so a purely offline geotagging workflow never
triggers it — but it means "fully local" doesn't mean "fully offline on first use" once you
touch the People/Representatives/Discover features.

**CLI flags:**

| Flag | Default | Description |
|---|---|---|
| `--scan-dir DIR` | — | Directory to scan (repeatable for multiple libraries) |
| `--cache-dir DIR` | `<scan-dir>/.geotagger` | Where the database + thumbnails live (see [Cache location](#cache-location)) |
| `--host HOST` | `127.0.0.1` | Bind address |
| `--port PORT` | `8000` | Port |
| `--network` | off | Bind `0.0.0.0` — see [LAN exposure warning](#lan-exposure-warning) |
| `--workers N` | `4` | Worker threads for thumbnail generation |
| `--no-scan` | off | Skip the startup scan; use the existing database as-is |

## Cache location

By default, each scanned directory gets its own `.geotagger/` subfolder (database +
thumbnails, potentially gigabytes for a large library, plus the downloaded ExifTool
binary and GeoNames/OSM data — see [setup](#where-downloaded-toolsdata-end-up)) created
**inside that photo root**. If your photo tree is treated as read-only, or synced by a
NAS/Dropbox/backup tool that will churn on thumbnail writes, point the cache elsewhere
instead:

```bash
uv run geotagger --scan-dir "D:\Photos" --cache-dir "D:\GeoTaggerCache"
# or
GEOTAGGER_CACHE_DIR=D:\GeoTaggerCache uv run geotagger --scan-dir "D:\Photos"
```

`GEOTAGGER_CACHE_DIR` is a single shared location for the database, thumbnails, ExifTool,
and GeoNames/OSM data alike — handy if you scan more than one photo library and don't want
to duplicate the downloaded tools/data per library.

## Resetting / uninstalling

All state lives in a small number of places, all safe to delete to start over:

- `<cache-dir>/.geotagger/` (or `.geotagger/` inside each scan root, if `--cache-dir` was
  never set) — the database and thumbnails.
- `~/.insightface` — the downloaded face-recognition model pack.
- `<cache-dir>/tools/`, `<cache-dir>/data/` — the downloaded ExifTool binary and
  GeoNames/OSM data, where `<cache-dir>` is the same location as above, or `~/.geotagger`
  if neither `--cache-dir` nor `--root` was ever passed.

Deleting the `.geotagger` cache loses tagged faces, life contexts, and any geotags/place
names that were never exported to XMP sidecars (see below) — sidecars themselves and the
original media are untouched either way.

## LAN exposure warning

`--network` binds `0.0.0.0` so other devices on your network can reach the app. **There is
no authentication of any kind** — anyone who can reach the port can browse every photo,
rewrite geotags, edit sidecar files, and rename people. This is an acceptable tradeoff for a
personal tool on a trusted home network, but do not expose it beyond that (e.g. via port
forwarding) without adding your own auth layer in front of it.

## Supported file types

- **Images:** `.jpg` `.jpeg` `.heic` `.heif` `.nef` `.dng` `.tif` `.tiff` `.png`
- **Video:** `.mp4` `.mov` `.m4v` `.avi`
- **Full RAW demosaic** (via rawpy/LibRaw, opt-in): `.nef` `.dng` — off by default, since the
  embedded preview ExifTool extracts is much faster; toggle in Settings or via
  `GEOTAGGER_RAW_FULL_DECODE=1`.

## Data model: DB vs. sidecars

The SQLite database (in the cache directory above) is the working store for everything —
geotags, resolved place names, face detections/labels, life contexts, time-sync offsets.
Sidecar files are the durable, portable output, brought in sync with the database on demand:

- Geotags are DB-only by default; `POST /api/geocode/export-sidecars` (or the export button
  in the UI) writes GPS + resolved place names into each photo's XMP sidecar. Set
  `GEOTAGGER_WRITE_XMP_ON_GEOTAG=1` (or the equivalent Settings toggle) to write GPS to the
  sidecar immediately on every drag/edit instead.
- Face/person tags are **database-only** — there is no sidecar export for face data (yet).

Because of this, the `.geotagger` cache is more than disposable scratch space: deleting it
before exporting loses any geotagging/face work that hasn't been written out yet.

## Features

| Page | Purpose |
|---|---|
| **Home** (`/`) | Library health dashboard — scan status, counts, links into every tool |
| **Search** (`/search.html`) | Multi-criteria photo search: date range, location text, geotag status, people (including "two+ people together") |
| **Geocode** (`/geocode.html`) | Main map/grid view — drag photos onto the map to geotag them (see [Usage](#usage)) |
| **Quick Geocode** (`/quick-geocode.html`) | Fast-path geotagging for a burst of nearby, time-clustered ungeotagged photos: set one location for the whole group |
| **Places DB** (`/map.html`) | Visualize the imported OSM place-boundary polygons |
| **Time Sync** (`/timesync.html`) | Correct a camera's clock drift/timezone by matching known-time photos, then batch-adjust that camera's timestamps |
| **People** (`/people.html`) | Face tagging: label detected faces, review suggested matches, manage the unlabeled queue |
| **Representatives** (`/representatives.html`) | Review the kept representative (medoid) faces for prolific people, after deduplication |
| **Contexts** (`/contexts.html`) | Draw/manage "Life Context" time+place polygons used for guessing and filtering photos |
| **Settings** (`/settings.html`) | Runtime-tunable knobs (face-matching thresholds, RAW decode, XMP-on-geotag, etc.) — see `config.py`'s `SETTINGS_SPEC` for the full list and semantics |

Reachable but not in the top nav:

| Page | Purpose |
|---|---|
| **Quick Tag** (`/tag.html`) | Mobile-friendly face triage: walks the face-clustering queue one group at a time |
| **Photo Faces** (`/photo-faces.html`) | View and edit every detected face in one photo; with `&mode=crowd` it walks the crowd-photo playlist |
| **People Manager** (`/people-manage.html`) | Edit names, birth dates, and family groupings for tagged people in one list |

## Usage: geotagging photos

1. Open the dashboard at `/` for an overview, or go straight to `/geocode.html`
2. Geotagged photos show as pushpins on the map; thumbnails appear in the center grid
3. **Drag thumbnails onto the map** to geotag them at the drop point
4. **Ctrl/Cmd+click** or **Shift+click** to multi-select; drag the selection
5. **Manual entry:** type lat/lng, click "Apply to selection"
6. **Copy location:** focus a photo in the right pane, select others, click "Copy location to selection"
7. **Edit:** drag an existing pushpin to a new position
8. **Remove:** select photos, click "Remove geotag"

## Reverse geocoding (place names)

Once the GeoNames data is installed (see setup step 3), any photo with coordinates is
resolved to **city / state / county / country** entirely offline — the nearest populated
place is found via a spatial index. Coordinates are quantized (~11 m) so nearby photos
share one lookup.

If the OSM place database is also built (setup step 4), the **city** instead comes from the
actual administrative boundary the coordinate falls inside — and photos additionally get a
**sub-location** (the smallest containing park / stadium / campus / neighborhood / named
building). By default, a coordinate outside every imported OSM city polygon falls back to
the GeoNames nearest-city name (GeoNames still fills state/county/country either way) —
useful since OSM coverage is usually only a handful of imported regions. Once your imported
regions cover your whole library, set `GEOTAGGER_OSM_CITY_FALLBACK_GEONAMES=0` for strict
"OSM only" behavior, where a coordinate outside every polygon gets no city name at all.

- **On scan:** newly-indexed geotagged photos are reverse-geocoded automatically (stored in
  the database).
- **On geotag:** dropping/applying a location also writes the place names.
- Place names are stored in the database, and written into XMP sidecars as the standard
  IPTC/Photoshop fields (`photoshop:City`, `photoshop:State`, `photoshop:Country`,
  `Iptc4xmpCore:CountryCode`) that Lightroom, Bridge, digiKam, etc. all read.

`POST /api/geocode/backfill` only geocodes photos that have *never* been resolved — a photo
already geocoded before you built (or later extended) the OSM place database won't pick up
the new place names on its own. To force already-geocoded photos to be re-resolved:

```bash
uv run python scripts/regeocode.py --dry-run --bbox minLng,minLat,maxLng,maxLat --limit 20  # preview a subset
uv run python scripts/regeocode.py --bbox minLng,minLat,maxLng,maxLat --limit 20            # verify a subset
uv run python scripts/regeocode.py --bbox minLng,minLat,maxLng,maxLat                       # the whole region
uv run python scripts/regeocode.py                                                          # the whole library
```

`--bbox` is handy to try just the region you imported OSM data for before committing to a
full-library run (which can take a while on a large library). This also clears the geocode
cache, since it's stale once OSM data changes the city-resolution rules globally.

API:

| Endpoint | Purpose |
|---|---|
| `GET /api/geocode/status` | Geocoder availability + geocoded/pending counts |
| `POST /api/geocode/backfill` | Reverse-geocode photos that have coords but no place yet (`{"limit": N}`; repeat until `remaining` is 0) |
| `POST /api/geocode/export-sidecars` | Write resolved place names into the XMP sidecar of every geocoded photo |

## Face detection and people tagging

The **People** page is the largest subsystem in the app: InsightFace (`buffalo_l`) detects
faces during scanning and stores per-face embeddings; you label faces with a person's name,
and later scans/reviews use cosine-similarity matching against those labels to suggest
identities on new unlabeled faces. Related pages:

- **People** — the main labeling/review workflow, plus an unlabeled queue with pre-checked
  high-confidence suggestions.
- **Quick Tag** — a mobile-oriented version of the same triage flow, one clustered group at
  a time.
- **Discover** (face clustering, surfaced within People) — groups unlabeled faces by
  similarity so you can label a whole cluster in one action.
- **Representatives** — for people with many labeled faces, a deduplication pass clusters
  near-duplicate labels and keeps one representative (medoid) per distinct look; this page
  reviews/adjusts those picks.
- **Crowd Review** — photos with a large number of detected faces (default ≥ 50) are treated
  as "crowd photos" and reviewed separately rather than forcing per-face labeling.
- **People Manager** — bulk-edit names, birth dates, and family groupings.
- Age-aware matching uses a person's birth date plus each photo's date to penalize/exclude
  implausible age gaps when suggesting identities.

Face/person tags are **database-only** — see [Data model](#data-model-db-vs-sidecars).

All of the thresholds and caps that drive this (match threshold, clustering thresholds,
crowd size, age penalties, etc.) are listed with explanations in the **Settings** page and in
`config.py`'s `SETTINGS_SPEC`; most can be changed live without a restart.

## Time Sync

If a camera's clock was wrong (wrong timezone, drifted, never set), match a few of its
photos against another source of ground truth (e.g. a phone photo of the same moment, or a
known event time), compute the offset, and batch-apply it to correct that camera's
timestamps across the library — useful since accurate timestamps also drive Quick Geocode's
time-clustering and age-aware face matching.

## Life Contexts

Draw named time+place polygons (e.g. "Home 2020–2023", "College") on the Contexts page.
These are used elsewhere to guess a plausible location for undated/ungeotagged photos and to
filter search results by context.

## Sidecar naming

Default: `basename.xmp` (e.g. `IMG_1234.NEF` → `IMG_1234.xmp`) — Lightroom/Adobe convention.

If your collection has same-stem files in the same folder (e.g. `IMG.JPG` + `IMG.NEF`), they would
share one sidecar. The scan will warn you. Switch to `fullname.xmp` mode to avoid collisions:

```
GEOTAGGER_SIDECAR_MODE=fullname uv run geotagger
```

## Configuration

Common environment variables — see `src/geotagger/config.py` for the full list (~35 knobs
total, including every `GEOTAGGER_FACE_*` tuning parameter, most of which are also editable
live from the Settings page):

| Env var | Default | Description |
|---|---|---|
| `GEOTAGGER_EXIFTOOL` | *(none — see [tools/data location](#where-downloaded-toolsdata-end-up))* | Path to ExifTool binary |
| `GEOTAGGER_SIDECAR_MODE` | `basename` | `basename` or `fullname` |
| `GEOTAGGER_HOST` | `127.0.0.1` | Bind address |
| `GEOTAGGER_PORT` | `8000` | Port |
| `GEOTAGGER_CACHE_DIR` | *(none — see [Cache location](#cache-location))* | Directory for the database + thumbnails + tools/data |
| `GEOTAGGER_WORKERS` | `4` | Thumbnail-generation worker threads |
| `GEOTAGGER_NO_SCAN` | `0` | `1` = skip the startup scan |
| `GEOTAGGER_GEONAMES_DIR` | *(none — see [tools/data location](#where-downloaded-toolsdata-end-up))* | Directory holding the downloaded GeoNames files |
| `GEOTAGGER_GEOCODE_PRECISION` | `4` | Decimal degrees of coordinate quantization for the geocode cache (4 ≈ 11 m) |
| `GEOTAGGER_OSM_DB` | *(none — see [tools/data location](#where-downloaded-toolsdata-end-up))* | OSM place-boundary database (built by `scripts/build_osm_places.py`) |
| `GEOTAGGER_OSM_CITY_FALLBACK_GEONAMES` | `1` | `0` = strict OSM-only city (no fallback for coordinates outside every imported polygon) |
| `GEOTAGGER_WRITE_XMP_ON_GEOTAG` | `0` | `1` = write GPS to the XMP sidecar immediately on every geotag edit |
| `GEOTAGGER_RAW_FULL_DECODE` | `0` | `1` = fully demosaic RAW files via LibRaw instead of using the embedded preview |
| `GEOTAGGER_THUMB_FORMAT` | `webp` | Format for cached thumbnails/previews/face crops: `webp` (smaller) or `jpeg` |
| `GEOTAGGER_THUMB_QUALITY` | `80` webp / `85` jpeg | Encoder quality for cached renditions |
| `GEOTAGGER_THUMB_QUALITY_HIGH` | `90` | Quality for the (uncached) face-detection rendition |
| `GEOTAGGER_WEBP_METHOD` | `4` | libwebp effort, 0 (fast) … 6 (slowest, smallest) |

## Cross-platform notes

The Windows-specific parts of setup are the automatic ExifTool download
(`scripts/get_exiftool.py` fetches the Windows zip) and the Windows-flavored paths used in
this README. Everything else — FastAPI/uvicorn, Pillow/pillow-heif/av, InsightFace/
onnxruntime, rawpy, osmium — ships wheels for macOS and Linux too, and the app has no
Windows-only code paths in normal operation. It just hasn't been run/tested there. On
macOS/Linux: install ExifTool via your package manager (see setup step 2) and use forward-
slash paths for `--scan-dir`/`--cache-dir`/`--root`. Reports of success (or failure) are
welcome.

## Attribution / data licenses

This project's code is MIT-licensed (see `LICENSE`). It optionally downloads and bundles two
third-party geographic datasets under their own licenses, unrelated to the code license:

- [GeoNames](https://www.geonames.org) data — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- [OpenStreetMap](https://www.openstreetmap.org/copyright) extracts — [ODbL](https://opendatacommons.org/licenses/odbl/)

Map tiles are served live from `tile.openstreetmap.org`; see OSM's tile usage policy if you
plan on heavy use.
