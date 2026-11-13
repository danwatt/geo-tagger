"""Audit D4: removing a geotag must survive the next scan.

Two defects: remove_geotag stored the sidecar's full path (even when no sidecar
existed) where the scanner stores its name or None, so the freshness check always
failed and the file was re-read; and a re-read of a photo whose ORIGINAL carries
GPS put the embedded coordinates straight back. These run the real scan pipeline
against generated temp JPEGs (never a user's original) through a real ExifTool,
spying on sidecar.read_metadata to see whether a file was re-read.
"""

import os
from pathlib import Path

import pytest
from PIL import Image

from geotagger import config, index, scanning, sidecar
from geotagger.services import geocode_service, geotag_service, photos_service

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


@pytest.fixture
def reads(monkeypatch):
    """Wrap the real ExifTool read; returns the list of paths it was called for."""
    calls: list[Path] = []
    real = sidecar.read_metadata

    def spy(p):
        calls.append(p)
        return real(p)

    monkeypatch.setattr(sidecar, "read_metadata", spy)
    return calls


@pytest.fixture
def xmp_on(monkeypatch):
    monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", True)


def _jpg(path: Path, gps: bool = False, dt: str | None = None) -> Path:
    """A tiny generated JPEG, optionally with embedded EXIF GPS / DateTimeOriginal."""
    exif = Image.Exif()
    if gps:
        g = exif.get_ifd(0x8825)
        g[1], g[2], g[3], g[4] = "N", (40.0, 30.0, 0.0), "W", (74.0, 0.0, 0.0)
    if dt:
        exif.get_ifd(0x8769)[0x9003] = dt
    Image.new("RGB", (8, 8), "red").save(path, "JPEG", exif=exif)
    return path


def _scan(root):
    return scanning.scan_directory(root, show_progress=False, generate_thumbnails=False)


def _row(p: Path):
    return index.get_db().execute(
        "SELECT * FROM photos WHERE dir=? AND filename=?", (str(p.parent), p.name)).fetchone()


def _scanner_entry(p: Path):
    """What the scan walk would hand fresh_flags for `p` right now."""
    sc = sidecar.sidecar_path(p)
    sc_name, sc_mtime = (sc.name, sc.stat().st_mtime) if sc.exists() else (None, None)
    return (str(p.parent), p.name, p.stat().st_mtime, sc_name, sc_mtime)


def _assert_fresh(p: Path):
    e = _scanner_entry(p)
    assert index.fresh_flags([e]) == [True]
    assert index.is_fresh(*e) is True


def _touch(p: Path):
    """Bump the (generated test) file's mtime so the next scan re-reads it."""
    t = p.stat().st_mtime + 100
    os.utime(p, (t, t))


def _external_sidecar_gps(p: Path, lat: float, lng: float):
    """Another tool writing GPS into the sidecar: only the coordinates, leaving any
    other tag (including our removal marker) as it was."""
    from geotagger.exiftool_session import get_et
    sc = sidecar.sidecar_path(p)
    get_et().execute("-overwrite_original", f"-XMP:GPSLatitude={lat}",
                     f"-XMP:GPSLongitude={lng}", str(sc))
    # Freshness allows 1 s of sidecar mtime slack; a real edit comes later than
    # this test's, so push the mtime past it.
    t = sc.stat().st_mtime + 100
    os.utime(sc, (t, t))


DERIVED = index.DERIVED_LOCATION_COLUMNS


# ── (a) the removal itself is recorded the way the scanner will see it ──

class TestRemovalIsFresh:
    @pytest.mark.parametrize("with_sidecar", [False, True])
    def test_rescan_after_remove_does_not_reread(self, db, et_session, lib, reads, monkeypatch,
                                                  with_sidecar):
        img = _jpg(lib / "a.jpg")
        if with_sidecar:
            sidecar.write_gps(img, 1.0, 2.0)
        _scan(lib)
        pid = _row(img)["id"]
        assert _row(img)["lat"] == (1.0 if with_sidecar else None)

        geotag_service.remove_geotag([pid])

        row = _row(img)
        assert row["sidecar_path"] == ("a.xmp" if with_sidecar else None)
        _assert_fresh(img)
        reads.clear()
        assert _scan(lib)[:2] == (0, 1)
        assert reads == []
        assert _row(img)["lat"] is None

    def test_sidecar_mode_remove_is_fresh(self, db, et_session, lib, reads, xmp_on):
        img = _jpg(lib / "a.jpg", gps=True)
        _scan(lib)
        geotag_service.remove_geotag([_row(img)["id"]])
        _assert_fresh(img)
        reads.clear()
        _scan(lib)
        assert reads == []


# ── (b) a re-read must not resurrect GPS embedded in the original ──

class TestRemovalSurvivesReread:
    @pytest.mark.parametrize("mode", ["db_only", "db_only_with_sidecar", "sidecar"])
    def test_embedded_gps_stays_removed(self, db, et_session, lib, reads, monkeypatch, mode):
        img = _jpg(lib / "e.jpg", gps=True)
        if mode == "db_only_with_sidecar":
            sidecar.write_datetime(img, 1_600_000_000)  # a sidecar with no GPS in it
        monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", mode == "sidecar")
        _scan(lib)
        row = _row(img)
        assert (row["lat"], row["lng"]) == pytest.approx(EMBEDDED)
        assert row["geotag_source"] == "embedded"
        pid = row["id"]
        geocode_service.geocode_pending()  # whatever is installed; columns are cleared below anyway

        geotag_service.remove_geotag([pid])
        _touch(img)
        reads.clear()
        _scan(lib)

        assert reads == [img]  # it really was re-read
        row = _row(img)
        assert (row["lat"], row["lng"], row["geotag_source"]) == (None, None, "none")
        assert row["geotag_removed"] == 1  # embedded GPS never clears the marker
        assert all(row[c] is None for c in DERIVED)
        _assert_fresh(img)  # and the re-read row is itself fresh

    def test_sidecar_marker_suppresses_embedded_gps_without_the_db(self, db, et_session, lib,
                                                                   xmp_on):
        """In sidecar mode the removal lives in the sidecar too, so it survives a
        DB rebuild: reading the file afresh reports no location."""
        img = _jpg(lib / "e.jpg", gps=True)
        _scan(lib)
        geotag_service.remove_geotag([_row(img)["id"]])
        meta = sidecar.read_metadata(img)
        assert (meta["lat"], meta["lng"], meta["geotag_source"]) == (None, None, "none")


# ── (c) geotagging again clears the marker ──

class TestRegeotagClearsMarker:
    @pytest.mark.parametrize("xmp", [False, True])
    def test_regeotag_after_removal(self, db, et_session, lib, reads, monkeypatch, xmp):
        monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", xmp)
        img = _jpg(lib / "r.jpg", gps=True)
        _scan(lib)
        pid = _row(img)["id"]
        geotag_service.remove_geotag([pid])
        assert _row(img)["geotag_removed"] == 1

        geotag_service.write_geotag([pid], 10.0, 20.0, gps_accuracy=5.0)
        row = _row(img)
        assert (row["lat"], row["lng"], row["geotag_removed"]) == (10.0, 20.0, 0)
        _assert_fresh(img)

        _touch(img)
        _scan(lib)
        row = _row(img)
        assert (row["lat"], row["lng"]) == (pytest.approx(10.0), pytest.approx(20.0))
        assert row["geotag_source"] == ("sidecar" if xmp else "database")
        assert row["geotag_removed"] == 0


# ── (d) GPS another tool writes into the sidecar after the removal wins ──

class TestExternalSidecarGpsWins:
    @pytest.mark.parametrize("xmp", [False, True])
    def test_external_sidecar_gps_clears_marker(self, db, et_session, lib, reads, monkeypatch, xmp):
        monkeypatch.setattr(config, "WRITE_XMP_ON_GEOTAG", xmp)
        img = _jpg(lib / "x.jpg", gps=True)
        _scan(lib)
        pid = _row(img)["id"]
        geotag_service.remove_geotag([pid])

        _external_sidecar_gps(img, 33.0, 44.0)  # sidecar mtime/name change → re-read
        _scan(lib)

        row = _row(img)
        assert (row["lat"], row["lng"]) == (pytest.approx(33.0), pytest.approx(44.0))
        assert (row["geotag_source"], row["geotag_removed"]) == ("sidecar", 0)


# ── (e) every other sidecar writer leaves the row fresh ──

class TestWritersLeaveRowFresh:
    def _setup(self, lib, **kw):
        img = _jpg(lib / "w.jpg", **kw)
        _scan(lib)
        return img, _row(img)["id"]

    def _rescan_reads_nothing(self, lib, img, reads):
        _assert_fresh(img)
        reads.clear()
        _scan(lib)
        assert reads == []

    def test_write_geotag_db_only(self, db, et_session, lib, reads):
        img, pid = self._setup(lib)
        geotag_service.write_geotag([pid], 1.0, 2.0, gps_accuracy=5.0)
        self._rescan_reads_nothing(lib, img, reads)

    def test_write_geotag_sidecar(self, db, et_session, lib, reads, xmp_on):
        img, pid = self._setup(lib)
        geotag_service.write_geotag([pid], 1.0, 2.0, gps_accuracy=5.0)
        self._rescan_reads_nothing(lib, img, reads)

    def test_update_photo_times(self, db, et_session, lib, reads):
        img, pid = self._setup(lib, dt="2020:01:02 03:04:05")
        t0 = 1577934245  # 2020-01-02 03:04:05 as wall-clock-as-UTC
        out = photos_service.update_photo_times([{"id": pid, "expected": t0, "target": t0 + 3600}])
        assert out["written"] == [pid]
        self._rescan_reads_nothing(lib, img, reads)

    def test_assign_approximate_dates(self, db, et_session, lib, reads):
        img, pid = self._setup(lib)
        assert photos_service.assign_approximate_dates([pid], 2001, 6) == 1
        self._rescan_reads_nothing(lib, img, reads)

    def test_commit_and_undo_guessed_dates(self, db, et_session, lib, reads):
        img, pid = self._setup(lib)
        res = photos_service.commit_guessed_dates(
            [{"photo_id": pid, "year": 2002, "month": 3, "day": 4, "precision": None}])
        self._rescan_reads_nothing(lib, img, reads)
        assert photos_service.undo_date_commit(res["previous"]) == 1
        self._rescan_reads_nothing(lib, img, reads)

    def test_export_to_sidecars(self, db, et_session, lib, reads):
        img, pid = self._setup(lib)
        geotag_service.write_geotag([pid], 1.0, 2.0, gps_accuracy=5.0)  # DB-only
        assert geocode_service.export_to_sidecars()["written"] == 1
        self._rescan_reads_nothing(lib, img, reads)


# ── the shared helper the scanner and every writer use ──

class TestSidecarTracking:
    def test_absent_sidecar_is_none(self, tmp_path):
        assert sidecar.sidecar_tracking(tmp_path / "n.jpg") == (None, None)

    def test_present_sidecar_is_name_and_mtime(self, tmp_path):
        (tmp_path / "n.xmp").write_bytes(b"x")
        name, mtime = sidecar.sidecar_tracking(tmp_path / "n.jpg")
        assert name == "n.xmp"
        assert mtime == (tmp_path / "n.xmp").stat().st_mtime


class TestMigration:
    def test_column_added_to_existing_db(self, tmp_path, monkeypatch):
        import sqlite3
        monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
        cache = tmp_path / index.CACHE_DIR_NAME
        cache.mkdir()
        old = sqlite3.connect(cache / "index.db")
        # A pre-D4 DB that still has the ancient `path` column, so the table-rebuild
        # migration runs too and must carry the new column across.
        old.execute("""CREATE TABLE photos (id INTEGER PRIMARY KEY, filename TEXT NOT NULL,
            dir TEXT NOT NULL, ext TEXT NOT NULL, media_type TEXT NOT NULL, mtime REAL NOT NULL,
            size INTEGER NOT NULL, lat REAL, lng REAL,
            geotag_source TEXT NOT NULL DEFAULT 'none', sidecar_path TEXT, sidecar_mtime REAL,
            camera TEXT, scanned_at REAL NOT NULL, path TEXT, UNIQUE(dir, filename))""")
        old.execute("INSERT INTO photos (filename, dir, ext, media_type, mtime, size, scanned_at, path)"
                    " VALUES ('a.jpg', '/d', '.jpg', 'image', 1, 1, 1, '/d/a.jpg')")
        old.commit()
        old.close()
        conn = index.init_db(tmp_path)
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
            assert "geotag_removed" in cols and "path" not in cols
            assert conn.execute("SELECT geotag_removed FROM photos").fetchone()[0] == 0
        finally:
            conn.close()
            index._db = None
            index._db_path = None
