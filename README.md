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

### 4. Run

```bash
uv run geotagger
# or
uv run python -m geotagger
```

Opens at <http://127.0.0.1:8000>

## Usage

1. Paste a directory path into the toolbar and click **Scan**
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

- **On scan:** newly-indexed geotagged photos are reverse-geocoded automatically (stored in
  the database).
- **On geotag:** dropping/applying a location also writes the place names.
- Place names are stored in the database, and written into XMP sidecars as the standard
  IPTC/Photoshop fields (`photoshop:City`, `photoshop:State`, `photoshop:Country`,
  `Iptc4xmpCore:CountryCode`) that Lightroom, Bridge, digiKam, etc. all read.

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
