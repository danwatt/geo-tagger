"""Audit D5: a rescan that changes what a photo IS must invalidate what was derived
from the old version.

Coordinates: an externally edited sidecar moves lat/lng, and the place names
(loc_*, geocoded_at) derived from the old position must be cleared in the same
upsert so the geocode backfill resolves the new one. File content: a changed
checksum drops the semantic embedding so it is re-embedded, but never touches
faces or person assignments (manual, DB-only work a face re-detect would destroy).
"""

import pytest

from geotagger import index, sidecar

_PLACE = {
    "loc_city": "Oldtown", "loc_state": "Oldstate", "loc_county": "Old County",
    "loc_country": "Oldland", "loc_country_code": "OL",
    "loc_sublocation": "Old Park", "loc_postal_code": "00000", "geocoded_at": 1234.0,
}


def _scan(path="p1.jpg", lat=None, lng=None, source=None, checksum=None, mtime=1000.0,
          sidecar_path=None):
    """upsert_photo as the scan calls it (values as read_metadata returns them)."""
    if source is None:
        source = "sidecar" if lat is not None else "none"
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=mtime, size=100, lat=lat, lng=lng, geotag_source=source,
        sidecar_path=sidecar_path, sidecar_mtime=5.0 if sidecar_path else None,
        camera="", photo_datetime=0, gps_accuracy=-1.0, orientation=1,
        checksum=checksum,
    )


def _pid(db, path="p1.jpg"):
    return db.execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()[0]


def _set_place(db, pid):
    sets = ", ".join(f"{c}=?" for c in _PLACE)
    with index.transaction() as tx:
        tx.execute(f"UPDATE photos SET {sets} WHERE id=?", (*_PLACE.values(), pid))


def _derived(db, pid):
    cols = ", ".join(index.DERIVED_LOCATION_COLUMNS)
    return dict(db.execute(f"SELECT {cols} FROM photos WHERE id=?", (pid,)).fetchone())


def _cleared(db, pid):
    row = _derived(db, pid)
    return all(v is None for v in row.values())


def _intact(db, pid):
    return _derived(db, pid) == _PLACE


# ── Part A: coordinates changed on rescan ──

class TestRescanCoordinateChange:
    def test_moved_sidecar_clears_every_derived_column_and_queues_geocode(self, db):
        _scan(lat=40.0, lng=-75.0, sidecar_path="p1.xmp")
        pid = _pid(db)
        _set_place(db, pid)
        assert index.count_photos_needing_geocode() == 0

        _scan(lat=41.0, lng=-75.0, sidecar_path="p1.xmp", mtime=2000.0)

        assert _cleared(db, pid), _derived(db, pid)
        assert index.count_photos_needing_geocode() == 1
        assert [r["id"] for r in index.get_photos_needing_geocode()] == [pid]

    def test_moved_longitude_only_also_clears(self, db):
        _scan(lat=40.0, lng=-75.0)
        pid = _pid(db)
        _set_place(db, pid)
        _scan(lat=40.0, lng=-74.0, mtime=2000.0)
        assert _cleared(db, pid)

    def test_unchanged_coordinates_leave_place_names_intact(self, db):
        _scan(lat=40.0, lng=-75.0)
        pid = _pid(db)
        _set_place(db, pid)
        _scan(lat=40.0, lng=-75.0, mtime=2000.0)  # file touched, same GPS
        assert _intact(db, pid)
        assert index.count_photos_needing_geocode() == 0

    def test_float_noise_below_epsilon_is_not_a_move(self, db):
        _scan(lat=40.123456789012, lng=-75.0)
        pid = _pid(db)
        _set_place(db, pid)
        _scan(lat=40.123456789012 + 3e-11, lng=-75.0 - 3e-11, mtime=2000.0)
        assert _intact(db, pid)

    def test_value_to_null_clears(self, db):
        """GPS stripped from the file (not a DB-only tag, no removal marker)."""
        _scan(lat=40.0, lng=-75.0, source="embedded")
        pid = _pid(db)
        _set_place(db, pid)
        _scan(mtime=2000.0)
        assert index.get_photo(pid)["lat"] is None
        assert _cleared(db, pid)

    def test_null_to_value_clears_stale_names(self, db):
        """An untagged row carrying stale names (e.g. from an older build) that
        gains coordinates must be geocoded fresh, not keep the stale place."""
        _scan()
        pid = _pid(db)
        _set_place(db, pid)
        _scan(lat=40.0, lng=-75.0, sidecar_path="p1.xmp", mtime=2000.0)
        assert _cleared(db, pid)
        assert index.count_photos_needing_geocode() == 1

    def test_untagged_rescan_leaves_columns_alone(self, db):
        _scan()
        pid = _pid(db)
        _set_place(db, pid)
        _scan(mtime=2000.0)
        assert _intact(db, pid)

    def test_kept_database_tag_leaves_place_names_intact(self, db):
        """`keep`: the hand-placed DB-only tag survives the rescan, so nothing
        moved, whatever the file says."""
        _scan()
        pid = _pid(db)
        index.update_geotag(pid, 48.85, 2.35, "database", None, None)
        _set_place(db, pid)
        _scan(lat=10.0, lng=20.0, source="embedded", mtime=2000.0)
        assert (index.get_photo(pid)["lat"], index.get_photo(pid)["lng"]) == (48.85, 2.35)
        assert _intact(db, pid)

    def test_removed_marker_keeps_coordinates_null_and_columns_untouched(self, db):
        """`removed`: embedded GPS does not come back, so stored coordinates stay
        NULL -> NULL and nothing is cleared beyond what the removal did."""
        _scan(lat=40.5, lng=-74.0, source="embedded")
        pid = _pid(db)
        index.update_geotag(pid, None, None, "none", None, None, gps_accuracy=-1.0)
        _set_place(db, pid)  # sentinel: must not be touched by the rescan
        _scan(lat=40.5, lng=-74.0, source="embedded", mtime=2000.0)
        assert index.get_photo(pid)["lat"] is None
        assert _intact(db, pid)

    def test_sidecar_coordinates_after_removal_clear(self, db):
        """A sidecar with coordinates lifts the removal and is a real move."""
        _scan(lat=40.5, lng=-74.0, source="embedded")
        pid = _pid(db)
        index.update_geotag(pid, None, None, "none", None, None, gps_accuracy=-1.0)
        _set_place(db, pid)
        _scan(lat=12.0, lng=13.0, sidecar_path="p1.xmp", mtime=2000.0)
        assert index.get_photo(pid)["lat"] == 12.0
        assert _cleared(db, pid)

    def test_batched_upserts_in_one_transaction(self, db):
        """The scan writes 200-row batches inside one transaction (each upsert a
        nested savepoint); per-row outcomes must match the unbatched path."""
        for name in ("a.jpg", "b.jpg", "c.jpg"):
            _scan(path=name, lat=40.0, lng=-75.0)
            _set_place(db, _pid(db, name))
        with index.transaction():
            _scan(path="a.jpg", lat=41.0, lng=-75.0, mtime=2000.0)   # moved
            _scan(path="b.jpg", lat=40.0, lng=-75.0, mtime=2000.0)   # unchanged
            _scan(path="c.jpg", mtime=2000.0)                        # stripped
            _scan(path="d.jpg", lat=1.0, lng=2.0)                    # new
        assert _cleared(db, _pid(db, "a.jpg"))
        assert _intact(db, _pid(db, "b.jpg"))
        assert _cleared(db, _pid(db, "c.jpg"))
        assert _cleared(db, _pid(db, "d.jpg"))
        assert index.count_photos_needing_geocode() == 2   # a (moved) and d (new)


class TestSidecarRoundTripIsNotAMove:
    def test_reread_of_sidecar_written_from_full_precision_float(self, db, et_session, sample_image):
        """A sidecar written from a full-precision float reads back ~1e-10 deg off
        (ExifTool stores degrees + decimal minutes). Re-reading the photo the user
        tagged here must not wipe its place names."""
        lat, lng = 40.71280123456789, -74.00601234567891
        sidecar.write_gps(sample_image, lat, lng)
        meta = sidecar.read_metadata(sample_image)
        assert (meta["lat"], meta["lng"]) != (lat, lng)  # the jitter is real

        _scan(path=sample_image.name, lat=lat, lng=lng, sidecar_path="photo.xmp")
        pid = _pid(db, sample_image.name)
        _set_place(db, pid)
        _scan(path=sample_image.name, lat=meta["lat"], lng=meta["lng"],
              sidecar_path="photo.xmp", mtime=2000.0)
        assert _intact(db, pid)


# ── Part B: file content changed (checksum) ──

class TestChecksumChange:
    MODEL = "test-model"

    def _photo_with_derivatives(self, db, checksum):
        _scan(lat=40.0, lng=-75.0, checksum=checksum)
        pid = _pid(db)
        alice = index.create_person("Alice")
        with index.transaction() as tx:
            tx.execute("UPDATE photos SET faces_scanned_at=99.0 WHERE id=?", (pid,))
            fid = tx.execute(
                "INSERT INTO faces (photo_id, person_id, bbox, det_score, source, created_at, "
                "assigned_at) VALUES (?, ?, '0,0,1,1', 0.9, 'detected', 0, 1)",
                (pid, alice),
            ).lastrowid
            tx.execute("INSERT INTO face_embeddings (face_id, embedding) VALUES (?, X'00')", (fid,))
        index.store_embeddings([(pid, b"\x00\x01")], self.MODEL)
        return pid, fid, alice

    def _state(self, db, pid, fid):
        return {
            "embedded": index.get_embedding(pid, self.MODEL) is not None,
            "faces_scanned_at": index.get_photo(pid)["faces_scanned_at"],
            "face": tuple(db.execute("SELECT photo_id, person_id FROM faces WHERE id=?",
                                     (fid,)).fetchone() or ()),
            "face_embedding": db.execute("SELECT COUNT(*) FROM face_embeddings WHERE face_id=?",
                                         (fid,)).fetchone()[0],
        }

    def test_changed_checksum_requeues_semantic_but_keeps_faces(self, db):
        pid, fid, alice = self._photo_with_derivatives(db, "aaa")
        _scan(lat=40.0, lng=-75.0, checksum="bbb", mtime=2000.0)
        assert self._state(db, pid, fid) == {
            "embedded": False, "faces_scanned_at": 99.0,
            "face": (pid, alice), "face_embedding": 1,
        }
        assert pid in index.get_unembedded_photo_ids(self.MODEL)
        assert index.get_photo(pid)["checksum"] == "bbb"

    def test_first_hashing_resets_nothing(self, db):
        """NULL -> hash is a first hashing (old row, or a failed hash earlier)."""
        pid, fid, alice = self._photo_with_derivatives(db, None)
        _scan(lat=40.0, lng=-75.0, checksum="aaa", mtime=2000.0)
        assert self._state(db, pid, fid)["embedded"] is True
        assert pid not in index.get_unembedded_photo_ids(self.MODEL)

    def test_failed_hash_resets_nothing(self, db):
        """hash -> NULL (scan_file's hash failed) isn't evidence of a change."""
        pid, fid, alice = self._photo_with_derivatives(db, "aaa")
        _scan(lat=40.0, lng=-75.0, checksum=None, mtime=2000.0)
        assert self._state(db, pid, fid)["embedded"] is True

    def test_same_checksum_resets_nothing(self, db):
        pid, fid, alice = self._photo_with_derivatives(db, "aaa")
        _scan(lat=40.0, lng=-75.0, checksum="aaa", mtime=2000.0)
        assert self._state(db, pid, fid) == {
            "embedded": True, "faces_scanned_at": 99.0,
            "face": (pid, alice), "face_embedding": 1,
        }

    def test_backfill_set_checksums_resets_nothing(self, db):
        pid, fid, alice = self._photo_with_derivatives(db, None)
        index.set_checksums([("aaa", pid)])
        assert self._state(db, pid, fid)["embedded"] is True

    def test_batched_checksum_changes(self, db):
        pid, fid, alice = self._photo_with_derivatives(db, "aaa")
        _scan(path="q.jpg", checksum="qqq")
        qid = _pid(db, "q.jpg")
        index.store_embeddings([(qid, b"\x00")], self.MODEL)
        with index.transaction():
            _scan(lat=40.0, lng=-75.0, checksum="bbb", mtime=2000.0)   # changed
            _scan(path="q.jpg", checksum="qqq", mtime=2000.0)          # same
        assert index.get_embedding(pid, self.MODEL) is None
        assert index.get_embedding(qid, self.MODEL) is not None
        assert self._state(db, pid, fid)["face"] == (pid, alice)

    def test_rescan_failure_rolls_back_embedding_delete(self, db):
        """The delete rides the upsert's transaction: a batch that fails keeps it."""
        pid, fid, alice = self._photo_with_derivatives(db, "aaa")
        with pytest.raises(RuntimeError):
            with index.transaction():
                _scan(lat=40.0, lng=-75.0, checksum="bbb", mtime=2000.0)
                raise RuntimeError("boom")
        assert index.get_embedding(pid, self.MODEL) is not None
        assert index.get_photo(pid)["checksum"] == "aaa"
