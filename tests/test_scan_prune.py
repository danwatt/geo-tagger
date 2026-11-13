"""Post-scan pruning of vanished files (audit S2): a deleted file's row (and its
faces) goes, a moved file's row is relinked to the new path keeping its DB-only
state, and every doubtful case — missing root, ambiguous duplicates, rows outside
the scanned root — keeps its rows. ExifTool is stubbed out, as in
test_scan_batching, so no et_session is needed."""

import numpy as np
import pytest

from geotagger import config, faces, index, scanning, sidecar


@pytest.fixture(autouse=True)
def _fresh_scan_state():
    scanning.reset_scan_state()
    yield
    scanning.reset_scan_state()


_META = {"lat": None, "lng": None, "geotag_source": "none", "camera": "",
         "photo_datetime": 0, "gps_accuracy": 0.0, "orientation": 1}


@pytest.fixture(autouse=True)
def fake_scan(monkeypatch):
    """No ExifTool, no thumbnails, no progress display, and never the real
    save_last_scan_roots (it would write the user's per-user sentinel file)."""
    monkeypatch.setattr(sidecar, "read_metadata", lambda p: dict(_META))
    monkeypatch.setattr(index, "save_last_scan_roots", lambda roots: None)
    real = scanning.scan_directory

    def quiet(root, **kw):
        return real(root, show_progress=False, generate_thumbnails=False, **kw)

    monkeypatch.setattr(scanning, "scan_directory", quiet)


@pytest.fixture
def lib(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    return root


def _write(path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _row(db, path):
    return db.execute("SELECT * FROM photos WHERE dir=? AND filename=?",
                      (str(path.parent), path.name)).fetchone()


def _count(db, table="photos"):
    return db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _tag_face(photo_id: int, person: str | None = None) -> int:
    pid = index.create_person(person) if person else None
    return index.add_manual_face(photo_id, "0,0,1,1", person_id=pid,
                                 embedding=faces.encode_embedding(np.ones(faces.EMBED_DIM, dtype=np.float32)))


def _db_geotag(photo_id: int, lat=10.0, lng=20.0):
    """A hand-placed geotag that lives only in the row (WRITE_XMP_ON_GEOTAG off)."""
    index.update_geotag(photo_id, lat, lng, "database", None, None)


def _embed(db, photo_id: int):
    with index.transaction() as tx:
        tx.execute("INSERT INTO photo_embeddings (photo_id, model, vec, created_at) "
                   "VALUES (?, 'm', x'00', 0)", (photo_id,))


class TestDeleted:
    def test_deleted_file_pruned_with_faces(self, db, lib, capsys):
        keep = _write(lib / "keep.jpg", b"keep")
        gone = _write(lib / "sub" / "gone.jpg", b"gone")
        scanning.run_scan([lib])
        gid = _row(db, gone)["id"]
        fid = _tag_face(gid, "Alice")
        _db_geotag(gid)
        _embed(db, gid)
        gen = index.faces_generation()

        gone.unlink()
        scanning.run_scan([lib])

        assert _row(db, gone) is None
        assert _row(db, keep) is not None
        assert db.execute("SELECT COUNT(*) FROM faces WHERE photo_id=?", (gid,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM face_embeddings WHERE face_id=?", (fid,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM photo_embeddings WHERE photo_id=?", (gid,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM photos_spatial WHERE id=?", (gid,)).fetchone()[0] == 0
        assert index.faces_generation() > gen
        # The person survives; only the face went.
        assert db.execute("SELECT COUNT(*) FROM persons WHERE name='Alice'").fetchone()[0] == 1
        assert "relinked 0 moved file(s), removed 1 vanished file(s)" in capsys.readouterr().out

    def test_place_representative_cleared(self, db, lib):
        _write(lib / "keep.jpg", b"keep")
        gone = _write(lib / "gone.jpg", b"gone")
        scanning.run_scan([lib])
        gid = _row(db, gone)["id"]
        with index.transaction() as tx:
            tx.execute("INSERT INTO places (name, type, bounds, created_at, representative_photo_id) "
                       "VALUES ('p', 'rect', '[]', 0, ?)", (gid,))
        gone.unlink()
        scanning.run_scan([lib])
        assert db.execute("SELECT representative_photo_id FROM places").fetchone()[0] is None


class TestMoved:
    def test_moved_file_relinked_keeping_db_only_state(self, db, lib, capsys):
        _write(lib / "other.jpg", b"other")
        old = _write(lib / "a" / "IMG_1.jpg", b"img-one")
        scanning.run_scan([lib])
        oid = _row(db, old)["id"]
        fid = _tag_face(oid, "Bob")
        _db_geotag(oid, 51.5, -0.1)
        index.set_geocode_ignored([oid], True)
        _embed(db, oid)

        new = lib / "b" / "renamed.jpg"
        new.parent.mkdir()
        old.rename(new)
        scanning.run_scan([lib])

        assert _row(db, old) is None
        row = _row(db, new)
        assert row["id"] == oid  # same row, so every photo_id reference holds
        assert (row["lat"], row["lng"], row["geotag_source"]) == (51.5, -0.1, "database")
        assert row["geocode_ignored"] == 1
        face = db.execute("SELECT f.photo_id, p.name FROM faces f JOIN persons p ON p.id=f.person_id "
                          "WHERE f.id=?", (fid,)).fetchone()
        assert tuple(face) == (oid, "Bob")
        assert db.execute("SELECT COUNT(*) FROM photo_embeddings WHERE photo_id=?", (oid,)).fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM photos_spatial WHERE id=?", (oid,)).fetchone()[0] == 1
        assert _count(db) == 2  # no leftover duplicate row
        assert "relinked 1 moved file(s), removed 0 vanished file(s)" in capsys.readouterr().out

        # Settled: the next run sees nothing to do.
        scanning.run_scan([lib])
        assert _row(db, new)["id"] == oid

    def test_move_between_scanned_roots(self, db, tmp_path):
        one, two = tmp_path / "one", tmp_path / "two"
        _write(one / "stay1.jpg", b"s1")
        _write(two / "stay2.jpg", b"s2")
        old = _write(one / "x.jpg", b"moving")
        scanning.run_scan([one, two])
        oid = _row(db, old)["id"]
        _tag_face(oid, "Cara")
        old.rename(two / "x.jpg")
        scanning.run_scan([one, two])
        assert _row(db, two / "x.jpg")["id"] == oid
        assert db.execute("SELECT COUNT(*) FROM faces WHERE photo_id=?", (oid,)).fetchone()[0] == 1

    def test_ambiguous_duplicates_not_mislinked(self, db, lib):
        """Two identical files moved and renamed: which old row is which new file
        can't be told, so neither is relinked (no tag lands on the wrong copy)."""
        _write(lib / "other.jpg", b"other")
        a = _write(lib / "a.jpg", b"same-bytes")
        b = _write(lib / "b.jpg", b"same-bytes")
        scanning.run_scan([lib])
        aid, bid = _row(db, a)["id"], _row(db, b)["id"]
        _tag_face(aid, "Ann")
        a.rename(lib / "c.jpg")
        b.rename(lib / "d.jpg")
        scanning.run_scan([lib])
        new_ids = {_row(db, lib / "c.jpg")["id"], _row(db, lib / "d.jpg")["id"]}
        assert not new_ids & {aid, bid}
        # Ann's face did not migrate onto either copy.
        assert db.execute("SELECT COUNT(*) FROM faces f JOIN persons p ON p.id=f.person_id "
                          "WHERE p.name='Ann'").fetchone()[0] == 0

    def test_duplicates_moved_with_names_relinked_by_name(self, db, lib):
        """Same tie, but the folder moved intact: unique filenames pair them."""
        _write(lib / "other.jpg", b"other")
        a = _write(lib / "old" / "a.jpg", b"same-bytes")
        b = _write(lib / "old" / "b.jpg", b"same-bytes")
        scanning.run_scan([lib])
        aid, bid = _row(db, a)["id"], _row(db, b)["id"]
        (lib / "old").rename(lib / "new")
        scanning.run_scan([lib])
        assert _row(db, lib / "new" / "a.jpg")["id"] == aid
        assert _row(db, lib / "new" / "b.jpg")["id"] == bid


class TestGuards:
    def test_missing_root_prunes_nothing(self, db, tmp_path, capsys):
        root = tmp_path / "drive"
        _write(root / "a.jpg", b"a")
        _write(root / "b.jpg", b"b")
        scanning.run_scan([root])
        aid = _row(db, root / "a.jpg")["id"]
        _tag_face(aid, "Dee")
        (root / "a.jpg").unlink()
        (root / "b.jpg").unlink()
        root.rmdir()  # the unplugged drive
        scanning.run_scan([root])
        assert _count(db) == 2
        assert _count(db, "faces") == 1
        assert "Not pruning" in capsys.readouterr().out

    def test_empty_root_prunes_nothing(self, db, lib):
        _write(lib / "a.jpg", b"a")
        scanning.run_scan([lib])
        (lib / "a.jpg").unlink()  # root still there, but the walk finds no media
        scanning.run_scan([lib])
        assert _count(db) == 1

    def test_rows_outside_scanned_root_untouched(self, db, tmp_path):
        inside, outside = tmp_path / "in", tmp_path / "inside_sibling"
        _write(inside / "a.jpg", b"a")
        gone_out = _write(outside / "b.jpg", b"b")
        # A sibling whose name shares the root's prefix ("in" vs "inside_sibling")
        # must not be treated as under it.
        scanning.run_scan([inside, outside])
        gone_out.unlink()
        _write(outside / "keep.jpg", b"k")
        scanning.run_scan([inside])  # only `in` scanned this time
        assert _row(db, gone_out) is not None

    def test_unreadable_subdir_rows_kept(self, db, lib, monkeypatch):
        _write(lib / "a.jpg", b"a")
        locked = _write(lib / "locked" / "b.jpg", b"b")
        scanning.run_scan([lib])
        import os
        real_scandir = os.scandir

        def scandir(path):
            if str(path) == str(locked.parent):
                raise PermissionError(path)
            return real_scandir(path)

        monkeypatch.setattr(os, "scandir", scandir)
        scanning.run_scan([lib])
        assert _row(db, locked) is not None

    def test_cancelled_scan_prunes_nothing(self, db, lib):
        import threading
        _write(lib / "a.jpg", b"a")
        gone = _write(lib / "b.jpg", b"b")
        scanning.run_scan([lib])
        gone.unlink()
        cancel = threading.Event()
        cancel.set()
        scanning.run_scan([lib], cancel)
        assert _row(db, gone) is not None

    def test_mass_vanish_refused(self, db, lib, capsys, monkeypatch):
        for i in range(30):
            _write(lib / f"p{i}.jpg", b"p%d" % i)
        scanning.run_scan([lib])
        for i in range(25):
            (lib / f"p{i}.jpg").unlink()
        scanning.run_scan([lib])
        assert _count(db) == 30
        assert "Refusing to remove 25 of 30" in capsys.readouterr().err
        # Opting in lets it through.
        monkeypatch.setattr(config, "SCAN_PRUNE_MAX_FRACTION", 1.0)
        scanning.run_scan([lib])
        assert _count(db) == 5

    def test_vanished_row_kept_when_move_target_failed_to_index(self, db, lib, monkeypatch):
        """The moved file's metadata read fails this run, so it has no row to
        relink to; the old row (same size) must wait rather than be deleted."""
        _write(lib / "other.jpg", b"other")
        old = _write(lib / "a.jpg", b"payload")
        scanning.run_scan([lib])
        oid = _row(db, old)["id"]
        _tag_face(oid, "Eve")
        old.rename(lib / "moved.jpg")

        def failing(p):
            if p.name == "moved.jpg":
                raise RuntimeError("exiftool hiccup")
            return dict(_META)

        monkeypatch.setattr(sidecar, "read_metadata", failing)
        scanning.run_scan([lib])
        assert db.execute("SELECT id FROM photos WHERE id=?", (oid,)).fetchone() is not None

        monkeypatch.setattr(sidecar, "read_metadata", lambda p: dict(_META))
        scanning.run_scan([lib])
        assert _row(db, lib / "moved.jpg")["id"] == oid
        assert db.execute("SELECT COUNT(*) FROM faces WHERE photo_id=?", (oid,)).fetchone()[0] == 1
