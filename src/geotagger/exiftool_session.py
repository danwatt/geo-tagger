from contextlib import asynccontextmanager
import importlib
import logging
import os
import subprocess
import sys
import threading
import time
import exiftool
from geotagger import config

logger = logging.getLogger(__name__)

_et: "_GuardedExifTool | None" = None
_et_error: str | None = None
# Reentrant: the -stay_open session is a single request/response pipe, so EVERY
# native call from a worker thread must hold this. _GuardedExifTool.execute takes it
# itself (so a forgotten caller-side lock can't interleave the pipe), sidecar.py takes
# it around each call, and some callers (e.g. geocode_service.export_to_sidecars) also
# hold it around a whole sidecar.write_gps() — which itself reads metadata — so a
# plain Lock would self-deadlock on that nesting.
_et_lock = threading.RLock()


class ExifToolTimeout(TimeoutError):
    """One ExifTool call exceeded the watchdog deadline. The process has already been
    killed and restarted, so the session is usable again; only this call failed.
    A TimeoutError subclass so code that caught run_with_timeout's old plain
    TimeoutError keeps working."""


class ExifToolDied(RuntimeError):
    """The ExifTool process closed its output mid-command (it crashed or was killed)."""


# ── EOF-safe pipe reads (patch into pyexiftool) ──
# pyexiftool 0.5.x reads a command's output with `_read_fd_endswith`, a loop that
# keeps calling os.read() until it sees the {ready} sentinel. If the process dies
# mid-command, os.read() returns b"" (EOF) forever and that loop spins at 100% CPU,
# appending empty chunks, and never returns — measured: a thread blocked in a hung
# call, after the process was killed, burned 1.97 CPU-seconds per 2 s wall and never
# exited. That makes a kill useless as a way to unblock the caller (and was the
# silent fate of every thread the old run_with_timeout abandoned). execute() looks
# the helper up as a module global at call time, so replacing it there is enough;
# ours is identical except that EOF raises instead of looping. Plain blocking
# os.read() on every platform: the original's POSIX select() on a single fd with no
# timeout was equivalent to blocking anyway.
_pyet = importlib.import_module("exiftool.exiftool")


def _read_fd_endswith(fd, b_endswith: bytes, block_size: int) -> bytes:
    output_list: list[bytes] = []
    endswith_count = len(b_endswith) + 4  # same tail window as pyexiftool's version
    while not _pyet._get_buffer_end(output_list, endswith_count).strip().endswith(b_endswith):
        chunk = os.read(fd, block_size)
        if not chunk:
            raise ExifToolDied("ExifTool closed its output mid-command (process exited or was killed)")
        output_list.append(chunk)
    return b"".join(output_list)


# Only arm the watchdog if the patch is actually in place: killing the process
# without it would turn a blocked caller into a spinning one that still never
# releases the lock — strictly worse than not killing. Gated on the 0.5 series the
# replacement was written against, so an upgrade disables the watchdog (loudly)
# rather than patching internals that may have changed shape.
_EOF_SAFE = (str(getattr(exiftool, "__version__", "")).startswith("0.5.")
             and callable(getattr(_pyet, "_read_fd_endswith", None))
             and callable(getattr(_pyet, "_get_buffer_end", None)))
if _EOF_SAFE:
    _pyet._read_fd_endswith = _read_fd_endswith
else:  # pragma: no cover - only after a pyexiftool upgrade changes its internals
    print("WARNING: pyexiftool internals changed; ExifTool call watchdog disabled "
          "(review geotagger/exiftool_session.py)")


def _kill_process_tree(proc) -> None:
    """Force-kill a pyexiftool subprocess so a read blocked on its stdout hits EOF.

    TerminateProcess (Popen.kill on Windows) ends only that one process. If exiftool
    is reached through a launcher/shim that spawns the real interpreter as a child
    (e.g. a Chocolatey shim), the child keeps the inherited pipe ends open, the
    blocked read never sees EOF, and the kill achieves nothing — so on Windows walk
    the tree with taskkill /T first. (The exiftool.org 64-bit package runs Perl
    in-process — verified, no child process — so there it's belt-and-braces.) Popen
    holds a handle to the process, so its PID can't have been recycled under us.
    Absolute taskkill path so a stray taskkill.exe on PATH can't be picked up.
    POSIX exiftool is a single Perl process; SIGKILL is enough."""
    if sys.platform == "win32" and proc.poll() is None:
        taskkill = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe")
        try:
            subprocess.run([taskkill, "/F", "/T", "/PID", str(proc.pid)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        except Exception:
            pass  # fall through to the direct kill below
    try:
        proc.kill()
    except Exception:
        pass  # already gone


# ── Call watchdog ──
# One daemon thread enforces the deadline of every in-flight ExifTool call. The
# calling thread runs the call itself (no helper thread per call, so no abandoned
# thread can be left holding the old process's pipes); the watchdog's only job is to
# kill the process when a deadline passes. The killed process's pipes hit EOF, the
# EOF-safe reader above raises in the caller, and the *caller* — still holding the
# ExifTool lock — restarts the session before releasing it (see
# _GuardedExifTool._execute_watched). So exactly one thread ever restarts a given
# wedge, and every other thread waiting on the lock only ever sees the fresh process.

# How long after a kill the watchdog waits for the blocked call to unwind before
# logging that it didn't (i.e. something outside the killed tree still holds the pipe).
_UNWIND_GRACE_S = 10.0


class _Job:
    __slots__ = ("deadline", "kill", "killed_at", "warned", "label")

    def __init__(self, deadline: float, kill, label: str):
        self.deadline = deadline
        self.kill = kill            # () -> bool: True if a live process was killed
        self.killed_at: float | None = None
        self.warned = False
        self.label = label


class _Watchdog:
    def __init__(self):
        self._cond = threading.Condition()
        self._jobs: dict[int, _Job] = {}
        self._seq = 0
        self._thread: threading.Thread | None = None

    def arm(self, kill, timeout_s: float, label: str = "") -> int:
        with self._cond:
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="exiftool-watchdog", daemon=True)
                self._thread.start()
            self._seq += 1
            self._jobs[self._seq] = _Job(time.monotonic() + timeout_s, kill, label)
            self._cond.notify()
            return self._seq

    def disarm(self, token: int) -> bool:
        """Retire a job. Returns True if the watchdog killed its process. Taken under
        the same condition the kill runs under, so a call that completes in the same
        instant the deadline passes gets a definite answer, never a half-killed one."""
        with self._cond:
            job = self._jobs.pop(token, None)
            return job is not None and job.killed_at is not None

    def _run(self):
        with self._cond:
            while True:
                now = time.monotonic()
                next_wake: float | None = None
                for job in list(self._jobs.values()):
                    if job.killed_at is None:
                        if now >= job.deadline:
                            # Kill while holding the condition: disarm() can't slip in
                            # between "deadline passed" and "process killed".
                            killed = False
                            try:
                                killed = job.kill()
                            except Exception as e:
                                logger.error(f"ExifTool watchdog: kill failed: {e}")
                            if killed:
                                job.killed_at = now
                                logger.warning(f"ExifTool call exceeded its deadline ({job.label}); killed the process")
                                wake = now + _UNWIND_GRACE_S
                            else:
                                # No live process to kill (e.g. mid-restart): look again shortly.
                                wake = now + 0.5
                        else:
                            wake = job.deadline
                    elif not job.warned:
                        if now >= job.killed_at + _UNWIND_GRACE_S:
                            job.warned = True
                            logger.error(
                                f"ExifTool was killed {_UNWIND_GRACE_S:.0f}s ago but the blocked call "
                                f"({job.label}) has not returned; something outside the killed "
                                f"process tree still holds its pipe")
                            continue
                        wake = job.killed_at + _UNWIND_GRACE_S
                    else:
                        continue
                    next_wake = wake if next_wake is None else min(next_wake, wake)
                self._cond.wait(None if next_wake is None else max(0.0, next_wake - time.monotonic()))


_watchdog = _Watchdog()

# Per-thread deadline override set by run_with_timeout (scripts); None → config value.
_tls = threading.local()


def _effective_timeout() -> float:
    override = getattr(_tls, "timeout", None)
    return config.EXIFTOOL_TIMEOUT if override is None else override


def _describe(params) -> str:
    """Short label for logs/errors: the last argument is the target file for every
    call this app makes."""
    if not params:
        return "no arguments"
    last = params[-1]
    last = last.decode("utf-8", "replace") if isinstance(last, bytes) else str(last)
    return last if len(last) <= 200 else "…" + last[-199:]


class _GuardedExifTool(exiftool.ExifToolHelper):
    """ExifToolHelper that serializes, validates and time-limits every call.

    Validation: refuses arguments containing a line break or NUL. pyexiftool feeds
    the -stay_open process one argument per line, so a line break inside any
    argument — a tag value, a place name, a file path — is read by ExifTool as
    additional arguments. That turns attacker-influenced text into arbitrary
    ExifTool options, including a second target file, which would break the
    "originals are immutable" guarantee. Nothing the app writes legitimately
    contains these characters.

    Every helper method (get_tags, execute_json, …) funnels through execute(), so
    checking, locking and the watchdog here cover all callers, reads included — the
    timeout lives in this one place rather than at each call site.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Both only touched while holding _et_lock.
        self._watch_depth = 0    # >0 while a watched call is on the stack (auto-start's -ver probe re-enters)
        self._recovering = False

    def execute(self, *params, **kwargs):
        for p in params:
            bad = (any(c in p for c in (b"\n", b"\r", b"\0")) if isinstance(p, bytes)
                   else any(c in str(p) for c in "\n\r\0"))
            if bad:
                raise ValueError("ExifTool argument contains a line break or NUL character")
        with _et_lock:
            timeout = _effective_timeout()
            if self._watch_depth or not timeout or not _EOF_SAFE:
                # Nested (ExifToolHelper's auto-start runs `-ver` through here while
                # the outer call's deadline is already armed and covers it), or the
                # watchdog is off.
                self._watch_depth += 1
                try:
                    return super().execute(*params, **kwargs)
                finally:
                    self._watch_depth -= 1
            return self._execute_watched(timeout, params, kwargs)

    def _execute_watched(self, timeout: float, params, kwargs):
        label = _describe(params)
        token = _watchdog.arm(self._kill_process, timeout, label)
        self._watch_depth += 1
        try:
            try:
                result = super().execute(*params, **kwargs)
            finally:
                self._watch_depth -= 1
                killed = _watchdog.disarm(token)
        except BaseException as e:
            if killed:
                # This thread was the one blocked on the dead pipe, and it has unwound
                # (the EOF-safe reader raised) before restarting — so it never touches
                # the new process's pipes, and it still holds the lock, so no other
                # thread can observe the gap or restart a second time.
                self._recover(f"timed out after {timeout:g}s on {label}")
                raise ExifToolTimeout(
                    f"ExifTool did not respond within {timeout:g}s on {label}; "
                    f"process was killed and restarted") from e
            if self._process_died():
                self._recover(f"exited mid-command on {label}")
            raise
        if killed:
            # Completed in the same instant the watchdog fired: the result is good,
            # but the process is gone, so restart before anyone else uses it.
            self._recover(f"was killed as a call on {label} completed")
        return result

    def _process_died(self) -> bool:
        proc = self._process
        return proc is not None and proc.poll() is not None

    def _kill_process(self) -> bool:
        """Watchdog callback (runs on the watchdog thread). Reads `_process` once;
        only the lock-holding caller ever replaces it."""
        proc = self._process
        if proc is None or proc.poll() is not None:
            # Already dead: report success so the caller's EOF is attributed to the
            # timeout (it'll restart either way).
            return proc is not None
        _kill_process_tree(proc)
        return True

    def _recover(self, reason: str) -> None:
        """Tear down the current (dead or wedged) process and start a fresh one in
        place. Caller holds _et_lock. Restarting *this* object rather than building a
        new one keeps every `et = get_et()` handle callers already hold valid, and
        reuses exactly the executable/encoding/common_args (the UTF-8 charset args)
        start_et() constructed it with."""
        proc = self._process
        if proc is not None:
            if proc.poll() is None:
                _kill_process_tree(proc)
            # Safe to close now: the only reader (this thread) has unwound.
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    if pipe is not None:
                        pipe.close()
                except Exception:
                    pass
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
        self._flag_running_false()
        if self._recovering:
            # The restart's own `-ver` probe failed; don't recurse. The session is left
            # stopped and ExifToolHelper's auto-start retries on the next call.
            return
        self._recovering = True
        try:
            self.run()
            logger.warning(f"ExifTool {reason}; restarted (pid {self._process.pid})")
        except Exception as e:
            logger.error(f"ExifTool {reason}; restart failed ({e}); will retry on next call")
            if self._process is not None and self._process.poll() is None:
                _kill_process_tree(self._process)
            self._flag_running_false()
        finally:
            self._recovering = False


def get_et() -> exiftool.ExifToolHelper:
    if _et_error:
        raise RuntimeError(f"ExifTool unavailable: {_et_error}")
    if _et is None:
        raise RuntimeError("ExifTool session not started")
    return _et


def get_et_lock() -> threading.RLock:
    """Get the (reentrant) lock for thread-safe ExifTool access. execute() already
    takes it per call; hold it yourself only to make several calls atomic (e.g. a
    read-then-write). Unserialized concurrent calls interleave on the pipe and leave
    both readers blocked forever."""
    return _et_lock


def exiftool_status() -> dict:
    if _et_error:
        return {"ok": False, "error": _et_error}
    if _et is None:
        return {"ok": False, "error": "not started"}
    return {"ok": True}


def start_et() -> bool:
    """Start the shared ExifTool session. Returns True if it's ready.

    Safe to call multiple times (no-op if already started). Used by both the
    server lifespan and standalone scripts so RAW/HEIC/video preview extraction
    works in either context.
    """
    global _et, _et_error
    if _et is not None:
        return True
    try:
        # encoding="utf-8" + "-charset filename=utf8" so tag values AND file paths
        # are exchanged as UTF-8 in both directions. Without this, the default
        # Windows code page (cp1252) mojibakes or outright fails on the many
        # non-Latin-1 place names from GeoNames (e.g. "Ōtemachi", "Zürich"), and
        # on non-cp1252 file paths. "-G -n" are pyexiftool's defaults, which the
        # rest of the app relies on (group-prefixed keys, numeric GPS/orientation).
        # A watchdog restart (_GuardedExifTool._recover) re-runs this same object,
        # so these arguments carry over unchanged.
        _et = _GuardedExifTool(
            executable=config.EXIFTOOL_PATH,
            encoding="utf-8",
            common_args=["-charset", "filename=utf8", "-G", "-n"],
        )
        version = _et.execute("-ver").strip()
        _et_error = None
        print(f"ExifTool {version} ready ({config.EXIFTOOL_PATH})")
        return True
    except FileNotFoundError:
        _et = None
        _et_error = (
            f"ExifTool binary not found at '{config.EXIFTOOL_PATH}'. "
            "Run: uv run python scripts/get_exiftool.py"
        )
        print(f"WARNING: {_et_error}")
        return False
    except Exception as e:
        # The helper auto-starts the process on first execute(), so a failure
        # after that point (e.g. the `-ver` probe itself) leaves a live
        # -stay_open child. Terminate it before dropping the only handle, or it
        # lingers until the app exits. Best-effort: we're reporting `e` regardless.
        et, _et = _et, None
        try:
            if et is not None and et.running:
                et.terminate()
        except Exception:
            pass
        _et_error = str(e)
        print(f"WARNING: ExifTool startup failed: {e}")
        return False


def stop_et():
    """Terminate the shared ExifTool session if running."""
    global _et
    if _et is not None:
        _et.terminate()
        _et = None


def restart_et() -> bool:
    """Force-restart the shared session in place (or start it if it isn't). Returns
    True if it's ready. Rarely needed: a timed-out call already restarts it."""
    with _et_lock:
        if _et is None:
            return start_et()
        _et._recover("restart requested")
        return _et.running


def run_with_timeout(fn, timeout_s: float):
    """Run `fn` (which makes ExifTool calls) with a per-call deadline of `timeout_s`
    instead of config.EXIFTOOL_TIMEOUT, returning its result.

    `fn` runs on the calling thread; the override applies to every ExifTool call it
    makes on that thread. A call that overruns is handled by the session watchdog
    like any other: the process is killed and restarted in place, and
    ExifToolTimeout (a TimeoutError) is raised out of `fn`. Safe alongside other
    threads using the session — they wait on the lock and see only the fresh process.
    Note the deadline is per ExifTool call, not for `fn` as a whole.
    """
    prev = getattr(_tls, "timeout", None)
    _tls.timeout = timeout_s
    try:
        return fn()
    finally:
        _tls.timeout = prev


@asynccontextmanager
async def lifespan(app):
    start_et()
    yield
    stop_et()
