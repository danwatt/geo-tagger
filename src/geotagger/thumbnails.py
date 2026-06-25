import hashlib
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from geotagger.config import THUMB_SIZE, PREVIEW_SIZE, CACHE_DIR_NAME, VIDEO_EXTENSIONS
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


def _frame_via_av(path: Path) -> Image.Image:
    """Extract a representative frame from a video using PyAV."""
    import av as _av
    with _av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            raise RuntimeError("No video stream found")

        # Seek to ~10% of duration for a more interesting frame than frame 0
        duration = container.duration  # microseconds, may be None
        if duration:
            target_us = int(duration * 0.10)
            container.seek(target_us)

        for frame in container.decode(stream):
            img = frame.to_image()  # returns PIL Image
            return img

    raise RuntimeError("Could not decode any video frame")


def _open_image(path: Path) -> Image.Image:
    ext = path.suffix.lower()

    if ext in VIDEO_EXTENSIONS:
        # Try ExifTool embedded thumbnail first (fast, works for many MOV files)
        preview = _extract_embedded_preview(path)
        if preview:
            return Image.open(io.BytesIO(preview))
        # Fall back to PyAV frame extraction
        return _frame_via_av(path)

    if ext in {".heic", ".heif"}:
        preview = _extract_embedded_preview(path)
        if preview:
            return Image.open(io.BytesIO(preview))
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
            return Image.open(path)
        except Exception:
            raise RuntimeError(f"Cannot decode HEIC: {path}")

    if ext in {".nef", ".dng", ".tif", ".tiff"}:
        preview = _extract_embedded_preview(path)
        if preview:
            return Image.open(io.BytesIO(preview))
        return Image.open(path)

    return Image.open(path)


def _make_thumbnail(path: Path, max_size: int, is_video: bool = False) -> bytes:
    img = _open_image(path)
    img = img.convert("RGB")
    img.thumbnail((max_size, max_size), Image.LANCZOS)

    if is_video:
        _stamp_play_icon(img)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _stamp_play_icon(img: Image.Image):
    """Draw a semi-transparent play triangle in the centre of the image."""
    w, h = img.size
    size = min(w, h) // 4

    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    cx, cy = w // 2, h // 2
    r = size // 2

    # Circle background
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 140))

    # Triangle (pointing right)
    tip_x = cx + r * 2 // 5
    draw.polygon([
        (cx - r // 3, cy - r // 2),
        (cx - r // 3, cy + r // 2),
        (tip_x,       cy),
    ], fill=(255, 255, 255, 220))

    img.paste(Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB"), (0, 0))


def get_thumbnail(path: Path, mtime: float, size: int) -> bytes:
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size) + "_thumb.jpg"
    cached = thumbs / key
    if cached.exists():
        return cached.read_bytes()
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, THUMB_SIZE, is_video=is_video)
    cached.write_bytes(data)
    return data


def get_preview(path: Path, mtime: float, size: int) -> bytes:
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size) + "_preview.jpg"
    cached = thumbs / key
    if cached.exists():
        return cached.read_bytes()
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, PREVIEW_SIZE, is_video=is_video)
    cached.write_bytes(data)
    return data
