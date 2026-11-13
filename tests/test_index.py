import json

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
