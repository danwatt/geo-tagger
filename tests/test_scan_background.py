"""Background startup scan: scan state, cancellation, status endpoint, and the
lifespan starting the scan in a thread instead of inline."""

import threading

import pytest

from geotagger import index, scanning


@pytest.fixture(autouse=True)
def _fresh_scan_state():
    scanning.reset_scan_state()
    yield
    scanning.reset_scan_state()


@pytest.fixture
def saved_roots(monkeypatch):
    """Capture save_last_scan_roots calls. The `db` fixture clears
    GEOTAGGER_CACHE_DIR, so the real function would write the user's legacy
    per-user sentinel file; never let a test do that."""
    calls = []
    monkeypatch.setattr(index, "save_last_scan_roots", lambda roots: calls.append(list(roots)))
    return calls


def _make_jpegs(root, n=2):
    from PIL import Image
    for i in range(n):
        Image.new("RGB", (4, 4), color="red").save(root / f"p{i}.jpg", "JPEG")


class TestScanState:
    def test_initial_state_shape(self):
        s = scanning.get_scan_status()
        assert s == {
            "running": False, "root": None, "processed": 0, "total": 0,
            "indexed": 0, "skipped": 0, "warnings": 0, "error": None,
            "started_at": None, "finished_at": None,
        }

    def test_get_returns_a_copy(self):
        s = scanning.get_scan_status()
        s["running"] = True
        assert scanning.get_scan_status()["running"] is False

    def test_real_scan_updates_counts(self, db, et_session, thumbs_dir, tmp_path):
        scan_root = tmp_path / "lib"
        scan_root.mkdir()
        _make_jpegs(scan_root, 2)

        count, skipped, _ = scanning.scan_directory(scan_root, show_progress=False)
        assert (count, skipped) == (2, 0)
        s = scanning.get_scan_status()
        assert s["running"] is False  # scan_directory alone doesn't own `running`
        assert s["root"] == str(scan_root)
        assert (s["processed"], s["total"], s["indexed"], s["skipped"]) == (2, 2, 2, 0)

        # Second pass: everything is fresh, so it is skipped, not indexed.
        scanning.scan_directory(scan_root, show_progress=False)
        s = scanning.get_scan_status()
        assert (s["processed"], s["total"], s["indexed"], s["skipped"]) == (2, 2, 0, 2)

    def test_run_scan_transitions_and_saves_roots(self, db, et_session, thumbs_dir, tmp_path, monkeypatch, saved_roots):
        scan_root = tmp_path / "lib"
        scan_root.mkdir()
        _make_jpegs(scan_root, 1)

        seen = {}
        real = scanning.scan_directory

        def spy(root, *a, **kw):
            seen["running_during"] = scanning.get_scan_status()["running"]
            return real(root, *a, show_progress=False, **{k: v for k, v in kw.items() if k != "show_progress"})

        monkeypatch.setattr(scanning, "scan_directory", spy)
        scanning.run_scan([scan_root])

        assert seen["running_during"] is True
        s = scanning.get_scan_status()
        assert s["running"] is False and s["error"] is None
        assert s["started_at"] is not None and s["finished_at"] >= s["started_at"]
        assert s["indexed"] == 1
        assert saved_roots == [[str(scan_root)]]

    def test_run_scan_counts_warnings_across_roots(self, db, tmp_path, monkeypatch, capsys, saved_roots):
        """Per-file failures don't fail the scan, so the count is the only sign
        that a run which 'finished' indexed little or nothing."""
        monkeypatch.setattr(scanning, "scan_directory",
                            lambda root, **kw: (0, 0, ["Error processing a.jpg: x", "Error processing b.jpg: x"]))
        scanning.run_scan([tmp_path / "one", tmp_path / "two"])

        s = scanning.get_scan_status()
        assert s["running"] is False and s["error"] is None
        assert s["warnings"] == 4

    def test_run_scan_records_failure(self, db, tmp_path, monkeypatch, capsys, saved_roots):
        def boom(root, **kw):
            raise RuntimeError("disk on fire")

        monkeypatch.setattr(scanning, "scan_directory", boom)
        scanning.run_scan([tmp_path])  # must not raise

        s = scanning.get_scan_status()
        assert s["running"] is False and s["error"] == "disk on fire"
        assert "disk on fire" in capsys.readouterr().err
        assert saved_roots == []  # roots not saved on failure


class TestCancel:
    def test_cancel_before_scan_processes_nothing(self, db, et_session, thumbs_dir, tmp_path):
        scan_root = tmp_path / "lib"
        scan_root.mkdir()
        _make_jpegs(scan_root, 2)
        cancel = threading.Event()
        cancel.set()

        count, skipped, warnings = scanning.scan_directory(scan_root, show_progress=False, cancel=cancel)
        assert (count, skipped) == (0, 0)
        assert scanning.get_scan_status()["processed"] == 0

    def test_cancel_mid_scan_stops_early_without_raising(self, db, et_session, thumbs_dir, tmp_path, monkeypatch):
        scan_root = tmp_path / "lib"
        scan_root.mkdir()
        _make_jpegs(scan_root, 6)
        cancel = threading.Event()
        monkeypatch.setenv("GEOTAGGER_WORKERS", "1")

        real_is_fresh = index.is_fresh

        def cancelling_is_fresh(*a, **kw):
            cancel.set()  # first file in flight trips the cancel
            return real_is_fresh(*a, **kw)

        monkeypatch.setattr(index, "is_fresh", cancelling_is_fresh)
        scanning.scan_directory(scan_root, show_progress=False, cancel=cancel)
        s = scanning.get_scan_status()
        assert s["total"] == 6
        assert s["processed"] < 6

    def test_run_scan_cancelled_does_not_save_roots(self, db, tmp_path, saved_roots):
        cancel = threading.Event()
        cancel.set()
        scanning.run_scan([tmp_path], cancel)
        assert scanning.get_scan_status()["running"] is False
        assert saved_roots == []


class TestStatusEndpoint:
    def test_shape_when_idle(self, client):
        r = client.get("/api/scan/status")
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"running", "root", "processed", "total", "indexed",
                             "skipped", "warnings", "error", "started_at", "finished_at"}
        assert body["running"] is False and body["error"] is None

    def test_reflects_state(self, client):
        scanning._update_scan_state(running=True, root="/x", processed=3, total=10)
        body = client.get("/api/scan/status").json()
        assert body["running"] is True and body["processed"] == 3 and body["total"] == 10


class TestLifespanBackgroundScan:
    def test_scan_runs_in_thread_not_inline(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient
        from geotagger import exiftool_session, faces, main

        scan_root = tmp_path / "lib"
        scan_root.mkdir()
        monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(tmp_path / "cache"))
        monkeypatch.setenv("GEOTAGGER_SCAN_DIRS", str(scan_root))
        monkeypatch.delenv("GEOTAGGER_NO_SCAN", raising=False)

        started = threading.Event()
        release = threading.Event()
        calls = {}

        def fake_scan(root, *a, **kw):
            calls["thread"] = threading.current_thread()
            calls["cancel"] = kw.get("cancel")
            started.set()
            release.wait(10)
            return 0, 0, []

        monkeypatch.setattr(scanning, "scan_directory", fake_scan)
        et_was_running = exiftool_session._et is not None

        try:
            # Loopback base URL so a Host-header allowlist (if present) accepts it.
            with TestClient(main.app, base_url="http://127.0.0.1:8000") as c:
                # Startup returned (we're inside the context) while the fake still blocks.
                assert started.wait(5)
                assert calls["thread"] is not threading.main_thread()
                assert calls["thread"].name == "startup-scan"
                assert calls["thread"].is_alive()
                r = c.get("/api/scan/status")
                assert r.status_code == 200, r.text
                assert r.json()["running"] is True
                # Release just before exit; shutdown must join the thread cleanly.
                release.set()
            calls["thread"].join(5)
            assert not calls["thread"].is_alive()
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

    def test_shutdown_sets_cancel_event(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient
        from geotagger import exiftool_session, main

        scan_root = tmp_path / "lib"
        scan_root.mkdir()
        monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(tmp_path / "cache"))
        monkeypatch.setenv("GEOTAGGER_SCAN_DIRS", str(scan_root))
        monkeypatch.delenv("GEOTAGGER_NO_SCAN", raising=False)

        started = threading.Event()
        seen = {}

        def fake_scan(root, *a, cancel=None, **kw):
            started.set()
            seen["cancelled"] = cancel.wait(10)  # only returns True if shutdown signals it
            return 0, 0, []

        monkeypatch.setattr(scanning, "scan_directory", fake_scan)
        et_was_running = exiftool_session._et is not None
        try:
            with TestClient(main.app):
                assert started.wait(5)
            assert seen["cancelled"] is True
        finally:
            if et_was_running:
                exiftool_session.start_et()
            if index._db is not None:
                index._db.close()
            index._db = None
            index._db_path = None
