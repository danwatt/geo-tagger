"""Crash-safe downloads for the offline datasets and model files.

Every "is it already downloaded?" check in the app is just "does the file exist
under its final name" — so the final name must never hold a partial file. A
download here streams into a temporary sibling, is verified (byte count against
Content-Length, plus an MD5 when the publisher offers one), optionally
transformed (e.g. OSM compaction, zip extraction), and only then moved into
place with os.replace. A timeout, a short body, a checksum mismatch or a failing
transform all leave nothing under the final name, and the temp file is removed.
A hard kill can still leave a temp file behind; it's never read as a cache hit
and the next attempt overwrites it.

Framework-free and stdlib-only (urllib), like the downloaders it replaces.
Windows: os.replace onto a final file that another handle has open can fail with
PermissionError — callers that replace a file the app may be reading (census DB,
cached extracts) still have to drop their own handles first.
"""

import hashlib
import logging
import os
import zipfile
import zlib
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

from geotagger import config

logger = logging.getLogger(__name__)

USER_AGENT = "geo-tagger-data-mgmt/1.0"
_CHUNK = 1 << 20

# progress(done_bytes, total_bytes_or_None) — total is the Content-Length when sent.
Progress = Callable[[int, int | None], None]


class DownloadError(RuntimeError):
    """A download arrived incomplete or failed verification. Deliberately not a
    URLError subclass: census_builder treats URLError as "this vintage isn't
    published, try the previous year", which a truncated transfer is not."""


def _open(url: str, timeout: float | None, headers: dict[str, str] | None):
    req = Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urlopen(req, timeout=config.DOWNLOAD_TIMEOUT if timeout is None else timeout)


def fetch_text(url: str, timeout: float | None = None, max_bytes: int = 1 << 16) -> str:
    """Small text resource (e.g. a published checksum file) read into memory."""
    with _open(url, timeout, None) as r:
        return r.read(max_bytes).decode("utf-8", "replace")


def check_zip(path: Path) -> None:
    """Raise DownloadError unless `path` is a readable zip whose members all pass
    their CRC check — the publisher-independent integrity check for archives that
    come without a checksum (or with no Content-Length, e.g. chunked responses)."""
    try:
        with zipfile.ZipFile(path) as zf:
            bad = zf.testzip()
    except (zipfile.BadZipFile, zlib.error, OSError, EOFError, ValueError) as e:
        # zlib.error: a damaged deflate stream fails before its CRC is compared.
        raise DownloadError(f"{path.name} is not a complete zip archive: {e}") from e
    if bad is not None:
        raise DownloadError(f"{path.name} is corrupt (CRC mismatch in {bad})")


def zip_ok(path: Path) -> bool:
    """check_zip as a bool — for vetting an archive already sitting in a cache."""
    try:
        check_zip(path)
        return True
    except DownloadError:
        return False


def extract_zip_txt(zip_part: Path) -> Path:
    """download_to transform for a single-dataset zip such as GeoNames'
    cities500.zip: CRC-check it, then extract its data .txt (not the readme)
    beside it. The returned temp file is what lands under the final name."""
    check_zip(zip_part)
    out = zip_part.with_name(zip_part.name + ".txt")
    try:
        with zipfile.ZipFile(zip_part) as zf:
            member = next(n for n in zf.namelist()
                          if n.endswith(".txt") and "readme" not in n.lower())
            with zf.open(member) as src, open(out, "wb") as f:
                while chunk := src.read(_CHUNK):
                    f.write(chunk)
    except BaseException:
        out.unlink(missing_ok=True)  # download_to only cleans up what's returned
        raise
    return out


def download_to(url: str, dest: Path, *, expected_md5: str | None = None,
                transform: Callable[[Path], Path | None] | None = None,
                progress: Progress | None = None, part: Path | None = None,
                timeout: float | None = None,
                headers: dict[str, str] | None = None) -> dict:
    """Download `url` to `dest` atomically. Blocking — run it on the executor.

    Flow: stream into `part` (default ``<dest>.part``) -> compare the byte count to
    Content-Length -> compare the MD5 of the raw bytes to `expected_md5` -> call
    ``transform(part)`` -> os.replace the result onto `dest`.

    `transform` gets the verified temp file and either rewrites it in place
    (return None) or writes a different file and returns that path, which is then
    what lands at `dest` (it should live beside `dest` so the rename stays on one
    filesystem). Checksums are taken on the raw download, before the transform,
    since a transform such as compaction changes the bytes. A transform that raises
    must remove any file of its own it had started; `part` is always removed here.

    `part` lets a caller keep the temp file out of a directory that is globbed by
    final-name pattern (the pbf cache) while still giving it a name a format-
    sniffing reader accepts.

    Returns {"bytes": raw bytes downloaded, "md5": hex digest of them}. Raises
    DownloadError on a short body or checksum mismatch, and lets urllib's
    HTTPError/URLError/TimeoutError through unchanged.
    """
    dest = Path(dest)
    part = Path(part) if part is not None else dest.with_name(dest.name + ".part")
    part.parent.mkdir(parents=True, exist_ok=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    produced: Path | None = None
    try:
        # Opened before the temp file, so an HTTP error (404 for a not-yet-published
        # Census vintage, say) never creates one.
        with _open(url, timeout, headers) as r:
            length = r.headers.get("Content-Length")
            total = int(length) if length and length.isdigit() else None
            md5 = hashlib.md5(usedforsecurity=False)
            done = 0
            with open(part, "wb") as f:
                while chunk := r.read(_CHUNK):
                    f.write(chunk)
                    md5.update(chunk)
                    done += len(chunk)
                    if progress:
                        progress(done, total)
        if total is not None and done != total:
            raise DownloadError(
                f"Incomplete download of {dest.name}: got {done:,} of {total:,} bytes")
        digest = md5.hexdigest()
        if expected_md5 is not None and digest.lower() != expected_md5.strip().lower():
            raise DownloadError(
                f"Checksum mismatch for {dest.name}: expected MD5 {expected_md5}, got {digest}")
        if transform is not None:
            produced = transform(part)
        final_src = produced if produced is not None else part
        os.replace(final_src, dest)
        return {"bytes": done, "md5": digest}
    finally:
        # Success leaves neither behind (the replaced one no longer exists);
        # any failure removes both so no stray temp file outlives the attempt.
        for leftover in {part, produced} - {None}:
            try:
                leftover.unlink(missing_ok=True)
            except OSError:
                # Windows: still open somewhere (pyosmium leaks a reader's handle
                # when a transform fails mid-read). Never mask the real error for
                # it — the next attempt truncates and overwrites the same name.
                logger.warning("Could not remove temp file %s", leftover, exc_info=True)
