"""The photos table rebuild that drops the legacy `path` column (audit D6), and the
startup recovery for databases the old, non-atomic rebuild left half-migrated.

Every test builds an on-disk DB by hand in the shape a real old install had —
`path TEXT UNIQUE NOT NULL`, faces keyed on photo ids with person assignments, an
R*Tree kept in sync by triggers — then runs the real index.init_db on it."""
import os
import re
import sqlite3
import subprocess
import sys
import textwrap

import pytest

from geotagger import db_timing, index

# Deliberately sparse ids: a rebuild that renumbered rows would show.
PHOTOS = [  # id, dir, filename, lat, lng
    (3, "/lib", "a.jpg", 40.0, -75.0),
    (7, "/lib", "b.jpg", None, None),
    (42, "/lib/sub", "c.jpg", 41.0, -74.0),
]
FACES = [  # id, photo_id, person_id
    (10, 3, 1), (11, 3, None), (12, 42, 2),
]

LEGACY_SCHEMA = """
CREATE TABLE photos (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    dir TEXT NOT NULL,
    ext TEXT NOT NULL,
    media_type TEXT NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    lat REAL,
    lng REAL,
    geotag_source TEXT NOT NULL DEFAULT 'none',
    sidecar_path TEXT,
    sidecar_mtime REAL,
    camera TEXT,
    scanned_at REAL NOT NULL,
    photo_datetime INTEGER,
    faces_scanned_at REAL,
    geocode_ignored INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE persons (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at REAL NOT NULL);
CREATE TABLE faces (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    bbox TEXT NOT NULL,
    det_score REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'detected',
    created_at REAL NOT NULL
);
CREATE TABLE face_embeddings (
    face_id INTEGER PRIMARY KEY REFERENCES faces(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL
);
CREATE INDEX idx_faces_photo ON faces(photo_id);
CREATE VIRTUAL TABLE photos_spatial USING rtree(id, min_lat, max_lat, min_lng, max_lng);
CREATE TRIGGER photos_spatial_insert AFTER INSERT ON photos
WHEN NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL
BEGIN
    INSERT INTO photos_spatial (id, min_lat, max_lat, min_lng, max_lng)
    VALUES (NEW.id, NEW.lat, NEW.lat, NEW.lng, NEW.lng);
END;
CREATE TRIGGER photos_spatial_update AFTER UPDATE ON photos
BEGIN
    DELETE FROM photos_spatial WHERE id = OLD.id;
    INSERT INTO photos_spatial (id, min_lat, max_lat, min_lng, max_lng)
    SELECT NEW.id, NEW.lat, NEW.lat, NEW.lng, NEW.lng
    WHERE NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL;
END;
CREATE TRIGGER photos_spatial_delete AFTER DELETE ON photos
BEGIN
    DELETE FROM photos_spatial WHERE id = OLD.id;
END;
CREATE TABLE photo_embeddings (photo_id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB,
                               created_at REAL NOT NULL);
CREATE TRIGGER photo_embeddings_delete AFTER DELETE ON photos
BEGIN
    DELETE FROM photo_embeddings WHERE photo_id = OLD.id;
END;
CREATE INDEX idx_photos_datetime ON photos(photo_datetime);
"""


def _db_file(tmp_path):
    cache = tmp_path / index.CACHE_DIR_NAME
    cache.mkdir(exist_ok=True)
    return cache / "index.db"


def _build_legacy(tmp_path):
    """A pre-migration DB: photos still has `path`, faces/embeddings/R*Tree populated."""
    conn = sqlite3.connect(_db_file(tmp_path))
    conn.executescript(LEGACY_SCHEMA)
    conn.executemany("INSERT INTO persons VALUES (?, ?, 0)", [(1, "Ann"), (2, "Bob")])
    for pid, d, f, lat, lng in PHOTOS:
        conn.execute(
            "INSERT INTO photos (id, path, filename, dir, ext, media_type, mtime, size, lat, lng,"
            " scanned_at, photo_datetime) VALUES (?, ?, ?, ?, '.jpg', 'image', 1, 1, ?, ?, 1, ?)",
            (pid, f"{d}/{f}", f, d, lat, lng, 1000 + pid))
    for fid, pid, person in FACES:
        conn.execute("INSERT INTO faces (id, photo_id, person_id, bbox, det_score, created_at)"
                     " VALUES (?, ?, ?, '[0,0,1,1]', 0.9, 0)", (fid, pid, person))
        conn.execute("INSERT INTO face_embeddings VALUES (?, ?)", (fid, bytes([fid]) * 8))
    conn.executemany("INSERT INTO photo_embeddings VALUES (?, 'm', x'00', 0)", [(3,), (42,)])
    conn.commit()
    conn.close()


def _old_code_rebuild_until_crash(tmp_path, finish=False):
    """What the pre-D6 code committed before a crash mid-copy: the RENAME and the new
    (path-less) CREATE, each autocommitted. finish=True runs it to completion — the
    state every DB the old code migrated successfully is in."""
    conn = sqlite3.connect(_db_file(tmp_path))
    conn.execute("ALTER TABLE photos RENAME TO photos_old")
    conn.execute("""CREATE TABLE photos (id INTEGER PRIMARY KEY, filename TEXT NOT NULL,
        dir TEXT NOT NULL, ext TEXT NOT NULL, media_type TEXT NOT NULL, mtime REAL NOT NULL,
        size INTEGER NOT NULL, lat REAL, lng REAL, geotag_source TEXT NOT NULL DEFAULT 'none',
        sidecar_path TEXT, sidecar_mtime REAL, camera TEXT, scanned_at REAL NOT NULL,
        photo_datetime INTEGER, faces_scanned_at REAL, geocode_ignored INTEGER NOT NULL DEFAULT 0,
        UNIQUE(dir, filename))""")
    if finish:
        cols = ("id, filename, dir, ext, media_type, mtime, size, lat, lng, geotag_source, "
                "sidecar_path, sidecar_mtime, camera, scanned_at, photo_datetime, "
                "faces_scanned_at, geocode_ignored")
        conn.execute(f"INSERT INTO photos ({cols}) SELECT {cols} FROM photos_old")
        conn.execute("DROP TABLE photos_old")
    conn.commit()
    conn.close()


def _dump(tmp_path):
    """Logical content of the whole DB file: schema + every row (R*Tree shadow
    tables included)."""
    conn = sqlite3.connect(_db_file(tmp_path))
    try:
        return list(conn.iterdump())
    finally:
        conn.close()


@pytest.fixture
def opened(monkeypatch):
    """Call init_db on the test's DB; always close and reset the singleton after."""
    monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
    conns = []

    def open_(tmp_path):
        conn = index.init_db(tmp_path)
        conns.append(conn)
        return conn

    yield open_
    for c in conns:
        c.close()
    if index._db is not None and index._db not in conns:
        index._db.close()
    index._db = None
    index._db_path = None


def _close_failed():
    """init_db raised: the connection it opened is still the singleton."""
    if index._db is not None:
        index._db.close()
    index._db = None
    index._db_path = None


def _photo_rows(conn):
    return [tuple(r) for r in conn.execute("SELECT id, dir, filename, lat, lng FROM photos ORDER BY id")]


def _face_rows(conn):
    return [tuple(r) for r in conn.execute("SELECT id, photo_id, person_id FROM faces ORDER BY id")]


def _fk_targets(conn, table="faces"):
    return {r[0] for r in conn.execute("SELECT \"table\" FROM pragma_foreign_key_list(?)", (table,))}


def _tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _assert_fully_migrated(conn):
    """Original ids, links, derived rows and schema objects all intact."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    assert "path" not in cols
    assert {"geotag_removed", "loc_city", "checksum"} <= cols  # filled in by the ADD COLUMN guards
    # The old hand-written CREATE's dead columns are not invented.
    assert not cols & {"loc_landmark", "loc_landmark_type", "face_count", "faces_processed_at"}
    assert _photo_rows(conn) == PHOTOS
    assert _face_rows(conn) == FACES
    assert [r[0] for r in conn.execute("SELECT face_id FROM face_embeddings ORDER BY 1")] == [10, 11, 12]
    assert [r[0] for r in conn.execute("SELECT photo_id FROM photo_embeddings ORDER BY 1")] == [3, 42]
    assert [tuple(r) for r in conn.execute("SELECT id, min_lat, min_lng FROM photos_spatial ORDER BY id")] \
        == [(3, 40.0, -75.0), (42, 41.0, -74.0)]
    assert _fk_targets(conn) == {"photos", "persons"}
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert not _tables(conn) & {"photos_old", "photos_new", "faces_new"}
    objs = {r[0]: r[1] for r in conn.execute(
        "SELECT name, tbl_name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL")}
    for name in ("photos_spatial_insert", "photos_spatial_update", "photos_spatial_delete",
                 "photo_embeddings_delete", "idx_photos_datetime", "idx_photos_untagged",
                 "idx_photos_facescan"):
        assert objs.get(name) == "photos", name
    assert objs.get("idx_faces_photo") == "faces"
    # UNIQUE(dir, filename) replaces the old UNIQUE path.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO photos (filename, dir, ext, media_type, mtime, size, scanned_at)"
                     " VALUES ('a.jpg', '/lib', '.jpg', 'image', 1, 1, 1)")
    # The spatial index and its (rewritten, lat/lng-scoped) triggers work.
    assert [r["filename"] for r in index.get_photos(bbox="-75.5,39.5,-74.5,40.5")] == ["a.jpg"]
    index.update_geotag(7, 40.1, -75.1, "sidecar", "b.xmp", 1.0)
    assert sorted(r["filename"] for r in index.get_photos(bbox="-75.5,39.5,-74.5,40.5")) == ["a.jpg", "b.jpg"]


# ── (a) the migration itself ──

class TestPathMigration:
    def test_preserves_ids_links_and_spatial_index(self, tmp_path, opened):
        _build_legacy(tmp_path)
        conn = opened(tmp_path)
        _assert_fully_migrated(conn)

    def test_second_init_is_a_noop(self, tmp_path, opened):
        _build_legacy(tmp_path)
        opened(tmp_path).close()
        index._db = None
        first = _dump(tmp_path)
        opened(tmp_path)
        assert _dump(tmp_path) == first

    def test_faces_fk_is_not_repointed_by_the_rebuild(self, tmp_path, opened):
        # Renaming the NEW table into place leaves faces' SQL text alone.
        _build_legacy(tmp_path)
        conn = opened(tmp_path)
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='faces'").fetchone()[0]
        assert "REFERENCES photos(id)" in sql and "photos_old" not in sql

    def test_extra_legacy_columns_are_carried_not_dropped(self, tmp_path, opened):
        # Any column the old table has (here the old code's dead loc_landmark) keeps
        # its data; only `path` goes.
        _build_legacy(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        conn.execute("ALTER TABLE photos ADD COLUMN loc_landmark TEXT")
        conn.execute("UPDATE photos SET loc_landmark='Pier' WHERE id=42")
        conn.commit()
        conn.close()
        conn = opened(tmp_path)
        assert conn.execute("SELECT loc_landmark FROM photos WHERE id=42").fetchone()[0] == "Pier"


# ── (b) failure mid-migration ──

_COPY_RE = re.compile(r'^\s*INSERT INTO "?photos(_new)?"?\s*\(.*\)\s*SELECT', re.S | re.I)


class TestFailureMidMigration:
    """A crash during the copy must leave the DB exactly as it was. Simulated by
    failing the copy INSERT itself — the statement both the old and new code issue —
    so this also fails against the pre-D6 code (verified: it leaves photos_old plus
    an empty photos there)."""

    def _fail_copy(self, monkeypatch):
        real = db_timing.TimedConnection.execute

        def execute(self, sql, parameters=()):
            if _COPY_RE.match(sql):
                raise sqlite3.OperationalError("simulated crash during copy")
            return real(self, sql, parameters)

        monkeypatch.setattr(db_timing.TimedConnection, "execute", execute)

    def test_failed_copy_leaves_db_unchanged_then_migrates(self, tmp_path, opened, monkeypatch):
        _build_legacy(tmp_path)
        before = _dump(tmp_path)
        self._fail_copy(monkeypatch)
        with pytest.raises(sqlite3.OperationalError, match="simulated"):
            index.init_db(tmp_path)
        _close_failed()
        assert _dump(tmp_path) == before

        monkeypatch.undo()
        monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
        _assert_fully_migrated(opened(tmp_path))

    def test_failure_after_drop_and_rename_rolls_back_everything(self, tmp_path, opened, monkeypatch):
        # The latest possible point: copy, DROP, RENAME and the index/trigger
        # recreation all done, only the final FK check + COMMIT left.
        _build_legacy(tmp_path)
        before = _dump(tmp_path)
        real = index._fk_violations
        calls = []

        def fk_violations(db):
            calls.append(1)
            if len(calls) == 2:
                raise RuntimeError("simulated crash before commit")
            return real(db)

        monkeypatch.setattr(index, "_fk_violations", fk_violations)
        with pytest.raises(RuntimeError, match="simulated"):
            index.init_db(tmp_path)
        _close_failed()
        assert _dump(tmp_path) == before
        monkeypatch.undo()
        monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
        _assert_fully_migrated(opened(tmp_path))

    def test_process_killed_mid_copy(self, tmp_path, opened):
        # A real crash: the process dies inside the transaction, no rollback runs.
        _build_legacy(tmp_path)
        before = _dump(tmp_path)
        script = textwrap.dedent(f"""
            import os, re, sys
            from geotagger import db_timing, index
            real = db_timing.TimedConnection.execute
            pat = re.compile({_COPY_RE.pattern!r}, re.S | re.I)
            def execute(self, sql, parameters=()):
                if pat.match(sql):
                    real(self, sql, parameters)   # copy done, uncommitted
                    os._exit(3)
                return real(self, sql, parameters)
            db_timing.TimedConnection.execute = execute
            index.init_db(__import__("pathlib").Path(sys.argv[1]))
        """)
        env = {k: v for k, v in os.environ.items() if k != "GEOTAGGER_CACHE_DIR"}
        proc = subprocess.run([sys.executable, "-c", script, str(tmp_path)], env=env)
        assert proc.returncode == 3
        assert _dump(tmp_path) == before
        _assert_fully_migrated(opened(tmp_path))


# ── (c) databases the old code already left broken ──

class TestRecovery:
    def test_crash_left_empty_photos_beside_photos_old(self, tmp_path, opened):
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        assert _fk_targets(conn) == {"photos_old", "persons"}  # what the old RENAME did
        conn.close()
        _assert_fully_migrated(opened(tmp_path))

    def test_crash_then_old_code_restarted(self, tmp_path, opened):
        # The old code's next start found no `path` on the empty photos, skipped the
        # migration and recreated what it could on it — but the triggers' names were
        # taken by photos_old, so IF NOT EXISTS skipped those.
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_facescan ON photos(media_type, faces_scanned_at)")
        conn.execute("CREATE TRIGGER IF NOT EXISTS photos_spatial_insert AFTER INSERT ON photos BEGIN SELECT 1; END")
        conn.commit()
        conn.close()
        _assert_fully_migrated(opened(tmp_path))

    def test_photos_missing_entirely(self, tmp_path, opened):
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        conn.execute("DROP TABLE photos")
        conn.commit()
        conn.close()
        _assert_fully_migrated(opened(tmp_path))

    def test_completed_old_migration_dangling_fk_is_repointed(self, tmp_path, opened):
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path, finish=True)
        conn = sqlite3.connect(_db_file(tmp_path))
        assert "photos_old" not in _tables(conn)
        assert _fk_targets(conn) == {"photos_old", "persons"}
        conn.close()
        conn = opened(tmp_path)
        assert _fk_targets(conn) == {"photos", "persons"}
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert _face_rows(conn) == FACES
        assert [r[0] for r in conn.execute("SELECT face_id FROM face_embeddings ORDER BY 1")] == [10, 11, 12]
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='idx_faces_photo'").fetchone()
        # With the reference fixed, FK enforcement no longer breaks face inserts.
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("INSERT INTO faces (photo_id, bbox, det_score, created_at) VALUES (3, '[]', 1, 0)")
        conn.rollback()
        conn.execute("PRAGMA foreign_keys=OFF")

    def test_repoint_keeps_preexisting_orphan_faces(self, tmp_path, opened):
        # FKs were never enforced, so orphans can exist; the repair must neither
        # choke on them nor delete them.
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path, finish=True)
        conn = sqlite3.connect(_db_file(tmp_path))
        conn.execute("INSERT INTO faces (id, photo_id, bbox, det_score, created_at) VALUES (99, 555, '[]', 1, 0)")
        conn.commit()
        conn.close()
        conn = opened(tmp_path)
        assert _fk_targets(conn) == {"photos", "persons"}
        assert conn.execute("SELECT photo_id FROM faces WHERE id=99").fetchone()[0] == 555

    def _rescanned_after_crash(self, tmp_path):
        """Crash, then a rescan filled the new photos with fresh ids."""
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        conn.executemany(
            "INSERT INTO photos (id, filename, dir, ext, media_type, mtime, size, lat, lng, scanned_at)"
            " VALUES (?, ?, ?, '.jpg', 'image', 1, 1, ?, ?, 2)",
            [(1, "a.jpg", "/lib", 10.0, 20.0), (2, "b.jpg", "/lib", None, None)])
        conn.commit()
        conn.close()

    def test_ambiguous_keeps_both_tables_and_warns(self, tmp_path, opened, caplog):
        self._rescanned_after_crash(tmp_path)
        raw = sqlite3.connect(_db_file(tmp_path))
        old_rows = raw.execute("SELECT * FROM photos_old ORDER BY id").fetchall()
        raw.close()
        with caplog.at_level("WARNING", logger="geotagger.index"):
            conn = opened(tmp_path)  # does not crash startup
        assert {"photos", "photos_old"} <= _tables(conn)
        assert [tuple(r) for r in conn.execute("SELECT * FROM photos_old ORDER BY id")] == old_rows
        assert [r[0] for r in conn.execute("SELECT id FROM photos ORDER BY id")] == [1, 2]
        assert _face_rows(conn) == FACES
        assert _fk_targets(conn) == {"photos_old", "persons"}  # left alone: may be the right target
        msg = " ".join(r.getMessage() for r in caplog.records)
        assert "photos (2 rows)" in msg and "photos_old (3 rows)" in msg
        # The live table got its triggers back, and the R*Tree mirrors it.
        assert [tuple(r) for r in conn.execute("SELECT id, min_lat FROM photos_spatial ORDER BY id")] == [(1, 10.0)]
        assert [r["filename"] for r in index.get_photos(bbox="19,9,21,11")] == ["a.jpg"]
        index.update_geotag(2, 10.0, 20.0, "sidecar", "b.xmp", 1.0)
        assert sorted(r["filename"] for r in index.get_photos(bbox="19,9,21,11")) == ["a.jpg", "b.jpg"]

    def test_ambiguous_is_stable_across_restarts(self, tmp_path, opened):
        self._rescanned_after_crash(tmp_path)
        opened(tmp_path).close()
        index._db = None
        first = _dump(tmp_path)
        opened(tmp_path)
        assert _dump(tmp_path) == first

    def test_photos_old_dropped_only_when_provably_redundant(self, tmp_path, opened):
        # photos holds every photos_old row unchanged under the same id.
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        cols = "id, filename, dir, ext, media_type, mtime, size, lat, lng, scanned_at, photo_datetime"
        conn.execute(f"INSERT INTO photos ({cols}) SELECT {cols} FROM photos_old")
        conn.commit()
        conn.close()
        conn = opened(tmp_path)
        assert "photos_old" not in _tables(conn)
        assert _photo_rows(conn) == PHOTOS
        assert _fk_targets(conn) == {"photos", "persons"}

    def test_one_differing_value_blocks_the_drop(self, tmp_path, opened):
        _build_legacy(tmp_path)
        _old_code_rebuild_until_crash(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        cols = "id, filename, dir, ext, media_type, mtime, size, lat, lng, scanned_at, photo_datetime"
        conn.execute(f"INSERT INTO photos ({cols}) SELECT {cols} FROM photos_old")
        conn.execute("UPDATE photos SET lat=0 WHERE id=3")  # a DB-only geotag would be lost
        conn.commit()
        conn.close()
        assert "photos_old" in _tables(opened(tmp_path))

    def test_empty_leftover_photos_new_is_dropped(self, tmp_path, opened):
        _build_legacy(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        conn.execute("CREATE TABLE photos_new (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        _assert_fully_migrated(opened(tmp_path))

    def test_nonempty_leftover_photos_new_blocks_migration_loudly(self, tmp_path, opened):
        _build_legacy(tmp_path)
        conn = sqlite3.connect(_db_file(tmp_path))
        conn.execute("CREATE TABLE photos_new (id INTEGER PRIMARY KEY)")
        conn.execute("INSERT INTO photos_new VALUES (1)")
        conn.commit()
        conn.close()
        before = _dump(tmp_path)
        with pytest.raises(RuntimeError, match="photos_new"):
            index.init_db(tmp_path)
        _close_failed()
        assert _dump(tmp_path) == before


# ── (d) fresh installs ──

class TestFreshDb:
    def test_fresh_db_untouched(self, tmp_path, opened, caplog):
        with caplog.at_level("WARNING", logger="geotagger.index"):
            conn = opened(tmp_path)
        assert not caplog.records
        assert not _tables(conn) & {"photos_old", "photos_new", "faces_new"}
        assert _fk_targets(conn) == {"photos", "persons"}
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='faces'").fetchone()[0]
        assert "REFERENCES photos(id)" in sql
        cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
        assert "path" not in cols and "loc_landmark" not in cols
        conn.close()
        index._db = None
        first = _dump(tmp_path)
        opened(tmp_path)
        assert _dump(tmp_path) == first
