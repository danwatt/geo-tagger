import os
import sys
from pathlib import Path

# Name of the binary scripts/get_exiftool.py downloads into tools/: the Windows
# distribution is a standalone .exe, the Unix/macOS distribution is a Perl
# script (needs `perl` on PATH) named plain "exiftool".
BUNDLED_EXIFTOOL_NAME = "exiftool.exe" if sys.platform == "win32" else "exiftool"

# Cache directory: can be absolute path or relative to scanned root
# If GEOTAGGER_CACHE_DIR is set, use that as an absolute path
# Otherwise, use CACHE_DIR_NAME relative to the scanned root
def get_cache_dir() -> Path | None:
    """Get the cache directory from environment, if set."""
    cache_dir_env = os.environ.get("GEOTAGGER_CACHE_DIR")
    return Path(cache_dir_env) if cache_dir_env else None

CACHE_DIR_NAME = ".geotagger"  # Used when get_cache_dir() returns None

# Where the "last scanned root(s)" sentinel lives when GEOTAGGER_CACHE_DIR isn't set —
# needed to remember which root(s) to auto-load on a flag-less restart, before any
# scan root is known. Deliberately outside the project checkout (a program writing
# into its own install directory breaks on read-only installs and is a packaging
# smell); defaults to a per-user home directory, override with GEOTAGGER_STATE_DIR.
def get_state_dir() -> Path:
    if env := os.environ.get("GEOTAGGER_STATE_DIR"):
        return Path(env)
    return Path.home() / ".geotagger"

# Base dir for downloaded tools/ and data/ (ExifTool binary, GeoNames, OSM places):
# same resolution as the DB's cache_dir, so they default to living alongside the
# index rather than inside the repo checkout. GEOTAGGER_CACHE_DIR (if set) wins as
# a single shared location; otherwise it's the app's primary scan root's cache dir,
# or — before any root is known (fresh install, no scan configured yet) — the
# global per-user state dir.
def resolve_data_root(primary_root: Path | None = None) -> Path:
    if env := os.environ.get("GEOTAGGER_CACHE_DIR"):
        return Path(env)
    if primary_root is not None:
        return Path(primary_root) / CACHE_DIR_NAME
    return get_state_dir()

# Where scripts/get_exiftool.py installs the downloaded binary — always the
# standard location, regardless of GEOTAGGER_EXIFTOOL (which points at a binary
# you've supplied yourself; you wouldn't run the download script in that case).
def get_tools_dir(data_root: Path | None = None) -> Path:
    return resolve_data_root(data_root) / "tools"

# ExifTool binary resolution: env var > <data_root>/tools/exiftool(.exe) > PATH
def get_exiftool_path(data_root: Path | None = None) -> str:
    if env := os.environ.get("GEOTAGGER_EXIFTOOL"):
        return env
    bundled = get_tools_dir(data_root) / BUNDLED_EXIFTOOL_NAME
    if bundled.exists():
        return str(bundled)
    return "exiftool"

EXIFTOOL_PATH: str = get_exiftool_path()

# Reclaim free-list space (deleted-row pages) at startup via VACUUM, gated on
# the free-page ratio so a mostly-compact DB isn't fully rewritten every run.
AUTO_VACUUM = os.environ.get("GEOTAGGER_AUTO_VACUUM", "1") == "1"
AUTO_VACUUM_THRESHOLD = float(os.environ.get("GEOTAGGER_AUTO_VACUUM_THRESHOLD", "0.1"))
# Target SQLite page size. 16384 (vs SQLite's 4096 default) cuts wasted space in
# the face_embeddings table: an embedding-heavy row (~2.1KB) only just misses
# fitting two to a 4096-byte page, stranding ~47% of every page; larger pages
# pack several rows each. Applied once via the same VACUUM (see
# index.vacuum_if_needed) — a no-op once the DB is already at this page size.
AUTO_VACUUM_PAGE_SIZE = int(os.environ.get("GEOTAGGER_VACUUM_PAGE_SIZE", "16384"))

# Thumbnail and preview dimensions
THUMB_SIZE = 256
PREVIEW_SIZE = 1000

# ── Cached rendition encoding (thumbnails.py) ──
# Format every generated rendition (grid thumb, preview, face crop) is encoded in.
# WebP at q80 is typically 25-35% smaller than JPEG q85 at comparable perceptual
# quality, and the thumbs cache is by far the largest thing this app writes.
# "jpeg" restores the old behaviour. The chosen format's extension is part of every
# cache filename, so switching swaps to a separate set of files instead of serving a
# stale mix — old renditions are simply never read again (delete the cache's `thumbs/`
# dir to reclaim their space).
THUMB_FORMAT = os.environ.get("GEOTAGGER_THUMB_FORMAT", "webp").strip().lower()
if THUMB_FORMAT not in ("webp", "jpeg"):
    raise ValueError(f"GEOTAGGER_THUMB_FORMAT must be 'webp' or 'jpeg', got {THUMB_FORMAT!r}")
# Encoder quality for cached renditions. Defaults are per-format on purpose: the two
# scales aren't comparable, and WebP q80 ≈ JPEG q85 visually.
THUMB_QUALITY = int(os.environ.get("GEOTAGGER_THUMB_QUALITY", "80" if THUMB_FORMAT == "webp" else "85"))
# Quality for the (uncached, in-memory) face-detection rendition — higher, since
# compression artifacts cost detection recall and ArcFace embedding accuracy.
THUMB_QUALITY_HIGH = int(os.environ.get("GEOTAGGER_THUMB_QUALITY_HIGH", "90"))
# libwebp encoder effort, 0 (fast) … 6 (slowest, smallest). Only matters for WebP.
# 4 is Pillow's default and a reasonable balance; a full-library scan encodes one
# thumb per photo, so raising this makes scans noticeably slower for a few % of size.
WEBP_METHOD = int(os.environ.get("GEOTAGGER_WEBP_METHOD", "4"))

# Sidecar naming: "basename" -> IMG.NEF uses IMG.xmp
#                 "fullname" -> IMG.NEF uses IMG.NEF.xmp
SIDECAR_MODE = os.environ.get("GEOTAGGER_SIDECAR_MODE", "basename")  # or "fullname"

# ── Reverse geocoding (offline, GeoNames) ──
# Directory holding the GeoNames data files (cities500.txt, admin1CodesASCII.txt,
# admin2Codes.txt, countryInfo.txt). Download them with:
#     uv run python scripts/get_geonames.py
def get_geonames_dir(data_root: Path | None = None) -> Path:
    if env := os.environ.get("GEOTAGGER_GEONAMES_DIR"):
        return Path(env)
    return resolve_data_root(data_root) / "data" / "geonames"

GEONAMES_DIR: Path = get_geonames_dir()

# Coordinates are quantized to this many decimal degrees before a reverse-geocode
# lookup, so nearby photos share one cached result. 4 decimals ≈ 11 m at the
# equator (and less at higher latitudes) — fine for city/state/country tagging.
GEOCODE_PRECISION = int(os.environ.get("GEOTAGGER_GEOCODE_PRECISION", "4"))

# GeoNames cities500 mixes real municipalities with tiny GNIS-imported
# subdivisions, and both carry feature code "PPL" — so a pure nearest-point
# lookup can label a photo with a 1,800-person subdivision nobody has heard of
# while the recognizable town of 200,000 sits barely further away. When
# GEOCODE_POP_WEIGHT is on, the lookup considers GEOCODE_CANDIDATES nearest
# places and picks the lowest `distance_km / (1 + log10(population))` instead of
# the plain nearest, which lets a much larger place win a near-tie in distance.
# Set to "0" for the old strict nearest-point behaviour.
GEOCODE_POP_WEIGHT = os.environ.get("GEOTAGGER_GEOCODE_POP_WEIGHT", "1").lower() in ("1", "true", "yes", "on")
# Hard reach cap for the weighting above: a candidate is only allowed to beat the
# nearest place if it lies within this many km *past* it. Without the cap, the
# log-population term can drag a label tens of km away in sparse rural areas
# (measured: Ridgway 21.8 km -> Montrose 42.0 km).
GEOCODE_POP_WEIGHT_MAX_KM = float(os.environ.get("GEOTAGGER_GEOCODE_POP_WEIGHT_MAX_KM", "10"))
# A candidate must beat the nearest place's score by at least this fraction to take
# the label. Without it, coordinates far from everything (where every score is
# large and nearly equal) flip on noise — measured: Bryson City NC 3.67 vs
# Gatlinburg TN 3.66, i.e. a coin toss that also crosses a state line. 0.10 keeps
# the clear-cut wins (Oak Cliff Place -> Cypress is 13% better) and drops the ties.
GEOCODE_POP_WEIGHT_MARGIN = float(os.environ.get("GEOTAGGER_GEOCODE_POP_WEIGHT_MARGIN", "0.10"))
# How many nearest places the weighted lookup scores. 12 is plenty — the reach cap
# eliminates anything further out anyway, and a k=12 KD-tree query still runs in
# microseconds. Ignored when GEOCODE_POP_WEIGHT is off.
GEOCODE_CANDIDATES = int(os.environ.get("GEOTAGGER_GEOCODE_CANDIDATES", "12"))
# Long-edge resolution of the grid the map's place-boundary overlay is computed on
# when the weighting above is active. The weighted boundaries are Apollonius arcs
# (and the margin/reach guards clip them further), so there is no cheap exact
# diagram to draw — geocode.voronoi_cells instead labels a grid with the real
# lookup and traces each place's region, making boundary error ~one grid step of
# the viewport. Higher = smoother outlines, more CPU per pan and a bigger payload.
GEOCODE_BOUNDARY_GRID = int(os.environ.get("GEOTAGGER_GEOCODE_BOUNDARY_GRID", "192"))

# ── OSM places (offline, polygon reverse geocoding) ──
# SQLite DB of OSM area polygons (cities, parks, stadiums, campuses, neighborhoods,
# named buildings) built from GeoFabrik .osm.pbf extract(s) with:
#     uv run python scripts/build_osm_places.py <region>.osm.pbf
# When present, polygon containment is the source of a photo's city + sub-location
# (see osm_places.py); GeoNames then only supplies state/county/country.
def get_osm_db(data_root: Path | None = None) -> Path:
    if env := os.environ.get("GEOTAGGER_OSM_DB"):
        return Path(env)
    return resolve_data_root(data_root) / "data" / "osm" / "places.sqlite"

OSM_DB_PATH: Path = get_osm_db()


def get_pbf_cache_dir() -> Path:
    """Where the downloaded GeoFabrik .osm.pbf extracts are kept after the Data
    Management page has merged them into the places DB. Read at call time (not
    bound to a constant) because OSM_DB_PATH is re-resolved by resolve_data_paths
    once the scan root is known. Keeping the raw extracts is what makes the
    on-demand street search (osm_streets.py) possible without loading every road
    into a database — delete the directory and only that feature stops working."""
    return OSM_DB_PATH.parent / "pbf-cache"


# ── OSM street search (on-demand, over the cached .osm.pbf extracts) ──
# Max ways one search returns before it stops scanning and reports "truncated".
# Each way is a street *segment* (OSM splits a road at every junction/tag change),
# so a few hundred covers a long road across a city viewport.
OSM_STREETS_MAX_WAYS = int(os.environ.get("GEOTAGGER_OSM_STREETS_MAX_WAYS", "600"))
# pyosmium node-location index used while streaming a .pbf. "flex_mem" is the same
# index osm_builder uses for the merge; it holds every node location in RAM
# (hundreds of MB for a big state extract) but keeps the scan to a single pass.
# "sparse_file_array,<path>" would trade speed for memory if that ever matters.
OSM_STREETS_LOCATION_INDEX = os.environ.get("GEOTAGGER_OSM_STREETS_INDEX", "flex_mem")

# ── US Census places (offline, polygon reverse geocoding) ──
# SQLite DB of US Census Cartographic Boundary "places" — every incorporated place
# *plus* every census designated place (CDP), which is what covers the unincorporated
# suburbia OSM has no boundary for (OSM only carries boundary=administrative cities;
# there are ~15 boundary=census areas in the whole Texas extract). Built from the
# national 1:500,000 shapefile with:
#     uv run python scripts/get_census_places.py
# Consulted after OSM and before the GeoNames nearest-point fallback — see
# census_places.py and geocode._merged_lookup.
def get_census_db(data_root: Path | None = None) -> Path:
    if env := os.environ.get("GEOTAGGER_CENSUS_DB"):
        return Path(env)
    return resolve_data_root(data_root) / "data" / "census" / "places.sqlite"

CENSUS_DB_PATH: Path = get_census_db()

# Vintage of the Cartographic Boundary files to download. The Census publishes a new
# one each year at a stable URL shape (…/GENZ<year>/shp/cb_<year>_us_place_500k.zip);
# the downloader walks back a couple of years from here if that year isn't posted yet.
CENSUS_CB_YEAR = int(os.environ.get("GEOTAGGER_CENSUS_CB_YEAR", "2025"))
# ZCTA boundaries get their own vintage: ZIP Code Tabulation Areas are only
# retabulated with the decennial census, so the Cartographic Boundary set publishes
# them once per decade rather than yearly — GENZ2021..GENZ2025 have no ZCTA file at
# all (verified against the Census file listings), and 2020 is the current series.
CENSUS_ZCTA_YEAR = int(os.environ.get("GEOTAGGER_CENSUS_ZCTA_YEAR", "2020"))
# Whether a ZIP's USPS mailing city may stand in as the photo's city when neither OSM
# nor a Census place contains the point. On by default: a mailing city is how the
# address there actually reads, and it's containment rather than a distance guess.
# The trade-off is rural ZIPs, which are named for whichever tiny post office serves
# them — measured on a 61K-photo library, this answered 18% of distinct coordinates
# and disagreed with the GeoNames guess 657 times, including Navasota -> Washington
# and Ridgway -> Cimarron. Set to "0" to keep storing loc_postal_code but leave the
# city to the GeoNames nearest-place estimate.
ZCTA_CITY_FALLBACK = os.environ.get("GEOTAGGER_ZCTA_CITY_FALLBACK", "1").lower() in ("1", "true", "yes", "on")


def resolve_data_paths(primary_root: Path | None):
    """(Re)resolve EXIFTOOL_PATH/GEONAMES_DIR/OSM_DB_PATH/CENSUS_DB_PATH once the
    app's primary scan root is known, so they default alongside the DB's cache_dir
    instead of the state-dir fallback used at import time (no root known yet). Call
    once during startup, before ExifTool/geocoder/OSM/Census places are touched."""
    global EXIFTOOL_PATH, GEONAMES_DIR, OSM_DB_PATH, CENSUS_DB_PATH
    EXIFTOOL_PATH = get_exiftool_path(primary_root)
    GEONAMES_DIR = get_geonames_dir(primary_root)
    OSM_DB_PATH = get_osm_db(primary_root)
    CENSUS_DB_PATH = get_census_db(primary_root)

# When True, fall back to the GeoNames nearest-city name for photos that fall
# outside every OSM city polygon (e.g. rural areas, or a region not yet ingested).
# Default True: OSM cities still take priority wherever a photo falls inside one,
# but a coordinate outside every ingested OSM polygon still gets a usable city
# instead of "(none)" — the common case while OSM coverage is only ever a
# handful of imported regions. Set to "0" for strict "OSM replaces city" (no
# fallback) once your imported regions cover the whole library and "(none)"
# should mean "genuinely outside my library's area."
OSM_CITY_FALLBACK_GEONAMES = os.environ.get("GEOTAGGER_OSM_CITY_FALLBACK_GEONAMES", "1") == "1"

# When True, placing/editing a geotag also writes GPS coordinates into the photo's
# XMP sidecar immediately. Default False: the geotag is stored in the DB only, and
# sidecars (GPS + resolved place names) are brought up to date later via the
# on-demand export action (see geotagger/services/geocode_service.export_to_sidecars,
# /api/geocode/export-sidecars). Runtime-tunable (see SETTINGS_SPEC).
WRITE_XMP_ON_GEOTAG = os.environ.get("GEOTAGGER_WRITE_XMP_ON_GEOTAG", "0").lower() in ("1", "true", "yes", "on")

# Supported file extensions
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".heic", ".heif", ".nef", ".dng", ".tif", ".tiff", ".png"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi"}
ALL_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
# Camera RAW formats we can fully demosaic to a JPEG via rawpy/LibRaw (see
# RAW_FULL_DECODE below). Deliberately narrower than the RAW/TIFF set handled by
# thumbnails._open_image's embedded-preview branch: .tif/.tiff/.heic have no LibRaw
# full-decode path here and stay on the embedded-preview route.
RAW_EXTENSIONS = {".nef", ".dng"}

# ── RAW decoding ──
# When True, camera RAW files (RAW_EXTENSIONS) are fully demosaiced to a JPEG via
# rawpy/LibRaw for both the served preview and face detection, instead of using the
# embedded preview ExifTool extracts (small/heavily-compressed on some cameras).
# Off by default — the embedded preview is much faster. Runtime-tunable (see
# SETTINGS_SPEC); full-decode renditions cache under a distinct "_fd" suffix so
# toggling the setting never serves a stale, mixed cache.
RAW_FULL_DECODE = os.environ.get("GEOTAGGER_RAW_FULL_DECODE", "0").lower() in ("1", "true", "yes", "on")
# Long-edge (px) the full RAW decode is downscaled to for FACE DETECTION (the served
# preview keeps PREVIEW_SIZE). Larger sharpens the ArcFace crops used for embeddings;
# detection itself still resizes to FACE_DET_SIZE internally, so this mainly helps
# small faces and future-proofs raising FACE_DET_SIZE.
FACE_DECODE_MAX_DIM = int(os.environ.get("GEOTAGGER_FACE_DECODE_MAX_DIM", "3000"))
# Long edge (px) a hand-drawn face box is upscaled to before the fallback re-detect
# that embeds it (faces.embed_bbox). The whole point of a manual box is that normal
# detection missed the face, usually because it was small/soft — enlarging the crop
# gives SCRFD a second, easier look.
FACE_MANUAL_CROP_DIM = int(os.environ.get("GEOTAGGER_FACE_MANUAL_CROP_DIM", "640"))

# Server
HOST = os.environ.get("GEOTAGGER_HOST", "127.0.0.1")
PORT = int(os.environ.get("GEOTAGGER_PORT", "8000"))

# ── Face detection / recognition ──
# InsightFace model pack ("buffalo_l" = SCRFD detector + ArcFace r50 embeddings).
FACE_MODEL_NAME = os.environ.get("GEOTAGGER_FACE_MODEL", "buffalo_l")
# Detection input size (square). Larger finds smaller/more faces but is slower.
FACE_DET_SIZE = int(os.environ.get("GEOTAGGER_FACE_DET_SIZE", "640"))
# Drop detections below this score (the model's own default floor is ~0.5).
FACE_DET_THRESHOLD = float(os.environ.get("GEOTAGGER_FACE_DET_THRESHOLD", "0.5"))
# Cosine-similarity threshold for calling two faces the same person.
# ArcFace normed embeddings: ~0.28 is permissive, ~0.4 is confident.
FACE_MATCH_THRESHOLD = float(os.environ.get("GEOTAGGER_FACE_MATCH_THRESHOLD", "0.35"))
# Max unlabeled faces to scan when gathering a person's guesses (scope=suggested
# / "Only suggested"). 0 = exhaustive (scan every unlabeled face). Set a positive
# value to bound the scan if a very large library makes the first scan too slow.
FACE_SUGGEST_SCAN_CAP = int(os.environ.get("GEOTAGGER_FACE_SUGGEST_SCAN_CAP", "0"))
# Max labeled examples per person used in the single-person gate pass inside
# suggest_for_person. A person with thousands of labeled faces causes the gate
# matmul to be as expensive as the full-gallery rank pass; capping at ~200
# evenly-spread examples preserves recall (any genuine match will hit at least
# one of them) while keeping the gate cheap regardless of label count.
FACE_GATE_MAX_EXAMPLES = int(os.environ.get("GEOTAGGER_FACE_GATE_MAX_EXAMPLES", "200"))
# When reviewing one person's guesses, another person whose own best example
# scores within this cosine margin of the top match is flagged as an ambiguous
# alternative ("could be this family member instead") — a near-tie, not a clear win.
FACE_AMBIGUITY_MARGIN = float(os.environ.get("GEOTAGGER_FACE_AMBIGUITY_MARGIN", "0.05"))
# Minimum detector confidence for a face to be offered as a *suggestion*. Tiny /
# blurry / profile faces (low det_score) have noisy embeddings that cause false
# matches, so they're skipped when gathering guesses — but still detected, stored,
# and taggable by hand. Lower it if too many real faces are excluded; 0 disables.
FACE_SUGGEST_MIN_DET_SCORE = float(os.environ.get("GEOTAGGER_FACE_SUGGEST_MIN_DET_SCORE", "0.65"))
# Minimum bbox area (fraction of the detection image, 0..1) for a *labeled* face
# to be used as a gallery example when matching unlabeled faces. A tiny/distant
# face embeds noisily even when correctly labeled, so a person's small-bbox
# examples are excluded as match SOURCES (they stay labeled and visible — this
# only affects the gallery matmul in build_gallery). 0 disables the floor.
FACE_MIN_GALLERY_BBOX_AREA = float(os.environ.get("GEOTAGGER_FACE_MIN_GALLERY_BBOX_AREA", "0.01"))
# Unlabeled queue (people.js): a suggestion is only ever shown above
# FACE_MATCH_THRESHOLD, but this higher cutoff decides which of those visible
# suggestions get pre-checked on page load vs. left for manual triage.
FACE_PRESELECT_MIN_SCORE = float(os.environ.get("GEOTAGGER_FACE_PRESELECT_MIN_SCORE", "0.5"))
# Max faces the People page's grid (any scope) fetches per load. Higher shows
# more at once but is slower to render; the server independently caps this at
# 20000 (see api_list_faces) regardless of what's set here.
FACE_QUERY_LIMIT = int(os.environ.get("GEOTAGGER_FACE_QUERY_LIMIT", "5000"))

# ── Representative-face picking (prolific people accumulate many near-duplicate
# labels; cluster them and keep one medoid per look instead of every example) ──
# Only people with at least this many labeled faces get clustered — someone with
# a handful of labels already has an all-representative set, nothing to collapse.
FACE_DEDUP_MIN_FACES = int(os.environ.get("GEOTAGGER_FACE_DEDUP_MIN_FACES", "50"))
# Cosine similarity at/above which two of one person's labeled faces are the
# "same look" and get clustered together (see faces.cluster_unlabeled — this
# reuses that connected-components method, just scoped to one person's labels
# instead of the whole unlabeled queue).
FACE_DEDUP_THRESHOLD = float(os.environ.get("GEOTAGGER_FACE_DEDUP_THRESHOLD", "0.65"))
# Cap on kept representatives, as a fraction of the person's total labeled faces.
# Normally one representative per cluster is far below this; it only bites when
# a very prolific person's faces are unusually diverse (many small clusters),
# in which case only the largest (most-repeated) clusters keep a representative.
FACE_DEDUP_MAX_FRACTION = float(os.environ.get("GEOTAGGER_FACE_DEDUP_MAX_FRACTION", "0.10"))

# ── Large Crowd management ──
# Photos with at least this many detected faces are treated as crowd photos.
FACE_CROWD_MIN_SIZE = int(os.environ.get("GEOTAGGER_FACE_CROWD_MIN_SIZE", "50"))

# ── Unsupervised face clustering ("Discover" view) ──
# Cosine similarity at/above which two unlabeled faces are linked into one group.
# Tighter = purer groups; looser = more merging (and more risk of chaining).
FACE_CLUSTER_THRESHOLD = float(os.environ.get("GEOTAGGER_FACE_CLUSTER_THRESHOLD", "0.65"))
# Groups smaller than this are dropped as noise (strangers / one-off detections).
FACE_CLUSTER_MIN_SIZE = int(os.environ.get("GEOTAGGER_FACE_CLUSTER_MIN_SIZE", "3"))
# Cluster at most this many highest-detection-score unlabeled faces, to stay fast.
FACE_CLUSTER_CAP = int(os.environ.get("GEOTAGGER_FACE_CLUSTER_CAP", "10000"))

# ── Age-aware recognition (uses person birth/not_before/not_after dates + photo dates) ──
# A dated photo taken more than this many years before a person's birth, or
# outside their not_before/not_after window by more than this, excludes that
# person from suggestions (grace absorbs date/clock imprecision).
FACE_BIRTH_TOLERANCE_YEARS = float(os.environ.get("GEOTAGGER_FACE_BIRTH_TOLERANCE_YEARS", "0.5"))
# Cosine penalty per year of age gap between an unknown face and a labeled
# example (prefers same-age examples), capped to avoid dominating the score.
FACE_AGE_PENALTY_PER_YEAR = float(os.environ.get("GEOTAGGER_FACE_AGE_PENALTY_PER_YEAR", "0.02"))
FACE_AGE_PENALTY_CAP_YEARS = float(os.environ.get("GEOTAGGER_FACE_AGE_PENALTY_CAP_YEARS", "10"))
# ONNX Runtime execution providers (comma-separated, in preference order). The
# default tries CUDA first: onnxruntime-gpu falls back to the next provider in the
# list (with a warning) when CUDA can't load, so CPU-only machines still work.
# Set "CPUExecutionProvider" alone to force CPU.
_DEFAULT_ONNX_PROVIDERS = "CUDAExecutionProvider,CPUExecutionProvider"


def _providers(env_name: str) -> list[str]:
    return [p.strip() for p in os.environ.get(env_name, _DEFAULT_ONNX_PROVIDERS).split(",")
            if p.strip()]


FACE_PROVIDERS = _providers("GEOTAGGER_FACE_PROVIDERS")

# ── Semantic (text → photo) search ──
# SigLIP 2 image/text embeddings, run on onnxruntime from Immich's pre-exported ONNX
# files (see docs/SEMANTIC_SEARCH_PLAN.md §2 for the benchmark behind this choice).
# The name is stored with every vector, so switching models (e.g. to the faster
# "ViT-B-32-SigLIP2-256__webli") just marks everything as needing re-indexing.
SEMANTIC_MODEL_NAME = os.environ.get("GEOTAGGER_SEMANTIC_MODEL", "ViT-B-16-SigLIP2__webli")
# Base URL the one-shot Data Management download fetches the model files from;
# "{name}" is replaced with SEMANTIC_MODEL_NAME.
SEMANTIC_MODEL_URL = os.environ.get(
    "GEOTAGGER_SEMANTIC_MODEL_URL", "https://huggingface.co/immich-app/{name}/resolve/main/")
SEMANTIC_PROVIDERS = _providers("GEOTAGGER_SEMANTIC_PROVIDERS")
# Text→image cosine cutoff. Measured on the prototype's hand-labeled set: 0.08 keeps
# 99% of relevant photos but passes 6.8% of irrelevant ones; 0.10 keeps 92% / passes
# 2.4%. Results are ranked, so the noise that does pass sinks to the bottom.
SEMANTIC_MIN_SCORE = float(os.environ.get("GEOTAGGER_SEMANTIC_MIN_SCORE", "0.09"))
# Image→image ("More like this") cosine cutoff — a different scale entirely: on
# the sample set the median of *all* photo pairs is 0.64, so 0.5 matched nearly
# everything. 0.8 kept 83% of same-subject pairs while passing 14% of all pairs.
SEMANTIC_SIMILAR_MIN_SCORE = float(os.environ.get("GEOTAGGER_SEMANTIC_SIMILAR_MIN_SCORE", "0.8"))

# ── Work queue (Home's ranked list of untagged batches) ──
# Biggest gap between consecutive shots from one camera that still counts as the
# same outing. 4 h splits a wedding from a reception at another venue (wanted)
# but also splits a long road-trip day (see docs/work-queue.md §9).
WORKQUEUE_SESSION_GAP = int(os.environ.get("GEOTAGGER_WORKQUEUE_SESSION_GAP", str(4 * 3600)))
# A directory becomes a folder batch only when at least this fraction of the
# photos in it are still untagged — a folder that's mostly done is not one decision.
WORKQUEUE_FOLDER_MIN_FRAC = float(os.environ.get("GEOTAGGER_WORKQUEUE_FOLDER_MIN_FRAC", "0.8"))
# Batches smaller than this never reach the queue; the long tail stays the month
# picker's job. Home reports how many photos fell into that tail so the numbers add up.
WORKQUEUE_MIN_SIZE = int(os.environ.get("GEOTAGGER_WORKQUEUE_MIN_SIZE", "5"))

# ── Runtime-tunable settings (in-app Settings page) ──
# The subset of knobs above that are safe to change without a restart: pure
# post-hoc math over already-computed embeddings/scores, not baked into a
# loaded model (unlike FACE_DET_THRESHOLD/FACE_DET_SIZE/FACE_MODEL_NAME/
# FACE_PROVIDERS, which only take effect when the InsightFace pipeline is
# (re)built, so they stay env-only). Persisted overrides live in the DB
# `settings` table and are (re)applied on top of the env default at startup
# via apply_all_overrides(); consumers must read these via `config.KEY`
# (module-attribute access) rather than `from geotagger.config import KEY`,
# since only the module's own attribute gets mutated when a setting changes.
SETTINGS_SPEC = [
    {"key": "WRITE_XMP_ON_GEOTAG", "type": "bool",
     "group": "Geotagging", "label": "Write GPS to XMP sidecar immediately",
     "help": "When on, placing/editing a geotag writes GPS coordinates into the XMP sidecar right away. When off (default), geotags are stored in the database only — use the sidecar export action to catch sidecars up on demand."},
    {"key": "WORKQUEUE_SESSION_GAP", "type": "int", "min": 600, "max": 172800, "step": 600,
     "group": "Work queue", "label": "Session gap (seconds)",
     "help": "Longest gap between consecutive shots from one camera that still counts as the same outing (14400 = 4 hours). Shorter splits a wedding from the reception at another venue; longer keeps a whole road-trip day together."},
    {"key": "WORKQUEUE_FOLDER_MIN_FRAC", "type": "float", "min": 0.1, "max": 1.0, "step": 0.05,
     "group": "Work queue", "label": "Folder batch threshold",
     "help": "How much of a directory must still be untagged before the folder itself becomes a batch. 0.8 keeps a scanned folder with a few phone photos mixed in; 1.0 means only wholly untagged folders."},
    {"key": "WORKQUEUE_MIN_SIZE", "type": "int", "min": 1, "max": 500, "step": 1,
     "group": "Work queue", "label": "Minimum batch size",
     "help": "Batches smaller than this never reach the queue — the long tail stays the month picker's job. Home still counts those photos so the numbers add up."},
    {"key": "RAW_FULL_DECODE", "type": "bool",
     "group": "RAW photos", "label": "Full RAW decode",
     "help": "Fully demosaic RAW files (NEF/DNG) to a JPEG via LibRaw for the served preview and face detection, instead of the embedded preview. Higher quality but much slower; off uses the fast embedded preview."},
    {"key": "FACE_DECODE_MAX_DIM", "type": "int", "min": 640, "max": 8000, "step": 100,
     "group": "RAW photos", "label": "Face-detect decode size (px)",
     "help": "When full RAW decode is on, the long edge the RAW is downscaled to for face detection (the served preview stays at the preview size). Recorded per-photo so low-res scans can be re-run later."},
    {"key": "FACE_MATCH_THRESHOLD", "type": "float", "min": 0.1, "max": 0.9, "step": 0.01,
     "group": "Face recognition", "label": "Match threshold",
     "help": "Cosine similarity required to accept a suggested identity. Lower finds more matches but more false positives."},
    {"key": "FACE_AMBIGUITY_MARGIN", "type": "float", "min": 0.0, "max": 0.3, "step": 0.01,
     "group": "Face recognition", "label": "Ambiguity margin",
     "help": "A second candidate scoring within this margin of the top match is flagged as an alternative (e.g. look-alike siblings)."},
    {"key": "FACE_SUGGEST_MIN_DET_SCORE", "type": "float", "min": 0.0, "max": 1.0, "step": 0.05,
     "group": "Face recognition", "label": "Suggestion min detection score",
     "help": "Faces detected below this confidence are never offered as a suggestion (still detected and taggable by hand). 0 disables the floor."},
    {"key": "FACE_MIN_GALLERY_BBOX_AREA", "type": "float", "min": 0.0, "max": 0.5, "step": 0.005,
     "group": "Face recognition", "label": "Min gallery bbox area",
     "help": "Labeled faces whose bounding box is smaller than this fraction of the image are excluded as match sources (still labeled and taggable by hand). 0 disables the floor."},
    {"key": "FACE_PRESELECT_MIN_SCORE", "type": "float", "min": 0.1, "max": 0.95, "step": 0.01,
     "group": "Face recognition", "label": "Unlabeled queue pre-select score",
     "help": "On the Unlabeled queue, suggestions scoring at/above this are pre-checked for bulk-assign; weaker ones are shown but left unchecked for manual review."},
    {"key": "FACE_QUERY_LIMIT", "type": "int", "min": 100, "max": 20000, "step": 100,
     "group": "Face recognition", "label": "People page grid size",
     "help": "Max faces fetched per load in the People page grid (any scope). Higher shows more at once but is slower to render."},
    {"key": "FACE_SUGGEST_SCAN_CAP", "type": "int", "min": 0, "max": 200000, "step": 100,
     "group": "Face recognition", "label": "Suggestion scan cap",
     "help": "Max unlabeled faces scanned when gathering guesses. 0 = exhaustive."},
    {"key": "FACE_GATE_MAX_EXAMPLES", "type": "int", "min": 10, "max": 2000, "step": 10,
     "group": "Face recognition", "label": "Gate max examples per person",
     "help": "Caps how many of a person's labeled examples are used in the cheap first pass when reviewing their guesses."},
    {"key": "FACE_CROWD_MIN_SIZE", "type": "int", "min": 2, "max": 500, "step": 1,
     "group": "Face recognition", "label": "Crowd photo min faces",
     "help": "Photos with at least this many detected faces are treated as crowd photos."},
    {"key": "FACE_DEDUP_MIN_FACES", "type": "int", "min": 5, "max": 5000, "step": 5,
     "group": "Representative faces", "label": "Min labeled faces to dedup",
     "help": "Only people with at least this many labeled faces get clustered into representatives; smaller label sets are left entirely representative."},
    {"key": "FACE_DEDUP_THRESHOLD", "type": "float", "min": 0.3, "max": 0.95, "step": 0.01,
     "group": "Representative faces", "label": "Cluster threshold",
     "help": "Cosine similarity at/above which two of one person's labeled faces are treated as the same look and clustered together."},
    {"key": "FACE_DEDUP_MAX_FRACTION", "type": "float", "min": 0.01, "max": 1.0, "step": 0.01,
     "group": "Representative faces", "label": "Max representative fraction",
     "help": "Cap on kept representatives as a fraction of a person's total labeled faces. Only bites when someone's faces are unusually diverse (many small clusters)."},
    {"key": "FACE_CLUSTER_THRESHOLD", "type": "float", "min": 0.3, "max": 0.95, "step": 0.01,
     "group": "Face clustering (Discover)", "label": "Cluster threshold",
     "help": "Cosine similarity at/above which two unlabeled faces are linked into one group. Tighter = purer groups, looser = more chaining."},
    {"key": "FACE_CLUSTER_MIN_SIZE", "type": "int", "min": 2, "max": 50, "step": 1,
     "group": "Face clustering (Discover)", "label": "Cluster min size",
     "help": "Groups smaller than this are dropped as noise."},
    {"key": "FACE_CLUSTER_CAP", "type": "int", "min": 0, "max": 200000, "step": 500,
     "group": "Face clustering (Discover)", "label": "Cluster scan cap",
     "help": "Cluster at most this many highest-confidence unlabeled faces, to stay fast. 0 = no cap."},
    {"key": "FACE_BIRTH_TOLERANCE_YEARS", "type": "float", "min": 0.0, "max": 5.0, "step": 0.1,
     "group": "Age-aware matching", "label": "Date-bound tolerance (years)",
     "help": "A dated photo taken more than this many years before a person's birth, or outside their not-before/not-after window, excludes them from suggestions."},
    {"key": "FACE_AGE_PENALTY_PER_YEAR", "type": "float", "min": 0.0, "max": 0.2, "step": 0.005,
     "group": "Age-aware matching", "label": "Age penalty per year",
     "help": "Cosine penalty per year of age gap between an unknown face and a labeled example."},
    {"key": "FACE_AGE_PENALTY_CAP_YEARS", "type": "float", "min": 0.0, "max": 50.0, "step": 1.0,
     "group": "Age-aware matching", "label": "Age penalty cap (years)",
     "help": "Maximum age gap (in years) the penalty above scales with."},
    {"key": "SEMANTIC_MIN_SCORE", "type": "float", "min": 0.0, "max": 0.3, "step": 0.005,
     "group": "Text search", "label": "Minimum text-match score",
     "help": "Photos scoring below this against a typed description are dropped. Lower = more results, more noise. SigLIP scores are small: relevant photos are typically 0.10–0.15."},
    {"key": "SEMANTIC_SIMILAR_MIN_SCORE", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01,
     "group": "Text search", "label": "\"More like this\" minimum similarity",
     "help": "Photo-to-photo similarity required for \"More like this\" results. Image-to-image scores run much higher than text-to-image."},
]

# Snapshot of the env-resolved value for each tunable, captured before any DB
# override is applied — lets the settings page show/restore "default".
SETTINGS_DEFAULTS = {spec["key"]: globals()[spec["key"]] for spec in SETTINGS_SPEC}


def _coerce_setting(key: str, raw) -> float | int | bool:
    spec = next(s for s in SETTINGS_SPEC if s["key"] == key)
    if spec["type"] == "bool":
        # Accept a checkbox's 1/0, a JSON bool, or an env-style "true"/"on" string.
        # Bools carry no min/max in the spec, so there is nothing to range-check.
        if isinstance(raw, str):
            return raw.strip().lower() in ("1", "true", "yes", "on")
        return bool(raw)
    value = float(raw) if spec["type"] == "float" else int(raw)
    if not (spec["min"] <= value <= spec["max"]):
        raise ValueError(f"{key} must be between {spec['min']} and {spec['max']}")
    return value


def apply_setting_override(key: str, raw) -> float | int | bool:
    """Validate, coerce, and apply one setting to this module's live attribute
    (visible to every consumer that reads it as `config.KEY`). Returns the
    coerced value so the caller can persist/report it."""
    value = _coerce_setting(key, raw)
    globals()[key] = value
    return value


def apply_all_overrides(overrides: dict[str, str]):
    """Apply every stored override at startup. Silently keeps the env default
    for a row that's missing, unknown, or fails validation (e.g. a spec's
    min/max changed since the value was saved)."""
    for key, raw in overrides.items():
        if key in SETTINGS_DEFAULTS:
            try:
                apply_setting_override(key, raw)
            except (ValueError, TypeError):
                pass


def reset_setting(key: str):
    """Restore one setting to its env-resolved default."""
    globals()[key] = SETTINGS_DEFAULTS[key]
