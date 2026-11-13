"""Bundling original media files into a ZIP archive for download. Blocking and
framework-free; called from routes via run_in_executor.

The archive is built on disk, never in memory: a few hundred RAW files is several
GB, and the previous in-memory build held that in RAM (and then again in the browser
tab). Originals are only ever read here — never written."""

import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from geotagger import config, index

logger = logging.getLogger(__name__)

TEMP_PREFIX = "geotagger-zip-"


class ZipSelectionError(Exception):
    """The selection can't be turned into an archive. ``kind`` is 'none_found'
    (nothing requested exists on disk) or 'too_large' (over the byte cap)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


@dataclass
class ZipPlan:
    members: list[tuple[str, str, int]]  # (source path, archive name, size in bytes)
    total_bytes: int
    skipped: int  # requested ids with no DB row or no file on disk


def _fmt_bytes(n: int) -> str:
    return f"{n / (1024 ** 3):.2f} GiB" if n >= 1024 ** 3 else f"{n / (1024 ** 2):.1f} MiB"


def plan_zip(photo_ids: list[int]) -> ZipPlan:
    """Resolve and stat the requested photos before any archive work, so an empty
    or oversized selection fails fast. Duplicate filenames (same name in
    different directories) get a numeric suffix so nothing is silently
    overwritten inside the archive. Duplicate ids are collapsed."""
    ids = list(dict.fromkeys(photo_ids))
    # One bound-JSON query instead of a get_photo() per id; map back to request order.
    rows = {r["id"]: r for r in index.get_photos(ids=ids)}
    members: list[tuple[str, str, int]] = []
    used_names: dict[str, int] = {}
    total = 0
    skipped = 0
    for pid in ids:
        row = rows.get(pid)
        if row is None:
            skipped += 1
            continue
        src = Path(index.photo_path(row))
        try:
            size = src.stat().st_size if src.is_file() else None
        except OSError:
            size = None
        if size is None:
            skipped += 1
            continue
        name = row["filename"]
        if name in used_names:
            used_names[name] += 1
            stem, ext = Path(name).stem, Path(name).suffix
            name = f"{stem} ({used_names[name]}){ext}"
        else:
            used_names[name] = 0
        members.append((str(src), name, size))
        total += size
    if not members:
        raise ZipSelectionError("none_found", "None of the selected files exist on disk.")
    limit = config.ZIP_MAX_BYTES  # module-attribute access: tests monkeypatch it
    if limit and total > limit:
        raise ZipSelectionError(
            "too_large",
            f"Selection is {_fmt_bytes(total)}, over the {_fmt_bytes(limit)} download limit "
            f"(GEOTAGGER_ZIP_MAX_BYTES). Select fewer photos.")
    return ZipPlan(members, total, skipped)


def build_zip(plan: ZipPlan) -> str:
    """Write the archive to a temp file and return its path (caller deletes it).
    ZIP_STORED: photos/videos are already compressed, deflate would only burn CPU."""
    import zipfile

    fd, path = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".zip")
    try:
        with os.fdopen(fd, "wb") as fh, zipfile.ZipFile(fh, "w", zipfile.ZIP_STORED) as zf:
            for src, name, _size in plan.members:
                zf.write(src, arcname=name)
    except BaseException:
        remove_quietly(path)
        raise
    return path


def remove_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def sweep_stale_temp() -> None:
    """Delete archives a crashed/killed previous run left in the temp dir. Only
    ones over an hour old: a second instance (another library, another port) may
    be serving a fresh one right now."""
    import time
    cutoff = time.time() - 3600
    for p in Path(tempfile.gettempdir()).glob(f"{TEMP_PREFIX}*.zip"):
        try:
            if p.stat().st_mtime < cutoff:
                remove_quietly(str(p))
        except OSError:
            pass
