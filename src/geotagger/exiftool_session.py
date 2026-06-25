from contextlib import asynccontextmanager
import threading
import exiftool
from geotagger.config import EXIFTOOL_PATH

_et: exiftool.ExifToolHelper | None = None
_et_error: str | None = None
_et_lock = threading.Lock()


def get_et() -> exiftool.ExifToolHelper:
    if _et_error:
        raise RuntimeError(f"ExifTool unavailable: {_et_error}")
    if _et is None:
        raise RuntimeError("ExifTool session not started")
    return _et


def get_et_lock() -> threading.Lock:
    """Get the lock for thread-safe ExifTool access."""
    return _et_lock


def exiftool_status() -> dict:
    if _et_error:
        return {"ok": False, "error": _et_error}
    if _et is None:
        return {"ok": False, "error": "not started"}
    return {"ok": True}


@asynccontextmanager
async def lifespan(app):
    global _et, _et_error
    try:
        _et = exiftool.ExifToolHelper(executable=EXIFTOOL_PATH)
        version = _et.execute("-ver").strip()
        print(f"ExifTool {version} ready ({EXIFTOOL_PATH})")
    except FileNotFoundError:
        _et = None
        _et_error = (
            f"ExifTool binary not found at '{EXIFTOOL_PATH}'. "
            "Run: uv run python scripts/get_exiftool.py"
        )
        print(f"WARNING: {_et_error}")
    except Exception as e:
        _et = None
        _et_error = str(e)
        print(f"WARNING: ExifTool startup failed: {e}")
    yield
    if _et is not None:
        _et.terminate()
        _et = None
