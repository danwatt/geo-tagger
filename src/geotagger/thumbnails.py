import hashlib
import io
import os
import threading
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from geotagger import config
from geotagger.config import THUMB_SIZE, PREVIEW_SIZE, CACHE_DIR_NAME, get_cache_dir, VIDEO_EXTENSIONS
from geotagger.exiftool_session import get_et

_thumbs_dir: Path | None = None


class DecodeError(RuntimeError):
    """The file exists but none of our decoders could turn it into pixels (corrupt,
    truncated, or a codec we lack). A RuntimeError subclass so older broad catches
    keep working; the media routes map it to 422 instead of a generic 500."""


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
    # float()/int() so an int mtime (e.g. 1700000000 vs 1700000000.0) can't change
    # the key's text: the DB column is REAL, so every reader gets a float back, and a
    # caller passing the same instant as an int must land on the same file.
    return hashlib.sha1(f"{path}:{float(mtime)}:{int(size)}".encode()).hexdigest()


def _cache_file(path: Path, mtime: float, size: int, variant: str) -> Path:
    """``thumbs/{key[:2]}/{key}_{variant}{ext}`` — the one place a cached rendition's
    filename is assembled. ``variant`` carries everything after the key (``thumb``,
    ``thumb_o6``, ``face_<bbox>_fd_o8``…). Doesn't create the subdirectory."""
    key = _cache_key(path, mtime, size)
    return _get_thumbs_dir() / key[:2] / _cache_name(key, variant)


def _cache_name(key: str, variant: str) -> str:
    return f"{key}_{variant}{cache_ext()}"


def _thumb_variant(orientation: int | None) -> str:
    return f"thumb{_orient_suffix(orientation)}"


def _preview_variant(path: Path, orientation: int | None) -> str:
    return f"preview{_fd_suffix(path)}{_orient_suffix(orientation)}"


def _face_variant(path: Path, bbox: tuple[float, float, float, float],
                  orientation: int | None) -> str:
    bbox_key = hashlib.sha1(",".join(f"{v:.4f}" for v in bbox).encode()).hexdigest()[:10]
    return f"face_{bbox_key}{_fd_suffix(path)}{_orient_suffix(orientation)}"


def thumb_cache_path(path: Path, mtime: float, size: int, orientation: int | None) -> Path:
    """Cache file of the grid thumbnail. Shared by ``get_thumbnail`` (API, scan) and
    ``thumbnail_exists`` so the probe and the generator can't disagree on the name —
    the scan once probed/wrote the unsuffixed name while the API read ``_o{n}``
    (audit S4). ``mtime``/``size``/``orientation`` must be the values stored in the
    photo's DB row: those are what the API passes."""
    return _cache_file(path, mtime, size, _thumb_variant(orientation))


def _preview_cache_path(path: Path, mtime: float, size: int,
                        orientation: int | None = None) -> Path:
    """Cache file of the canonical (orientation None/1) or oriented preview, shared by
    ``get_preview``, ``get_preview_oriented`` and ``rebuild_preview_from_full_decode``."""
    return _cache_file(path, mtime, size, _preview_variant(path, orientation))


def _face_crop_cache_path(path: Path, mtime: float, size: int,
                          bbox: tuple[float, float, float, float],
                          orientation: int | None) -> Path:
    """Cache file of one face crop, shared by ``get_face_crop`` / ``face_crop_exists``."""
    return _cache_file(path, mtime, size, _face_variant(path, bbox, orientation))


def rendition_etag(path: Path, mtime: float, size: int, orientation: int | None,
                   kind: str, bbox: tuple[float, float, float, float] | None = None) -> str:
    """Opaque validator for one served rendition (``kind``: thumb / preview / face).

    Derived from the rendition's cache file name (built by the same helpers the
    cache uses), which by construction carries every input that changes its
    bytes: the (path, mtime, size) key, the orientation suffix (audit A6 — an ETag
    without it kept a sideways image after an orientation fix), the RAW
    full-decode marker, the face bbox, and the output format's extension. One
    source of truth, so a new cache-key input can't be forgotten here. Needs no
    initialized cache dir."""
    if kind == "thumb":
        variant = _thumb_variant(orientation)
    elif kind == "preview":
        variant = _preview_variant(path, orientation)
    elif kind == "face" and bbox is not None:
        variant = _face_variant(path, bbox, orientation)
    else:
        raise ValueError(f"unknown rendition kind {kind!r}")
    name = _cache_name(_cache_key(path, mtime, size), variant)
    return hashlib.sha1(name.encode()).hexdigest()[:20]


# ── Atomic cache I/O ──

def _read_cached(cached: Path) -> bytes | None:
    """Bytes of a cache hit, or None for a miss. A zero-length file counts as a miss
    (a truncated leftover from a crash or an old non-atomic write would otherwise be
    served forever, since the cache key never changes), as does any OS error reading it."""
    try:
        data = cached.read_bytes()
    except OSError:
        return None
    return data or None


def _cache_present(cached: Path) -> bool:
    """Cheap existence check (stat, no read) with the same zero-length-is-a-miss rule."""
    try:
        return cached.stat().st_size > 0
    except OSError:
        return False


def _write_cached(cached: Path, data: bytes) -> None:
    """Write a cache file atomically: temp sibling then ``os.replace``, so a concurrent
    reader sees either no file or the complete one, never a partial write.

    The temp name is unique per writer (pid + thread + uuid) so two threads generating the
    same rendition don't clobber each other's temp. It keeps the ``{key}_`` prefix (so
    ``invalidate_photo_cache`` sweeps stray temps) but ends in ``.tmp``, so it can never
    equal a real cache filename. On Windows ``os.replace`` raises PermissionError if a
    reader has the destination open at that instant; that (or the temp having been swept
    away) means someone else's complete file is already in place, so it is not an error.
    """
    tmp = cached.with_name(
        f"{cached.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        try:
            os.replace(tmp, cached)
        except (PermissionError, FileNotFoundError):
            pass  # lost a race; finally below removes our temp if it's still there
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass  # already renamed into place (normal) or swept


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


# Embedded-image tags to try, best first, and the size below which a hit is ignored
# (some files carry a stub/placeholder a few bytes long).
_PREVIEW_TAGS = ("PreviewImage", "JpgFromRaw", "ThumbnailImage")
_MIN_PREVIEW_BYTES = 100


def _pick_preview(found: dict[str, bytes]) -> bytes | None:
    """First candidate in _PREVIEW_TAGS priority order that's big enough to be real."""
    for tag in _PREVIEW_TAGS:
        data = found.get(tag)
        if data and len(data) > _MIN_PREVIEW_BYTES:
            return data
    return None


def _parse_preview_json(out: str) -> dict[str, bytes]:
    """Decode `exiftool -j -b -Tag…` output into {bare tag name: bytes}.

    With -j, -b emits binary values as "base64:…" strings. Keys carry a group
    prefix (-G is a common arg, e.g. "QuickTime:PreviewImage"), stripped here; without
    -a ExifTool reports one value per tag name — the same one plain `-b -Tag` would."""
    import base64
    import json as _json
    rows = _json.loads(out) if out.strip() else []
    found: dict[str, bytes] = {}
    for key, value in (rows[0] if rows else {}).items():
        tag = key.rsplit(":", 1)[-1]
        if tag not in _PREVIEW_TAGS or tag in found:
            continue
        if isinstance(value, str) and value.startswith("base64:"):
            found[tag] = base64.b64decode(value[len("base64:"):])
        elif value is not None:
            # Data that happens to be valid UTF-8 comes back as plain text; real
            # JPEG never does (0xFF 0xD8 isn't UTF-8), so this only sees stubs.
            found[tag] = str(value).encode("utf-8")
    return found


def _extract_embedded_preview(path: Path) -> bytes | None:
    """The file's best embedded JPEG (PreviewImage > JpgFromRaw > ThumbnailImage),
    or None. Each ExifTool call takes the session lock for that call only, so other
    workers' calls interleave between attempts.

    Two strategies, chosen by what's typical for the type, giving identical results:

    - Camera RAW (RAW_EXTENSIONS): one tag per call, PreviewImage first. It's almost
      always present, so the usual cost is one call that ships only that image. Asking
      for all three at once would also ship JpgFromRaw, which in a NEF is the
      full-size JPEG (several MB, base64-inflated by a third) — pure waste whenever
      PreviewImage wins.
    - Everything else (video, HEIC, TIFF): usually *no* embedded preview, which cost
      three failed calls — three parses of the file, under the lock — before the
      PyAV/libheif fallback. Ask for all three in one `-j -b` call instead: one parse,
      and whatever previews these types do carry are small.

    ExifToolTimeout propagates (the session has already been restarted): trying the
    next tag or strategy would just hang on the same file again."""
    from geotagger.exiftool_session import ExifToolTimeout
    et = get_et()

    if path.suffix.lower() in config.RAW_EXTENSIONS:
        for tag in _PREVIEW_TAGS:
            try:
                data = et.execute("-b", f"-{tag}", str(path), raw_bytes=True)
            except ExifToolTimeout:
                raise
            except Exception:
                continue
            if data and len(data) > _MIN_PREVIEW_BYTES:
                return data
        return None

    try:
        out = et.execute("-j", "-b", *(f"-{t}" for t in _PREVIEW_TAGS), str(path))
    except ExifToolTimeout:
        raise
    except Exception:
        return None
    try:
        return _pick_preview(_parse_preview_json(out))
    except (ValueError, TypeError, AttributeError, IndexError):
        return None  # malformed JSON / unexpected shape: same as "no preview"


def _frame_via_av(path: Path) -> Image.Image:
    """Extract a representative frame from a video using PyAV."""
    import av as _av
    with _av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            raise DecodeError("No video stream found")

        # Seek to ~10% of duration for a more interesting frame than frame 0
        duration = container.duration  # microseconds, may be None
        if duration:
            target_us = int(duration * 0.10)
            container.seek(target_us)

        for frame in container.decode(stream):
            img = frame.to_image()  # returns PIL Image
            return img

    raise DecodeError("Could not decode any video frame")


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
        except Exception as e:
            raise DecodeError(f"Cannot decode HEIC: {path}") from e

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
    if img.format in ("JPEG", "MPO"):
        # Downscale a still-lazy JPEG BEFORE convert()/transpose, which force a full-
        # resolution decode and so forfeit libjpeg's DCT-domain scaling. thumbnail()
        # calls draft() itself (to 2x the target, then a LANCZOS resize with an exact
        # box), so decode runs at 1/2, 1/4 or 1/8 scale and the final size is still
        # computed from the ORIGINAL dimensions -- identical to the old output. The
        # mode is left alone (draft(None, ...)) so CMYK/L files still go through the
        # convert("RGB") below. A square box makes doing this before the orientation
        # transpose safe (width/height swap doesn't change what fits). Gated to JPEG:
        # draft is a no-op elsewhere, and palette/alpha images must be converted to RGB
        # before resizing (a P-mode resize silently falls back to NEAREST).
        img.thumbnail((max_size, max_size), Image.LANCZOS)
    img = img.convert("RGB")
    if not sensor_space:
        img = apply_orientation(img, orientation)
    img.thumbnail((max_size, max_size), Image.LANCZOS)  # no-op if the JPEG path already fit it

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


def thumbnail_exists(path: Path, mtime: float, size: int,
                     orientation: int | None = None) -> bool:
    """Check if the grid thumbnail ``get_thumbnail`` would serve for this
    ``orientation`` already exists in the cache."""
    try:
        return _cache_present(thumb_cache_path(path, mtime, size, orientation))
    except Exception:
        return False


def face_crop_exists(path: Path, mtime: float, size: int,
                     bbox: tuple[float, float, float, float],
                     orientation: int | None = None) -> bool:
    """Check if a face crop already exists in the cache (mirrors ``get_face_crop``'s
    cache filename, minus the ``margin``/``out_size`` params — those aren't part of
    the cache key, so any prior crop for this bbox/orientation counts)."""
    try:
        return _cache_present(_face_crop_cache_path(path, mtime, size, bbox, orientation))
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
    for f in subdir.glob(f"{key}_*"):  # also matches in-flight/leftover ``.tmp`` files
        try:
            f.unlink()
        except FileNotFoundError:
            continue  # a writer just renamed/removed its temp
        removed += 1
    return removed


def get_thumbnail(path: Path, mtime: float, size: int,
                  orientation: int | None = None) -> bytes:
    """Grid thumbnail, rotated upright for ``orientation`` (display-only path).
    Rotation is applied exactly once, in ``_make_thumbnail``; the cached bytes are
    already upright and served as-is."""
    cached = thumb_cache_path(path, mtime, size, orientation)
    cached.parent.mkdir(exist_ok=True)  # first 2 chars of the key as subdirectory
    hit = _read_cached(cached)
    if hit is not None:
        return hit
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, THUMB_SIZE, is_video=is_video, orientation=orientation)
    _write_cached(cached, data)
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
    cached = _preview_cache_path(path, mtime, size)
    cached.parent.mkdir(exist_ok=True)
    is_raw = path.suffix.lower() in config.RAW_EXTENSIONS
    data = _make_thumbnail(path, PREVIEW_SIZE, full_decode=is_raw)
    _write_cached(cached, data)
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
    cached = _preview_cache_path(path, mtime, size)
    cached.parent.mkdir(exist_ok=True)  # first 2 chars of the key as subdirectory
    fd = _fd_suffix(path)
    hit = _read_cached(cached)
    if hit is not None:
        return hit
    is_video = path.suffix.lower() in VIDEO_EXTENSIONS
    data = _make_thumbnail(path, PREVIEW_SIZE, is_video=is_video, orientation=orientation,
                           full_decode=bool(fd), sensor_space=True)
    _write_cached(cached, data)
    return data


def get_preview_oriented(path: Path, mtime: float, size: int,
                         orientation: int | None = None) -> bytes:
    """Display preview with EXIF orientation applied.

    orientation 1/None returns the canonical preview as-is (no extra file). For
    rotated photos the canonical preview is rotated once and cached separately.
    """
    if not orientation or orientation == 1:
        return get_preview(path, mtime, size, orientation)
    cached = _preview_cache_path(path, mtime, size, orientation)
    cached.parent.mkdir(exist_ok=True)
    hit = _read_cached(cached)
    if hit is not None:
        return hit
    img = Image.open(io.BytesIO(get_preview(path, mtime, size, orientation))).convert("RGB")
    img = apply_orientation(img, orientation)
    data = _encode(img)
    _write_cached(cached, data)
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
    cached = _face_crop_cache_path(path, mtime, size, bbox, orientation)
    cached.parent.mkdir(exist_ok=True)
    hit = _read_cached(cached)
    if hit is not None:
        return hit

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
    _write_cached(cached, data)
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
