"""The ExifTool call watchdog (exiftool_session._GuardedExifTool): a call that hangs
is killed after the deadline, the session restarts in place, that one call raises
ExifToolTimeout, the lock is released, and the next call works.

Most tests drive the *real* pyexiftool execute()/read loop and the real watchdog
against a fake subprocess built on os.pipe(), so they need no ExifTool binary: the
fake answers commands with pyexiftool's {ready}/status sentinels, ignores commands
containing HANG (so the read blocks for real), and "dies" by closing its pipe ends.
One test at the bottom uses the real binary when it's installed."""

import os
import re
import sys
import threading
import time

import pytest

from geotagger import config, exiftool_session
from geotagger.exiftool_session import ExifToolDied, ExifToolTimeout


class _FakeStdin:
    def __init__(self, proc):
        self._proc = proc
        self._buf = b""

    def write(self, data: bytes):
        self._buf += data

    def flush(self):
        buf, self._buf = self._buf, b""
        self._proc.handle(buf)

    def close(self):
        pass


class _FakeProc:
    """Popen stand-in for an `exiftool -stay_open` child."""
    def __init__(self, ident: int):
        self.ident = ident               # 1 for a session's first process, 2 after a restart, ...
        self.pid = -self.ident          # never a real PID (and _kill_process_tree is stubbed)
        r_out, self._w_out = os.pipe()
        r_err, self._w_err = os.pipe()
        self.stdout = os.fdopen(r_out, "rb", buffering=0)
        self.stderr = os.fdopen(r_err, "rb", buffering=0)
        self.stdin = _FakeStdin(self)
        self.returncode = None
        self.kill_calls = 0
        self.received: list[list[bytes]] = []
        self.hung = threading.Event()
        self._guard = threading.Lock()

    def handle(self, cmd: bytes):
        lines = cmd.split(b"\n")
        num = re.search(rb"-execute(\d+)", cmd).group(1)
        args = lines[:-4]  # drop pyexiftool's -echo4, status format, -execute and trailing ""
        self.received.append(args)
        if b"HANG" in args:
            self.hung.set()
            return  # never answer: the caller's read blocks
        if b"DIE" in args:
            self.kill()  # crash mid-command
            return
        body = b"13.59" if args == [b"-ver"] else b"proc%d:%s" % (self.ident, args[-1])
        os.write(self._w_out, body + b"{ready" + num + b"}\n")
        os.write(self._w_err, b"=0=post" + num + b"\n")

    def poll(self):
        return self.returncode

    def kill(self):
        with self._guard:
            self.kill_calls += 1
            if self.returncode is None:
                self.returncode = -9
                # Like a dead process: our ends see EOF.
                os.close(self._w_out)
                os.close(self._w_err)

    def wait(self, timeout=None):
        return self.returncode

    def communicate(self, *a, **kw):  # only reached via pyexiftool's __del__/terminate
        self.kill()
        return b"", b""


class _FakeSession(exiftool_session._GuardedExifTool):
    """The real _GuardedExifTool, with run() spawning a _FakeProc instead of exiftool."""

    def __init__(self):
        super().__init__(executable=sys.executable, encoding="utf-8")
        self.procs: list[_FakeProc] = []

    def run(self):
        if self.running:
            return
        proc = _FakeProc(len(self.procs) + 1)
        self.procs.append(proc)
        self._process = proc
        self._running = True
        self._ver = self._parse_ver()  # same nested `-ver` re-entry the real run() does


@pytest.fixture
def session(monkeypatch):
    monkeypatch.setattr(config, "EXIFTOOL_TIMEOUT", 0.5)
    # Never let the watchdog taskkill a (fake, negative) PID.
    monkeypatch.setattr(exiftool_session, "_kill_process_tree", lambda proc: proc.kill())
    et = _FakeSession()
    et.run()
    yield et
    if et._process is not None:
        et._process.kill()
    et._flag_running_false()


def _lock_is_free() -> bool:
    """True if another thread can take the ExifTool lock right now."""
    box = {}

    def probe():
        ok = exiftool_session.get_et_lock().acquire(timeout=1)
        if ok:
            exiftool_session.get_et_lock().release()
        box["ok"] = ok

    t = threading.Thread(target=probe)
    t.start()
    t.join(5)
    return box.get("ok", False)


# ── EOF-safe read patch ──

def test_pyexiftool_uses_the_eof_safe_reader():
    import importlib
    assert importlib.import_module("exiftool.exiftool")._read_fd_endswith is exiftool_session._read_fd_endswith


def test_reader_raises_on_eof_instead_of_spinning():
    r, w = os.pipe()
    os.write(w, b"partial output, no sentinel")
    os.close(w)
    try:
        t0 = time.monotonic()
        with pytest.raises(ExifToolDied):
            exiftool_session._read_fd_endswith(r, b"{ready123}", 4096)
        assert time.monotonic() - t0 < 1
    finally:
        os.close(r)


def test_reader_returns_output_up_to_the_sentinel():
    r, w = os.pipe()
    os.write(w, b"hello\n{ready7}\n")
    try:
        assert exiftool_session._read_fd_endswith(r, b"{ready7}", 4) == b"hello\n{ready7}\n"
    finally:
        os.close(w)
        os.close(r)


# ── Watchdog ──

def test_normal_calls_pass_through(session):
    assert session.execute("-ver") == "13.59"
    assert session.execute("-b", "file.jpg").startswith("proc1:")
    assert len(session.procs) == 1


def test_hang_times_out_restarts_and_next_call_works(session):
    first = session._process
    t0 = time.monotonic()
    with pytest.raises(ExifToolTimeout, match="did not respond within 0.5s on HANG"):
        session.execute("-b", "-PreviewImage", "HANG")
    elapsed = time.monotonic() - t0
    assert 0.4 < elapsed < 5

    assert first.kill_calls == 1            # killed exactly once
    assert len(session.procs) == 2          # restarted exactly once
    assert session._process is session.procs[1] and session.running
    assert _lock_is_free()
    assert session.execute("-b", "next.jpg") == "proc2:next.jpg"


def test_two_waiters_behind_a_hang_cause_exactly_one_restart(session):
    results: dict[str, object] = {}

    def call(name, *args):
        try:
            results[name] = session.execute(*args)
        except BaseException as e:
            results[name] = e

    hanger = threading.Thread(target=call, args=("hang", "-b", "HANG"))
    hanger.start()
    assert session.procs[0].hung.wait(5)    # the hanging call holds the lock now
    waiters = [threading.Thread(target=call, args=(f"w{i}", "-b", f"w{i}.jpg")) for i in range(2)]
    for w in waiters:
        w.start()
    for t in [hanger, *waiters]:
        t.join(10)
        assert not t.is_alive()

    assert isinstance(results["hang"], ExifToolTimeout)
    # Both waiters ran only after the restart, on the fresh process.
    assert results["w0"] == "proc2:w0.jpg"
    assert results["w1"] == "proc2:w1.jpg"
    assert len(session.procs) == 2
    assert session.procs[0].kill_calls == 1
    assert _lock_is_free()


def test_timeout_inside_an_outer_lock_hold_keeps_reentrancy_intact(session):
    """geotag_service/geocode_service hold the RLock around write_gps, which makes
    several calls. A timeout deep inside must restart, raise, and leave the outer
    hold exactly as it was (still held by this thread, released on exit)."""
    lock = exiftool_session.get_et_lock()
    with lock:
        assert session.execute("-b", "before.jpg") == "proc1:before.jpg"
        with pytest.raises(ExifToolTimeout):
            session.execute("-b", "HANG")
        assert not _lock_is_free()          # outer hold survives
        assert session.execute("-b", "after.jpg") == "proc2:after.jpg"
    assert _lock_is_free()


def test_process_dying_mid_command_restarts_and_raises(session):
    with pytest.raises(ExifToolDied):
        session.execute("-b", "DIE")
    assert len(session.procs) == 2
    assert session.execute("-b", "x.jpg") == "proc2:x.jpg"


def test_call_completing_as_the_watchdog_fires_returns_result_and_restarts(session, monkeypatch):
    real_disarm = exiftool_session._watchdog.disarm
    monkeypatch.setattr(exiftool_session._watchdog, "disarm",
                        lambda token: real_disarm(token) or True)  # "killed" just as it finished
    assert session.execute("-b", "ok.jpg") == "proc1:ok.jpg"
    assert len(session.procs) == 2


def test_zero_timeout_disables_the_watchdog(session, monkeypatch):
    monkeypatch.setattr(config, "EXIFTOOL_TIMEOUT", 0)
    armed = []
    monkeypatch.setattr(exiftool_session._watchdog, "arm",
                        lambda *a, **kw: armed.append(a) or 0)
    assert session.execute("-b", "a.jpg") == "proc1:a.jpg"
    assert armed == []


def test_run_with_timeout_overrides_the_deadline_for_this_thread(session, monkeypatch):
    monkeypatch.setattr(config, "EXIFTOOL_TIMEOUT", 3600)
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):  # ExifToolTimeout is a TimeoutError, as scripts expect
        exiftool_session.run_with_timeout(lambda: session.execute("-b", "HANG"), 0.3)
    assert time.monotonic() - t0 < 5
    assert getattr(exiftool_session._tls, "timeout", None) is None  # override restored
    assert session.execute("-b", "y.jpg") == "proc2:y.jpg"


def test_line_breaks_are_still_rejected(session):
    with pytest.raises(ValueError, match="line break"):
        session.execute("-b", "evil\n-o\nx.jpg")


# ── Real binary ──

def test_real_exiftool_hang_is_killed_and_session_recovers(et_session, monkeypatch):
    """`-` as the target makes ExifTool read the file from stdin — which in
    -stay_open mode is the argument pipe, so it blocks forever: a genuine hang."""
    monkeypatch.setattr(config, "EXIFTOOL_TIMEOUT", 1.5)
    et = exiftool_session.get_et()
    old_pid = et._process.pid
    with pytest.raises(ExifToolTimeout):
        et.execute("-b", "-PreviewImage", "-", raw_bytes=True)
    assert et is exiftool_session.get_et()  # restarted in place
    assert et._process.pid != old_pid
    assert _lock_is_free()
    assert et.execute("-ver").strip()
