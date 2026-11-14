"""Audit U2: undoing a committed geotag / removal / ignore mark.

Each writer on the commit path returns a `previous` snapshot per photo, and
geotag_service.undo_geotags puts that state back. "Back" means the state a
re-read of the files would land on again, not a copy of the old coordinates: a
photo whose location came from the ORIGINAL gets the sidecar's GPS taken out
(so the embedded GPS shows through), not the embedded coordinates written into
the sidecar. These run the real scan pipeline against generated temp JPEGs
through a real ExifTool and check the sidecar's GPS tags after the round trip.
"""

import os
from pathlib import Path

import pytest
from PIL import Image

from geotagger import config, index, scanning, sidecar
from geotagger.services import geotag_service

EMBEDDED = (40.5, -74.0)  # what _jpg(gps=True) embeds: 40°30' N, 74° W


@pytest.fixture(autouse=True)
def _fresh_scan_state():
    scanning.reset_scan_state()
    yield
    scanning.reset_scan_state()


@pytest.fixture
def lib(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    return root


@pytest.fixture(params=[False, True], ids=["db_only", "sidecar_mode"])
def xmp(request, monkeypatch):
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", request.param)
    return request.param


def _jpg(path: Path, gps: bool = False) -> Path:
    exif = Image.Exif()
    if gps:
        g = exif.get_ifd(0x8825)
        g[1], g[2], g[3], g[4] = "N", (40.0, 30.0, 0.0), "W", (74.0, 0.0, 0.0)
    Image.new("RGB", (8, 8), "red").save(path, "JPEG", exif=exif)
    return path


def _scan(root):
    return scanning.scan_directory(root, show_progress=False, generate_thumbnails=False)


def _row(p: Path):
    return index.get_db().execute(
        "SELECT * FROM photos WHERE dir=? AND filename=?", (str(p.parent), p.name)).fetchone()


def _sidecar_gps(p: Path) -> dict:
    """The sidecar's GPS-related tags ({} when there is no sidecar)."""
    from geotagger.exiftool_session import get_et
    sc = sidecar.sidecar_path(p)
    if not sc.exists():
        return {}
    row = get_et().get_tags([str(sc)], tags=[
        "XMP:GPSLatitude", "XMP:GPSLongitude", "XMP:GPSHPositioningError",
        "XMP:GPSStatus", "XMP:City"])[0]
    return {k.split(":", 1)[1]: v for k, v in row.items() if k.startswith("XMP:")}


def _assert_fresh(p: Path):
    sc = sidecar.sidecar_path(p)
    sc_name, sc_mtime = (sc.name, sc.stat().st_mtime) if sc.exists() else (None, None)
    assert index.is_fresh(str(p.parent), p.name, p.stat().st_mtime, sc_name, sc_mtime) is True


def _reread(lib, p: Path):
    """Force a re-read of `p` (bump the generated file's mtime) and rescan."""
    t = p.stat().st_mtime + 100
    os.utime(p, (t, t))
    _scan(lib)
    return _row(p)


def _undo(out: dict) -> dict:
    return geotag_service.undo_geotags([r["previous"] for r in out["results"]])


def _state(row) -> tuple:
    return (row["lat"], row["lng"], row["geotag_source"], row["geotag_removed"])


# ── photo whose location comes from the original (embedded GPS) ──

class TestEmbedded:
    def _setup(self, lib):
        img = _jpg(lib / "e.jpg", gps=True)
        _scan(lib)
        row = _row(img)
        assert row["geotag_source"] == "embedded"
        return img, row["id"]

    def test_remove_then_undo_shows_the_embedded_gps_again(self, db, et_session, lib, xmp):
        img, pid = self._setup(lib)
        out = geotag_service.remove_geotag([pid])
        assert out["results"][0]["previous"]["geotag"]["geotag_source"] == "embedded"
        if xmp:
            assert _sidecar_gps(img).get("GPSStatus") == "V"

        res = _undo(out)
        assert res["written"] == [pid] and res["failed"] == []
        row = _row(img)
        assert (row["lat"], row["lng"]) == pytest.approx(EMBEDDED)
        assert (row["geotag_source"], row["geotag_removed"]) == ("embedded", 0)
        # The sidecar no longer says anything about the location: no void
        # marker, and the embedded coordinates were NOT copied into it.
        tags = _sidecar_gps(img)
        assert "GPSStatus" not in tags and "GPSLatitude" not in tags
        _assert_fresh(img)
        assert _state(_reread(lib, img))[2:] == ("embedded", 0)

    def test_geotag_then_undo_takes_ours_out_of_the_sidecar(self, db, et_session, lib, xmp):
        img, pid = self._setup(lib)
        out = geotag_service.write_geotag([pid], 10.0, 20.0, gps_accuracy=5.0)
        if xmp:
            assert _sidecar_gps(img)["GPSLatitude"] == pytest.approx(10.0)

        assert _undo(out)["written"] == [pid]
        row = _row(img)
        assert (row["lat"], row["lng"]) == pytest.approx(EMBEDDED)
        assert row["geotag_source"] == "embedded"
        assert "GPSLatitude" not in _sidecar_gps(img)
        _assert_fresh(img)
        row = _reread(lib, img)
        assert (row["lat"], row["lng"]) == pytest.approx(EMBEDDED)


# ── photo whose location lives in the sidecar ──

class TestSidecarGeotag:
    def _setup(self, lib):
        img = _jpg(lib / "s.jpg")
        sidecar.write_gps(img, 1.5, 2.5, gps_accuracy=30.0)
        _scan(lib)
        row = _row(img)
        assert row["geotag_source"] == "sidecar"
        return img, row["id"]

    def test_geotag_then_undo_writes_the_old_point_back(self, db, et_session, lib, xmp):
        img, pid = self._setup(lib)
        out = geotag_service.write_geotag([pid], 10.0, 20.0)
        assert _undo(out)["written"] == [pid]
        row = _row(img)
        assert (row["lat"], row["lng"]) == (1.5, 2.5)
        assert (row["geotag_source"], row["gps_accuracy"]) == ("sidecar", 30.0)
        tags = _sidecar_gps(img)
        assert (tags["GPSLatitude"], tags["GPSLongitude"]) == (pytest.approx(1.5), pytest.approx(2.5))
        assert tags["GPSHPositioningError"] == pytest.approx(30.0)
        _assert_fresh(img)

    def test_remove_then_undo(self, db, et_session, lib, xmp):
        img, pid = self._setup(lib)
        out = geotag_service.remove_geotag([pid])
        assert _sidecar_gps(img)["GPSStatus"] == "V"
        assert _undo(out)["written"] == [pid]
        tags = _sidecar_gps(img)
        assert "GPSStatus" not in tags
        assert tags["GPSLatitude"] == pytest.approx(1.5)
        assert _state(_row(img)) == (1.5, 2.5, "sidecar", 0)
        _assert_fresh(img)
        row = _reread(lib, img)
        assert (row["lat"], row["geotag_source"]) == (pytest.approx(1.5), "sidecar")


# ── photo that had been removed, and photo that never had a location ──

class TestNoLocation:
    def test_undo_restores_a_removal(self, db, et_session, lib, xmp):
        """Undoing a geotag of a REMOVED photo removes it again — the embedded
        GPS must stay hidden, marker and all."""
        img = _jpg(lib / "r.jpg", gps=True)
        _scan(lib)
        pid = _row(img)["id"]
        geotag_service.remove_geotag([pid])
        out = geotag_service.write_geotag([pid], 10.0, 20.0)
        assert _row(img)["geotag_removed"] == 0

        assert _undo(out)["written"] == [pid]
        assert _state(_row(img)) == (None, None, "none", 1)
        if xmp:
            assert _sidecar_gps(img)["GPSStatus"] == "V"
        _assert_fresh(img)
        assert _state(_reread(lib, img)) == (None, None, "none", 1)

    def test_undo_restores_never_located(self, db, et_session, lib, xmp):
        """A photo with no location at all goes back to no location — not to a
        removal (that marker would hide GPS a later tool adds to the file)."""
        img = _jpg(lib / "n.jpg")
        _scan(lib)
        pid = _row(img)["id"]
        out = geotag_service.write_geotag([pid], 10.0, 20.0, gps_accuracy=5.0)

        assert _undo(out)["written"] == [pid]
        row = _row(img)
        assert _state(row) == (None, None, "none", 0)
        assert row["gps_accuracy"] == -1.0
        tags = _sidecar_gps(img)
        assert "GPSLatitude" not in tags and "GPSStatus" not in tags
        _assert_fresh(img)


# ── DB-only geotag ──

def test_database_geotag_round_trip(db, et_session, lib, monkeypatch):
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", False)
    img = _jpg(lib / "d.jpg")
    _scan(lib)
    pid = _row(img)["id"]
    geotag_service.write_geotag([pid], 3.0, 4.0, gps_accuracy=8.0)
    out = geotag_service.write_geotag([pid], 10.0, 20.0)
    assert _undo(out)["written"] == [pid]
    assert _state(_row(img)) == (3.0, 4.0, "database", 0)
    assert _row(img)["gps_accuracy"] == 8.0
    assert not sidecar.sidecar_path(img).exists()   # undo never creates a sidecar here
    _assert_fresh(img)


def test_clear_gps_leaves_a_sidecar_with_no_location_of_ours_alone(db, et_session, lib):
    """Place names exported into a sidecar that has no coordinates aren't a
    geotag write to undo."""
    img = _jpg(lib / "x.jpg")
    sidecar.write_location(img, {"city": "Springfield", "country": "US"})
    before = sidecar.sidecar_path(img).stat().st_mtime_ns
    sidecar.clear_gps(img)
    assert sidecar.sidecar_path(img).stat().st_mtime_ns == before
    assert _sidecar_gps(img)["City"] == "Springfield"


# ── ignore marks, conflicts, partial failure ──

def test_ignore_then_undo(db, et_session, lib):
    img = _jpg(lib / "i.jpg")
    _scan(lib)
    pid = _row(img)["id"]
    out = geotag_service.set_geocode_ignored([pid, 99999], True)
    assert [r["id"] for r in out["results"]] == [pid]   # unknown ids have no snapshot
    assert _row(img)["geocode_ignored"] == 1
    res = _undo(out)
    assert res["written"] == [pid] and "location" not in res["results"][0]
    assert _row(img)["geocode_ignored"] == 0


def test_changed_since_commit_is_a_conflict_and_left_alone(db, et_session, lib, monkeypatch):
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", True)
    a, b = _jpg(lib / "a.jpg"), _jpg(lib / "b.jpg")
    _scan(lib)
    ids = [_row(a)["id"], _row(b)["id"]]
    out = geotag_service.write_geotag(ids, 10.0, 20.0)
    geotag_service.write_geotag([ids[1]], 30.0, 40.0)   # b moved again since

    res = _undo(out)
    assert res["written"] == [ids[0]]
    assert res["failed"] == [{"id": ids[1], "error": "changed since the commit", "conflict": True}]
    assert _row(a)["lat"] is None
    assert (_row(b)["lat"], _sidecar_gps(b)["GPSLatitude"]) == (30.0, pytest.approx(30.0))


def test_undo_failure_is_per_photo(db, et_session, lib, monkeypatch):
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", True)
    a, b = _jpg(lib / "a.jpg"), _jpg(lib / "b.jpg")
    sidecar.write_gps(a, 1.0, 2.0)
    sidecar.write_gps(b, 1.0, 2.0)
    _scan(lib)
    ids = [_row(a)["id"], _row(b)["id"]]
    out = geotag_service.write_geotag(ids, 10.0, 20.0)

    real = sidecar.write_gps

    def flaky(p, *args, **kw):
        if p.name == "a.jpg":
            raise TimeoutError("slow")
        return real(p, *args, **kw)

    monkeypatch.setattr(sidecar, "write_gps", flaky)
    res = _undo(out)
    assert res["written"] == [ids[1]]
    assert res["failed"] == [{"id": ids[0], "error": "slow"}]
    assert _row(a)["lat"] == 10.0 and _row(b)["lat"] == 1.0
