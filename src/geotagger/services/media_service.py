"""Run a rendition (thumbnail, preview, face crop, full-size render) and classify
its failure, for the media routes (audit A6).

Every decoder fails differently on the same root cause — PIL raises
FileNotFoundError for a vanished JPEG, LibRaw an IO error, ExifTool/PyAV their
own — so the reliable test for "the file is gone" is to look after the failure,
not to match exception types. That look is a stat, which can hang on a dropped
network share, so it runs here in the executor with the render, never on the
event loop.

A render that succeeds from the disk cache doesn't touch the original at all, so
renditions of a file on an unplugged drive keep being served: only a photo that
actually needs decoding reports missing.
"""

from pathlib import Path
from typing import Callable


class MediaMissingError(Exception):
    """The photo's file is not on disk any more (moved or deleted since the scan)."""


class MediaDecodeError(Exception):
    """The file exists but can't be decoded (corrupt or unsupported)."""


def _is_decode_error(e: BaseException) -> bool:
    from PIL import Image, UnidentifiedImageError
    from geotagger.thumbnails import DecodeError
    types: list[type] = [DecodeError, UnidentifiedImageError, Image.DecompressionBombError]
    # Optional native decoders: only classify their errors if they're installed.
    try:
        import rawpy
        types.append(rawpy.LibRawError)
    except (ImportError, AttributeError):
        pass
    try:
        import av
        types.append(av.error.FFmpegError)
    except (ImportError, AttributeError):
        pass
    return isinstance(e, tuple(types))


def _file_present(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:      # unreachable share, permission on a parent dir…
        return False


def render(fn: Callable[..., bytes], path: Path, *args, **kwargs) -> bytes:
    """``fn(path, *args, **kwargs)``, with its failure translated: MediaMissingError
    when the file has gone, MediaDecodeError when it exists but won't decode, and
    anything else re-raised untouched (the route logs it and answers a generic 500).
    Call from the executor."""
    try:
        return fn(path, *args, **kwargs)
    except Exception as e:
        if not _file_present(path):
            raise MediaMissingError(str(path)) from e
        if _is_decode_error(e):
            raise MediaDecodeError(str(e)) from e
        raise
