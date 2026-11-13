from contextlib import asynccontextmanager
import threading
import exiftool
from geotagger import config

_et: "_GuardedExifTool | None" = None
_et_error: str | None = None
# Reentrant: the -stay_open session is a single request/response pipe, so EVERY
# native call from a worker thread must hold this. sidecar.py takes it around each
# call internally, and some callers (e.g. geocode_service.export_to_sidecars) also
# hold it around a whole sidecar.write_gps() — which itself reads metadata — so a
# plain Lock would self-deadlock on that nesting.
_et_lock = threading.RLock()


class _GuardedExifTool(exiftool.ExifToolHelper):
    """ExifToolHelper that refuses arguments containing a line break or NUL.

    pyexiftool feeds the -stay_open process one argument per line, so a line
    break inside any argument — a tag value, a place name, a file path — is
    read by ExifTool as additional arguments. That turns attacker-influenced
    text into arbitrary ExifTool options, including a second target file, which
    would break the "originals are immutable" guarantee. Every helper method
    (get_tags, execute_json, …) funnels through execute(), so checking here
    covers all callers, reads included. Nothing the app writes legitimately
    contains these characters.
    """

    def execute(self, *params, **kwargs):
        for p in params:
            bad = (any(c in p for c in (b"\n", b"\r", b"\0")) if isinstance(p, bytes)
                   else any(c in str(p) for c in "\n\r\0"))
            if bad:
                raise ValueError("ExifTool argument contains a line break or NUL character")
        return super().execute(*params, **kwargs)


def get_et() -> exiftool.ExifToolHelper:
    if _et_error:
        raise RuntimeError(f"ExifTool unavailable: {_et_error}")
    if _et is None:
        raise RuntimeError("ExifTool session not started")
    return _et


def get_et_lock() -> threading.RLock:
    """Get the (reentrant) lock for thread-safe ExifTool access. Hold it around
    every native call on the shared session: unserialized concurrent calls
    interleave on the pipe and leave both readers blocked forever."""
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
        _et = None
        _et_error = str(e)
        print(f"WARNING: ExifTool startup failed: {e}")
        return False


def stop_et():
    """Terminate the shared ExifTool session if running."""
    global _et
    if _et is not None:
        _et.terminate()
        _et = None


def _kill_et():
    """Force-kill the ExifTool subprocess and drop the session handle.

    Used to recover from a *wedged* session: a file that makes ExifTool hang blocks
    the -stay_open pipe with no way to time the read out (pyexiftool exposes no
    per-command timeout). We SIGKILL the OS process instead of the clean
    ``terminate()`` because terminate() calls ``communicate()``, which would race
    with the worker thread still blocked reading the same pipe. Killing the process
    makes that blocked read hit EOF and unwind on its own.
    """
    global _et
    et = _et
    _et = None  # drop the handle first so get_et() forces a restart
    if et is not None:
        try:
            proc = getattr(et, "_process", None)
            if proc is not None:
                proc.kill()
        except Exception:
            pass  # best-effort; we're abandoning this session regardless


def restart_et() -> bool:
    """Kill a wedged ExifTool session and start a fresh one. Returns True if ready."""
    _kill_et()
    return start_et()


def run_with_timeout(fn, timeout_s: float):
    """Run an ExifTool call with a wall-clock timeout, returning its result.

    pyexiftool talks to a persistent -stay_open process over a pipe and offers no
    per-command timeout, so a file that makes ExifTool hang blocks forever. We run
    `fn` in a daemon thread and wait up to `timeout_s`. If it doesn't finish we treat
    the session as wedged: kill the subprocess (which unblocks the thread's now-dead
    pipe read) and raise TimeoutError. The session is left stopped afterwards — call
    restart_et() (or start_et()) before the next read.

    Intended for single-threaded callers (scripts / backfills); it is not safe to
    call while another thread is using the same session, since it kills the process.
    """
    import threading

    box: dict = {}

    def worker():
        try:
            box["result"] = fn()
        except BaseException as e:  # propagate genuine ExifTool errors to the caller
            box["error"] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        _kill_et()  # wedged; abandon the session so the blocked read unwinds
        raise TimeoutError(f"ExifTool call exceeded {timeout_s:.0f}s")
    if "error" in box:
        raise box["error"]
    return box.get("result")


@asynccontextmanager
async def lifespan(app):
    start_et()
    yield
    stop_et()
