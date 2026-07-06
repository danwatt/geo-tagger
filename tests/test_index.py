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
        db.execute(
            "INSERT INTO faces (photo_id, person_id, bbox, det_score, embedding, "
            "source, ignored, created_at) VALUES (?, ?, '0,0,1,1', 0.9, X'00', "
            "'detected', ?, 0)",
            (pid, person_id, ignored),
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


class TestContextsForTime:
    def _make(self, db, name, start_ts, end_ts):
        return index.create_context(
            name, json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            start_ts, end_ts, 0, 1, 0, 1,
        )

    def test_open_ended_context_matches_any_time(self, db):
        self._make(db, "always", None, None)
        rows = index.contexts_for_time(9999999)
        assert len(rows) == 1

    def test_closed_range_matches_inside(self, db):
        self._make(db, "range", 100, 200)
        assert len(index.contexts_for_time(150)) == 1

    def test_closed_range_excludes_before_and_after(self, db):
        self._make(db, "range", 100, 200)
        assert index.contexts_for_time(50) == []
        assert index.contexts_for_time(250) == []

    def test_open_start_matches_up_to_end(self, db):
        self._make(db, "until-200", None, 200)
        assert len(index.contexts_for_time(-500)) == 1
        assert index.contexts_for_time(201) == []

    def test_open_end_matches_from_start_onward(self, db):
        self._make(db, "from-100", 100, None)
        assert len(index.contexts_for_time(100)) == 1
        assert len(index.contexts_for_time(1_000_000)) == 1
        assert index.contexts_for_time(99) == []

    def test_only_matching_contexts_returned(self, db):
        self._make(db, "early", 0, 100)
        self._make(db, "late", 200, 300)
        rows = index.contexts_for_time(50)
        assert [r["name"] for r in rows] == ["early"]


class TestContextsForPointTime:
    def test_point_inside_polygon_and_time_matches(self, db):
        index.create_context(
            "square", json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            None, None, 0, 1, 0, 1,
        )
        rows = index.contexts_for_point_time(0.5, 0.5, 123)
        assert len(rows) == 1

    def test_point_outside_bbox_excluded(self, db):
        index.create_context(
            "square", json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            None, None, 0, 1, 0, 1,
        )
        assert index.contexts_for_point_time(5, 5, 123) == []

    def test_time_outside_range_excludes_even_if_point_matches(self, db):
        index.create_context(
            "square", json.dumps([[0, 0], [0, 1], [1, 1], [1, 0]]),
            100, 200, 0, 1, 0, 1,
        )
        assert index.contexts_for_point_time(0.5, 0.5, 999) == []


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
