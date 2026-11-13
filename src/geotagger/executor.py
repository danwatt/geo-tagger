"""Shared thread pool for blocking request work (thumbnailing, ExifTool, face
detection, geocoding, sidecar writes). Follows the module-singleton + lazy-getter
shape used by index.get_db() / exiftool_session.get_et(): a module global, an
init_* that populates it, and a get_* that raises if unset."""

import threading
from concurrent.futures import ThreadPoolExecutor

_executor: ThreadPoolExecutor | None = None

# How long shutdown waits for jobs that are already running. Request work is
# normally finished by now (uvicorn drains in-flight requests before running
# lifespan shutdown); what can remain is a fire-and-forget job such as a dataset
# or model download, which can run for many minutes.
SHUTDOWN_GRACE_SECONDS = 5.0


def init_executor(max_workers: int = 4) -> ThreadPoolExecutor:
    """Create the shared request executor. Called once from the app lifespan."""
    global _executor
    _executor = ThreadPoolExecutor(max_workers=max_workers)
    return _executor


def get_executor() -> ThreadPoolExecutor:
    if _executor is None:
        raise RuntimeError("Executor not initialized — call init_executor first")
    return _executor


def shutdown_executor(grace_seconds: float = SHUTDOWN_GRACE_SECONDS) -> bool:
    """Stop the shared executor. Returns True if every worker has finished, i.e.
    it is safe to close what the jobs use (the DB); False if a job was still
    running when the grace period ran out. Blocking (up to `grace_seconds`).

    Queued jobs are cancelled rather than run: at shutdown nobody is left to
    receive their results. Running jobs can't be interrupted, so they get a
    bounded wait instead of `shutdown(wait=True)` — an unbounded wait would make
    Ctrl-C hang for as long as the slowest job (a multi-GB download). A job that
    outlives the grace period keeps its thread; the interpreter still joins
    worker threads at exit, as it always has.
    """
    global _executor
    ex = _executor
    _executor = None  # get_executor() raises from here on: no new submissions
    if ex is None:
        return True
    ex.shutdown(wait=False, cancel_futures=True)
    # ThreadPoolExecutor has no timed join, so do the blocking wait in a daemon
    # thread and give up on *that* after the grace period.
    waiter = threading.Thread(target=ex.shutdown, kwargs={"wait": True},
                              name="executor-shutdown", daemon=True)
    waiter.start()
    waiter.join(grace_seconds)
    return not waiter.is_alive()
