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


class TestGetThumbnail:
    def test_creates_and_caches_thumbnail(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(400, 300))
        fsize = path.stat().st_size

        data1 = thumbnails.get_thumbnail(path, 1.0, fsize)
        assert data1[:2] == b"\xff\xd8"  # JPEG magic bytes
        img = Image.open(io.BytesIO(data1))
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
        assert not (subdir / f"{key}_preview_o1.jpg").exists()

    def test_rotated_orientation_creates_a_separate_cached_file(self, thumbs_dir, tmp_path):
        path = _make_photo(tmp_path, size=(40, 20))
        fsize = path.stat().st_size
        canonical = Image.open(io.BytesIO(thumbnails.get_preview(path, 1.0, fsize)))

        data = thumbnails.get_preview_oriented(path, 1.0, fsize, orientation=6)
        img = Image.open(io.BytesIO(data))
        assert img.size == (canonical.size[1], canonical.size[0])

        key = thumbnails._cache_key(path, 1.0, fsize)
        subdir = thumbnails._get_thumbs_dir() / key[:2]
        assert (subdir / f"{key}_preview_o6.jpg").exists()

        data2 = thumbnails.get_preview_oriented(path, 1.0, fsize, orientation=6)  # cache hit
        assert data2 == data


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
        assert img.format == "JPEG"
        assert max(img.size) <= THUMB_SIZE


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
