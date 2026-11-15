"""Submitting a background job (download, build, street search) to the jobs
executor with a "queued" phase in its status.

Every job module keeps its own `_job` dict + lock (data_service, semantic_service,
streets_service). `running` goes True when the job is *accepted* — that is what the
409 "already running" check and the UI's polling loops key on — but the jobs
executor is small (config.JOB_WORKERS), so an accepted job may wait for a worker.
`queued` says which of the two it is, and the message says so in words, so a job
waiting behind another doesn't look frozen (audit A7). Framework-free."""

import threading
from collections.abc import Callable
from concurrent.futures import Executor

QUEUED_MESSAGE = "Queued — waiting for another background job to finish…"


def accept(lock: threading.Lock, job: dict, **fields) -> bool:
    """Mark `job` accepted (running + queued) unless one is already in flight.
    Returns False if it is. `fields` reset the job's other keys for the new run."""
    with lock:
        if job["running"]:
            return False
        job.update(fields)
        job.update(running=True, queued=True, done=False, error=None, message=QUEUED_MESSAGE)
    return True


def submit(executor: Executor, lock: threading.Lock, job: dict,
           fn: Callable, *args, start_message: str = "Starting…") -> None:
    """Run fn(*args) on `executor`, flipping `job` from queued to started the
    moment a worker picks it up. `fn` owns the rest of the job's lifecycle
    (messages, done/error, and clearing `running` when it ends).

    If the submit itself fails (the executor is shutting down), or the job is
    cancelled before it started, the job is un-accepted so it doesn't sit at
    "running" forever."""
    def run():
        with lock:
            job["queued"] = False
            job["message"] = start_message
        fn(*args)

    def unaccept():
        with lock:
            job.update(running=False, queued=False)

    try:
        fut = executor.submit(run)
    except Exception:
        unaccept()
        raise
    # Shutdown cancels jobs still queued (executor._shutdown_pool); one that never
    # started must not be left claiming to run.
    fut.add_done_callback(lambda f: unaccept() if f.cancelled() else None)
