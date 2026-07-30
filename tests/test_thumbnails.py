import io
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageOps

from geotagger import thumbnails
from geotagger.config import THUMB_SIZE, PREVIEW_SIZE, CACHE_DIR_NAME


def _make_photo(tmp_path, name="photo.jpg", size=(40, 30), color=(200, 50, 50)):
    path = tmp_path / name
    Image.new("RGB", size, color).save(path, "JPEG")
    return path


class TestCacheKey:
    def test_deterministic(self):
        a = thumbnails._cache_key(Path("/a/b.jpg"), 123.0, 456)
        b = thumbnails._cache_key(Path("/a/b.jpg"), 123.0, 456)
        assert a == b

    def test_differs_by_path(self):
        a = thumbnails._cache_key(Path("a.jpg"), 1.0, 1)
        b = thumbnails._cache_key(Path("b.jpg"), 1.0, 1)
        assert a != b

    def test_differs_by_mtime(self):
        a = thumbnails._cache_key(Path("a.jpg"), 1.0, 1)
        b = thumbnails._cache_key(Path("a.jpg"), 2.0, 1)
        assert a != b

    def test_differs_by_size(self):
        a = thumbnails._cache_key(Path("a.jpg"), 1.0, 1)
        b = thumbnails._cache_key(Path("a.jpg"), 1.0, 2)
        assert a != b

    def test_is_sha1_hex(self):
        key = thumbnails._cache_key(Path("a.jpg"), 1.0, 1)
        assert len(key) == 40
        int(key, 16)  # doesn't raise


class TestInitThumbs:
    def test_raises_before_init(self, monkeypatch):
        monkeypatch.setattr(thumbnails, "_thumbs_dir", None)
        with pytest.raises(RuntimeError):
            thumbnails._get_thumbs_dir()

    def test_creates_thumbs_subdir_under_root(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
        monkeypatch.setattr(thumbnails, "_thumbs_dir", None)
        thumbnails.init_thumbs(tmp_path)
        expected = tmp_path / CACHE_DIR_NAME / "thumbs"
        assert expected.is_dir()
        assert thumbnails._get_thumbs_dir() == expected
        thumbnails._thumbs_dir = None

    def test_raises_without_root_or_env(self, monkeypatch):
        monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
        with pytest.raises(RuntimeError):
            thumbnails.init_thumbs(None)

    def test_env_cache_dir_overrides_root(self, tmp_path, monkeypatch):
        env_dir = tmp_path / "elsewhere"
        monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(env_dir))
        thumbnails.init_thumbs(tmp_path / "ignored_root")
        assert thumbnails._get_thumbs_dir() == env_dir / "thumbs"
        thumbnails._thumbs_dir = None


class TestOrientSuffix:
    @pytest.mark.parametrize("orientation,expected", [
        (None, ""), (1, ""), (2, "_o2"), (6, "_o6"), (8, "_o8"),
    ])
    def test_suffix(self, orientation, expected):
        assert thumbnails._orient_suffix(orientation) == expected


class TestApplyOrientation:
    @staticmethod
    def _quad_image():
        img = Image.new("RGB", (3, 2))
        for x in range(3):
            for y in range(2):
                img.putpixel((x, y), (x * 50, y * 50, 100))
        return img

    def test_none_and_one_are_identity(self):
        img = self._quad_image()
        assert thumbnails.apply_orientation(img.copy(), None).get_flattened_data() == img.get_flattened_data()
        assert thumbnails.apply_orientation(img.copy(), 1).get_flattened_data() == img.get_flattened_data()

    @pytest.mark.parametrize("orientation", [2, 3, 4, 5, 6, 7, 8])
    def test_matches_pil_reference_exif_transpose(self, orientation):
        # Cross-check against PIL's own ImageOps.exif_transpose (the mapping
        # apply_orientation is documented to mirror) rather than hand-deriving
        # expected pixels per orientation code.
        img = self._quad_image()
        got = thumbnails.apply_orientation(img.copy(), orientation)

        reference = img.copy()
        reference.getexif()[0x0112] = orientation  # EXIF Orientation tag
        expected = ImageOps.exif_transpose(reference)

        assert got.size == expected.size
        assert got.get_flattened_data() == expected.get_flattened_data()


class TestOrientBbox:
    def test_orientation_one_is_identity(self):
        assert thumbnails.orient_bbox([0.1, 0.2, 0.3, 0.4], 1) == [0.1, 0.2, 0.3, 0.4]

    def test_none_treated_as_orientation_one(self):
        assert thumbnails.orient_bbox([0.1, 0.2, 0.3, 0.4], None) == [0.1, 0.2, 0.3, 0.4]

    @pytest.mark.parametrize("orientation", [2, 3, 4, 5, 6, 7, 8])
    def test_matches_where_the_transformed_pixels_actually_land(self, orientation):
        # Ground truth: draw a filled rectangle at `bbox` in sensor space, run
        # it through the same transpose apply_orientation uses, and check that
        # orient_bbox predicts where the rectangle actually ends up.
        w, h = 100, 60
        bbox = (0.1, 0.2, 0.3, 0.5)
        px1, py1, px2, py2 = int(bbox[0] * w), int(bbox[1] * h), int(bbox[2] * w), int(bbox[3] * h)

        img = Image.new("L", (w, h), 0)
        ImageDraw.Draw(img).rectangle([px1, py1, px2 - 1, py2 - 1], fill=255)

        oriented = thumbnails.apply_orientation(img, orientation)
        ow, oh = oriented.size
        left, upper, right, lower = oriented.getbbox()
        actual = (left / ow, upper / oh, right / ow, lower / oh)

        predicted = thumbnails.orient_bbox(list(bbox), orientation)
        assert predicted == pytest.approx(actual, abs=0.02)


class TestUnorientBbox:
    @pytest.mark.parametrize("orientation", [1, 2, 3, 4, 5, 6, 7, 8])
    def test_is_the_inverse_of_orient_bbox(self, orientation):
        b = [0.1, 0.2, 0.35, 0.55]
        # display = orient(sensor); unorient(display) must recover sensor.
        display = thumbnails.orient_bbox(b, orientation)
        assert thumbnails.unorient_bbox(display, orientation) == pytest.approx(b, abs=1e-6)
        # and the reverse composition round-trips too
        sensor = thumbnails.unorient_bbox(b, orientation)
        assert thumbnails.orient_bbox(sensor, orientation) == pytest.approx(b, abs=1e-6)

    def test_none_is_identity(self):
        assert thumbnails.unorient_bbox([0.1, 0.2, 0.3, 0.4], None) == [0.1, 0.2, 0.3, 0.4]


class TestStampPlayIcon:
    def test_draws_something_in_the_center(self):
        img = Image.new("RGB", (100, 100), (50, 50, 50))
        before = img.get_flattened_data()
        thumbnails._stamp_play_icon(img)
        assert img.get_flattened_data() != before
        assert img.getpixel((50, 50)) != (50, 50, 50)


class TestThumbnailExists:
    def test_false_when_not_initialized(self, monkeypatch):
        monkeypatch.setattr(thumbnails, "_thumbs_dir", None)
        assert thumbnails.thumbnail_exists(Path("a.jpg"), 1.0, 1) is False

    def test_false_before_generation_true_after(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path)
        fsize = path.stat().st_size
        assert thumbnails.thumbnail_exists(path, 1.0, fsize) is False
        thumbnails.get_thumbnail(path, 1.0, fsize)
        assert thumbnails.thumbnail_exists(path, 1.0, fsize) is True


class TestInvalidatePhotoCache:
    def test_removes_every_cached_rendition_for_the_photo(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(400, 300))
        fsize = path.stat().st_size
        thumbnails.get_thumbnail(path, 1.0, fsize)
        thumbnails.get_preview(path, 1.0, fsize)
        thumbnails.get_face_crop(path, 1.0, fsize, (0.1, 0.1, 0.3, 0.3))

        key = thumbnails._cache_key(path, 1.0, fsize)
        subdir = thumbnails._get_thumbs_dir() / key[:2]
        assert list(subdir.glob(f"{key}_*"))  # sanity: something got cached

        removed = thumbnails.invalidate_photo_cache(path, 1.0, fsize)
        assert removed == 3
        assert list(subdir.glob(f"{key}_*")) == []

        # Regenerates cleanly afterward.
        assert thumbnails.thumbnail_exists(path, 1.0, fsize) is False
        thumbnails.get_thumbnail(path, 1.0, fsize)
        assert thumbnails.thumbnail_exists(path, 1.0, fsize) is True

    def test_does_not_touch_a_different_photos_cache(self, thumbs_dir, tmp_path):
        path_a = _make_photo(tmp_path, name="a.jpg")
        path_b = _make_photo(tmp_path, name="b.jpg")
        fsize_a, fsize_b = path_a.stat().st_size, path_b.stat().st_size
        thumbnails.get_thumbnail(path_a, 1.0, fsize_a)
        thumbnails.get_thumbnail(path_b, 1.0, fsize_b)

        thumbnails.invalidate_photo_cache(path_a, 1.0, fsize_a)

        assert thumbnails.thumbnail_exists(path_a, 1.0, fsize_a) is False
        assert thumbnails.thumbnail_exists(path_b, 1.0, fsize_b) is True

    def test_returns_zero_when_nothing_was_ever_cached(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path)
        fsize = path.stat().st_size
        assert thumbnails.invalidate_photo_cache(path, 1.0, fsize) == 0


class TestGetThumbnail:
    def test_creates_and_caches_thumbnail(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(400, 300))
        fsize = path.stat().st_size

        data1 = thumbnails.get_thumbnail(path, 1.0, fsize)
        img = Image.open(io.BytesIO(data1))
        assert img.format == "WEBP"  # default rendition format
        assert max(img.size) <= THUMB_SIZE

        data2 = thumbnails.get_thumbnail(path, 1.0, fsize)  # cache hit
        assert data2 == data1

    def test_different_mtime_is_a_separate_cache_entry(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path)
        fsize = path.stat().st_size
        thumbnails.get_thumbnail(path, 100.0, fsize)
        assert thumbnails.thumbnail_exists(path, 100.0, fsize) is True
        assert thumbnails.thumbnail_exists(path, 200.0, fsize) is False

    def test_orientation_uses_separate_cache_files(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(40, 20))
        fsize = path.stat().st_size
        img_o1 = Image.open(io.BytesIO(thumbnails.get_thumbnail(path, 1.0, fsize, orientation=1)))
        img_o6 = Image.open(io.BytesIO(thumbnails.get_thumbnail(path, 1.0, fsize, orientation=6)))
        # Orientation 6 is a 90-degree rotation: width/height swap.
        assert img_o6.size == (img_o1.size[1], img_o1.size[0])


class TestGetPreview:
    def test_creates_and_caches_preview_shrunk_to_preview_size(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(1800, 900))
        fsize = path.stat().st_size

        data = thumbnails.get_preview(path, 1.0, fsize)
        img = Image.open(io.BytesIO(data))
        assert max(img.size) <= PREVIEW_SIZE
        assert max(img.size) == PREVIEW_SIZE  # source was bigger, so it did shrink

        data2 = thumbnails.get_preview(path, 1.0, fsize)  # cache hit
        assert data2 == data


class TestGetPreviewOriented:
    def test_orientation_one_reuses_the_canonical_preview(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path)
        fsize = path.stat().st_size
        canonical = thumbnails.get_preview(path, 1.0, fsize)
        oriented = thumbnails.get_preview_oriented(path, 1.0, fsize, orientation=1)
        assert oriented == canonical

        key = thumbnails._cache_key(path, 1.0, fsize)
        subdir = thumbnails._get_thumbs_dir() / key[:2]
        assert not (subdir / f"{key}_preview_o1{thumbnails.cache_ext()}").exists()

    def test_rotated_orientation_creates_a_separate_cached_file(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(40, 20))
        fsize = path.stat().st_size
        canonical = Image.open(io.BytesIO(thumbnails.get_preview(path, 1.0, fsize)))

        data = thumbnails.get_preview_oriented(path, 1.0, fsize, orientation=6)
        img = Image.open(io.BytesIO(data))
        assert img.size == (canonical.size[1], canonical.size[0])

        key = thumbnails._cache_key(path, 1.0, fsize)
        subdir = thumbnails._get_thumbs_dir() / key[:2]
        assert (subdir / f"{key}_preview_o6{thumbnails.cache_ext()}").exists()

        data2 = thumbnails.get_preview_oriented(path, 1.0, fsize, orientation=6)  # cache hit
        assert data2 == data


class TestRenditionFormat:
    def test_webp_default_ext_and_media_type(self):
        assert thumbnails.cache_ext() == ".webp"
        assert thumbnails.media_type() == "image/webp"

    def test_jpeg_setting_switches_ext_media_type_and_encoding(self, monkeypatch, thumbs_dir, tmp_path):
        monkeypatch.setattr(thumbnails.config, "THUMB_FORMAT", "jpeg")
        assert thumbnails.cache_ext() == ".jpg"
        assert thumbnails.media_type() == "image/jpeg"

        path = _make_photo(tmp_path, size=(300, 200))
        fsize = path.stat().st_size
        data = thumbnails.get_thumbnail(path, 1.0, fsize)
        assert Image.open(io.BytesIO(data)).format == "JPEG"
        key = thumbnails._cache_key(path, 1.0, fsize)
        assert (thumbs_dir / key[:2] / f"{key}_thumb.jpg").exists()

    def test_format_switch_does_not_read_the_other_formats_cache(self, monkeypatch, thumbs_dir, tmp_path):
        # The extension is part of the filename, so a flipped setting must miss the
        # existing file rather than serve bytes of the wrong format.
        path = _make_photo(tmp_path)
        fsize = path.stat().st_size
        thumbnails.get_thumbnail(path, 1.0, fsize)             # writes .webp
        assert thumbnails.thumbnail_exists(path, 1.0, fsize) is True
        monkeypatch.setattr(thumbnails.config, "THUMB_FORMAT", "jpeg")
        assert thumbnails.thumbnail_exists(path, 1.0, fsize) is False

    def test_webp_is_smaller_than_jpeg_for_the_same_source(self, monkeypatch, thumbs_dir, tmp_path):
        # Needs detailed pixels — a flat color compresses to nothing in either format.
        path = tmp_path / "detailed.jpg"
        src = Image.new("RGB", (1200, 900))
        src.putdata([((x * 7) % 256, (x * 13 + x // 1200 * 3) % 256, (x * 29) % 256)
                     for x in range(1200 * 900)])
        src.save(path, "JPEG", quality=95)
        fsize = path.stat().st_size
        webp = thumbnails.get_preview(path, 1.0, fsize)
        thumbnails.invalidate_photo_cache(path, 1.0, fsize)
        monkeypatch.setattr(thumbnails.config, "THUMB_FORMAT", "jpeg")
        monkeypatch.setattr(thumbnails.config, "THUMB_QUALITY", 85)
        jpeg = thumbnails.get_preview(path, 1.0, fsize)
        assert len(webp) < len(jpeg)


class TestOpenImageRawFallback:
    def test_tiff_without_embedded_preview_falls_back_to_direct_open(self, et_session, thumbs_dir, tmp_path):
        # .tiff routes through the RAW/TIFF branch of _open_image, which tries
        # an ExifTool-extracted embedded preview first. A plain PIL-written
        # TIFF has none, so this exercises the fallback to a direct PIL open.
        path = tmp_path / "photo.tiff"
        Image.new("RGB", (60, 40), (10, 20, 30)).save(path, "TIFF")
        fsize = path.stat().st_size

        data = thumbnails.get_thumbnail(path, 1.0, fsize)
        img = Image.open(io.BytesIO(data))
        assert max(img.size) <= THUMB_SIZE


class TestRawFullDecode:
    def test_fd_suffix_only_for_raw_when_enabled(self, monkeypatch):
        monkeypatch.setattr(thumbnails.config, "RAW_FULL_DECODE", True)
        assert thumbnails._fd_suffix(Path("a.nef")) == "_fd"
        assert thumbnails._fd_suffix(Path("a.DNG")) == "_fd"   # case-insensitive ext
        assert thumbnails._fd_suffix(Path("a.jpg")) == ""      # not a RAW format
        monkeypatch.setattr(thumbnails.config, "RAW_FULL_DECODE", False)
        assert thumbnails._fd_suffix(Path("a.nef")) == ""      # setting off

    def test_decode_raw_full_requests_sensor_orientation(self, monkeypatch):
        # rawpy/LibRaw auto-rotates by default; _decode_raw_full MUST pass user_flip=0
        # so the decode stays in sensor space (else face boxes get double-oriented on
        # rotated photos). Guards the regression without needing a real RAW.
        import numpy as np
        import rawpy
        captured = {}

        class FakeRaw:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def postprocess(self, **kw):
                captured.update(kw)
                return np.zeros((4, 6, 3), dtype=np.uint8)  # (H, W, C)

        monkeypatch.setattr(rawpy, "imread", lambda p: FakeRaw())
        img = thumbnails._decode_raw_full(Path("x.nef"))
        assert captured.get("user_flip") == 0      # sensor orientation, no auto-rotate
        assert img.size == (6, 4)                   # PIL (W, H) from the (H, W, C) array

    def test_preview_uses_libraw_and_caches_under_fd_suffix(self, thumbs_dir, monkeypatch):
        monkeypatch.setattr(thumbnails.config, "RAW_FULL_DECODE", True)
        calls = []

        def fake_decode(path):
            calls.append(path)
            return Image.new("RGB", (2400, 1600), (10, 120, 200))

        monkeypatch.setattr(thumbnails, "_decode_raw_full", fake_decode)

        path = Path("/library/IMG_1234.nef")
        data = thumbnails.get_preview(path, 1.0, 999)
        assert calls == [path]                    # LibRaw decode used, not ExifTool
        img = Image.open(io.BytesIO(data))
        assert max(img.size) <= PREVIEW_SIZE      # served preview still capped at PREVIEW_SIZE

        key = thumbnails._cache_key(path, 1.0, 999)
        subdir = thumbs_dir / key[:2]
        ext = thumbnails.cache_ext()
        assert (subdir / f"{key}_preview_fd{ext}").exists()
        assert not (subdir / f"{key}_preview{ext}").exists()

    def test_detection_preview_full_decode_caps_at_decode_max_and_reports_full(
            self, thumbs_dir, monkeypatch):
        monkeypatch.setattr(thumbnails.config, "RAW_FULL_DECODE", True)
        # Deliberately not equal to PREVIEW_SIZE, so the assert below proves the
        # detect cap (not the preview cap) is what sized this rendition.
        monkeypatch.setattr(thumbnails.config, "FACE_DECODE_MAX_DIM", 1200)
        monkeypatch.setattr(thumbnails, "_decode_raw_full",
                            lambda p: Image.new("RGB", (6000, 4000), (5, 5, 5)))

        data, is_full = thumbnails.get_detection_preview(Path("x.dng"), 1.0, 1)
        assert is_full is True
        img = Image.open(io.BytesIO(data))
        assert max(img.size) == 1200              # detect cap, not PREVIEW_SIZE

    def test_detection_preview_plain_jpg_is_not_full_decode(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(800, 600))
        fsize = path.stat().st_size
        data, is_full = thumbnails.get_detection_preview(path, 1.0, fsize)
        assert is_full is False
        assert data == thumbnails.get_preview(path, 1.0, fsize)

    def test_detection_preview_falls_back_when_decode_fails(self, monkeypatch):
        # A real .nef isn't available; force the LibRaw path to raise and confirm we
        # fall back to the canonical preview and report is_full=False (→ NULL column).
        monkeypatch.setattr(thumbnails.config, "RAW_FULL_DECODE", True)

        def boom(path):
            raise RuntimeError("no libraw")

        monkeypatch.setattr(thumbnails, "_decode_raw_full", boom)
        monkeypatch.setattr(thumbnails, "get_preview", lambda *a, **k: b"CANON")
        data, is_full = thumbnails.get_detection_preview(Path("x.nef"), 1.0, 1)
        assert data == b"CANON" and is_full is False


class TestRenderFullsize:
    def test_draws_boxes_and_returns_full_res_jpeg(self, tmp_path):
        path = _make_photo(tmp_path, size=(200, 150))
        specs = [("0.1,0.1,0.4,0.4", "Alice", False),   # labeled → box + label
                 ("0.5,0.5,0.9,0.9", None, False)]       # unlabeled → box only
        data = thumbnails.render_fullsize_with_faces(path, 1, specs)
        img = Image.open(io.BytesIO(data))
        assert img.format == "JPEG"
        assert img.size == (200, 150)      # full resolution, not the 1600 preview

    def test_raw_goes_through_libraw_decode(self, monkeypatch):
        called = []

        def fake(p):
            called.append(p)
            return Image.new("RGB", (300, 200), (30, 30, 30))

        monkeypatch.setattr(thumbnails, "_decode_raw_full", fake)
        data = thumbnails.render_fullsize_with_faces(Path("x.nef"), 1, [])
        assert called == [Path("x.nef")]   # LibRaw, not ExifTool/PIL
        assert Image.open(io.BytesIO(data)).size == (300, 200)

    def test_orientation_makes_the_image_upright(self, tmp_path):
        path = _make_photo(tmp_path, size=(200, 100))
        data = thumbnails.render_fullsize_with_faces(path, 6, [])  # 90° rotation
        assert Image.open(io.BytesIO(data)).size == (100, 200)     # dims swapped

    def test_unparseable_bbox_is_skipped_not_fatal(self, tmp_path):
        path = _make_photo(tmp_path, size=(80, 60))
        data = thumbnails.render_fullsize_with_faces(path, 1, [("garbage", None, False)])
        assert Image.open(io.BytesIO(data)).size == (80, 60)


class TestGetFaceCrop:
    def test_returns_a_square_crop_of_the_requested_size(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(200, 200))
        fsize = path.stat().st_size
        data = thumbnails.get_face_crop(path, 1.0, fsize, bbox=(0.3, 0.3, 0.5, 0.5), out_size=80)
        img = Image.open(io.BytesIO(data))
        assert img.size == (80, 80)

    def test_bbox_near_the_edge_is_clamped_not_an_error(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(100, 100))
        fsize = path.stat().st_size
        data = thumbnails.get_face_crop(path, 1.0, fsize, bbox=(0.0, 0.0, 0.1, 0.1))
        img = Image.open(io.BytesIO(data))
        assert img.size == (160, 160)  # default out_size, still square despite clamping

    def test_caches_by_bbox_and_differs_for_different_boxes(self, thumbs_dir, tmp_path):
        # A flat-color source would make any crop region byte-identical, so use
        # a two-tone image where the two bboxes genuinely crop different pixels.
        path = tmp_path / "photo.jpg"
        img = Image.new("RGB", (100, 100), (200, 50, 50))
        ImageDraw.Draw(img).rectangle([50, 50, 99, 99], fill=(50, 50, 200))
        img.save(path, "JPEG")
        fsize = path.stat().st_size

        data1 = thumbnails.get_face_crop(path, 1.0, fsize, bbox=(0.1, 0.1, 0.4, 0.4))
        data1_again = thumbnails.get_face_crop(path, 1.0, fsize, bbox=(0.1, 0.1, 0.4, 0.4))
        assert data1_again == data1

        data2 = thumbnails.get_face_crop(path, 1.0, fsize, bbox=(0.5, 0.5, 0.9, 0.9))
        assert data2 != data1
