from geotagger.scanner import iter_media, detect_sidecar_collisions


def _touch(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"data")


class TestIterMedia:
    def test_yields_images_and_videos_with_media_type(self, tmp_path):
        _touch(tmp_path / "a.jpg")
        _touch(tmp_path / "b.mp4")
        found = {p.name: media_type for p, media_type in iter_media(tmp_path)}
        assert found == {"a.jpg": "image", "b.mp4": "video"}

    def test_skips_unsupported_extensions(self, tmp_path):
        _touch(tmp_path / "notes.txt")
        _touch(tmp_path / "photo.jpg")
        found = {p.name for p, _ in iter_media(tmp_path)}
        assert found == {"photo.jpg"}

    def test_skips_xmp_sidecars(self, tmp_path):
        _touch(tmp_path / "photo.jpg")
        _touch(tmp_path / "photo.xmp")
        found = {p.name for p, _ in iter_media(tmp_path)}
        assert found == {"photo.jpg"}

    def test_skips_cache_dir(self, tmp_path):
        _touch(tmp_path / "photo.jpg")
        _touch(tmp_path / ".geotagger" / "thumbs" / "hidden.jpg")
        found = {p.name for p, _ in iter_media(tmp_path)}
        assert found == {"photo.jpg"}

    def test_recurses_into_subdirectories(self, tmp_path):
        _touch(tmp_path / "top.jpg")
        _touch(tmp_path / "2020" / "vacation" / "nested.heic")
        found = {p.name for p, _ in iter_media(tmp_path)}
        assert found == {"top.jpg", "nested.heic"}

    def test_extension_matching_is_case_insensitive(self, tmp_path):
        _touch(tmp_path / "PHOTO.JPG")
        found = {p.name: t for p, t in iter_media(tmp_path)}
        assert found == {"PHOTO.JPG": "image"}


class TestDetectSidecarCollisions:
    def test_no_collision_for_unique_stems(self, tmp_path):
        _touch(tmp_path / "a.jpg")
        _touch(tmp_path / "b.jpg")
        assert detect_sidecar_collisions(tmp_path) == []

    def test_collision_when_two_images_share_a_stem(self, tmp_path):
        _touch(tmp_path / "photo.jpg")
        _touch(tmp_path / "photo.heic")
        warnings = detect_sidecar_collisions(tmp_path)
        assert len(warnings) == 1
        assert "photo.jpg" in warnings[0]
        assert "photo.heic" in warnings[0]

    def test_no_collision_between_video_and_image_same_stem(self, tmp_path):
        # Only image extensions are considered for sidecar collisions.
        _touch(tmp_path / "clip.mp4")
        _touch(tmp_path / "clip.jpg")
        assert detect_sidecar_collisions(tmp_path) == []

    def test_same_stem_in_different_directories_is_not_a_collision(self, tmp_path):
        _touch(tmp_path / "a" / "photo.jpg")
        _touch(tmp_path / "b" / "photo.heic")
        assert detect_sidecar_collisions(tmp_path) == []
