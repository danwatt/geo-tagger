import hashlib
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from geotagger import config
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


# ── Rendition encoding (one place, so format is switchable) ──

def cache_ext() -> str:
    """File extension for cached renditions, per ``config.THUMB_FORMAT``. Part of every
    cache filename so a format switch reads/writes a distinct set of files rather than
    serving a stale mix."""
    return ".webp" if config.THUMB_FORMAT == "webp" else ".jpg"


def media_type() -> str:
    """HTTP content type matching ``cache_ext()`` — routes serving these bytes must use
    this, not a hardcoded image/jpeg."""
    return "image/webp" if config.THUMB_FORMAT == "webp" else "image/jpeg"


def _encode(img: Image.Image, quality: int | None = None) -> bytes:
    """Encode ``img`` in the configured rendition format. ``quality`` defaults to
    ``config.THUMB_QUALITY``; the scales differ per format, hence the per-format
    defaults in config."""
    q = config.THUMB_QUALITY if quality is None else quality
    buf = io.BytesIO()
    if config.THUMB_FORMAT == "webp":
        img.save(buf, format="WEBP", quality=q, method=config.WEBP_METHOD)
    else:
        img.save(buf, format="JPEG", quality=q, optimize=True)
    return buf.getvalue()


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


# The orientation code that undoes each EXIF orientation. Rotations 6 and 8 are
# inverses of each other; the flips (2, 4), 180 (3), and transposes (5, 7) are each
# their own inverse, so they map to themselves via the .get default below.
_INVERSE_ORIENTATION = {6: 8, 8: 6}


def unorient_bbox(bbox, orientation: int | None) -> list[float]:
    """Inverse of ``orient_bbox``: map a normalized box from display space back to
    sensor space. Detection runs on the upright (oriented) image, so its boxes come
    out in display space; this maps them into the sensor-space convention the rest of
    the pipeline (storage, ``get_face_crop``, ``orient_bbox`` for display) relies on."""
    o = orientation or 1
    return orient_bbox(bbox, _INVERSE_ORIENTATION.get(o, o))


def _fd_suffix(path: Path) -> str:
    """Cache-filename marker distinguishing full-RAW-decode renditions from the
    embedded-preview ones, so toggling ``config.RAW_FULL_DECODE`` swaps to a
    different set of cache files instead of serving a stale mix. Empty for non-RAW
    files and whenever the setting is off."""
    return "_fd" if config.RAW_FULL_DECODE and path.suffix.lower() in config.RAW_EXTENSIONS else ""


def _decode_raw_full(path: Path) -> Image.Image:
    """Full-resolution demosaic of a camera RAW via rawpy/LibRaw → a PIL RGB image.

    Heavier than the embedded preview but higher quality; used only when
    ``config.RAW_FULL_DECODE`` is enabled (see ``get_preview`` /
    ``get_detection_preview``). rawpy is a heavy native import, so it's imported
    lazily here, matching the module's local-import convention.

    ``user_flip=0`` is essential: rawpy/LibRaw otherwise auto-applies the sensor's
    orientation flip and returns an already-upright image. This module's whole
    contract is that the canonical decode is in **sensor space** (like the embedded
    preview), so previews and ``get_face_crop`` stay in a fixed space and rotation is
    applied explicitly via ``apply_orientation`` / ``orient_bbox`` from the DB
    orientation. (Detection separately rotates a copy upright — see
    ``get_detection_preview`` — but the canonical decode itself must stay sensor-space,
    and using our own DB orientation is more reliable than trusting the RAW's flip.)"""
    import rawpy
    with rawpy.imread(str(path)) as raw:
        rgb = raw.postprocess(use_camera_wb=True, output_bps=8, user_flip=0)  # HxWx3 uint8 RGB, sensor orientation
    return Image.fromarray(rgb)


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


def _open_image(path: Path, full_decode: bool = False,
                orientation: int | None = None) -> Image.Image:
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
            img = Image.open(path)
            # Unlike every other branch here, libheif bakes the container's own
            # rotation/mirror (irot/imir) into the decoded pixels — it's a mandatory
            # HEIF transform, not a hint like EXIF orientation. That breaks this
            # module's sensor-space contract, since these HEICs (no PreviewImage to
            # fall back to) also carry a legacy EXIF orientation tag describing the
            # same rotation for compatibility. Undo the bake so callers can apply
            # that tag once via apply_orientation(), same as every other path.
            return apply_orientation(img, _INVERSE_ORIENTATION.get(orientation or 1, orientation or 1))
        except Exception:
            raise RuntimeError(f"Cannot decode HEIC: {path}")

    # Opt-in full RAW demosaic (config.RAW_FULL_DECODE). Try LibRaw first; on any
    # failure fall through to the embedded-preview branch below so a decode error
    # never breaks preview generation.
    if full_decode and ext in config.RAW_EXTENSIONS:
        try:
            return _decode_raw_full(path)
        except Exception:
            pass

    if ext in {".nef", ".dng", ".tif", ".tiff"}:
        preview = _extract_embedded_preview(path)
        if preview:
            return Image.open(io.BytesIO(preview))
        return Image.open(path)

    return Image.open(path)


def _make_thumbnail(path: Path, max_size: int, is_video: bool = False,
                    orientation: int | None = None, full_decode: bool = False,
                    sensor_space: bool = False) -> bytes:
    """``orientation`` is always passed down to ``_open_image`` (needed to undo
    HEIC's baked-in container rotation regardless of display intent). ``sensor_space``
    skips the *display* rotation afterwards — set by ``get_preview``'s canonical,
    orientation-independent rendition."""
    img = _open_image(path, full_decode=full_decode, orientation=orientation)
    img = img.convert("RGB")
    if not sensor_space:
        img = apply_orientation(img, orientation)
    img.thumbnail((max_size, max_size), Image.LANCZOS)

    if is_video:
        _stamp_play_icon(img)

    return _encode(img)


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
        cached = subdir / (key + "_thumb" + cache_ext())
        return cached.exists()
    except Exception:
        return False


def face_crop_exists(path: Path, mtime: float, size: int,
                     bbox: tuple[float, float, float, float],
                     orientation: int | None = None) -> bool:
    """Check if a face crop already exists in the cache (mirrors ``get_face_crop``'s
    cache filename, minus the ``margin``/``out_size`` params — those aren't part of
    the cache key, so any prior crop for this bbox/orientation counts)."""
    try:
        thumbs = _get_thumbs_dir()
        bbox_key = hashlib.sha1(",".join(f"{v:.4f}" for v in bbox).encode()).hexdigest()[:10]
        key = _cache_key(path, mtime, size)
        subdir = thumbs / key[:2]
        cached = subdir / f"{key}_face_{bbox_key}{_fd_suffix(path)}{_orient_suffix(orientation)}{cache_ext()}"
        return cached.exists()
    except Exception:
        return False


def invalidate_photo_cache(path: Path, mtime: float, size: int) -> int:
    """Delete every cached thumbnail/preview/face-crop file for one photo.

    All of a photo's cached renditions (grid thumb, canonical + oriented previews,
    every face crop, every RAW-full-decode/orientation variant) share the same
    ``{key}`` prefix from ``_cache_key``, so a glob + unlink clears them all in one
    go. Used before a forced rebuild (e.g. re-deriving RAW previews/crops from a
    full decode) so no stale file lingers under a filename a later request could
    still hit. Returns the number of files removed.
    """
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    subdir = thumbs / key[:2]
    if not subdir.exists():
        return 0
    removed = 0
    for f in subdir.glob(f"{key}_*"):
        f.unlink()
        removed += 1
    return removed


def get_thumbnail(path: Path, mtime: float, size: int,
                  orientation: int | None = None) -> bytes:
    """Grid thumbnail, rotated upright for ``orientation`` (display-only path)."""
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    # Use first 2 chars of hash as subdirectory
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    cached = subdir / f"{key}_thumb{_orient_suffix(orientation)}{cache_ext()}"
    if cached.exists():
        return cached.read_bytes()
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, THUMB_SIZE, is_video=is_video, orientation=orientation)
    cached.write_bytes(data)
    return data


def rebuild_preview_from_full_decode(path: Path, mtime: float, size: int) -> bytes:
    """Force a full native decode (LibRaw for RAW files) and write it into the
    SAME cache slot ``get_preview()`` would read for the live
    ``config.RAW_FULL_DECODE`` setting — regardless of that setting's value.

    ``get_preview()`` only does a full RAW decode when the live setting is on, AND
    only checks the ``_fd``-suffixed filename in that case; if a caller flips the
    setting on just to force a decode, the result lands under a different filename
    than a server running with the setting off will ever look up, so the rebuilt
    image is silently never served. This bypasses that coupling: it always does the
    real decode but names the file via ``_fd_suffix`` at the setting's CURRENT
    value, so whatever a running server is actually configured to read gets the
    freshly decoded pixels. Used by ``scripts/rescan_raw_faces.py``'s
    ``--thumbnails-only`` mode. Non-RAW files just get their normal preview.
    """
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    is_raw = path.suffix.lower() in config.RAW_EXTENSIONS
    data = _make_thumbnail(path, PREVIEW_SIZE, full_decode=is_raw)
    cached = subdir / f"{key}_preview{_fd_suffix(path)}{cache_ext()}"
    cached.write_bytes(data)
    return data


def get_preview(path: Path, mtime: float, size: int,
                orientation: int | None = None) -> bytes:
    """Canonical preview in sensor orientation (NOT rotated).

    The source for face crops and the served webapp preview, so its pixels — and the
    face bboxes normalized to them — stay in a fixed space. Face *detection* runs on
    ``get_detection_preview`` (same canonical space, but a larger full RAW decode when
    ``config.RAW_FULL_DECODE`` is on). Use ``get_preview_oriented`` for display.

    ``orientation`` doesn't change this preview's pixels (still sensor space, and
    not part of the cache key) — it's only needed to undo HEIC's baked-in container
    rotation in ``_open_image`` so "sensor space" holds for those files too.
    """
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    # Use first 2 chars of hash as subdirectory
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    fd = _fd_suffix(path)
    cached = subdir / f"{key}_preview{fd}{cache_ext()}"
    if cached.exists():
        return cached.read_bytes()
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, PREVIEW_SIZE, is_video=is_video, orientation=orientation,
                           full_decode=bool(fd), sensor_space=True)
    cached.write_bytes(data)
    return data


def get_preview_oriented(path: Path, mtime: float, size: int,
                         orientation: int | None = None) -> bytes:
    """Display preview with EXIF orientation applied.

    orientation 1/None returns the canonical preview as-is (no extra file). For
    rotated photos the canonical preview is rotated once and cached separately.
    """
    if not orientation or orientation == 1:
        return get_preview(path, mtime, size, orientation)
    thumbs = _get_thumbs_dir()
    key = _cache_key(path, mtime, size)
    subdir = thumbs / key[:2]
    subdir.mkdir(exist_ok=True)
    cached = subdir / f"{key}_preview{_fd_suffix(path)}_o{orientation}{cache_ext()}"
    if cached.exists():
        return cached.read_bytes()
    img = Image.open(io.BytesIO(get_preview(path, mtime, size, orientation))).convert("RGB")
    img = apply_orientation(img, orientation)
    data = _encode(img)
    cached.write_bytes(data)
    return data


def get_detection_preview(path: Path, mtime: float, size: int,
                          orientation: int | None = None) -> tuple[bytes, bool]:
    """Return ``(encoded_bytes, ran_on_full_decode)`` — the UPRIGHT input for FACE DETECTION.

    Bytes are in ``config.THUMB_FORMAT`` (WebP by default) at ``THUMB_QUALITY_HIGH``;
    the caller decodes them with ``cv2.imdecode``, which handles both formats.

    Detection runs on the display-oriented image, NOT the sensor image: SCRFD (detector)
    and ArcFace (embedder) both expect upright faces, so a sideways face in a rotated
    photo would otherwise be missed and its embedding poor. The caller maps the resulting
    boxes back to sensor space (``unorient_bbox``) before storing, preserving the
    sensor-space storage convention ``get_face_crop`` / ``orient_bbox`` depend on. This
    is a no-op for orientation 1 (the common case), so only rotated photos change.

    With ``config.RAW_FULL_DECODE`` on and a RAW file, fully demosaics via LibRaw,
    rotates upright, and downscales to ``config.FACE_DECODE_MAX_DIM`` (larger than the
    served preview, so the ArcFace crops are sharper); built in memory, not disk-cached.
    Otherwise it reuses the oriented display preview. On any RAW decode failure it falls
    back to that oriented preview.

    The bool is True only when detection actually ran on a full/real decode; the caller
    stores it as the photo's ``faces_det_dimension`` (None ⇒ ran on the embedded/normal
    preview — the RAW progressive-re-run target). Non-RAW images take the ``False`` branch."""
    ext = path.suffix.lower()
    if config.RAW_FULL_DECODE and ext in config.RAW_EXTENSIONS:
        try:
            img = _decode_raw_full(path).convert("RGB")
            img = apply_orientation(img, orientation)   # detect on the upright image
            img.thumbnail((config.FACE_DECODE_MAX_DIM, config.FACE_DECODE_MAX_DIM), Image.LANCZOS)
            return _encode(img, quality=config.THUMB_QUALITY_HIGH), True
        except Exception:
            pass  # fall through to the oriented display preview
    return get_preview_oriented(path, mtime, size, orientation), False


def get_face_crop(path: Path, mtime: float, size: int, bbox: tuple[float, float, float, float],
                  margin: float = 0.4, out_size: int = 160,
                  orientation: int | None = None) -> bytes:
    """Return a square crop of one face (encoded per ``config.THUMB_FORMAT``), cropped
    from the cached preview.

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
    cached = subdir / f"{key}_face_{bbox_key}{_fd_suffix(path)}{_orient_suffix(orientation)}{cache_ext()}"
    if cached.exists():
        return cached.read_bytes()

    img = Image.open(io.BytesIO(get_preview(path, mtime, size, orientation))).convert("RGB")
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

    data = _encode(crop)
    cached.write_bytes(data)
    return data


def _box_font(size: int):
    """A truetype font at ``size`` px for face labels, falling back to the tiny
    bitmap default on older Pillow (load_default gained a size arg in 10.1)."""
    try:
        return ImageFont.load_default(size=size)
    except (TypeError, AttributeError):
        return ImageFont.load_default()


def _draw_box_label(draw: ImageDraw.ImageDraw, text: str, x: float, y: float,
                    color: tuple[int, int, int], font) -> None:
    """Draw a filled label chip with ``text`` just above (x, y)."""
    try:
        left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
        tw, th = right - left, bottom - top
    except Exception:  # very old Pillow without textbbox
        tw, th = len(text) * 7, 12
    pad = max(2, th // 4)
    top_y = max(0.0, y - th - 2 * pad)
    draw.rectangle([x, top_y, x + tw + 2 * pad, top_y + th + 2 * pad], fill=color)
    draw.text((x + pad, top_y + pad), text, fill=(20, 20, 20), font=font)


def render_fullsize_with_faces(path: Path, orientation: int | None,
                               face_specs: list[tuple[str, str | None, bool]]) -> bytes:
    """Full-resolution render of a photo with detected face boxes drawn on, as JPEG.

    RAW files (``config.RAW_EXTENSIONS``) are fully demosaiced via LibRaw; other
    images open directly. The image is rotated upright for ``orientation`` and each
    face's sensor-space normalized bbox is oriented to match (``orient_bbox``), scaled
    to pixels, and drawn as a colour-coded, labelled rectangle: green = assigned to a
    person, amber = unlabeled, grey = ignored. ``face_specs`` is a list of
    ``(bbox_str, person_name, ignored)``. Heavy (full decode + draw) — call from the
    executor, never the event loop. Not disk-cached: it's an on-demand full-size view.

    Deliberately always JPEG, unlike the cached renditions: nothing is stored so there's
    no size to save, and WebP caps at 16383px per side — a full-res sensor image can
    exceed that.
    """
    ext = path.suffix.lower()
    img = _decode_raw_full(path) if ext in config.RAW_EXTENSIONS else _open_image(path, orientation=orientation)
    img = img.convert("RGB")
    img = apply_orientation(img, orientation)
    w, h = img.size

    draw = ImageDraw.Draw(img)
    # Scale stroke + label with the image so both stay legible at full resolution.
    line_w = max(2, round(min(w, h) / 400))
    font = _box_font(max(12, round(min(w, h) / 60)))
    for bbox_str, name, ignored in face_specs:
        try:
            coords = [float(v) for v in bbox_str.split(",")]
        except (ValueError, AttributeError):
            continue
        ox1, oy1, ox2, oy2 = orient_bbox(coords, orientation)
        x1, y1, x2, y2 = ox1 * w, oy1 * h, ox2 * w, oy2 * h
        color = (150, 150, 150) if ignored else ((90, 200, 120) if name else (245, 200, 60))
        draw.rectangle([x1, y1, x2, y2], outline=color, width=line_w)
        if name and not ignored:
            _draw_box_label(draw, name, x1, y1, color, font)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()
