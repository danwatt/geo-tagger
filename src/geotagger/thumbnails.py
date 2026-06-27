import hashlib
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from geotagger.config import THUMB_SIZE, PREVIEW_SIZE, CACHE_DIR_NAME, get_cache_dir, VIDEO_EXTENSIONS
from geotagger.exiftool_session import get_et, get_et_lock

_thumbs_dir: Path | None = None


def init_thumbs(root: Path | None = None):
    """Initialize thumbnails directory. If CACHE_DIR is set, use that; otherwise use root / CACHE_DIR_NAME."""
    global _thumbs_dir

    cache_dir_from_env = get_cache_dir()
    if cache_dir_from_env:
        cache_dir = cache_dir_from_env
    elif root:
        cache_dir = root / CACHE_DIR_NAME
    else:
        raise RuntimeError("Must specify root directory or set GEOTAGGER_CACHE_DIR")

    _thumbs_dir = cache_dir / "thumbs"
    _thumbs_dir.mkdir(parents=True, exist_ok=True)


def _get_thumbs_dir() -> Path:
    if _thumbs_dir is None:
        raise RuntimeError("Thumbnails not initialized — call init_thumbs first")
    return _thumbs_dir


def _cache_key(path: Path, mtime: float, size: int) -> str:
    return hashlib.sha1(f"{path}:{mtime}:{size}".encode()).hexdigest()


# EXIF orientation (1..8) → the PIL transpose that brings a sensor-orientation
# image upright. Same mapping PIL's ImageOps.exif_transpose uses, but driven by a
# value we read ourselves — embedded RAW/HEIC previews often carry no tag, so the
# image can't be relied on to describe its own rotation. 1 has no entry (no-op).
_EXIF_TRANSPOSE = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,   # EXIF "rotate 90° CW" = PIL rotate 270° CCW
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,    # EXIF "rotate 90° CCW"
}


def apply_orientation(img: Image.Image, orientation: int | None) -> Image.Image:
    """Return ``img`` rotated/flipped upright for its EXIF ``orientation`` (1..8).
    1/None is a no-op (the common landscape case)."""
    method = _EXIF_TRANSPOSE.get(orientation or 1)
    # NB: FLIP_LEFT_RIGHT's enum value is 0 (falsy), so test for None explicitly.
    return img.transpose(method) if method is not None else img


def _orient_suffix(orientation: int | None) -> str:
    """Cache-filename suffix so oriented renditions never collide with the
    canonical (sensor-space) ones — and so orientation 1 keeps its existing files,
    avoiding needless regeneration for the landscape majority."""
    return "" if not orientation or orientation == 1 else f"_o{orientation}"


def orient_bbox(bbox, orientation: int | None) -> list[float]:
    """Map a normalized (x1, y1, x2, y2) box from sensor space to display space
    for the given EXIF ``orientation``, returned axis-aligned. Lets stored boxes
    (always sensor-space) line up over an oriented preview without re-detection."""
    o = orientation or 1
    if o == 1:
        return [float(v) for v in bbox]
    x1, y1, x2, y2 = (float(v) for v in bbox)

    def pt(x, y):
        return {
            2: (1 - x, y),       3: (1 - x, 1 - y),  4: (x, 1 - y),
            5: (y, x),           6: (1 - y, x),      7: (1 - y, 1 - x),
            8: (y, 1 - x),
        }.get(o, (x, y))

    ax, ay = pt(x1, y1)
    bx, by = pt(x2, y2)
    return [min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)]


def _extract_embedded_preview(path: Path) -> bytes | None:
    et = get_et()
    lock = get_et_lock()

    with lock:
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


def _make_thumbnail(path: Path, max_size: int, is_video: bool = False,
                    orientation: int | None = None) -> bytes:
    img = _open_image(path)
    img = img.convert("RGB")
    img = apply_orientation(img, orientation)
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


def thumbnail_exists(path: Path, mtime: float, size: int) -> bool:
    """Check if a thumbnail already exists in the cache."""
    try:
        thumbs = _get_thumbs_dir()
        key = _cache_key(path, mtime, size)
        subdir = thumbs / key[:2]
        cached = subdir / (key + "_thumb.jpg")
        return cached.exists()
    except Exception:
        return False


def get_thumbnail(path: Path, mtime: float, size: int,
                  orientation: int | None = None) -> bytes:
    """Grid thumbnail, rotated upright for ``orientation`` (display-only path)."""
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    # Use first 2 chars of hash as subdirectory
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    cached = subdir / f"{key}_thumb{_orient_suffix(orientation)}.jpg"
    if cached.exists():
        return cached.read_bytes()
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, THUMB_SIZE, is_video=is_video, orientation=orientation)
    cached.write_bytes(data)
    return data


def get_preview(path: Path, mtime: float, size: int) -> bytes:
    """Canonical preview in sensor orientation (NOT rotated).

    This is the recognition pipeline's input and the source for face crops, so
    its pixels — and the face bboxes normalized to them — stay in a fixed space.
    Use ``get_preview_oriented`` for display.
    """
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    # Use first 2 chars of hash as subdirectory
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    cached = subdir / (key + "_preview.jpg")
    if cached.exists():
        return cached.read_bytes()
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, PREVIEW_SIZE, is_video=is_video)
    cached.write_bytes(data)
    return data


def get_preview_oriented(path: Path, mtime: float, size: int,
                         orientation: int | None = None) -> bytes:
    """Display preview with EXIF orientation applied.

    orientation 1/None returns the canonical preview as-is (no extra file). For
    rotated photos the canonical preview is rotated once and cached separately.
    """
    if not orientation or orientation == 1:
        return get_preview(path, mtime, size)
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    cached = subdir / f"{key}_preview_o{orientation}.jpg"
    if cached.exists():
        return cached.read_bytes()
    img = Image.open(io.BytesIO(get_preview(path, mtime, size))).convert("RGB")
    img = apply_orientation(img, orientation)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    data = buf.getvalue()
    cached.write_bytes(data)
    return data


def get_face_crop(path: Path, mtime: float, size: int, bbox: tuple[float, float, float, float],
                  margin: float = 0.4, out_size: int = 160,
                  orientation: int | None = None) -> bytes:
    """Return a square JPEG crop of one face, cropped from the cached preview.

    bbox is normalized (0..1) to the canonical (sensor-space) preview, so the
    crop region is computed there and the resulting tile is rotated upright for
    ``orientation`` last. The crop is padded by `margin` (fraction of the box
    size) and squared off, then cached on disk keyed by the photo, the box, and
    the orientation so the grid loads fast.
    """
    thumbs = _get_thumbs_dir()
    bbox_key = hashlib.sha1(",".join(f"{v:.4f}" for v in bbox).encode()).hexdigest()[:10]
    key = _cache_key(path, mtime, size)
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    cached = subdir / f"{key}_face_{bbox_key}{_orient_suffix(orientation)}.jpg"
    if cached.exists():
        return cached.read_bytes()

    img = Image.open(io.BytesIO(get_preview(path, mtime, size))).convert("RGB")
    w, h = img.size
    x1, y1, x2, y2 = bbox[0] * w, bbox[1] * h, bbox[2] * w, bbox[3] * h
    bw, bh = x2 - x1, y2 - y1
    # Pad to a square box centred on the face so crops are uniform.
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = max(bw, bh) * (1 + margin) / 2
    left, top = int(max(0, cx - half)), int(max(0, cy - half))
    right, bottom = int(min(w, cx + half)), int(min(h, cy + half))
    crop = img.crop((left, top, right, bottom))
    crop = apply_orientation(crop, orientation)  # show the face upright
    crop = crop.resize((out_size, out_size), Image.LANCZOS)

    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=85)
    data = buf.getvalue()
    cached.write_bytes(data)
    return data
