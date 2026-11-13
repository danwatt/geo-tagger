import hashlib

from geotagger.scanner import iter_media, walk_media, detect_sidecar_collisions, file_checksum


def _touch(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"data")


class TestFileChecksum:
    def test_matches_hashlib_sha256(self, tmp_path):
        p = tmp_path / "a.jpg"
        p.write_bytes(b"hello world")
        assert file_checksum(p) == hashlib.sha256(b"hello world").hexdigest()

    def test_empty_file(self, tmp_path):
        p = tmp_path / "empty.jpg"
        p.write_bytes(b"")
        assert file_checksum(p) == hashlib.sha256(b"").hexdigest()

    def test_chunk_boundary_is_transparent(self, tmp_path):
        # Content spanning several reads must hash identically to one-shot.
        data = b"x" * (5 * 1024 * 1024 + 7)
        p = tmp_path / "big.bin"
        p.write_bytes(data)
        assert file_checksum(p, _chunk=1024) == hashlib.sha256(data).hexdigest()


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


# ── Single pruned walk (audit P2) ──
class TestWalkMedia:
    def test_never_lists_the_cache_dir(self, tmp_path, monkeypatch):
        import os
        _touch(tmp_path / "photo.jpg")
        _touch(tmp_path / "sub" / "deep.jpg")
        _touch(tmp_path / ".geotagger" / "thumbs" / "x.jpg")
        _touch(tmp_path / "sub" / ".geotagger" / "y.jpg")  # nested cache dirs too
        listed = []
        real = os.scandir

        def spy(path):
            listed.append(os.fspath(path))
            return real(path)

        monkeypatch.setattr(os, "scandir", spy)
        found = {p.name for p, _ in iter_media(tmp_path)}
        assert found == {"photo.jpg", "deep.jpg"}
        assert not any(".geotagger" in d for d in listed), listed

    def test_matches_rglob_reference_on_nested_tree(self, tmp_path):
        from geotagger.config import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, CACHE_DIR_NAME
        for rel in ["a.jpg", "b.MOV", "n.txt", "a.xmp", "d1/c.heic", "d1/d2/e.PNG",
                    "d1/d2/e.xmp", "d3/f.mp4", "日本語/写真.jpg", ".geotagger/t/g.jpg"]:
            _touch(tmp_path / rel)

        def reference():
            out = {}
            for p in tmp_path.rglob("*"):
                if CACHE_DIR_NAME in p.parts or p.suffix.lower() == ".xmp":
                    continue
                ext = p.suffix.lower()
                if ext in IMAGE_EXTENSIONS:
                    out[p] = "image"
                elif ext in VIDEO_EXTENSIONS:
                    out[p] = "video"
            return out

        assert dict(iter_media(tmp_path)) == reference()

    def test_xmp_names_are_per_directory_and_casefolded(self, tmp_path):
        _touch(tmp_path / "a.jpg")
        _touch(tmp_path / "A.XMP")
        _touch(tmp_path / "sub" / "b.jpg")
        got = {p.name: names for p, _, names in walk_media(tmp_path)}
        assert got["a.jpg"] == {"a.xmp"}
        assert got["b.jpg"] == frozenset()

    def test_unreadable_directory_does_not_abort(self, tmp_path, monkeypatch):
        import os
        _touch(tmp_path / "ok.jpg")
        _touch(tmp_path / "locked" / "hidden.jpg")
        _touch(tmp_path / "open" / "seen.jpg")
        real = os.scandir

        def flaky(path):
            if os.path.basename(os.fspath(path)) == "locked":
                raise PermissionError(13, "denied")
            return real(path)

        monkeypatch.setattr(os, "scandir", flaky)
        assert {p.name for p, _ in iter_media(tmp_path)} == {"ok.jpg", "seen.jpg"}

    def test_cancel_stops_the_walk(self, tmp_path):
        import threading
        _touch(tmp_path / "a" / "x.jpg")
        _touch(tmp_path / "b" / "y.jpg")
        cancel = threading.Event()
        cancel.set()
        assert list(walk_media(tmp_path, cancel=cancel)) == []

    def test_symlinked_directory_is_not_followed(self, tmp_path):
        import os
        real = tmp_path / "real"
        _touch(real / "r.jpg")
        root = tmp_path / "root"
        root.mkdir()
        try:
            os.symlink(real, root / "link", target_is_directory=True)
        except (OSError, NotImplementedError):
            import pytest
            pytest.skip("symlinks not permitted")
        assert list(iter_media(root)) == []
