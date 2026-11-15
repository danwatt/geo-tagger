"""Audit A7: background jobs (dataset/model downloads, the street search) run on
their own small executor, not the shared request executor — so starting every
job on the Data page can't occupy every request worker and freeze the UI — and
a job waiting for a jobs worker reports "queued" instead of looking frozen.

The real runners reach the network, so each is swapped for a stub that blocks
until released and does the same end-of-job bookkeeping the real one does."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from geotagger import config, executor
from geotagger.services import _jobs, data_service, semantic_service

# name: (POST url, POST body, status url, module, job global, runner global, lock global)
_JOBS = {
    "geonames": ("/api/data/geonames/download", {}, "/api/data/geonames/download/status",
                 data_service, "_geonames_job", "_run_geonames_download", "_geonames_lock"),
    "census": ("/api/data/census/download", {}, "/api/data/census/download/status",
               data_service, "_census_job", "_run_census_download", "_census_lock"),
    "face_model": ("/api/data/face-model/download", {}, "/api/data/face-model/download/status",
                   data_service, "_face_model_job", "_run_face_model_download", "_face_model_lock"),
    "semantic_model": ("/api/data/semantic-model/download", {},
                       "/api/data/semantic-model/download/status",
                       semantic_service, "_dl_job", "_run_model_download", "_dl_lock"),
}


def _wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def stub_jobs(monkeypatch):
    """Replace every job runner with a stub that records its thread name and
    blocks on `release`. Fresh job dicts, so no state leaks between tests."""
    release = threading.Event()
    threads: dict[str, str] = {}

    for name, (_u, _b, _s, mod, job_attr, runner_attr, lock_attr) in _JOBS.items():
        monkeypatch.setattr(mod, job_attr, {"running": False, "queued": False, "done": False,
                                            "error": None, "message": "", "result": None})

        def runner(*_args, name=name, mod=mod, job_attr=job_attr, lock_attr=lock_attr):
            threads[name] = threading.current_thread().name
            try:
                release.wait(10)
            finally:
                with getattr(mod, lock_attr):
                    getattr(mod, job_attr).update(running=False, done=True, message="Done")

        monkeypatch.setattr(mod, runner_attr, runner)
    yield release, threads
    release.set()


def test_jobs_run_on_the_jobs_executor_not_the_request_one(client, stub_jobs):
    release, threads = stub_jobs
    post, body, status, *_ = _JOBS["geonames"]
    try:
        assert client.post(post, json=body).status_code == 200
        assert _wait_for(lambda: "geonames" in threads)
        assert threads["geonames"].startswith("geotagger-job")
        assert client.get(status).json()["queued"] is False
    finally:
        release.set()
    assert _wait_for(lambda: client.get(status).json()["done"])


def test_requests_stay_responsive_while_every_job_is_running(client, stub_jobs):
    """The audit's repro: start all four downloads. With them on the request
    executor this occupied every worker and any run_in_executor request hung;
    now a request using the request executor still completes promptly."""
    release, threads = stub_jobs
    try:
        for name, (post, body, *_rest) in _JOBS.items():
            assert client.post(post, json=body).status_code == 200, name
        # JOB_WORKERS run at once; the rest wait their turn.
        assert _wait_for(lambda: len(threads) == min(config.JOB_WORKERS, len(_JOBS)))

        result: dict = {}

        def request():
            # /api/semantic/status runs on the request executor.
            result["status"] = client.get("/api/semantic/status").status_code

        t = threading.Thread(target=request, name="a7-probe")
        t.start()
        t.join(5)
        assert not t.is_alive(), "request hung behind the background jobs"
        assert result["status"] == 200
    finally:
        release.set()
    for name, (_p, _b, status, *_rest) in _JOBS.items():
        assert _wait_for(lambda status=status: client.get(status).json()["done"]), name
    assert all(n.startswith("geotagger-job") for n in threads.values())


def test_waiting_job_reports_queued_then_running(client, stub_jobs):
    """More jobs than jobs workers: the extra one is accepted (running, so a
    second click still gets 409) but says it is queued until a worker frees up."""
    release, threads = stub_jobs
    names = list(_JOBS)[: config.JOB_WORKERS + 1]
    try:
        for name in names:
            post, body, *_ = _JOBS[name]
            assert client.post(post, json=body).status_code == 200
        assert _wait_for(lambda: len(threads) == config.JOB_WORKERS)
        waiting = next(n for n in names if n not in threads)
        post, body, status, *_ = _JOBS[waiting]
        job = client.get(status).json()
        assert job["running"] is True and job["queued"] is True
        assert job["message"] == _jobs.QUEUED_MESSAGE
        assert client.post(post, json=body).status_code == 409
    finally:
        release.set()
    assert _wait_for(lambda: waiting in threads)
    assert _wait_for(lambda: client.get(status).json()["done"])
    assert client.get(status).json()["queued"] is False


class TestQueuedWithOneWorker:
    """Service level, on a private 1-worker pool: the exact queued -> started ->
    done sequence, and a queued job cancelled at shutdown un-claims itself."""

    @pytest.fixture
    def pool(self):
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="geotagger-job")
        yield pool
        pool.shutdown(wait=True, cancel_futures=True)

    def test_second_job_queues_until_the_first_ends(self, pool):
        lock = threading.Lock()
        first = {"running": False}
        second = {"running": False}
        release, started = threading.Event(), []

        def body(job, name):
            started.append(name)
            if name == "first":
                release.wait(10)
            with lock:
                job.update(running=False, done=True)

        assert _jobs.accept(lock, first) and _jobs.accept(lock, second)
        _jobs.submit(pool, lock, first, body, first, "first")
        _jobs.submit(pool, lock, second, body, second, "second")
        assert _wait_for(lambda: started == ["first"])
        assert first["queued"] is False and first["message"] == "Starting…"
        assert second == {"running": True, "queued": True, "done": False, "error": None,
                          "message": _jobs.QUEUED_MESSAGE}
        assert not _jobs.accept(lock, second)              # still the 409 case
        release.set()
        assert _wait_for(lambda: second.get("done"))
        assert started == ["first", "second"] and second["queued"] is False

    def test_queued_job_cancelled_at_shutdown_is_unclaimed(self, pool):
        lock = threading.Lock()
        first, second = {"running": False}, {"running": False}
        release, started = threading.Event(), threading.Event()

        def blocker():
            started.set()
            release.wait(10)

        try:
            _jobs.accept(lock, first)
            _jobs.submit(pool, lock, first, blocker)
            started.wait(5)
            _jobs.accept(lock, second)
            _jobs.submit(pool, lock, second, lambda: pytest.fail("cancelled job ran"))
            pool.shutdown(wait=False, cancel_futures=True)
            assert second["running"] is False and second["queued"] is False
        finally:
            release.set()


def test_lifespan_joins_job_threads_and_resets_the_singleton(client, stub_jobs):
    """A job that finished before shutdown leaves no thread behind (the client
    fixture's T5 guard checks the thread count after teardown); here, the
    singleton is live inside the app and its threads are named."""
    release, threads = stub_jobs
    pool = executor.get_jobs_executor()
    assert pool is not executor.get_executor()
    release.set()
    post, body, status, *_ = _JOBS["face_model"]
    assert client.post(post, json=body).status_code == 200
    assert _wait_for(lambda: client.get(status).json()["done"])
    assert threads["face_model"].startswith("geotagger-job")
