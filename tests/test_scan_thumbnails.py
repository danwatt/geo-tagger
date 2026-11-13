"""Scan-time thumbnails must be the exact files /api/thumbnail serves (audit S4).

The scan used to probe/write ``{key}_thumb`` keyed on ``stat.st_mtime`` while the
API reads ``{key}_thumb_o{n}`` keyed on the row's stored mtime/size, so for every
rotated photo the scan's thumbnail was dead weight and the first grid view
regenerated it. ExifTool is stubbed out; the JPEGs are real so Pillow can thumbnail
them."""

from pathlib import Path

import pytest
from PIL import Image

from geotagger import index, scanning, sidecar, thumbnails


@pytest.fixture(autouse=True)
def _fresh_scan_state():
    scanning.reset_scan_state()
    yield
    scanning.reset_scan_state()


@pytest.fixture
def make_calls(monkeypatch):
    """Count real thumbnail generations (cache misses) by wrapping _make_thumbnail."""
    calls: list[tuple[Path, int | None]] = []
    real = thumbnails._make_thumbnail

    def spy(path, max_size, *a, orientation=None, **kw):
        calls.append((Path(path), orientation))
        return real(path, max_size, *a, orientation=orientation, **kw)

    monkeypatch.setattr(thumbnails, "_make_thumbnail", spy)
    return calls


def _fake_meta(monkeypatch, orientation: int):
    meta = {"lat": None, "lng": None, "geotag_source": "none", "camera": "",
            "photo_datetime": 0, "gps_accuracy": 0.0, "orientation": orientation}
    monkeypatch.setattr(sidecar, "read_metadata", lambda p: dict(meta))


def _lib_with_photo(tmp_path) -> Path:
    root = tmp_path / "lib"
    root.mkdir()
    # Landscape, so an applied orientation-6 rotation is visible in the output size.
    Image.new("RGB", (80, 40), (200, 30, 30)).save(root / "a.jpg", "JPEG")
    return root


def _scan(root):
    return scanning.scan_directory(root, show_progress=False, generate_thumbnails=True)


def _row():
    return index.get_db().execute("SELECT * FROM photos").fetchone()


def _api_cache_file(row) -> Path:
    return thumbnails.thumb_cache_path(Path(index.photo_path(row)), row["mtime"],
                                       row["size"], row["orientation"])


@pytest.mark.parametrize("orientation, suffix", [(6, "_thumb_o6"), (1, "_thumb")])
def test_scan_thumbnail_is_the_file_the_api_serves(client, tmp_path, monkeypatch,
                                                   make_calls, orientation, suffix):
    thumbnails.init_thumbs(tmp_path)
    root = _lib_with_photo(tmp_path)
    _fake_meta(monkeypatch, orientation)

    _scan(root)
    assert len(make_calls) == 1
    row = _row()
    cached = _api_cache_file(row)
    assert cached.name.endswith(suffix + thumbnails.cache_ext())
    assert cached.exists()
    # Rotation applied once, at generation: the landscape source comes out portrait
    # for orientation 6 and stays landscape for 1.
    w, h = Image.open(cached).size
    assert (h > w) if orientation == 6 else (w > h)

    res = client.get(f"/api/thumbnail/{row['id']}")
    assert res.status_code == 200
    assert res.content == cached.read_bytes()
    assert len(make_calls) == 1  # served from the scan's file, not regenerated

    # An unchanged rescan finds the same file (counted as cached, nothing generated).
    _scan(root)
    assert len(make_calls) == 1


def test_fresh_file_thumbnail_keys_on_stored_mtime(client, tmp_path, monkeypatch, make_calls):
    """A fresh file's row isn't rewritten, and freshness tolerates 1 s of mtime
    drift, so the scan must key on the row's mtime, not the current stat."""
    thumbnails.init_thumbs(tmp_path)
    root = _lib_with_photo(tmp_path)
    _fake_meta(monkeypatch, 6)
    _scan(root)

    with index.transaction() as db:
        db.execute("UPDATE photos SET mtime = mtime - 0.5")
    row = _row()
    stale_stat_key = thumbnails.thumb_cache_path(
        Path(index.photo_path(row)), (root / "a.jpg").stat().st_mtime, row["size"], 6)
    stale_stat_key.unlink()  # the first scan's file, keyed on the (then equal) stat
    make_calls.clear()

    _scan(root)  # fresh: no metadata read, but the thumbnail is regenerated
    assert len(make_calls) == 1
    assert _api_cache_file(row).exists()
    assert not stale_stat_key.exists()

    res = client.get(f"/api/thumbnail/{row['id']}")
    assert res.status_code == 200
    assert len(make_calls) == 1


def test_thumbnail_exists_matches_get_thumbnail_per_orientation(thumbs_dir, tmp_path):
    path = tmp_path / "b.jpg"
    Image.new("RGB", (40, 20)).save(path, "JPEG")
    size = path.stat().st_size
    thumbnails.get_thumbnail(path, 5.0, size, orientation=6)
    assert thumbnails.thumbnail_exists(path, 5.0, size, 6) is True
    assert thumbnails.thumbnail_exists(path, 5.0, size, 1) is False
    # An int mtime names the same file as the equal float (the DB column is REAL).
    assert thumbnails.thumbnail_exists(path, 5, size, 6) is True
