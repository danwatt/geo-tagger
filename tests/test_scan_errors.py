"""Audit S3: per-file scan failures persist in scan_errors (cleared on success
or when the file vanishes), unchanged known-failing files aren't re-read, the
full warning list is reachable, and only one scan runs at a time. ExifTool is
stubbed out (as in test_scan_batching)."""

import os
import threading

import pytest

from geotagger import exiftool_session, index, scanning, sidecar


@pytest.fixture(autouse=True)
def _fresh_scan_state():
    scanning.reset_scan_state()
    yield
    scanning.reset_scan_state()


@pytest.fixture
def saved_roots(monkeypatch):
    """Never let run_scan write the user's real last-roots sentinel."""
    calls = []
    monkeypatch.setattr(index, "save_last_scan_roots", lambda roots: calls.append(list(roots)))
    return calls


_META = {"lat": None, "lng": None, "geotag_source": "none", "camera": "",
         "photo_datetime": 0, "gps_accuracy": 0.0, "orientation": 1}


@pytest.fixture
def et_ok(monkeypatch):
    """Pretend ExifTool is running, so a read failure counts as the file's fault."""
    monkeypatch.setattr(exiftool_session, "exiftool_status", lambda: {"ok": True})


@pytest.fixture
def fake_meta(monkeypatch):
    """read_metadata stub: names starting with 'bad' raise; returns the call list."""
    calls = []

    def read(p):
        calls.append(p.name)
        if p.name.startswith("bad"):
            raise ValueError("corrupt file")
        return dict(_META)

    monkeypatch.setattr(sidecar, "read_metadata", read)
    return calls


@pytest.fixture
def lib(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    (root / "good.jpg").write_bytes(b"good")
    (root / "bad.jpg").write_bytes(b"bad")
    return root


def _scan(root):
    return scanning.scan_directory(root, show_progress=False, generate_thumbnails=False)


def _errors(db):
    return [dict(r) for r in db.execute(
        "SELECT filename, stage, error, mtime, size, attempts FROM scan_errors ORDER BY filename")]


class TestPersistence:
    def test_read_failure_is_recorded_with_its_stat(self, db, lib, fake_meta, et_ok):
        count, _, warnings = _scan(lib)
        assert count == 1
        assert any("bad.jpg" in w for w in warnings)
        [e] = _errors(db)
        st = (lib / "bad.jpg").stat()
        assert e == {"filename": "bad.jpg", "stage": "read", "error": "corrupt file",
                     "mtime": st.st_mtime, "size": st.st_size, "attempts": 1}
        assert scanning.get_scan_status()["errors"] == 1

    def test_unchanged_known_failure_is_not_reread(self, db, lib, fake_meta, et_ok):
        _scan(lib)
        fake_meta.clear()
        _scan(lib)
        assert "bad.jpg" not in fake_meta  # skipped, not re-read
        s = scanning.get_scan_status()
        assert s["known_failed"] == 1
        assert s["processed"] == s["total"] == 2  # still counted, so progress completes
        assert _errors(db)[0]["attempts"] == 1   # and nothing was written for it

    def test_changed_file_is_retried_and_cleared_on_success(self, db, lib, fake_meta, et_ok, monkeypatch):
        _scan(lib)
        bad = lib / "bad.jpg"
        bad.write_bytes(b"repaired, and a different size")
        monkeypatch.setattr(sidecar, "read_metadata", lambda p: dict(_META))
        count, _, _ = _scan(lib)
        assert count == 1
        assert _errors(db) == []
        assert db.execute("SELECT 1 FROM photos WHERE filename='bad.jpg'").fetchone()
        assert scanning.get_scan_status()["errors"] == 0

    def test_changed_file_failing_again_bumps_attempts(self, db, lib, fake_meta, et_ok):
        _scan(lib)
        bad = lib / "bad.jpg"
        bad.write_bytes(b"still bad, new size")
        fake_meta.clear()
        _scan(lib)
        assert "bad.jpg" in fake_meta
        [e] = _errors(db)
        assert e["attempts"] == 2 and e["size"] == bad.stat().st_size

    def test_transient_failure_is_always_retried(self, db, lib, fake_meta, monkeypatch):
        # ExifTool unavailable: every read fails, but no file is at fault.
        monkeypatch.setattr(exiftool_session, "exiftool_status", lambda: {"ok": False, "error": "x"})
        _scan(lib)
        [e] = _errors(db)
        assert e["mtime"] is None and e["size"] is None
        fake_meta.clear()
        _scan(lib)
        assert "bad.jpg" in fake_meta

    def test_only_file_caused_failures_are_permanent(self, et_ok):
        from exiftool.exceptions import ExifToolExecuteError
        assert scanning._failure_is_transient(PermissionError("locked"))
        assert scanning._failure_is_transient(exiftool_session.ExifToolDied("died"))
        assert scanning._failure_is_transient(RuntimeError("hiccup"))
        assert not scanning._failure_is_transient(exiftool_session.ExifToolTimeout("slow"))
        assert not scanning._failure_is_transient(ExifToolExecuteError(1, "cmd", "", "bad"))
        assert not scanning._failure_is_transient(ValueError("corrupt"))

    def test_write_failure_is_recorded_without_stat(self, db, lib, fake_meta, et_ok, monkeypatch):
        real = index.upsert_photo

        def upsert(**kw):
            if kw["filename"] == "good.jpg":
                raise RuntimeError("disk full")
            return real(**kw)

        monkeypatch.setattr(index, "upsert_photo", upsert)
        _scan(lib)
        rows = {e["filename"]: e for e in _errors(db)}
        assert rows["good.jpg"]["stage"] == "write"
        assert rows["good.jpg"]["mtime"] is None

    def test_unchanged_clean_rescan_writes_nothing(self, db, tmp_path, fake_meta, et_ok):
        root = tmp_path / "clean"
        root.mkdir()
        (root / "a.jpg").write_bytes(b"a")
        _scan(root)
        statements = []
        db.set_trace_callback(statements.append)
        try:
            _scan(root)
        finally:
            db.set_trace_callback(None)
        assert not [s for s in statements if s.lstrip().startswith(("INSERT", "UPDATE", "DELETE"))]


class TestPruneAndRunScan:
    def test_vanished_failing_file_is_cleared(self, db, lib, fake_meta, et_ok, saved_roots):
        scanning.run_scan([lib])
        assert len(_errors(db)) == 1
        (lib / "bad.jpg").unlink()
        scanning.run_scan([lib])
        assert _errors(db) == []
        assert scanning.get_scan_status()["errors"] == 0

    def test_cancelled_scan_does_not_clear(self, db, lib, fake_meta, et_ok, saved_roots):
        scanning.run_scan([lib])
        (lib / "bad.jpg").unlink()
        cancel = threading.Event()
        cancel.set()
        scanning.run_scan([lib], cancel)
        assert len(_errors(db)) == 1

    def test_all_warnings_kept_and_console_says_where(self, db, tmp_path, monkeypatch, capsys, saved_roots):
        ws = [f"Error processing f{i}.jpg: x" for i in range(12)]
        monkeypatch.setattr(scanning, "scan_directory", lambda root, **kw: (0, 0, list(ws)))
        scanning.run_scan([tmp_path])
        assert scanning.get_last_warnings() == ws
        out = capsys.readouterr().out
        assert "Warnings: 12" in out and "/api/scan/errors" in out
        assert scanning.get_scan_status()["summary"].startswith("Finished")


class TestSingleScan:
    def test_second_scan_refused_while_running(self, db, tmp_path, monkeypatch, saved_roots):
        started, release = threading.Event(), threading.Event()

        def slow(root, **kw):
            started.set()
            release.wait(10)
            return 0, 0, []

        monkeypatch.setattr(scanning, "scan_directory", slow)
        t = scanning.start_background_scan([tmp_path], threading.Event())
        try:
            assert started.wait(5)
            with pytest.raises(scanning.ScanAlreadyRunning):
                scanning.start_background_scan([tmp_path], threading.Event())
            with pytest.raises(scanning.ScanAlreadyRunning):
                scanning.run_scan([tmp_path])
        finally:
            release.set()
            t.join(5)
        assert not t.is_alive()
        # Idle again: a new scan is accepted.
        scanning.run_scan([tmp_path])
        assert scanning.get_scan_status()["running"] is False


class TestEndpoints:
    def test_errors_listed_and_cleared(self, client, lib, fake_meta, et_ok):
        _scan(lib)
        body = client.get("/api/scan/errors").json()
        assert body["count"] == 1
        [e] = body["errors"]
        assert e["path"] == os.path.join(str(lib), "bad.jpg")
        assert e["stage"] == "read" and e["attempts"] == 1
        assert client.delete("/api/scan/errors").json() == {"cleared": 1}
        assert client.get("/api/scan/errors").json()["count"] == 0
        assert client.get("/api/scan/status").json()["errors"] == 0

    def test_clear_refused_while_scanning(self, client):
        scanning._update_scan_state(running=True)
        assert client.delete("/api/scan/errors").status_code == 409


def test_server_answers_during_a_slow_startup_scan(tmp_path, monkeypatch):
    """The audit's core complaint: the port didn't answer until the scan ended."""
    from fastapi.testclient import TestClient
    from geotagger import faces, main

    scan_root = tmp_path / "lib"
    scan_root.mkdir()
    monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("GEOTAGGER_SCAN_DIRS", str(scan_root))
    monkeypatch.delenv("GEOTAGGER_NO_SCAN", raising=False)
    started, release = threading.Event(), threading.Event()

    def slow(root, *a, **kw):
        scanning._update_scan_state(root=str(root), phase="indexing", processed=3, total=10)
        started.set()
        release.wait(10)
        return 0, 0, []

    monkeypatch.setattr(scanning, "scan_directory", slow)
    et_was_running = exiftool_session._et is not None
    try:
        with TestClient(main.app, base_url="http://127.0.0.1:8000") as c:
            assert started.wait(5)
            assert c.get("/api/status").status_code == 200
            assert c.get("/api/scan/errors").status_code == 200
            s = c.get("/api/scan/status").json()
            assert s["running"] is True and s["phase"] == "indexing"
            assert (s["processed"], s["total"]) == (3, 10)
            release.set()
        assert scanning.get_scan_status()["running"] is False
    finally:
        release.set()
        if et_was_running:
            exiftool_session.start_et()
        if index._db is not None:
            index._db.close()
        index._db = None
        index._db_path = None
        faces._gallery_cache = None
        faces._unlabeled_cache = None
        faces._suggested_scores_cache = None
