# Geo-Tagger

Local web app for geotagging photo collections. All geolocation metadata is written to
**XMP sidecar files** — original image files are never modified.

## Setup

### 1. Install Python dependencies

```bash
uv sync
```

### 2. Install ExifTool (required)

**Automatic (recommended):**
```bash
uv run python scripts/get_exiftool.py
```
This downloads ExifTool into `tools/exiftool.exe`.

**Manual fallback:**
1. Download the Windows zip from <https://exiftool.org>
2. Unzip — you get `exiftool(-k).exe` and an `exiftool_files/` folder
3. Rename `exiftool(-k).exe` → `exiftool.exe`
4. Place both `exiftool.exe` **and** `exiftool_files/` inside the `tools/` directory

> Both must sit together or ExifTool won't run.

You can also point to an existing ExifTool install via:
```
GEOTAGGER_EXIFTOOL=C:\path\to\exiftool.exe
```

### 3. Install GeoNames data (optional — enables reverse geocoding)

```bash
uv run python scripts/get_geonames.py
```

This downloads ~48 MB of [GeoNames](https://www.geonames.org) data (CC BY 4.0) into
`data/geonames/`, enabling fully-offline reverse geocoding (city / state / country from
coordinates). If you skip this step, everything else still works — photos just won't get
place names.

### 4. Install OSM place boundaries (optional — polygon reverse geocoding)

For accurate cities and **sub-locations** (parks, stadiums, campuses, neighborhoods, named
buildings) a photo falls *inside*, build a place database from an OpenStreetMap extract.
Download the region(s) where your photos are from [GeoFabrik](https://download.geofabrik.de/north-america.html)
— start with a single US state (`https://download.geofabrik.de/north-america/us/<state>-latest.osm.pbf`,
~0.3–2 GB) — then:

```bash
uv run python scripts/build_osm_places.py path/to/<state>-latest.osm.pbf
# add more regions later without rebuilding:
uv run python scripts/build_osm_places.py path/to/<another>.osm.pbf --append
```

This assembles named area polygons into `data/osm/places.sqlite`. When present, polygon
containment becomes the source of a photo's **city + sub-location**; GeoNames then only
supplies state/county/country. Skip it and geocoding falls back to GeoNames city names.
OSM data © OpenStreetMap contributors (ODbL). View the boundaries on the **Places DB** map
(`/map.html`) via the "OSM places" toggle.

### 5. Run

```bash
uv run geotagger
# or
uv run python -m geotagger
```

Opens at <http://127.0.0.1:8000>, showing the home dashboard with library health and
links into each tool. The map/grid geocode view lives at `/geocode.html`.

## Usage

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

## Sidecar naming

Default: `basename.xmp` (e.g. `IMG_1234.NEF` → `IMG_1234.xmp`) — Lightroom/Adobe convention.

If your collection has same-stem files in the same folder (e.g. `IMG.JPG` + `IMG.NEF`), they would
share one sidecar. The scan will warn you. Switch to `fullname.xmp` mode to avoid collisions:

```
GEOTAGGER_SIDECAR_MODE=fullname uv run geotagger
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `GEOTAGGER_EXIFTOOL` | `tools/exiftool.exe` | Path to ExifTool binary |
| `GEOTAGGER_SIDECAR_MODE` | `basename` | `basename` or `fullname` |
| `GEOTAGGER_HOST` | `127.0.0.1` | Bind address |
| `GEOTAGGER_PORT` | `8000` | Port |
| `GEOTAGGER_GEONAMES_DIR` | `data/geonames` | Directory holding the downloaded GeoNames files |
| `GEOTAGGER_GEOCODE_PRECISION` | `4` | Decimal degrees of coordinate quantization for the geocode cache (4 ≈ 11 m) |
| `GEOTAGGER_OSM_DB` | `data/osm/places.sqlite` | OSM place-boundary database (built by `scripts/build_osm_places.py`) |
| `GEOTAGGER_OSM_CITY_FALLBACK_GEONAMES` | `1` | `0` = strict OSM-only city (no fallback for coordinates outside every imported polygon) |
