"""Telling a bad *file* apart from a broken *pipeline* in the face-detection and
semantic-indexing batch loops (audit F1).

Both loops record a per-photo failure so the client loop can move past a file that
will never decode — but the same blanket handler used to catch a model that failed
to load, so one bad model download marked every photo in the library as processed,
and neither queue ever looked at them again. The rule now:

- Only an error raised while reading/decoding one photo's own file, and classified
  here as being about that file, is recorded against the photo (``FileUnreadable``).
- Everything else — model load, inference, out of memory, disk full, an unwritable
  thumbnail cache, a missing photo folder, a decoder that failed to import — aborts
  the batch (``BatchAborted``) with nothing marked. When unsure it aborts: an aborted
  batch is retried by clicking the button again, a wrongly marked library is the bug.
- ``FailureStreak`` holds back the marks for a run of consecutive failures so a long
  one (the signature of a cause the classifier missed) can abort unwritten.

Framework-free: services raise these, routes turn ``BatchAborted`` into a 503."""

import errno
import os
from pathlib import Path
from typing import NoReturn

# OS errors that describe the machine, not the file being read: disk full, out of
# file handles, read-only or over-quota filesystem, out of memory.
_SYSTEMIC_ERRNOS = {e for e in (errno.ENOSPC, errno.EMFILE, errno.ENFILE, errno.EROFS,
                                errno.ENOMEM, getattr(errno, "EDQUOT", None)) if e is not None}


class FileUnreadable(Exception):
    """This photo's own file could not be read or decoded — record it and move on."""


class BatchAborted(RuntimeError):
    """A failure that is not about any one file. Nothing in the batch from the
    failing photo on is marked; routes answer 503 with ``as_detail()``.

    ``code`` lets the client tell the cases apart: "model" (the model failed to
    load or run), "systemic" (anything else not about one file), and
    "too_many_failures" (the consecutive-failure guard — the one the client offers
    to override, since those may really be bad files)."""

    def __init__(self, message: str, code: str = "systemic", errors: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.errors = errors or []

    def as_detail(self) -> dict:
        return {"code": self.code, "message": str(self), "errors": self.errors}


def _same_path(a, b: Path) -> bool:
    try:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
    except (TypeError, ValueError):
        return False


def is_file_error(exc: BaseException, path: Path) -> bool:
    """Whether ``exc``, raised while reading/decoding ``path`` into an image, is
    about that file (True) or must be treated as systemic (False).

    Decoders raise every type under the sun for a corrupt file (OSError,
    UnidentifiedImageError, ValueError, struct.error, av/rawpy errors, RuntimeError
    from our own "Cannot decode HEIC"), so the default is "the file" — and the
    known-systemic shapes are carved out first."""
    if isinstance(exc, FileUnreadable):
        return True
    # A broken install (decoder plugin won't import) or a starved machine fails
    # every file the same way.
    if isinstance(exc, (MemoryError, ImportError, RecursionError)):
        return False
    if isinstance(exc, OSError):
        if exc.errno in _SYSTEMIC_ERRNOS:
            return False
        # An OSError naming some OTHER file is the thumbnail cache (the preview is
        # written there on first build) or a temp file, not the photo.
        if exc.filename and not _same_path(exc.filename, path):
            return False
    # The photo's folder itself is gone: an unmounted drive or a renamed parent
    # folder, which takes every photo in it down at once. Left for the file scan to
    # prune or relink; a lone deleted file (folder still there) is per-file.
    try:
        if not path.parent.is_dir():
            return False
    except OSError:
        return False
    return True


def raise_classified(exc: BaseException, path: Path) -> NoReturn:
    """Re-raise a decode-stage exception as ``FileUnreadable`` when it is about the
    file, else unchanged (the batch loop then aborts on it). Call from an
    ``except`` block wrapping only the read/decode of ``path``."""
    if isinstance(exc, FileUnreadable):
        raise exc
    if is_file_error(exc, path):
        raise FileUnreadable(f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__) from exc
    raise exc


class FailureStreak:
    """Holds back the marks for a run of consecutive per-file failures.

    ``fail()`` queues one; once ``limit`` are queued (and the batch didn't opt out
    with ``allow``) it raises ``BatchAborted("too_many_failures")`` with those still
    unwritten. ``ok()`` (a photo succeeded — the pipeline works) and ``drain()``
    (end of batch) hand back the queued ones for the caller to write."""

    def __init__(self, limit: int, allow: bool = False):
        self.limit = limit if (limit > 0 and not allow) else 0
        self.pending: list = []
        self.messages: list[str] = []

    def fail(self, item, message: str) -> None:
        self.pending.append(item)
        self.messages.append(message)
        if self.limit and len(self.pending) >= self.limit:
            raise BatchAborted(
                f"{len(self.pending)} photos in a row could not be read, so the batch "
                f"stopped without marking them — this usually means the drive or a "
                f"decoder is unavailable rather than that the files are bad.",
                code="too_many_failures", errors=list(self.messages))

    def ok(self) -> list:
        return self.drain()

    def drain(self) -> list:
        out, self.pending, self.messages = self.pending, [], []
        return out
