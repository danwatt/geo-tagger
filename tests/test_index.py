import json
import sqlite3

import pytest

from geotagger import index


def _upsert(db, path="p1.jpg", mtime=1000.0, sidecar_path=None, sidecar_mtime=None,
            camera="Canon EOS", photo_datetime=123, gps_accuracy=5.0, orientation=1,
            lat=None, lng=None):
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=mtime, size=100, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=sidecar_path, sidecar_mtime=sidecar_mtime,
        camera=camera, photo_datetime=photo_datetime,
        gps_accuracy=gps_accuracy, orientation=orientation,
    )


class TestAssignApproximateDate:
    def test_sets_datetime_precision_and_sidecar_tracking(self, db):
        _upsert(db, photo_datetime=None, sidecar_path=None, sidecar_mtime=None)
        pid = db.execute("SELECT id FROM photos WHERE filename='p1.jpg'").fetchone()[0]

        index.assign_approximate_date(pid, 946684800, "year", "p1.xmp", 42.0)

        row = index.get_photo(pid)
        assert row["photo_datetime"] == 946684800
        assert row["date_precision"] == "year"
        assert row["sidecar_path"] == "p1.xmp"
        assert row["sidecar_mtime"] == 42.0

    def test_rescan_does_not_clear_precision_flag(self, db):
        """A routine rescan (upsert_photo) doesn't touch date_precision — same
        as geocode_ignored — so an assigned approximate date survives it."""
        _upsert(db, photo_datetime=None)
        pid = db.execute("SELECT id FROM photos WHERE filename='p1.jpg'").fetchone()[0]
        index.assign_approximate_date(pid, 946684800, "year", "p1.xmp", 42.0)

        _upsert(db, photo_datetime=946684800, sidecar_path="p1.xmp", sidecar_mtime=42.0)

        assert index.get_photo(pid)["date_precision"] == "year"


class TestIsFresh:
    def test_missing_row_is_not_fresh(self, db):
        assert index.is_fresh(".", "missing.jpg", 1000.0, None, None) is False

    def test_unchanged_row_is_fresh(self, db):
        _upsert(db, mtime=1000.0, sidecar_path="p1.xmp", sidecar_mtime=500.0)
        assert index.is_fresh(".", "p1.jpg", 1000.0, "p1.xmp", 500.0) is True

    def test_mtime_drift_within_one_second_is_still_fresh(self, db):
        _upsert(db, mtime=1000.0, sidecar_path=None, sidecar_mtime=None)
        assert index.is_fresh(".", "p1.jpg", 1000.4, None, None) is True

    def test_mtime_changed_is_stale(self, db):
        _upsert(db, mtime=1000.0, sidecar_path=None, sidecar_mtime=None)
        assert index.is_fresh(".", "p1.jpg", 1005.0, None, None) is False

    def test_sidecar_added_is_stale(self, db):
        _upsert(db, mtime=1000.0, sidecar_path=None, sidecar_mtime=None)
        assert index.is_fresh(".", "p1.jpg", 1000.0, "p1.xmp", 500.0) is False

    def test_sidecar_mtime_changed_is_stale(self, db):
        _upsert(db, mtime=1000.0, sidecar_path="p1.xmp", sidecar_mtime=500.0)
        assert index.is_fresh(".", "p1.jpg", 1000.0, "p1.xmp", 600.0) is False

    def test_partially_indexed_row_is_stale(self, db):
        # camera=None simulates a row inserted by the fast scan pass before the
        # full-metadata read has happened.
        _upsert(db, camera=None)
        assert index.is_fresh(".", "p1.jpg", 1000.0, None, None) is False


class TestChecksum:
    def test_upsert_stores_and_reads_back_checksum(self, db):
        index.upsert_photo(
            filename="c.jpg", dir_=".", ext=".jpg", media_type="image",
            mtime=1.0, size=1, lat=None, lng=None, geotag_source="none",
            sidecar_path=None, sidecar_mtime=None, checksum="deadbeef",
        )
        row = db.execute("SELECT checksum FROM photos WHERE filename='c.jpg'").fetchone()
        assert row["checksum"] == "deadbeef"

    def test_upsert_defaults_checksum_to_null(self, db):
        # The scan inserts a fast row before hashing; count/query treat it as pending.
        _upsert(db, path="a.jpg")
        assert index.count_photos_missing_checksum() == 1
        assert [r["filename"] for r in index.get_photos_missing_checksum()] == ["a.jpg"]

    def test_missing_checksum_query_excludes_hashed_rows(self, db):
        _upsert(db, path="a.jpg")  # NULL checksum
        index.upsert_photo(
            filename="b.jpg", dir_=".", ext=".jpg", media_type="image",
            mtime=1.0, size=1, lat=None, lng=None, geotag_source="none",
            sidecar_path=None, sidecar_mtime=None, checksum="cafef00d",
        )
        assert index.count_photos_missing_checksum() == 1
        assert [r["filename"] for r in index.get_photos_missing_checksum()] == ["a.jpg"]

    def test_set_checksums_batch_fills_in_rows(self, db):
        _upsert(db, path="a.jpg")
        pid = db.execute("SELECT id FROM photos WHERE filename='a.jpg'").fetchone()["id"]
        index.set_checksums([("abc123", pid)])
        assert index.count_photos_missing_checksum() == 0
        assert db.execute(
            "SELECT checksum FROM photos WHERE id=?", (pid,)
        ).fetchone()["checksum"] == "abc123"


class TestOrientationBackfill:
    def test_null_orientation_rows_are_pending(self, db):
        # Simulate a pre-orientation row (indexed before the tag was read).
        _upsert(db, path="old.jpg", orientation=None)
        assert index.count_photos_missing_orientation() == 1
        assert [r["filename"] for r in index.get_photos_missing_orientation()] == ["old.jpg"]

    def test_set_orientations_clears_pending(self, db):
        _upsert(db, path="old.jpg", orientation=None)
        pid = db.execute("SELECT id FROM photos WHERE filename='old.jpg'").fetchone()["id"]
        index.set_orientations([(8, pid)])
        assert index.count_photos_missing_orientation() == 0
        assert db.execute(
            "SELECT orientation FROM photos WHERE id=?", (pid,)
        ).fetchone()["orientation"] == 8

    def test_populated_rows_are_not_pending(self, db):
        _upsert(db, path="new.jpg", orientation=1)
        assert index.count_photos_missing_orientation() == 0


def _photo_with_faces(db, path, specs, scanned=True, media_type="image"):
    """Insert a photo plus its faces. ``specs`` is a list of (person_id|None,
    ignored) — one per face; an empty list means a photo with no detected faces.
    ``scanned`` marks it as having gone through face detection."""
    import time
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type=media_type,
        mtime=1.0, size=1, lat=None, lng=None, geotag_source="none",
        sidecar_path=None, sidecar_mtime=None,
    )
    pid = db.execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()["id"]
    if scanned:
        db.execute("UPDATE photos SET faces_scanned_at=? WHERE id=?", (time.time(), pid))
    for person_id, ignored in specs:
        cur = db.execute(
            "INSERT INTO faces (photo_id, person_id, bbox, det_score, "
            "source, ignored, created_at) VALUES (?, ?, '0,0,1,1', 0.9, "
            "'detected', ?, 0)",
            (pid, person_id, ignored),
        )
        db.execute(
            "INSERT INTO face_embeddings (face_id, embedding) VALUES (?, X'00')",
            (cur.lastrowid,),
        )
    db.commit()
    return pid


class TestReplaceFacesDimension:
    def _insert(self, db, path, ext):
        index.upsert_photo(
            filename=path, dir_=".", ext=ext, media_type="image",
            mtime=1.0, size=1, lat=None, lng=None, geotag_source="none",
            sidecar_path=None, sidecar_mtime=None,
        )
        return db.execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()["id"]

    def test_records_det_dimension(self, db):
        pid = self._insert(db, "raw.nef", ".nef")
        index.replace_faces(pid, [], det_dimension=3000)
        row = db.execute(
            "SELECT faces_scanned_at, faces_det_dimension FROM photos WHERE id=?", (pid,)
        ).fetchone()
        assert row["faces_scanned_at"] is not None
        assert row["faces_det_dimension"] == 3000

    def test_defaults_to_null_for_embedded_preview_scans(self, db):
        pid = self._insert(db, "p.jpg", ".jpg")
        index.replace_faces(pid, [])   # no det_dimension → NULL (low-quality preview)
        row = db.execute(
            "SELECT faces_det_dimension FROM photos WHERE id=?", (pid,)
        ).fetchone()
        assert row["faces_det_dimension"] is None


class TestFaceCoverage:
    def test_buckets_partition_scanned_image_photos(self, db):
        alice = index.create_person("Alice")
        _photo_with_faces(db, "full_labeled.jpg", [(alice, 0), (alice, 0)])   # full
        _photo_with_faces(db, "full_ignored.jpg", [(None, 1)])               # full (all ignored)
        _photo_with_faces(db, "partial.jpg", [(alice, 0), (None, 0)])        # partial
        _photo_with_faces(db, "uncovered.jpg", [(None, 0), (None, 0)])       # none labeled
        _photo_with_faces(db, "noface.jpg", [])                              # no faces detected
        # Excluded from the tally: unscanned image, and a scanned video.
        _photo_with_faces(db, "unscanned.jpg", [(None, 0)], scanned=False)
        _photo_with_faces(db, "video.mp4", [(None, 0)], media_type="video")

        assert index.get_face_coverage() == {
            "full": 2, "partial": 1, "none": 1, "no_faces": 1,
        }

    def test_empty_library(self, db):
        assert index.get_face_coverage() == {
            "full": 0, "partial": 0, "none": 0, "no_faces": 0,
        }


class TestGetPhotosBbox:
    def test_filters_to_bbox(self, db):
        _upsert(db, path="in.jpg", lat=40.0, lng=-74.0)
        _upsert(db, path="out.jpg", lat=10.0, lng=10.0)
        rows = index.get_photos(bbox="-75,39,-73,41")
        assert [r["filename"] for r in rows] == ["in.jpg"]

    def test_unwraps_a_bbox_panned_around_the_globe(self, db):
        # Regression: Leaflet's getBounds() after panning past +/-180 returns
        # raw, unwrapped longitudes — this bbox is a Fort Worth, TX viewport
        # that arrives as -458.4/-456.1 instead of -98.4/-96.1.
        _upsert(db, path="fw.jpg", lat=32.75, lng=-97.3)
        rows = index.get_photos(
            bbox="-458.4223937988281,32.5635873170885,-456.0946655273438,33.0926823840692")
        assert [r["filename"] for r in rows] == ["fw.jpg"]


def _scan_upsert(lat=None, lng=None, source="none", camera="", gps_accuracy=-1.0,
                 sidecar_path=None, sidecar_mtime=None, mtime=1000.0):
    """upsert_photo as the scan pipeline calls it: values straight from
    sidecar.read_metadata for a file on disk."""
    index.upsert_photo(
        filename="p1.jpg", dir_=".", ext=".jpg", media_type="image",
        mtime=mtime, size=100, lat=lat, lng=lng, geotag_source=source,
        sidecar_path=sidecar_path, sidecar_mtime=sidecar_mtime,
        camera=camera, photo_datetime=0, gps_accuracy=gps_accuracy, orientation=1,
    )


class TestRescanKeepsDatabaseGeotag:
    """With WRITE_XMP_ON_GEOTAG off a hand-placed geotag lives only in the DB
    (geotag_source='database'), so a rescan must not replace it with whatever
    the file itself says."""

    def _hand_tag(self, db, lat=48.85, lng=2.35):
        _scan_upsert()
        pid = db.execute("SELECT id FROM photos WHERE filename='p1.jpg'").fetchone()[0]
        index.update_geotag(pid, lat, lng, "database", None, None)
        return pid

    def test_rescan_of_file_without_gps_keeps_the_tag(self, db):
        pid = self._hand_tag(db)

        _scan_upsert(mtime=2000.0)  # file touched → re-read, still no GPS

        row = index.get_photo(pid)
        assert (row["lat"], row["lng"], row["geotag_source"]) == (48.85, 2.35, "database")

    def test_rescan_keeps_the_tag_over_embedded_gps(self, db):
        """The user dragged a photo away from its embedded position; the file
        still carries the old one."""
        pid = self._hand_tag(db)

        _scan_upsert(lat=10.0, lng=20.0, source="embedded", gps_accuracy=4.0, mtime=2000.0)

        row = index.get_photo(pid)
        assert (row["lat"], row["lng"], row["geotag_source"]) == (48.85, 2.35, "database")

    def test_sidecar_gps_replaces_the_tag(self, db):
        """A sidecar is the durable form of a geotag (export, or another tool),
        so it wins over the DB-only value."""
        pid = self._hand_tag(db)

        _scan_upsert(lat=10.0, lng=20.0, source="sidecar", gps_accuracy=4.0,
                     sidecar_path="p1.xmp", sidecar_mtime=5.0, mtime=2000.0)

        row = index.get_photo(pid)
        assert (row["lat"], row["lng"], row["geotag_source"]) == (10.0, 20.0, "sidecar")
        assert row["gps_accuracy"] == 4.0

    def test_non_database_rows_still_follow_the_file(self, db):
        _scan_upsert(lat=10.0, lng=20.0, source="embedded")
        pid = db.execute("SELECT id FROM photos WHERE filename='p1.jpg'").fetchone()[0]

        _scan_upsert(mtime=2000.0)  # GPS stripped from the file

        row = index.get_photo(pid)
        assert (row["lat"], row["lng"], row["geotag_source"]) == (None, None, "none")

    def test_hand_tagged_row_is_fresh_after_rescan(self, db):
        """update_geotag leaves gps_accuracy NULL when none is given; the rescan
        must fill it so the row doesn't look never-read on every boot."""
        self._hand_tag(db)
        _scan_upsert(mtime=2000.0)
        assert index.is_fresh(".", "p1.jpg", 2000.0, None, None) is True


class TestCameraLessFreshness:
    def test_file_with_no_camera_tags_is_fresh_once_read(self, db):
        """'' = metadata read, no Make/Model found (scans, screenshots). Only
        NULL means never read."""
        _scan_upsert(camera="")
        assert index.is_fresh(".", "p1.jpg", 1000.0, None, None) is True

    def test_never_read_camera_is_stale(self, db):
        _scan_upsert(camera=None)
        assert index.is_fresh(".", "p1.jpg", 1000.0, None, None) is False


class TestDayStartTs:
    def test_is_utc_midnight(self):
        assert index._day_start_ts("1970-01-02") == 86400
        assert index._day_start_ts("2024-03-01") == 1709251200

    def test_pre_1970_date_is_negative_not_an_error(self):
        # datetime.timestamp() raises OSError for these on Windows.
        assert index._day_start_ts("1969-12-31") == -86400

    def test_unparseable_input_is_none(self):
        assert index._day_start_ts("not-a-date") is None
        assert index._day_start_ts("2024-13-01") is None
        assert index._day_start_ts("2024-03-01T00:00") is None


class TestDateRangeFilters:
    """get_photos and search_photos share _day_start_ts; both treat the range
    as whole UTC days, inclusive at both ends."""

    DAY = 1709251200  # 2024-03-01 00:00 UTC

    def _library(self, db):
        _upsert(db, path="before.jpg", photo_datetime=self.DAY - 1)
        _upsert(db, path="start.jpg", photo_datetime=self.DAY)
        _upsert(db, path="end.jpg", photo_datetime=self.DAY + 86399)
        _upsert(db, path="after.jpg", photo_datetime=self.DAY + 86400)

    def test_get_photos_range_covers_the_whole_day(self, db):
        self._library(db)
        rows = index.get_photos(date_from="2024-03-01", date_to="2024-03-01")
        assert [r["filename"] for r in rows] == ["start.jpg", "end.jpg"]

    def test_search_photos_range_covers_the_whole_day(self, db):
        self._library(db)
        rows = index.search_photos(date_from="2024-03-01", date_to="2024-03-01")
        assert [r["filename"] for r in rows] == ["start.jpg", "end.jpg"]

    def test_unparseable_bounds_are_ignored(self, db):
        self._library(db)
        assert len(index.get_photos(date_from="garbage", date_to="nope")) == 4
        assert len(index.search_photos(date_from="garbage", date_to="nope")) == 4

    def test_one_bad_bound_does_not_disable_the_other(self, db):
        self._library(db)
        rows = index.get_photos(date_from="garbage", date_to="2024-03-01")
        assert [r["filename"] for r in rows] == ["before.jpg", "start.jpg", "end.jpg"]
        rows = index.search_photos(date_from="2024-03-01", date_to="garbage")
        assert [r["filename"] for r in rows] == ["start.jpg", "end.jpg", "after.jpg"]


class TestVacuumIfNeeded:
    def test_resize_changes_page_size_and_stays_in_wal(self, db):
        result = index.vacuum_if_needed(min_free_ratio=1.0, target_page_size=8192)
        assert result["vacuumed"] and result["resized"]
        assert db.execute("PRAGMA page_size").fetchone()[0] == 8192
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"

    def test_failed_vacuum_still_restores_wal(self, db, monkeypatch):
        """The resize path drops to the rollback journal for the VACUUM; a
        failure there (disk full) must not leave the session out of WAL."""
        seen = []

        class FailingVacuum:
            def execute(self, sql, *args):
                if sql == "VACUUM":
                    # Proves the test really went through the non-WAL window.
                    seen.append(db.execute("PRAGMA journal_mode").fetchone()[0])
                    raise sqlite3.OperationalError("database or disk is full")
                return db.execute(sql, *args)

        monkeypatch.setattr(index, "get_db", lambda: FailingVacuum())
        with pytest.raises(sqlite3.OperationalError):
            index.vacuum_if_needed(min_free_ratio=1.0, target_page_size=8192)

        assert seen == ["delete"]
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


class TestCloseDb:
    def test_get_db_raises_after_close(self, db):
        index.close_db()

        with pytest.raises(RuntimeError, match="not initialized"):
            index.get_db()
        with pytest.raises(sqlite3.ProgrammingError):
            db.execute("SELECT 1")

    def test_close_is_idempotent(self, db):
        index.close_db()
        index.close_db()  # nothing open: no-op

    def test_close_folds_the_wal_into_the_main_file(self, db):
        _upsert(db)
        wal = index._db_path.with_name("index.db-wal")
        assert wal.exists() and wal.stat().st_size > 0

        index.close_db()

        assert not wal.exists() or wal.stat().st_size == 0


class TestGeotagGeneration:
    """The change-stamp behind coordinate-derived caches: it must move on every
    lat/lng change and stay put for writes that leave coordinates alone."""

    def _pid(self, db):
        return db.execute("SELECT id FROM photos WHERE filename='p1.jpg'").fetchone()[0]

    def test_new_geotagged_photo_bumps(self, db):
        gen = index.geotag_generation()
        _upsert(db, lat=40.0, lng=-75.0)
        assert index.geotag_generation() > gen

    def test_new_untagged_photo_does_not_bump(self, db):
        gen = index.geotag_generation()
        _upsert(db)
        assert index.geotag_generation() == gen

    def test_rescan_with_unchanged_coordinates_does_not_bump(self, db):
        _upsert(db, lat=40.0, lng=-75.0)
        gen = index.geotag_generation()
        _upsert(db, lat=40.0, lng=-75.0, mtime=2000.0)  # file touched, same GPS
        assert index.geotag_generation() == gen

    def test_rescan_with_moved_coordinates_bumps(self, db):
        _upsert(db, lat=40.0, lng=-75.0)
        gen = index.geotag_generation()
        _upsert(db, lat=41.0, lng=-75.0, mtime=2000.0)
        assert index.geotag_generation() > gen

    def test_rescan_that_keeps_a_database_tag_does_not_bump(self, db):
        """The stored coordinates decide, not the ones passed in: a hand-placed
        DB-only tag survives the rescan, so nothing moved."""
        _scan_upsert()
        index.update_geotag(self._pid(db), 48.85, 2.35, "database", None, None)
        gen = index.geotag_generation()
        _scan_upsert(lat=10.0, lng=20.0, source="embedded", mtime=2000.0)
        assert index.geotag_generation() == gen

    def test_update_geotag_bumps_on_tag_move_and_removal(self, db):
        _upsert(db)
        pid = self._pid(db)
        gen = index.geotag_generation()
        index.update_geotag(pid, 40.0, -75.0, "sidecar", "p1.xmp", 1.0)
        tagged = index.geotag_generation()
        index.update_geotag(pid, 41.0, -75.0, "sidecar", "p1.xmp", 2.0)
        moved = index.geotag_generation()
        index.update_geotag(pid, None, None, "none", "p1.xmp", 3.0)
        assert gen < tagged < moved < index.geotag_generation()

    def test_non_coordinate_writes_do_not_bump(self, db):
        _upsert(db, lat=40.0, lng=-75.0)
        pid = self._pid(db)
        gen = index.geotag_generation()
        index.set_geocode_ignored([pid], True)
        index.assign_approximate_date(pid, 946684800, "year", None, None)
        assert index.geotag_generation() == gen


class TestPlaceSearchWithOpenCursor:
    """search_place_distance is registered once on the shared connection (init_db).
    Registering it per query raised "Error creating function" while another
    statement on the connection was still active, e.g. a cursor left partly read."""

    def test_place_queries_work_while_another_cursor_is_open(self, db):
        for i in range(3):
            _upsert(db, path=f"in{i}.jpg", lat=40.0 + i * 1e-4, lng=-75.0, photo_datetime=100 + i)
        _upsert(db, path="far.jpg", lat=41.0, lng=-75.0, photo_datetime=200)
        pid = index.create_place("Home", "circle", '{"lat":40.0,"lng":-75.0,"radius":1000}')

        cur = db.execute("SELECT id FROM photos ORDER BY id")
        cur.fetchone()  # leave the statement active, with rows still pending

        rows = index.search_photos(place_id=pid, nearby_m=0)
        assert sorted(r["filename"] for r in rows) == ["in0.jpg", "in1.jpg", "in2.jpg"]
        assert index.get_place_stats()[pid]["photo_count"] == 3
