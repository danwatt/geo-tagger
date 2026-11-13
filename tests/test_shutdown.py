"""Orderly teardown: the request executor, the DB connection and the ExifTool
session are all released when the app (or a failed startup) lets go of them."""

import threading

import pytest

from geotagger import executor, exiftool_session, index


@pytest.fixture
def pool():
    """A private shared executor, torn down even if the test fails midway."""
    executor.init_executor(2)
    yield executor.get_executor()
    executor.shutdown_executor(grace_seconds=5)


class TestShutdownExecutor:
    def test_idle_pool_shuts_down_and_get_executor_raises(self, pool):
        assert executor.shutdown_executor(grace_seconds=5) is True
        with pytest.raises(RuntimeError, match="not initialized"):
            executor.get_executor()
        with pytest.raises(RuntimeError):
            pool.submit(lambda: None)  # the pool itself refuses new work too

    def test_no_executor_is_a_noop(self, pool):
        executor.shutdown_executor(grace_seconds=5)
        assert executor.shutdown_executor(grace_seconds=5) is True

    def test_waits_for_a_running_job_within_the_grace_period(self, pool):
        done = []
        started = threading.Event()

        def job():
            started.set()
            done.append(True)

        pool.submit(job)
        started.wait(5)
        assert executor.shutdown_executor(grace_seconds=5) is True
        assert done == [True]

    def test_gives_up_on_a_long_job_and_cancels_queued_ones(self, pool):
        """Ctrl-C must not hang on a long job: report it as still running rather
        than wait, and never start work that was only queued."""
        release = threading.Event()
        started = threading.Event()

        def long_job():
            started.set()
            release.wait(10)

        try:
            blockers = [pool.submit(long_job) for _ in range(2)]  # fill both workers
            started.wait(5)
            queued = pool.submit(lambda: None)

            assert executor.shutdown_executor(grace_seconds=0.05) is False
            assert queued.cancelled()
        finally:
            release.set()
        for f in blockers:
            f.result(5)


class TestLifespanTeardown:
    def test_db_and_executor_are_released_when_the_app_stops(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient
        from geotagger import main

        monkeypatch.setenv("GEOTAGGER_NO_SCAN", "1")
        monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(tmp_path))
        monkeypatch.delenv("GEOTAGGER_SCAN_DIRS", raising=False)
        index.init_db(tmp_path)
        et_was_running = exiftool_session._et is not None
        try:
            with TestClient(main.app, base_url="http://127.0.0.1") as c:
                assert c.get("/api/status").status_code == 200
                pool = executor.get_executor()

            with pytest.raises(RuntimeError, match="not initialized"):
                index.get_db()
            with pytest.raises(RuntimeError, match="not initialized"):
                executor.get_executor()
            with pytest.raises(RuntimeError):
                pool.submit(lambda: None)
        finally:
            index.close_db()
            if et_was_running:  # the lifespan stopped a session-scoped ExifTool
                exiftool_session.start_et()


class TestStartEtFailure:
    def test_failed_probe_terminates_the_started_process(self, monkeypatch):
        """A failure after the -stay_open child has started must not just drop
        the handle — that would leak the process until the app exits."""
        terminated = []

        class StartedThenBroken:
            running = True

            def __init__(self, *args, **kwargs):
                pass

            def execute(self, *params):
                raise RuntimeError("probe failed")

            def terminate(self):
                terminated.append(True)

        monkeypatch.setattr(exiftool_session, "_et", None)
        monkeypatch.setattr(exiftool_session, "_et_error", None)
        monkeypatch.setattr(exiftool_session, "_GuardedExifTool", StartedThenBroken)

        assert exiftool_session.start_et() is False
        assert terminated == [True]
        assert exiftool_session._et is None
        assert exiftool_session._et_error == "probe failed"
