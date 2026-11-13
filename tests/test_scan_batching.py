"""Scan DB-side batching (audit P1): one freshness lookup for the whole tree
instead of a SELECT per file, and upserts committed in short batches instead of
one transaction per file. ExifTool is stubbed out, so no et_session is needed."""

import re
import threading
from contextlib import contextmanager

import pytest

from geotagger import config, index, scanning, sidecar


@pytest.fixture(autouse=True)
def _fresh_scan_state():
    scanning.reset_scan_state()
    yield
    scanning.reset_scan_state()


_META = {"lat": None, "lng": None, "geotag_source": "none", "camera": "",
         "photo_datetime": 0, "gps_accuracy": 0.0, "orientation": 1}


@pytest.fixture
def fake_meta(monkeypatch):
    """Replace the ExifTool read with a fixed result; returns the list of paths
    it was called for."""
    calls = []

    def read(p):
        calls.append(p)
        return dict(_META)

    monkeypatch.setattr(sidecar, "read_metadata", read)
    return calls


def _make_files(root, n, subdirs=1):
    # The bytes only need to hash; nothing decodes them with thumbnails off.
    for i in range(n):
        d = root / f"d{i % subdirs}"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"p{i}.jpg").write_bytes(b"x%d" % i)


def _scan(root, **kw):
    return scanning.scan_directory(root, show_progress=False, generate_thumbnails=False, **kw)


def _indexed_names(db):
    return sorted(r[0] for r in db.execute("SELECT filename FROM photos"))


@pytest.fixture
def lib(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    return root


class TestFreshFlags:
    def test_agrees_with_is_fresh(self, db):
        def up(dir_, name, mtime=1000.0, camera="c", sidecar_path=None, sidecar_mtime=None):
            index.upsert_photo(filename=name, dir_=dir_, ext=".jpg", media_type="image",
                               mtime=mtime, size=1, lat=None, lng=None, geotag_source="none",
                               sidecar_path=sidecar_path, sidecar_mtime=sidecar_mtime,
                               camera=camera, photo_datetime=1, gps_accuracy=0.0, orientation=1)

        up("/a", "fresh.jpg")
        up("/a", "moved.jpg", mtime=1000.0)
        up("/a", "partial.jpg", camera=None)
        up("/b", "sc.jpg", sidecar_path="sc.xmp", sidecar_mtime=5.0)
        entries = [
            ("/a", "fresh.jpg", 1000.3, None, None),
            ("/a", "moved.jpg", 1009.0, None, None),
            ("/a", "partial.jpg", 1000.0, None, None),
            ("/a", "missing.jpg", 1000.0, None, None),
            ("/b", "sc.jpg", 1000.0, "sc.xmp", 5.0),
            ("/b", "sc.jpg", 1000.0, "sc.xmp", 9.0),
            # Exact comparison, as is_fresh's dir=? — a case-variant dir is a
            # different key, never silently matched.
            ("/A", "fresh.jpg", 1000.0, None, None),
        ]
        expected = [index.is_fresh(*e) for e in entries]
        assert index.fresh_flags(entries) == expected
        assert expected == [True, False, False, False, True, False, False]

    def test_chunks_directories(self, db, monkeypatch):
        monkeypatch.setattr(index, "_FRESH_DIR_CHUNK", 2)
        for i in range(5):
            index.upsert_photo(filename="p.jpg", dir_=f"/d{i}", ext=".jpg", media_type="image",
                               mtime=1.0, size=1, lat=None, lng=None, geotag_source="none",
                               sidecar_path=None, sidecar_mtime=None, camera="",
                               photo_datetime=1, gps_accuracy=0.0, orientation=1)
        entries = [(f"/d{i}", "p.jpg", 1.0, None, None) for i in range(5)]
        assert index.fresh_flags(entries) == [True] * 5


class TestRescan:
    def test_unchanged_rescan_does_no_per_file_queries_or_writes(self, db, lib, fake_meta):
        _make_files(lib, 25, subdirs=3)
        assert _scan(lib)[:2] == (25, 0)
        before = [tuple(r) for r in db.execute(
            "SELECT dir, filename, mtime, size, checksum, scanned_at FROM photos ORDER BY id")]
        fake_meta.clear()

        statements = []
        db.set_trace_callback(statements.append)
        try:
            count, skipped, _ = _scan(lib)
        finally:
            db.set_trace_callback(None)

        assert (count, skipped) == (0, 25)
        assert fake_meta == []  # no ExifTool read for a fresh file
        point = [s for s in statements if re.search(r"FROM photos WHERE dir\s*=", s)]
        batched = [s for s in statements if "WHERE dir IN" in s]
        writes = [s for s in statements if re.match(r"\s*(INSERT|UPDATE|DELETE)", s)]
        assert point == [] and writes == []
        assert len(batched) == 1  # 3 dirs, one chunk
        after = [tuple(r) for r in db.execute(
            "SELECT dir, filename, mtime, size, checksum, scanned_at FROM photos ORDER BY id")]
        assert after == before


@pytest.fixture
def batch_spy(monkeypatch):
    """Group each upsert_photo call by the outermost write unit it ran in.
    Returns the list of group sizes, in commit order."""
    groups: list[int] = []
    real_tx = index.transaction
    real_upsert = index.upsert_photo

    @contextmanager
    def spy_tx():
        # Only the scan's main thread writes in these tests, so the depth read
        # outside the lock is stable.
        if index._tx_depth == 0:
            groups.append(0)
        with real_tx() as db:
            yield db

    def spy_upsert(**kw):
        groups[-1] += 1
        return real_upsert(**kw)

    monkeypatch.setattr(index, "transaction", spy_tx)
    monkeypatch.setattr(index, "upsert_photo", spy_upsert)
    return groups


class TestBatchedWrites:
    def test_final_partial_batch_is_flushed(self, db, lib, fake_meta, batch_spy, monkeypatch):
        monkeypatch.setattr(scanning, "_SCAN_BATCH_ROWS", 3)
        monkeypatch.setattr(scanning, "_SCAN_BATCH_SECONDS", 3600.0)
        _make_files(lib, 7)

        count, skipped, warnings = _scan(lib)

        assert (count, skipped, warnings) == (7, 0, [])
        assert [g for g in batch_spy if g] == [3, 3, 1]
        assert len(_indexed_names(db)) == 7
        s = scanning.get_scan_status()
        assert (s["processed"], s["indexed"]) == (7, 7)

    def test_time_bound_flushes_without_waiting_for_row_count(self, db, lib, fake_meta,
                                                              batch_spy, monkeypatch):
        """A slow file mustn't hold earlier rows back until the row bound fills."""
        monkeypatch.setattr(scanning, "_SCAN_BATCH_ROWS", 1000)
        monkeypatch.setattr(scanning, "_SCAN_BATCH_SECONDS", 0.05)
        monkeypatch.setattr(config, "WORKERS", 2)
        _make_files(lib, 2)
        release = threading.Event()
        seen_before_release = []

        def read(p):
            if p.name == "p1.jpg":
                # Wait until the other file's row has been committed on its own.
                for _ in range(200):
                    if db.execute("SELECT 1 FROM photos WHERE filename='p0.jpg'").fetchone():
                        seen_before_release.append(True)
                        break
                    release.wait(0.01)
            return dict(_META)

        monkeypatch.setattr(sidecar, "read_metadata", read)
        assert _scan(lib)[0] == 2
        assert seen_before_release == [True]
        assert [g for g in batch_spy if g] == [1, 1]

    def test_failing_row_does_not_lose_its_neighbours(self, db, lib, fake_meta, batch_spy,
                                                      monkeypatch):
        monkeypatch.setattr(scanning, "_SCAN_BATCH_ROWS", 100)
        monkeypatch.setattr(scanning, "_SCAN_BATCH_SECONDS", 3600.0)
        _make_files(lib, 5)
        real_upsert = index.upsert_photo  # the spy, which counts the call

        def flaky(**kw):
            real_upsert(**kw)  # the row's statements run, then the row fails
            if kw["filename"] == "p2.jpg":
                raise RuntimeError("bad row")

        monkeypatch.setattr(index, "upsert_photo", flaky)

        count, skipped, warnings = _scan(lib)

        assert batch_spy == [5]  # one unit for all five
        assert _indexed_names(db) == ["p0.jpg", "p1.jpg", "p3.jpg", "p4.jpg"]
        assert count == 4
        assert warnings == ["Error processing p2.jpg: bad row"]
        assert scanning.get_scan_status()["indexed"] == 4

    def test_cancel_midway_keeps_what_was_scanned(self, db, lib, monkeypatch):
        monkeypatch.setattr(config, "WORKERS", 1)
        monkeypatch.setattr(scanning, "_SCAN_BATCH_ROWS", 2)
        monkeypatch.setattr(scanning, "_SCAN_BATCH_SECONDS", 3600.0)
        _make_files(lib, 10)
        cancel = threading.Event()
        reads = []

        def read(p):
            reads.append(p)
            if len(reads) == 3:
                cancel.set()  # the third file still finishes
            return dict(_META)

        monkeypatch.setattr(sidecar, "read_metadata", read)

        count, skipped, _ = _scan(lib, cancel=cancel)

        assert count == 3
        # The odd third row sat in a partial batch when the loop stopped.
        assert sorted(_indexed_names(db)) == sorted(p.name for p in reads)
        assert scanning.get_scan_status()["processed"] == 3

    def test_exception_midway_flushes_collected_rows(self, db, lib, fake_meta, monkeypatch):
        monkeypatch.setattr(config, "WORKERS", 1)
        monkeypatch.setattr(scanning, "_SCAN_BATCH_ROWS", 100)
        monkeypatch.setattr(scanning, "_SCAN_BATCH_SECONDS", 3600.0)
        _make_files(lib, 10)
        real_update = scanning._update_scan_state

        def update(**fields):
            if fields.get("processed") == 4:
                raise RuntimeError("display blew up")
            real_update(**fields)

        monkeypatch.setattr(scanning, "_update_scan_state", update)

        with pytest.raises(RuntimeError, match="display blew up"):
            _scan(lib)

        assert len(_indexed_names(db)) == 4
        assert len(fake_meta) < 10  # queued files were dropped, not all processed
        assert not db.in_transaction
