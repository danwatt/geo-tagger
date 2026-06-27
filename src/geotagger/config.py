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

# Supported file extensions
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".heic", ".heif", ".nef", ".dng", ".tif", ".tiff", ".png"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi"}
ALL_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS

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
# Max unlabeled faces to scan when gathering a person's guesses (scope=suggested).
FACE_SUGGEST_SCAN_CAP = int(os.environ.get("GEOTAGGER_FACE_SUGGEST_SCAN_CAP", "5000"))
# When reviewing one person's guesses, another person whose own best example
# scores within this cosine margin of the top match is flagged as an ambiguous
# alternative ("could be this family member instead") — a near-tie, not a clear win.
FACE_AMBIGUITY_MARGIN = float(os.environ.get("GEOTAGGER_FACE_AMBIGUITY_MARGIN", "0.05"))

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
