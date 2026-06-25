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
