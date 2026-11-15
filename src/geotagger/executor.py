"""Thread pools for blocking work, in two separate singletons:

- the **request executor** (`get_executor()`): short, awaited request work —
  thumbnailing, ExifTool, face detection batches, geocoding, sidecar writes;
- the **jobs executor** (`get_jobs_executor()`): fire-and-forget background
  jobs that can run for minutes — dataset and model downloads/builds, the
  on-demand street search. Kept apart (audit A7) so four jobs started from the
  Data page can't occupy every request worker and freeze the rest of the UI. It
  is deliberately small (GEOTAGGER_JOB_WORKERS, default 2): extra jobs wait their
  turn, and their status says "queued" meanwhile (services/_jobs.py).

Both follow the module-singleton + lazy-getter shape used by index.get_db() /
exiftool_session.get_et(): a module global, an init_* that populates it, and a
get_* that raises if unset."""

import threading
from concurrent.futures import ThreadPoolExecutor

_executor: ThreadPoolExecutor | None = None
_jobs_executor: ThreadPoolExecutor | None = None

# How long shutdown waits for work that is already running. Request work is
# normally finished by now (uvicorn drains in-flight requests before running
# lifespan shutdown); what can remain is a background job such as a dataset or
# model download, which can run for many minutes.
SHUTDOWN_GRACE_SECONDS = 5.0


def init_executor(max_workers: int = 4) -> ThreadPoolExecutor:
    """Create the shared request executor. Called once from the app lifespan."""
    global _executor
    _executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="geotagger-req")
    return _executor


def get_executor() -> ThreadPoolExecutor:
    if _executor is None:
        raise RuntimeError("Executor not initialized — call init_executor first")
    return _executor


def init_jobs_executor(max_workers: int = 2) -> ThreadPoolExecutor:
    """Create the background-jobs executor. Called once from the app lifespan."""
    global _jobs_executor
    _jobs_executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="geotagger-job")
    return _jobs_executor


def get_jobs_executor() -> ThreadPoolExecutor:
    if _jobs_executor is None:
        raise RuntimeError("Jobs executor not initialized — call init_jobs_executor first")
    return _jobs_executor


def _shutdown_pool(ex: ThreadPoolExecutor | None, grace_seconds: float) -> bool:
    """Stop `ex`, waiting at most `grace_seconds` for running work. Returns True
    if every worker has finished.

    Queued work is cancelled rather than run: at shutdown nobody is left to
    receive its results. Running work can't be interrupted, so it gets a bounded
    wait instead of `shutdown(wait=True)` — an unbounded wait would make Ctrl-C
    hang for as long as the slowest job (a multi-GB download). A job that
    outlives the grace period keeps its thread; the interpreter still joins
    worker threads at exit, as it always has.
    """
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


def shutdown_executor(grace_seconds: float = SHUTDOWN_GRACE_SECONDS) -> bool:
    """Stop the shared request executor. Returns True if every worker has
    finished, i.e. it is safe to close what the work uses (the DB); False if
    something was still running when the grace period ran out. Blocking (up to
    `grace_seconds`)."""
    global _executor
    ex = _executor
    _executor = None  # get_executor() raises from here on: no new submissions
    return _shutdown_pool(ex, grace_seconds)


def shutdown_jobs_executor(grace_seconds: float = SHUTDOWN_GRACE_SECONDS) -> bool:
    """Stop the background-jobs executor; same contract as shutdown_executor.
    Queued jobs are cancelled; a running download that outlasts the grace period
    is reported (False) rather than waited for."""
    global _jobs_executor
    ex = _jobs_executor
    _jobs_executor = None
    return _shutdown_pool(ex, grace_seconds)
