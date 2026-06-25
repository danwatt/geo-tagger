import hashlib
import io
from pathlib import Path

from PIL import Image
from geotagger.config import THUMB_SIZE, PREVIEW_SIZE, CACHE_DIR_NAME
from geotagger.exiftool_session import get_et

_thumbs_dir: Path | None = None


def init_thumbs(root: Path):
    global _thumbs_dir
    _thumbs_dir = root / CACHE_DIR_NAME / "thumbs"
    _thumbs_dir.mkdir(parents=True, exist_ok=True)


def _get_thumbs_dir() -> Path:
    if _thumbs_dir is None:
        raise RuntimeError("Thumbnails not initialized — call init_thumbs first")
    return _thumbs_dir


def _cache_key(path: Path, mtime: float, size: int) -> str:
    return hashlib.sha1(f"{path}:{mtime}:{size}".encode()).hexdigest()


def _extract_embedded_preview(path: Path) -> bytes | None:
    et = get_et()
    for tag in ("-PreviewImage", "-JpgFromRaw", "-ThumbnailImage"):
        try:
            data = et.execute("-b", tag, str(path), raw_bytes=True)
            if data and len(data) > 100:
                return data
        except Exception:
            pass
    return None


def _open_image(path: Path) -> Image.Image:
    ext = path.suffix.lower()
    if ext in {".heic", ".heif"}:
        # Try embedded preview first
        preview = _extract_embedded_preview(path)
        if preview:
            return Image.open(io.BytesIO(preview))
        # Fallback: pillow-heif
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
            return Image.open(path)
        except Exception:
            raise RuntimeError(f"Cannot decode HEIC: {path}")
    elif ext in {".nef", ".dng", ".tif", ".tiff"}:
        preview = _extract_embedded_preview(path)
        if preview:
            return Image.open(io.BytesIO(preview))
        return Image.open(path)
    else:
        return Image.open(path)


def _make_thumbnail(path: Path, max_size: int) -> bytes:
    img = _open_image(path)
    img = img.convert("RGB")
    img.thumbnail((max_size, max_size), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def get_thumbnail(path: Path, mtime: float, size: int) -> bytes:
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size) + "_thumb.jpg"
    cached = thumbs / key
    if cached.exists():
        return cached.read_bytes()
    data = _make_thumbnail(path, THUMB_SIZE)
    cached.write_bytes(data)
    return data


def get_preview(path: Path, mtime: float, size: int) -> bytes:
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size) + "_preview.jpg"
    cached = thumbs / key
    if cached.exists():
        return cached.read_bytes()
    data = _make_thumbnail(path, PREVIEW_SIZE)
    cached.write_bytes(data)
    return data
