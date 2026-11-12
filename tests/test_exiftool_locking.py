"""Regression tests: every ExifTool call in sidecar.py must be serialized on the
shared -stay_open session. Unserialized concurrent calls from scan worker threads
interleaved on the pipe and deadlocked the startup scan (both threads stuck in
pyexiftool's _read_fd_endswith)."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from geotagger import sidecar, exiftool_session


class _ConcurrencyDetectingET:
    """Stand-in for ExifToolHelper that records whether two threads were ever
    inside a native call at the same time."""

    def __init__(self):
        self._guard = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.calls = 0

    def _enter(self):
        with self._guard:
            self.active += 1
            self.calls += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.005)  # widen the race window so overlap is near-certain if unlocked
        with self._guard:
            self.active -= 1

    def get_tags(self, files, tags=None):
        self._enter()
        return [{"SourceFile": f} for f in files]

    def execute(self, *args, **kwargs):
        self._enter()
        return ""


def _install_fake(monkeypatch) -> _ConcurrencyDetectingET:
    fake = _ConcurrencyDetectingET()
    monkeypatch.setattr(sidecar, "get_et", lambda: fake)
    return fake


def test_concurrent_read_metadata_is_serialized(tmp_path, monkeypatch):
    fake = _install_fake(monkeypatch)
    images = []
    for i in range(16):
        img = tmp_path / f"IMG_{i}.NEF"
        img.write_bytes(b"")
        # A sidecar makes read_metadata issue two native calls per file.
        sidecar.sidecar_path(img).write_text("<x:xmpmeta/>")
        images.append(img)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(sidecar.read_metadata, images))

    assert fake.calls == 32
    assert fake.max_active == 1


def test_concurrent_read_orientations_is_serialized(tmp_path, monkeypatch):
    fake = _install_fake(monkeypatch)
    batches = [[tmp_path / f"b{b}_{i}.NEF" for i in range(3)] for b in range(8)]

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(sidecar.read_orientations, batches))

    assert fake.calls == 8
    assert fake.max_active == 1


def test_write_gps_under_outer_lock_does_not_self_deadlock(tmp_path, monkeypatch):
    """geocode_service.export_to_sidecars holds get_et_lock() around write_gps,
    which internally reads metadata and writes — both of which take the lock
    again. The lock must be reentrant or this nests into a self-deadlock."""
    _install_fake(monkeypatch)
    img = tmp_path / "IMG.NEF"
    img.write_bytes(b"")
    done = threading.Event()

    def run():
        with exiftool_session.get_et_lock():
            sidecar.write_gps(img, 1.0, 2.0)
        done.set()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    assert done.wait(5), "write_gps deadlocked under an already-held ExifTool lock"
