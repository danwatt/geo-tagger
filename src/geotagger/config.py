import os
from pathlib import Path

# Project root (two levels up from this file: src/geotagger/ -> src/ -> project/)
_PROJECT_ROOT = Path(__file__).parent.parent.parent

# ExifTool binary resolution: env var > tools/exiftool.exe > PATH
def get_exiftool_path() -> str:
    if env := os.environ.get("GEOTAGGER_EXIFTOOL"):
        return env
    bundled = _PROJECT_ROOT / "tools" / "exiftool.exe"
    if bundled.exists():
        return str(bundled)
    return "exiftool"

EXIFTOOL_PATH: str = get_exiftool_path()

# Cache directory: can be absolute path or relative to scanned root
# If GEOTAGGER_CACHE_DIR is set, use that as an absolute path
# Otherwise, use CACHE_DIR_NAME relative to the scanned root
def get_cache_dir() -> Path | None:
    """Get the cache directory from environment, if set."""
    cache_dir_env = os.environ.get("GEOTAGGER_CACHE_DIR")
    return Path(cache_dir_env) if cache_dir_env else None

CACHE_DIR_NAME = ".geotagger"  # Used when get_cache_dir() returns None

# Thumbnail and preview dimensions
THUMB_SIZE = 256
PREVIEW_SIZE = 1600

# Sidecar naming: "basename" -> IMG.NEF uses IMG.xmp
#                 "fullname" -> IMG.NEF uses IMG.NEF.xmp
SIDECAR_MODE = os.environ.get("GEOTAGGER_SIDECAR_MODE", "basename")  # or "fullname"

# ── Reverse geocoding (offline, GeoNames) ──
# Directory holding the GeoNames data files (cities500.txt, admin1CodesASCII.txt,
# admin2Codes.txt, countryInfo.txt). Download them with:
#     uv run python scripts/get_geonames.py
def get_geonames_dir() -> Path:
    if env := os.environ.get("GEOTAGGER_GEONAMES_DIR"):
        return Path(env)
    return _PROJECT_ROOT / "data" / "geonames"

GEONAMES_DIR: Path = get_geonames_dir()

# Coordinates are quantized to this many decimal degrees before a reverse-geocode
# lookup, so nearby photos share one cached result. 4 decimals ≈ 11 m at the
# equator (and less at higher latitudes) — fine for city/state/country tagging.
GEOCODE_PRECISION = int(os.environ.get("GEOTAGGER_GEOCODE_PRECISION", "4"))

# ── OSM places (offline, polygon reverse geocoding) ──
# SQLite DB of OSM area polygons (cities, parks, stadiums, campuses, neighborhoods,
# named buildings) built from GeoFabrik .osm.pbf extract(s) with:
#     uv run python scripts/build_osm_places.py <region>.osm.pbf
# When present, polygon containment is the source of a photo's city + sub-location
# (see osm_places.py); GeoNames then only supplies state/county/country.
def get_osm_db() -> Path:
    if env := os.environ.get("GEOTAGGER_OSM_DB"):
        return Path(env)
    return _PROJECT_ROOT / "data" / "osm" / "places.sqlite"

OSM_DB_PATH: Path = get_osm_db()

# When True, fall back to the GeoNames nearest-city name for photos that fall
# outside every OSM city polygon (e.g. rural areas, or a region not yet ingested).
# Default True: OSM cities still take priority wherever a photo falls inside one,
# but a coordinate outside every ingested OSM polygon still gets a usable city
# instead of "(none)" — the common case while OSM coverage is only ever a
# handful of imported regions. Set to "0" for strict "OSM replaces city" (no
# fallback) once your imported regions cover the whole library and "(none)"
# should mean "genuinely outside my library's area."
OSM_CITY_FALLBACK_GEONAMES = os.environ.get("GEOTAGGER_OSM_CITY_FALLBACK_GEONAMES", "1") == "1"

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

# ── Age-aware recognition (uses person birth dates + photo dates) ──
# A dated photo taken more than this many years before a person's birth excludes
# that person from suggestions (grace absorbs birth/clock imprecision).
FACE_BIRTH_TOLERANCE_YEARS = float(os.environ.get("GEOTAGGER_FACE_BIRTH_TOLERANCE_YEARS", "0.5"))
# Cosine penalty per year of age gap between an unknown face and a labeled
# example (prefers same-age examples), capped to avoid dominating the score.
FACE_AGE_PENALTY_PER_YEAR = float(os.environ.get("GEOTAGGER_FACE_AGE_PENALTY_PER_YEAR", "0.02"))
FACE_AGE_PENALTY_CAP_YEARS = float(os.environ.get("GEOTAGGER_FACE_AGE_PENALTY_CAP_YEARS", "10"))
# ONNX Runtime execution providers (comma-separated). Default CPU everywhere.
FACE_PROVIDERS = [
    p.strip() for p in
    os.environ.get("GEOTAGGER_FACE_PROVIDERS", "CPUExecutionProvider").split(",")
    if p.strip()
]

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
    {"key": "FACE_SUGGEST_SCAN_CAP", "type": "int", "min": 0, "max": 200000, "step": 100,
     "group": "Face recognition", "label": "Suggestion scan cap",
     "help": "Max unlabeled faces scanned when gathering guesses. 0 = exhaustive."},
    {"key": "FACE_GATE_MAX_EXAMPLES", "type": "int", "min": 10, "max": 2000, "step": 10,
     "group": "Face recognition", "label": "Gate max examples per person",
     "help": "Caps how many of a person's labeled examples are used in the cheap first pass when reviewing their guesses."},
    {"key": "FACE_CROWD_MIN_SIZE", "type": "int", "min": 2, "max": 500, "step": 1,
     "group": "Face recognition", "label": "Crowd photo min faces",
     "help": "Photos with at least this many detected faces are treated as crowd photos."},
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
     "group": "Age-aware matching", "label": "Birth-date tolerance (years)",
     "help": "A dated photo taken more than this many years before a person's birth excludes them from suggestions."},
    {"key": "FACE_AGE_PENALTY_PER_YEAR", "type": "float", "min": 0.0, "max": 0.2, "step": 0.005,
     "group": "Age-aware matching", "label": "Age penalty per year",
     "help": "Cosine penalty per year of age gap between an unknown face and a labeled example."},
    {"key": "FACE_AGE_PENALTY_CAP_YEARS", "type": "float", "min": 0.0, "max": 50.0, "step": 1.0,
     "group": "Age-aware matching", "label": "Age penalty cap (years)",
     "help": "Maximum age gap (in years) the penalty above scales with."},
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
