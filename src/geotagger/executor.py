"""Shared thread pool for blocking request work (thumbnailing, ExifTool, face
detection, geocoding, sidecar writes). Follows the module-singleton + lazy-getter
shape used by index.get_db() / exiftool_session.get_et(): a module global, an
init_* that populates it, and a get_* that raises if unset."""

from concurrent.futures import ThreadPoolExecutor

_executor: ThreadPoolExecutor | None = None


def init_executor(max_workers: int = 4) -> ThreadPoolExecutor:
    """Create the shared request executor. Called once from the app lifespan."""
    global _executor
    _executor = ThreadPoolExecutor(max_workers=max_workers)
    return _executor


def get_executor() -> ThreadPoolExecutor:
    if _executor is None:
        raise RuntimeError("Executor not initialized — call init_executor first")
    return _executor
