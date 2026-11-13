import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from geotagger.config import CACHE_DIR_NAME, get_cache_dir, get_state_dir
from geotagger.db_timing import TimedConnection
from geotagger.timeutil import has_date

_db: sqlite3.Connection | None = None
_db_path: Path | None = None


# ── "Has a date" predicate ──
# The one SQL definition of a dated photo, twin of timeutil.has_date (see there
# for the 0-or-NULL undated convention). Never `photo_datetime > 0`: pre-1970
# dates are negative, and that test files them under Undated forever.
#
# Range filters (`photo_datetime >= ? AND < ?`) AND this in too: undated rows
# store 0, so without it any window spanning 1970-01-01 would pull them in.
#
# Spelled as a bare `!= 0`, which already rejects NULL (NULL != 0 is NULL, and
# WHERE treats NULL as false). Adding `IS NOT NULL AND` reads clearer but the
# planner turns it into a `photo_datetime > NULL` range on idx_photos_datetime and
# prefers that over the work queue's partial idx_photos_untagged: measured on a
# 200K-row synthetic library, the work-queue target query went 36 ms -> 116 ms.
# The bare form kept every other hot query level with the old `> 0` (years
# MIN/MAX ~8.5 ms, month histogram ~95 ms, time-neighbour lists ~100-115 ms), and
# beside a range bound the bound still drives the seek. In ORDER BY it sorts
# NULL, then 0 (both undated), then 1 — undated first ascending.
def has_date_sql(alias: str = "") -> str:
    """``(… != 0)`` for photo_datetime — true only for a real date, NULL and 0
    both fail it — optionally qualified with a table alias (``has_date_sql("ph")``).
    Don't wrap it in NOT: NOT NULL is still NULL; use undated_sql()."""
    col = f"{alias}.photo_datetime" if alias else "photo_datetime"
    return f"({col} != 0)"


def undated_sql(alias: str = "") -> str:
    """Exact negation of has_date_sql (NULL-safe: NOT of a NULL comparison would
    be NULL, so this is spelled out rather than wrapped in NOT)."""
    col = f"{alias}.photo_datetime" if alias else "photo_datetime"
    return f"({col} IS NULL OR {col} = 0)"


HAS_DATE_SQL = has_date_sql()
UNDATED_SQL = undated_sql()

# Bumped on every change to face/person data that affects recognition. faces.py
# caches decoded embedding matrices keyed on this, rebuilding only when it moves.
_faces_generation = 0


def faces_generation() -> int:
    """Current face-data generation (see _faces_generation)."""
    return _faces_generation


def bump_faces_generation():
    """Invalidate cached recognition data after a face/person mutation."""
    global _faces_generation
    _faces_generation += 1


# Bumped whenever any photo's coordinates change (a tag added, moved or removed),
# and when the DB itself is swapped. Caches derived from the set of geotagged
# points (services/hotspots_service.py) key on this instead of a COUNT(*): a
# count can't see a moved tag, or one removed + one added, and costs a table
# scan per check. In-memory only — a restart starts with cold caches anyway.
_geotag_generation = 0


def geotag_generation() -> int:
    """Current geotag-data generation (see _geotag_generation)."""
    return _geotag_generation


def bump_geotag_generation():
    """Invalidate caches derived from photo coordinates after a lat/lng change."""
    global _geotag_generation
    _geotag_generation += 1


# ── Transactions ──
# The connection is ONE handle shared by the event loop, the executor threads and
# the scan workers, and SQLite transactions are per connection, not per thread.
# Unserialized, thread B's commit would persist thread A's half-finished
# multi-statement write, and a write that raised midway would leave its
# statements pending for the next unrelated commit to persist. So every write
# goes through transaction(): one re-entrant lock makes write units mutually
# exclusive, and each unit ends in exactly one COMMIT or ROLLBACK.
_tx_lock = threading.RLock()
# Nesting depth of transaction() on the thread holding _tx_lock (only ever
# touched under the lock). 0 = no unit open.
_tx_depth = 0


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """The one way to write: ``with index.transaction() as db: ...``.

    Holds the write lock for the block, commits on a clean exit and rolls back
    if the block raises — so the unit is all-or-nothing and no other thread's
    write (or commit) can land inside it. Reads the unit depends on belong
    inside the block too (read-then-write is then atomic, and ``lastrowid`` is
    this thread's own).

    Re-entrant: a write helper may call another, and a caller may wrap several
    index.* writes to make them one unit. Only the outermost block commits; an
    inner block is a SAVEPOINT, so an inner failure the caller chooses to catch
    undoes just the inner block's statements.

    Keep the block to DB work. The lock is global: ExifTool, hashing, face
    detection or any other slow call inside it stalls every other writer.

    Reads outside a block are not serialized against writers — same connection,
    so they can observe a unit's uncommitted statements. That state is never
    persisted unless the unit commits; a read that must not see it takes the
    block too.
    """
    global _tx_depth
    with _tx_lock:
        db = get_db()
        depth = _tx_depth
        outermost = depth == 0
        savepoint = f"tx{depth}"
        if not outermost:
            db.execute(f"SAVEPOINT {savepoint}")
        elif not db.in_transaction:
            # Explicit, not sqlite3's implicit BEGIN-before-DML: a nested
            # SAVEPOINT opened before the first DML would otherwise *be* the
            # transaction, and releasing it would commit mid-unit. IMMEDIATE
            # takes the write lock up front, so a unit that reads then writes
            # can't hit SQLITE_BUSY on the upgrade when a script in another
            # process has written in between.
            db.execute("BEGIN IMMEDIATE")
        # else: statements are already pending from code that wrote through
        # get_db() without committing (scripts, tests). Join them — they
        # commit or roll back with this unit, as they did with the next commit.
        _tx_depth = depth + 1
        try:
            yield db
            if outermost:
                db.commit()
            else:
                db.execute(f"RELEASE {savepoint}")
        except BaseException:
            # Also reached when the COMMIT itself fails (disk full, busy):
            # without the rollback the unit would stay open and ride the next
            # commit.
            try:
                if outermost:
                    db.rollback()
                else:
                    db.execute(f"ROLLBACK TO {savepoint}")
                    db.execute(f"RELEASE {savepoint}")
            except sqlite3.Error:
                pass  # e.g. connection closed under us — surface the original error
            # Helpers inside the unit may already have bumped a generation and
            # let a cache rebuild from rows that no longer exist.
            bump_faces_generation()
            bump_geotag_generation()
            raise
        finally:
            _tx_depth = depth


# Every photos column derived from a photo's coordinates (reverse geocoding plus the
# geocoded_at marker). Whenever lat/lng change or are removed these must be cleared
# together, or a photo keeps showing and searching under the old place. Add a new
# derived column here AND to the SETs that write it (update_geotag, _LOCATION_SQL).
# Writers that clear the set build their SET fragment from DERIVED_LOCATION_CLEAR_SQL
# so they cannot drift; test_index.py asserts _LOCATION_SQL writes the same set.
# loc_landmark / loc_landmark_type are deliberately absent: they are only in the
# migration-rebuild CREATE TABLE, nothing writes or reads them, and fresh databases
# don't have them, so naming them here would break fresh installs.
DERIVED_LOCATION_COLUMNS = (
    "loc_city", "loc_state", "loc_county", "loc_country", "loc_country_code",
    "loc_sublocation", "loc_postal_code", "geocoded_at",
)
DERIVED_LOCATION_CLEAR_SQL = ", ".join(f"{c}=NULL" for c in DERIVED_LOCATION_COLUMNS)


def init_db(root: Path | None = None) -> sqlite3.Connection:
    """Initialize the database. If CACHE_DIR is set, use that; otherwise use root / CACHE_DIR_NAME."""
    # Under the write lock so a (re)open can't swap the connection out from
    # under another thread's open unit. The schema/migration body itself runs
    # in SQLite's autocommit mode with one commit at the end, not transaction():
    # PRAGMA journal_mode can't run inside a transaction.
    with _tx_lock:
        try:
            return _init_db_locked(root)
        except BaseException:
            # Don't leave a failed migration's DML pending for the first
            # unrelated write to commit.
            if _db is not None and _db.in_transaction:
                _db.rollback()
            raise


def _init_db_locked(root: Path | None) -> sqlite3.Connection:
    global _db, _db_path
    # A different DB is a different set of geotags, whatever the old one held.
    bump_geotag_generation()

    cache_dir_from_env = get_cache_dir()
    if cache_dir_from_env:
        cache_dir = cache_dir_from_env
    elif root:
        cache_dir = root / CACHE_DIR_NAME
    else:
        raise RuntimeError("Must specify root directory or set GEOTAGGER_CACHE_DIR")

    cache_dir.mkdir(parents=True, exist_ok=True)
    _db_path = cache_dir / "index.db"
    # cached_statements=0: the sqlite3 module caches prepared statements per
    # connection keyed on SQL text, so two threads running the same query at
    # once share ONE statement — the second execute resets and rebinds it under
    # the first thread's cursor, which then returns the other thread's rows or
    # raises "bad parameter or other API misuse" (measured: a few wrong results
    # per 20K point SELECTs across 6 threads, 0 with the cache off). Reads are
    # not serialized by transaction(), so each cursor must own its statement.
    # Costs a re-prepare per query, ~2 µs on a point SELECT.
    _db = sqlite3.connect(str(_db_path), check_same_thread=False, factory=TimedConnection,
                          cached_statements=0)
    _db.row_factory = sqlite3.Row
    # Registered once per connection, here and nowhere else. The connection is
    # shared across threads, and SQLite refuses to redefine a user function while
    # any statement on it is still active, so registering per query raised
    # "Error creating function" whenever another cursor was mid-iteration.
    from geotagger.search_locations import place_distance
    _db.create_function("search_place_distance", 4, place_distance, deterministic=True)
    _db.execute("PRAGMA journal_mode=WAL")
    # NORMAL, not the default FULL: in WAL mode FULL fsyncs the WAL on every
    # commit, NORMAL only at checkpoints. WAL + NORMAL can't corrupt the DB; a
    # power cut (not an app crash) may lose the last few commits, which a scan
    # simply redoes and a UI edit's sidecar (the durable copy of a geotag)
    # already holds. Per-connection, so it never needs re-applying after the
    # journal_mode switches in vacuum_if_needed (which raises it to FULL for the
    # rollback-journal rebuild, where NORMAL is not corruption-safe).
    _db.execute("PRAGMA synchronous=NORMAL")
    # 64 MB page cache — default 2 MB is far too small for 93K embedding blobs.
    # Negative value = kibibytes; positive = pages (4 KB each).
    _db.execute("PRAGMA cache_size = -65536")
    _db.execute("""
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY,
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
            UNIQUE(dir, filename)
        )
    """)
    # Migrate existing DBs that predate added columns
    cols = {r[1] for r in _db.execute("PRAGMA table_info(photos)").fetchall()}
    if "camera" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN camera TEXT")
    if "photo_datetime" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN photo_datetime INTEGER")
    if "gps_accuracy" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN gps_accuracy REAL")
    # EXIF orientation 1..8 for display rotation (NULL = not yet read)
    if "orientation" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN orientation INTEGER")
    # SHA-256 hex of the file's bytes (NULL = not yet hashed). Populated for
    # new/changed files during a scan; existing rows are filled in by the
    # one-time scripts/backfill_checksums.py. Deliberately NOT part of is_fresh
    # so a routine rescan never re-hashes the whole library.
    if "checksum" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN checksum TEXT")
    # Timestamp of last face-detection pass for this photo (NULL = never scanned)
    if "faces_scanned_at" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN faces_scanned_at REAL")
    # Long edge (px) of the image the last face-detection pass ran on, when that was
    # a full/real decode (a full RAW LibRaw decode, or a normal image). NULL means
    # detection ran on the low-quality embedded preview (or predates this column) —
    # the set to target for a higher-resolution progressive re-scan of RAWs.
    if "faces_det_dimension" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN faces_det_dimension INTEGER")
    # Reverse-geocoded place names (from coordinates). geocoded_at NULL = not yet
    # looked up; a non-NULL geocoded_at with NULL names means "looked up, no match".
    if "loc_city" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN loc_city TEXT")
    if "loc_state" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN loc_state TEXT")
    if "loc_county" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN loc_county TEXT")
    if "loc_country" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN loc_country TEXT")
    if "loc_country_code" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN loc_country_code TEXT")
    # Smallest containing OSM named feature (park/stadium/campus/neighborhood/
    # building) from polygon reverse geocoding — a sub-location under loc_city.
    if "loc_sublocation" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN loc_sublocation TEXT")
    # ZIP code from the Census ZCTA layer (US only; NULL everywhere else, and on
    # photos geocoded before that layer was installed).
    if "loc_postal_code" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN loc_postal_code TEXT")
    if "geocoded_at" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN geocoded_at REAL")
    # Files that don't matter for geocoding (e.g. screenshots). They still show
    # in the grid, but the Show filter and geotagged/not-geotagged counts treat
    # them as if they were already geotagged.
    if "geocode_ignored" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN geocode_ignored INTEGER NOT NULL DEFAULT 0")
    # NULL = exact date (from EXIF/XMP or an exact sidecar correction). 'year'/'month'
    # = manually assigned via Assign approximate date (photos_service.assign_approximate_dates),
    # with photo_datetime holding the first instant of that year/month. Consumers that
    # display or reason about the date (detail pane, age-aware face matching) should
    # treat a non-NULL value as "approximate, don't trust the day/month".
    if "date_precision" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN date_precision TEXT")

    # One-time cleanup: sidecar_path used to store the sidecar's full path;
    # it's now just the filename (the sidecar always sits next to the image,
    # in `dir`, per sidecar.sidecar_path()). Only rows still holding a
    # separator get rewritten, so this is a no-op after the first run.
    stale_sidecars = _db.execute(
        "SELECT id, sidecar_path FROM photos WHERE sidecar_path LIKE '%/%' OR sidecar_path LIKE '%\\%'"
    ).fetchall()
    if stale_sidecars:
        import ntpath
        _db.executemany(
            "UPDATE photos SET sidecar_path=? WHERE id=?",
            [(ntpath.basename(r["sidecar_path"]), r["id"]) for r in stale_sidecars],
        )

    # Dropped: the full ExifTool JSON snapshot (photo_exif table, and before that
    # an inline exif_json column) — never queried by anything, and was the single
    # largest contributor to DB file size. One-time cleanup for DBs that still
    # have it; a no-op after the first run.
    _db.execute("DROP TABLE IF EXISTS photo_exif")
    if "exif_json" in cols:
        _db.execute("ALTER TABLE photos DROP COLUMN exif_json")

    # One-time migration off `path`, which just duplicated `dir` + filename on
    # every row (and every write). SQLite's ALTER TABLE DROP COLUMN refuses a
    # UNIQUE column, so the table is rebuilt instead. Recomputed fresh here (not
    # the `cols` above, which predates the ADD COLUMN guards and the exif_json
    # drop) so the copy carries exactly the columns now on the table. Renaming
    # photos also silently drops the indexes/triggers bound to it (verified:
    # SQLite moves them to the new name, then discards them with the DROP TABLE
    # below) — harmless, since every one of them is recreated with IF NOT EXISTS
    # further down this function.
    photos_cols = [r[1] for r in _db.execute("PRAGMA table_info(photos)").fetchall()]
    if "path" in photos_cols:
        keep_cols = [c for c in photos_cols if c != "path"]
        col_list = ", ".join(keep_cols)
        _db.execute("ALTER TABLE photos RENAME TO photos_old")
        _db.execute("""
            CREATE TABLE photos (
                id INTEGER PRIMARY KEY,
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
                gps_accuracy REAL,
                orientation INTEGER,
                checksum TEXT,
                face_count INTEGER,
                faces_scanned_at REAL,
                faces_processed_at REAL,
                faces_det_dimension INTEGER,
                loc_city TEXT,
                loc_state TEXT,
                loc_county TEXT,
                loc_country TEXT,
                loc_country_code TEXT,
                loc_sublocation TEXT,
                loc_postal_code TEXT,
                loc_landmark TEXT,
                loc_landmark_type TEXT,
                geocoded_at REAL,
                geocode_ignored INTEGER NOT NULL DEFAULT 0,
                date_precision TEXT,
                UNIQUE(dir, filename)
            )
        """)
        _db.execute(f"INSERT INTO photos ({col_list}) SELECT {col_list} FROM photos_old")
        _db.execute("DROP TABLE photos_old")

    _db.execute("""
        CREATE TABLE IF NOT EXISTS places (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            bounds TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)
    # Optional "representative" photo for a named place — a logical FK to
    # photos.id (nullable; not a hard constraint, so a pruned photo just leaves a
    # dangling id that resolves to nothing). Set via the geo page's right-click
    # menu. Additive migration for pre-existing DBs.
    _place_cols = {r[1] for r in _db.execute("PRAGMA table_info(places)").fetchall()}
    if "representative_photo_id" not in _place_cols:
        _db.execute("ALTER TABLE places ADD COLUMN representative_photo_id INTEGER")

    # Runtime-tunable settings (see config.SETTINGS_SPEC) that override the
    # env-var default without a restart. Values are stored as text and coerced
    # back to their real type by config.apply_setting_override.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at REAL NOT NULL
        )
    """)

    # Reverse-geocode cache keyed on integer-quantized coordinates (see
    # config.GEOCODE_PRECISION). qlat/qlng are round(coord * 10**precision), so
    # nearby photos collapse to one row and share a single lookup result.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS geocode_cache (
            qlat INTEGER NOT NULL,
            qlng INTEGER NOT NULL,
            city TEXT,
            state TEXT,
            county TEXT,
            country TEXT,
            country_code TEXT,
            source TEXT NOT NULL DEFAULT 'local',
            created_at REAL NOT NULL,
            PRIMARY KEY (qlat, qlng)
        )
    """)
    # OSM sub-location cached alongside the GeoNames names (additive migration).
    cache_cols = {r[1] for r in _db.execute("PRAGMA table_info(geocode_cache)").fetchall()}
    if "sublocation" not in cache_cols:
        _db.execute("ALTER TABLE geocode_cache ADD COLUMN sublocation TEXT")
    # ZIP code from the Census ZCTA layer, same deal. Rows cached before it existed
    # simply have NULL here — a stale-but-valid result, refreshed by scripts/regeocode.py.
    if "postal_code" not in cache_cols:
        _db.execute("ALTER TABLE geocode_cache ADD COLUMN postal_code TEXT")

    # Life Contexts (time+place polygons) were removed. Migrations are otherwise
    # additive, but leaving these tables behind would keep every existing DB
    # carrying a feature that no longer has code to read it — so drop them once,
    # on the next open. Nothing else references them; the plan doc
    # (docs/LIFE_CONTEXTS_PLAN.md) is kept if the feature ever comes back.
    _db.execute("DROP TABLE IF EXISTS context_persons")
    _db.execute("DROP TABLE IF EXISTS contexts")

    # Named family groups — a person can belong to one family.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS families (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            created_at REAL NOT NULL
        )
    """)

    # People the user has named. Faces get linked to a person once confirmed.
    # birth_date (ISO YYYY-MM-DD, optional) powers age-aware suggestions.
    # not_before/not_after (ISO YYYY-MM-DD, optional) further bound the window a
    # person can appear in — e.g. a person known to only show up in photos from
    # 2010 onward, or who stopped appearing after a given date — independent of
    # (and in addition to) the birth-date exclusion.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS persons (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            birth_date TEXT,
            created_at REAL NOT NULL
        )
    """)
    _person_cols = {r[1] for r in _db.execute("PRAGMA table_info(persons)").fetchall()}
    if "birth_date" not in _person_cols:
        _db.execute("ALTER TABLE persons ADD COLUMN birth_date TEXT")
    if "family_id" not in _person_cols:
        _db.execute("ALTER TABLE persons ADD COLUMN family_id INTEGER REFERENCES families(id) ON DELETE SET NULL")
    if "not_before" not in _person_cols:
        _db.execute("ALTER TABLE persons ADD COLUMN not_before TEXT")
    if "not_after" not in _person_cols:
        _db.execute("ALTER TABLE persons ADD COLUMN not_after TEXT")

    # One row per detected face. bbox is normalized (0..1) to the detection
    # image so it maps onto any rendition. embedding is a raw float32 vector.
    # A face is in exactly one state: labeled (person_id set), ignored
    # (ignored=1, e.g. background strangers or false detections), come-back
    # (come_back=1 — someone we recognize or suspect but aren't ready to
    # commit an assignment for yet; see [[come-back-queue]]), or unlabeled
    # (person_id NULL, ignored=0, come_back=0 — the work queue).
    _db.execute("""
        CREATE TABLE IF NOT EXISTS faces (
            id INTEGER PRIMARY KEY,
            photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
            bbox TEXT NOT NULL,
            det_score REAL NOT NULL,
            source TEXT NOT NULL DEFAULT 'detected',
            ignored INTEGER NOT NULL DEFAULT 0,
            come_back INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            assigned_at REAL
        )
    """)
    # Migrate faces tables that predate later columns.
    face_cols = {r[1] for r in _db.execute("PRAGMA table_info(faces)").fetchall()}
    if "ignored" not in face_cols:
        _db.execute("ALTER TABLE faces ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0")
    # When a face was tagged to a person (NULL = unlabeled). Distinct from
    # created_at (when the face was detected); powers tag-order views and undo.
    if "assigned_at" not in face_cols:
        _db.execute("ALTER TABLE faces ADD COLUMN assigned_at REAL")
    if "ignored_at" not in face_cols:
        _db.execute("ALTER TABLE faces ADD COLUMN ignored_at REAL")
    if "come_back" not in face_cols:
        _db.execute("ALTER TABLE faces ADD COLUMN come_back INTEGER NOT NULL DEFAULT 0")
    if "come_back_at" not in face_cols:
        _db.execute("ALTER TABLE faces ADD COLUMN come_back_at REAL")
    # Marks a labeled face as a kept "representative" example for its person —
    # one medoid per look-alike cluster, picked by faces.compute_representatives_for_person.
    # Storage reclamation (emptying non-representative embeddings) is a later step;
    # for now this only flags which examples would be kept, and get_labeled_faces
    # still returns every labeled face regardless of this flag.
    if "representative" not in face_cols:
        _db.execute("ALTER TABLE faces ADD COLUMN representative INTEGER NOT NULL DEFAULT 0")

    # Embeddings live in their own table, keyed 1:1 on face_id (which doubles as
    # its rowid, so a face->embedding lookup is a single B-tree point read) —
    # same locality rationale as the old photo_exif split: faces is queried far
    # more often (state/flags, queue scans) than the embedding blob itself is
    # needed, so keeping it out of faces keeps those scans off the blob pages.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS face_embeddings (
            face_id INTEGER PRIMARY KEY REFERENCES faces(id) ON DELETE CASCADE,
            embedding BLOB NOT NULL
        )
    """)
    # One-time migration for DBs that predate the split: copy each face's
    # embedding out, then drop the column. No-op after the first run.
    if "embedding" in face_cols:
        _db.execute(
            "INSERT INTO face_embeddings (face_id, embedding) SELECT id, embedding FROM faces"
        )
        _db.execute("ALTER TABLE faces DROP COLUMN embedding")

    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id)")
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id)")
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_ignored ON faces(ignored)")
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_come_back ON faces(come_back)")
    # Serves the people-UI queue queries: filter (ignored, come_back, person_id)
    # then return rows already ordered by det_score, so SQLite skips the
    # temp-b-tree sort and only touches the LIMIT rows instead of reading every
    # unlabeled embedding.
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_queue ON faces(ignored, come_back, person_id, det_score)")
    # Serves the People page's time/spatial Focus on the unlabeled queue: leads
    # with photo_id so a small pre-resolved photo_id set (see
    # index._photo_ids_in_window / list_faces) drives the scan instead of
    # idx_faces_queue's free det_score ordering — the latter otherwise forces a
    # full read of every unlabeled face's row (embedding blob included, just to
    # get its photo_id) until LIMIT is satisfied, which a narrow/sparse window
    # may never do. Measured ~500ms -> <1ms on a 78K-unlabeled-face library for
    # a window with zero matches.
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_photo_queue ON faces(photo_id, ignored, come_back, person_id, det_score)")
    # Serves tag-order / "recently tagged" / undo queries (ORDER BY assigned_at DESC).
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_assigned_at ON faces(assigned_at)")
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_ignored_at ON faces(ignored_at)")
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_come_back_at ON faces(come_back_at)")
    _db.execute("CREATE INDEX IF NOT EXISTS idx_faces_person_representative ON faces(person_id, representative)")
    # Partial index for count_faces("recent")'s COUNT(*) WHERE assigned_at IS NOT
    # NULL AND person_id IS NOT NULL — index-only scan instead of a full table scan.
    _db.execute(
        "CREATE INDEX IF NOT EXISTS idx_faces_assigned_count ON faces(assigned_at) "
        "WHERE assigned_at IS NOT NULL AND person_id IS NOT NULL"
    )

    # Negative labels: "face F is definitely NOT person P". Orthogonal to the
    # labeled/ignored/unlabeled state — the face stays in the queue and can still
    # match every OTHER person; P is just removed from F's candidate ranking.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS face_negatives (
            face_id    INTEGER NOT NULL REFERENCES faces(id)   ON DELETE CASCADE,
            person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
            created_at REAL NOT NULL,
            PRIMARY KEY (face_id, person_id)
        )
    """)
    _db.execute("CREATE INDEX IF NOT EXISTS idx_face_negatives_person ON face_negatives(person_id)")

    # One-shot repair (idempotent, index-driven, no-op on a clean DB): FKs are
    # never enforced here, and delete_person/delete_family used to remove only
    # the parent row. That left faces pointing at a dead person — invisible in
    # every queue, and silently inherited by the next person to reuse the id —
    # and persons pointing at a dead family. Put those faces back in the
    # unlabeled queue and detach those persons.
    _db.execute(
        "UPDATE faces SET person_id=NULL, assigned_at=NULL, representative=0 "
        "WHERE person_id IS NOT NULL AND person_id NOT IN (SELECT id FROM persons)")
    _db.execute("DELETE FROM face_negatives WHERE person_id NOT IN (SELECT id FROM persons)")
    _db.execute(
        "UPDATE persons SET family_id=NULL "
        "WHERE family_id IS NOT NULL AND family_id NOT IN (SELECT id FROM families)")

    # Create R*Tree spatial index for photo locations
    # R*Tree uses min/max bounds, so for a point we use same value for min and max
    _db.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS photos_spatial USING rtree(
            id,              -- references photos.id
            min_lat, max_lat,
            min_lng, max_lng
        )
    """)

    # Create triggers to keep the spatial index in sync
    # Insert trigger
    _db.execute("""
        CREATE TRIGGER IF NOT EXISTS photos_spatial_insert AFTER INSERT ON photos
        WHEN NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL
        BEGIN
            INSERT INTO photos_spatial (id, min_lat, max_lat, min_lng, max_lng)
            VALUES (NEW.id, NEW.lat, NEW.lat, NEW.lng, NEW.lng);
        END
    """)

    # Update trigger. Scoped to lat/lng, the only photos columns the R*Tree holds
    # (the body reads just NEW.id/NEW.lat/NEW.lng and OLD.id; id is never
    # updated). Unscoped, it delete+inserted an rtree row on every UPDATE of
    # photos: face scans, checksums, date writes.
    # IF NOT EXISTS won't replace the broad trigger an earlier install created,
    # so drop that form first. Idempotent: once the SQL says UPDATE OF it's a
    # no-op. This runs after the repair UPDATE above, which has already opened
    # the pending transaction, so a failure rolls back with init_db.
    _old_update_trigger = _db.execute(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='photos_spatial_update'"
    ).fetchone()
    if _old_update_trigger is not None and "UPDATE OF" not in _old_update_trigger["sql"].upper():
        _db.execute("DROP TRIGGER photos_spatial_update")
    _db.execute("""
        CREATE TRIGGER IF NOT EXISTS photos_spatial_update AFTER UPDATE OF lat, lng ON photos
        BEGIN
            DELETE FROM photos_spatial WHERE id = OLD.id;
            INSERT INTO photos_spatial (id, min_lat, max_lat, min_lng, max_lng)
            SELECT NEW.id, NEW.lat, NEW.lat, NEW.lng, NEW.lng
            WHERE NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL;
        END
    """)

    # Delete trigger
    _db.execute("""
        CREATE TRIGGER IF NOT EXISTS photos_spatial_delete AFTER DELETE ON photos
        BEGIN
            DELETE FROM photos_spatial WHERE id = OLD.id;
        END
    """)

    # Semantic-search vectors (geotagger.semantic): one SigLIP embedding per photo,
    # fp16 bytes. A separate table rather than a photos column keeps hot photos rows
    # small, and `model` lets a model swap coexist with old vectors until re-indexed.
    # vec NULL = embedding was attempted and failed (unreadable file) — recorded so
    # the batch loop doesn't retry it forever, same idea as faces_scanned_at.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS photo_embeddings (
            photo_id   INTEGER PRIMARY KEY,
            model      TEXT NOT NULL,
            vec        BLOB,
            created_at REAL NOT NULL
        )
    """)
    # FKs aren't enforced in this DB, so clean up via trigger like photos_spatial.
    _db.execute("""
        CREATE TRIGGER IF NOT EXISTS photo_embeddings_delete AFTER DELETE ON photos
        BEGIN
            DELETE FROM photo_embeddings WHERE photo_id = OLD.id;
        END
    """)

    # Dropped along with the photo_exif table above — a leftover trigger
    # referencing it would error on the next photo delete.
    _db.execute("DROP TRIGGER IF EXISTS photo_exif_delete")

    # Populate spatial index for existing photos (migration)
    _db.execute("""
        INSERT OR IGNORE INTO photos_spatial (id, min_lat, max_lat, min_lng, max_lng)
        SELECT id, lat, lat, lng, lng FROM photos WHERE lat IS NOT NULL AND lng IS NOT NULL
    """)

    # Create index on photo_datetime for fast time-based queries
    _db.execute("CREATE INDEX IF NOT EXISTS idx_photos_datetime ON photos(photo_datetime)")
    # Serves get_face_coverage / get_crowd_photos / faces-months, all filtering
    # WHERE media_type='image' AND faces_scanned_at IS NOT NULL before joining
    # faces — lets that filter use an index seek instead of a full photos scan.
    _db.execute("CREATE INDEX IF NOT EXISTS idx_photos_facescan ON photos(media_type, faces_scanned_at)")
    # Partial index over exactly the rows the work queue scans (untagged, not
    # ignored), in the (camera, time) order it groups sessions by — so building
    # the queue is an index scan of ~30K rows instead of a full-table sweep.
    _db.execute(
        "CREATE INDEX IF NOT EXISTS idx_photos_untagged ON photos(camera, photo_datetime) "
        "WHERE lat IS NULL AND geocode_ignored = 0"
    )

    # History of offline reference-dataset downloads (GeoNames files, GeoFabrik
    # OSM extracts, the InsightFace model pack) triggered from the Data
    # Management page — lets a future "check for updates" feature compare
    # downloaded_at/size against the source without re-downloading blind.
    _db.execute("""
        CREATE TABLE IF NOT EXISTS dataset_downloads (
            id INTEGER PRIMARY KEY,
            dataset TEXT NOT NULL,         -- 'geonames' | 'osm' | 'face_model'
            region TEXT,                   -- e.g. 'texas', 'germany'; NULL for geonames/face_model
            url TEXT,
            downloaded_at REAL NOT NULL,
            size_bytes INTEGER,
            records_loaded INTEGER
        )
    """)

    _db.commit()
    return _db


def get_db() -> sqlite3.Connection:
    if _db is None:
        raise RuntimeError("Database not initialized — call init_db first")
    return _db


def close_db() -> None:
    """Close the shared connection at shutdown (see lifespan.py); get_db() raises
    afterwards until init_db is called again. No-op if nothing is open.

    The caller must have stopped everything that uses the DB first — the
    connection is shared across threads, and a query on a closed connection
    raises ProgrammingError."""
    global _db, _db_path
    # Under the write lock: waits out a unit another thread still has open
    # rather than closing the connection in the middle of it.
    with _tx_lock:
        db = _db
        # Drop the handle first so a late get_db() fails with the clear
        # "not initialized" error rather than handing out a closed connection.
        _db = None
        _db_path = None
        if db is None:
            return
        try:
            # Fold the WAL back into the main file so a clean exit leaves a single
            # self-contained index.db. Best-effort: SQLite checkpoints on the last
            # close anyway, and a busy checkpoint must not stop the close.
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass
        db.close()
    bump_geotag_generation()  # nothing cached from this DB is valid for the next


def vacuum_if_needed(min_free_ratio: float = 0.1, target_page_size: int = 0) -> dict:
    """Reclaim free-list space (pages left behind by deletes/updates) via VACUUM,
    called once at app startup (see lifespan.py). Also applies ``target_page_size``
    (0 = leave as-is) if the DB isn't already on it — VACUUM is the only way
    SQLite ever changes page size, so this rides the same rebuild.

    VACUUM rewrites the entire file, so it's gated on the free-page ratio
    (PRAGMA freelist_count / page_count) rather than running unconditionally —
    a mostly-compact DB shouldn't pay a full rewrite on every launch. Needs
    roughly one DB's worth of free disk space alongside it for the rewrite.
    Must run before any other connection/transaction touches the DB.
    """
    # Holds the write lock but deliberately not transaction(): VACUUM (and
    # PRAGMA journal_mode) refuse to run inside a transaction. The lock keeps
    # any writer from opening one on the shared connection meanwhile.
    with _tx_lock:
        return _vacuum_if_needed_locked(min_free_ratio, target_page_size)


def _vacuum_if_needed_locked(min_free_ratio: float, target_page_size: int) -> dict:
    db = get_db()
    page_count = db.execute("PRAGMA page_count").fetchone()[0]
    freelist_count = db.execute("PRAGMA freelist_count").fetchone()[0]
    free_ratio = (freelist_count / page_count) if page_count else 0.0
    current_page_size = db.execute("PRAGMA page_size").fetchone()[0]
    resize = bool(target_page_size) and target_page_size != current_page_size
    if free_ratio < min_free_ratio and not resize:
        return {"vacuumed": False, "free_ratio": free_ratio, "page_count": page_count,
                "freelist_count": freelist_count, "page_size": current_page_size}
    t0 = time.time()
    if resize:
        # PRAGMA page_size only takes effect via the following VACUUM, and
        # SQLite silently ignores it while journal_mode=WAL — drop to the
        # rollback journal for the rebuild, then restore WAL below.
        # synchronous=NORMAL (set in init_db) is only corruption-safe under
        # WAL; with the rollback journal a power cut mid-rebuild could corrupt
        # the file, so use FULL for the duration.
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute(f"PRAGMA page_size={int(target_page_size)}")
    try:
        db.execute("VACUUM")
    finally:
        # Also on failure (e.g. disk full): the caller treats a failed VACUUM as
        # non-fatal and carries on, and without this the whole session would
        # silently run on the rollback journal — readers blocking writers.
        if resize:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
    # VACUUM's rewrite is one big WAL transaction; left alone, the -wal file sits
    # at roughly the DB's own size until some later write happens to trigger
    # SQLite's normal auto-checkpoint. TRUNCATE folds it back into the main file
    # and shrinks -wal to ~0 immediately instead of leaving that on disk.
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return {"vacuumed": True, "free_ratio": free_ratio, "page_count": page_count,
            "freelist_count": freelist_count, "resized": resize,
            "page_size": target_page_size if resize else current_page_size,
            "seconds": time.time() - t0}


def photo_path(row) -> str:
    """Reconstruct a photo's on-disk path from its dir + filename (derived on
    read, not stored — see upsert_photo)."""
    return str(Path(row["dir"]) / row["filename"])


def upsert_photo(
    filename: str, dir_: str, ext: str, media_type: str,
    mtime: float, size: int, lat, lng, geotag_source: str,
    sidecar_path: str | None, sidecar_mtime: float | None,
    camera: str | None = None, photo_datetime: int | None = None,
    gps_accuracy: float | None = None, orientation: int | None = None,
    checksum: str | None = None,
):
    with transaction() as db:
        # A hand-placed geotag with WRITE_XMP_ON_GEOTAG off exists only in this row
        # (geotag_source='database'), so a rescan must not replace it with what the
        # file says — the file has no GPS, or the embedded GPS the user overrode.
        # Only a sidecar wins: that is the durable form of a geotag (sidecar export,
        # or another tool). SET expressions all see the pre-update row, so the
        # `photos.geotag_source` test is consistent across the four columns.
        # gps_accuracy falls back to the file's value because update_geotag leaves
        # it NULL when none was given, and is_fresh reads NULL as "never read".
        keep = "photos.geotag_source = 'database' AND excluded.geotag_source <> 'sidecar'"
        # Coordinates before/after, to bump the geotag generation only when they
        # really move: a rescan of touched-but-otherwise-unchanged files (or new
        # photos without GPS) must not throw away the hotspot clustering per file.
        # The lookup rides the UNIQUE(dir, filename) index the upsert needs anyway.
        old = db.execute("SELECT lat, lng FROM photos WHERE dir=? AND filename=?",
                         (dir_, filename)).fetchone()
        new = db.execute(f"""
            INSERT INTO photos
                (filename, dir, ext, media_type, mtime, size, lat, lng,
                 geotag_source, sidecar_path, sidecar_mtime, camera, photo_datetime,
                 gps_accuracy, orientation, checksum, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dir, filename) DO UPDATE SET
                ext=excluded.ext,
                media_type=excluded.media_type, mtime=excluded.mtime, size=excluded.size,
                lat=CASE WHEN {keep} THEN photos.lat ELSE excluded.lat END,
                lng=CASE WHEN {keep} THEN photos.lng ELSE excluded.lng END,
                geotag_source=CASE WHEN {keep} THEN photos.geotag_source
                                   ELSE excluded.geotag_source END,
                gps_accuracy=CASE WHEN {keep}
                                  THEN COALESCE(photos.gps_accuracy, excluded.gps_accuracy)
                                  ELSE excluded.gps_accuracy END,
                sidecar_path=excluded.sidecar_path, sidecar_mtime=excluded.sidecar_mtime,
                camera=excluded.camera, photo_datetime=excluded.photo_datetime,
                orientation=excluded.orientation,
                checksum=excluded.checksum,
                scanned_at=excluded.scanned_at
            RETURNING lat, lng
        """, (filename, dir_, ext, media_type, mtime, size, lat, lng,
              geotag_source, sidecar_path, sidecar_mtime, camera, photo_datetime,
              gps_accuracy, orientation, checksum, time.time())).fetchone()
    # RETURNING reports what was actually stored, i.e. after the `keep` rule.
    if (new["lat"], new["lng"]) != ((old["lat"], old["lng"]) if old else (None, None)):
        bump_geotag_generation()


def update_geotag(photo_id: int, lat: float | None, lng: float | None,
                  geotag_source: str, sidecar_path: str, sidecar_mtime: float | None,
                  gps_accuracy: float | None = None):
    with transaction() as db:
        # Coordinates changed, so any previously-derived location names are stale.
        # Clear them all and reset geocoded_at so the point is re-geocoded; the caller
        # repopulates them (geotag_service.write_geotag does this immediately after).
        db.execute(f"""
            UPDATE photos SET lat=?, lng=?, gps_accuracy=?, geotag_source=?, sidecar_path=?, sidecar_mtime=?,
                {DERIVED_LOCATION_CLEAR_SQL}
            WHERE id=?
        """, (lat, lng, gps_accuracy, geotag_source, sidecar_path, sidecar_mtime, photo_id))
    bump_geotag_generation()


def set_geocode_ignored(photo_ids: list[int], ignored: bool):
    """Mark (or unmark) photos as not needing geocoding, e.g. screenshots.
    Ignored photos keep showing in the grid but count as geotagged for the
    Show filter and geotagged/not-geotagged stats."""
    if not photo_ids:
        return
    with transaction() as db:
        db.executemany(
            "UPDATE photos SET geocode_ignored=? WHERE id=?",
            [(1 if ignored else 0, pid) for pid in photo_ids],
        )


def assign_approximate_date(photo_id: int, photo_datetime: int | None, precision: str | None,
                            sidecar_path: str | None, sidecar_mtime: float | None):
    """Set photo_datetime + its precision flag (None=exact, 'year'/'month'=
    approximate). Used by both Assign approximate date and the filename/folder
    date-guess commit/undo. Bumping faces_generation is the caller's job (the
    services do it once for the whole batch)."""
    with transaction() as db:
        db.execute(
            "UPDATE photos SET photo_datetime=?, date_precision=?, sidecar_path=?, sidecar_mtime=? WHERE id=?",
            (photo_datetime, precision, sidecar_path, sidecar_mtime, photo_id),
        )


def _day_start_ts(day: str) -> int:
    """Unix timestamp of 00:00 UTC on a YYYY-MM-DD day. Raises ValueError if `day`
    doesn't parse — a typo'd filter must fail loudly (the API maps it to 400)
    rather than silently match the whole library.

    UTC via calendar.timegm — photo_datetime is stored as wall-clock-as-UTC and the
    timeline buckets with strftime(...'unixepoch') (UTC). Using local-time
    .timestamp() here would shift the window by the local tz offset and drop
    boundary photos the timeline still counts (and it raises OSError on Windows
    for pre-1970 dates).
    """
    import calendar
    from datetime import datetime
    try:
        return calendar.timegm(datetime.strptime(day, "%Y-%m-%d").timetuple())
    except ValueError:
        raise ValueError(f"invalid date {day!r}: expected YYYY-MM-DD") from None


def _bbox_clause(bbox: str) -> tuple[str, list[float]]:
    """SQL clause + params for a ``minLng,minLat,maxLng,maxLat`` viewport string.
    Raises ValueError on anything malformed (wrong arity, non-numeric, NaN/inf)."""
    import math
    from geotagger.geometry import normalize_lng_bbox
    try:
        parts = [float(x) for x in bbox.split(",")]
    except ValueError:
        parts = []
    if len(parts) != 4 or not all(math.isfinite(v) for v in parts):
        raise ValueError("bbox must be minLng,minLat,maxLng,maxLat")
    min_lng, min_lat, max_lng, max_lat = parts
    min_lng, max_lng = normalize_lng_bbox(min_lng, max_lng)
    return "lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?", [min_lat, max_lat, min_lng, max_lng]


def ids_json(ids) -> str:
    """JSON array of ints for ``IN (SELECT value FROM json_each(?))``. A caller-
    supplied id list expanded into ``IN (?,?,...)`` hits SQLite's 32,766-variable
    cap (OperationalError -> 500); one bound JSON parameter has no such limit,
    keeps a single indexed query, and preserves ORDER BY/LIMIT over the whole set
    (chunk-and-concatenate would not)."""
    import json as _json
    return _json.dumps([int(i) for i in ids])


# Columns the get_photos callers read (serializers.photo_to_dict / row_location,
# zip_service via photo_path). SELECT * also dragged ext, mtime, size, sidecar_*,
# scanned_at, orientation, checksum, faces_*, loc_county/postal_code/country_code
# and geocoded_at through sqlite3 -> Python for every row of an unpaged result;
# add a column here if a new caller needs it.
_PHOTO_LIST_COLS = ("id, filename, dir, media_type, lat, lng, geotag_source, camera, "
                    "photo_datetime, gps_accuracy, geocode_ignored, date_precision, "
                    "loc_city, loc_sublocation, loc_postal_code, loc_state, loc_country")


# Chronological with every undated photo first, as one block. Plain ORDER BY
# photo_datetime would put NULL-undated first but 0-undated between the 1969 and
# 1970 photos, so the grid's day grouping would show two "Undated" sections.
_CHRONO_ORDER = f"{HAS_DATE_SQL}, photo_datetime, filename"


def get_photos(geotagged: str = "all", bbox: str | None = None, date_from: str | None = None,
               date_to: str | None = None, undated: bool = False,
               dir: str | None = None, ids: list[int] | None = None) -> list[sqlite3.Row]:
    db = get_db()
    clauses = []
    params: list = []
    if ids is not None:
        # An explicit id set (e.g. handed off from Search) stands alone — every
        # other filter here narrows a scan of the library, but the caller already
        # picked exactly these photos.
        if not ids:
            return []
        return db.execute(
            f"SELECT {_PHOTO_LIST_COLS} FROM photos WHERE id IN (SELECT value FROM json_each(?)) "
            f"ORDER BY {_CHRONO_ORDER}",
            (ids_json(ids),),
        ).fetchall()
    if dir is not None:
        # Exact match, not a prefix: a folder batch is one directory, and
        # LIKE 'x%' would swallow a sibling named "x-extra".
        clauses.append("dir = ?")
        params.append(dir)
    if geotagged == "yes":
        clauses.append("(lat IS NOT NULL OR geocode_ignored = 1)")
    elif geotagged == "no":
        clauses.append("lat IS NULL AND geocode_ignored = 0")
    if undated:
        # No timestamp to filter by — date_from/date_to don't apply.
        clauses.append(UNDATED_SQL)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        return db.execute(f"SELECT {_PHOTO_LIST_COLS} FROM photos {where} ORDER BY filename", params).fetchall()
    if bbox and bbox.strip():
        # bbox=minLng,minLat,maxLng,maxLat; malformed raises ValueError
        clause, bbox_params = _bbox_clause(bbox)
        clauses.append(clause)
        params += bbox_params
    if date_from:
        clauses.append("photo_datetime >= ?")
        params.append(_day_start_ts(date_from))
    if date_to:
        # Add 24 hours to include the entire day
        clauses.append("photo_datetime < ?")
        params.append(_day_start_ts(date_to) + 86400)
    if date_from or date_to:
        clauses.append(HAS_DATE_SQL)  # undated 0 would match a range spanning 1970
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return db.execute(f"SELECT {_PHOTO_LIST_COLS} FROM photos {where} ORDER BY {_CHRONO_ORDER}",
                      params).fetchall()


def get_dir_counts(limit: int = 500) -> list[sqlite3.Row]:
    """Directories with their photo counts, most-untagged first — the folder facet
    behind /api/photos?dir=. Capped because a big library has thousands of
    directories and the picker only exists to reach the ones with work left."""
    return get_db().execute("""
        SELECT dir,
               COUNT(*) AS total,
               SUM(CASE WHEN lat IS NULL AND geocode_ignored = 0 THEN 1 ELSE 0 END) AS untagged
        FROM photos
        GROUP BY dir
        ORDER BY untagged DESC, dir
        LIMIT ?
    """, (limit,)).fetchall()


def get_photo(photo_id: int) -> sqlite3.Row | None:
    return get_db().execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()


# Undated photos sort last in both date orders — all of them: `photo_datetime IS
# NULL` alone sent NULL-undated last but left 0-undated in among the dates (first
# ascending before pre-1970 dates existed, mid-list after).
SEARCH_SORTS = {
    "date_asc": f"{UNDATED_SQL}, photo_datetime, filename",
    "date_desc": f"{UNDATED_SQL}, photo_datetime DESC, filename",
    "filename": "filename",
    # '' = read, no Make/Model (see sidecar.read_metadata); sorts last with NULL.
    "camera": "camera IS NULL OR camera = '', camera, photo_datetime",
}


def get_distinct_cameras() -> list[str]:
    """Cameras seen in the library, for the Search page's camera facet."""
    rows = get_db().execute(
        "SELECT DISTINCT camera FROM photos WHERE camera IS NOT NULL AND camera != '' "
        "ORDER BY camera"
    ).fetchall()
    return [r["camera"] for r in rows]


def search_photos(date_from: str | None = None, date_to: str | None = None,
                  undated: bool = False,
                  bbox: str | None = None, location: str | None = None,
                  person_ids: list[int] | None = None, person_mode: str = "all",
                  geotagged: str = "all", limit: int = 2000,
                  place_id: int | None = None, nearby_m: float = 0,
                  location_fields: str | None = None,
                  camera: str | None = None, dir: str | None = None,
                  has_faces: str = "all", gps_accuracy: str = "all",
                  sort: str = "date_asc", ids_only: bool = False) -> list[sqlite3.Row]:
    """Flexible multi-criteria photo search: date range, location (bbox and/or a
    free-text match against the reverse-geocoded place columns), people, camera,
    folder, GPS accuracy, and whether any face was detected.

    ``person_ids``/``person_mode`` answers "find photos with these people" —
    person_mode='all' requires every listed person to have an (assigned,
    non-ignored) face in the same photo (e.g. two people together);
    person_mode='any' matches a photo containing at least one of them.
    Every criterion is optional and they combine with AND. ``undated`` (no
    timestamp at all) is mutually exclusive with date_from/date_to, which are
    meaningless without a photo_datetime — same convention as get_photos.

    ``ids_only`` returns rows carrying just ``id`` (same filters, order and
    limit) for callers that only need the matching set — it spares SQLite and
    Python from materializing every column of up to a whole library of rows.
    """
    db = get_db()
    clauses: list[str] = []
    params: list = []

    if geotagged == "yes":
        clauses.append("(lat IS NOT NULL OR geocode_ignored = 1)")
    elif geotagged == "no":
        clauses.append("lat IS NULL AND geocode_ignored = 0")

    if undated:
        clauses.append(UNDATED_SQL)
    elif date_from:
        clauses.append("photo_datetime >= ?")
        params.append(_day_start_ts(date_from))
    if date_to and not undated:
        # Add 24 hours to include the entire day
        clauses.append("photo_datetime < ?")
        params.append(_day_start_ts(date_to) + 86400)
    if (date_from or date_to) and not undated:
        clauses.append(HAS_DATE_SQL)  # undated 0 would match a range spanning 1970

    if bbox and bbox.strip():
        # bbox=minLng,minLat,maxLng,maxLat; malformed raises ValueError
        clause, bbox_params = _bbox_clause(bbox)
        clauses.append(clause)
        params += bbox_params

    from geotagger.search_locations import parse_fields
    for field, value in parse_fields(location_fields).items():
        clauses.append(f"COALESCE({field}, '') = ? COLLATE NOCASE")
        params.append(value)
    if place_id is not None:
        clauses.append("EXISTS (SELECT 1 FROM places WHERE places.id = ? "
                       "AND search_place_distance(photos.lat, photos.lng, places.type, places.bounds) <= ?)")
        params.extend([place_id, nearby_m])

    if location and location.strip():
        like = f"%{location.strip()}%"
        clauses.append(
            "(loc_city LIKE ? OR loc_sublocation LIKE ? OR loc_state LIKE ? "
            "OR loc_county LIKE ? OR loc_country LIKE ?)"
        )
        params += [like, like, like, like, like]

    if person_ids:
        import json as _json
        ids_json = _json.dumps(person_ids)
        if person_mode == "any":
            clauses.append(
                "id IN (SELECT DISTINCT photo_id FROM faces "
                "WHERE person_id IN (SELECT value FROM json_each(?)) AND ignored = 0)"
            )
            params.append(ids_json)
        else:
            # 'all': every requested person must appear (as a distinct assigned
            # face) in the same photo — e.g. "photos with both Alice and Bob".
            clauses.append(
                "id IN (SELECT photo_id FROM faces "
                "WHERE person_id IN (SELECT value FROM json_each(?)) AND ignored = 0 "
                "GROUP BY photo_id HAVING COUNT(DISTINCT person_id) = ?)"
            )
            params += [ids_json, len(set(person_ids))]

    if camera:
        clauses.append("camera = ?")
        params.append(camera)

    if dir:
        # Exact match, same convention as get_photos' folder batches.
        clauses.append("dir = ?")
        params.append(dir)

    if has_faces == "yes":
        clauses.append("id IN (SELECT DISTINCT photo_id FROM faces)")
    elif has_faces == "no":
        clauses.append("id NOT IN (SELECT DISTINCT photo_id FROM faces)")

    if gps_accuracy == "precise":
        clauses.append("lat IS NOT NULL AND (gps_accuracy IS NULL OR gps_accuracy <= 0)")
    elif gps_accuracy == "imprecise":
        clauses.append("gps_accuracy IS NOT NULL AND gps_accuracy > 0")

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    order = SEARCH_SORTS.get(sort, SEARCH_SORTS["date_asc"])
    select = "id" if ids_only else "*"
    sql = f"SELECT {select} FROM photos {where} ORDER BY {order} LIMIT ?"
    params.append(limit)
    return db.execute(sql, params).fetchall()


# ── Checksums ──

def get_photos_missing_checksum(limit: int | None = None) -> list[sqlite3.Row]:
    """Rows whose file has not been hashed yet (checksum IS NULL) — the work list
    for scripts/backfill_checksums.py. Ordered by id for stable batching."""
    sql = "SELECT id, dir, filename FROM photos WHERE checksum IS NULL ORDER BY id"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return get_db().execute(sql).fetchall()


def count_photos_missing_checksum() -> int:
    return get_db().execute(
        "SELECT COUNT(*) FROM photos WHERE checksum IS NULL"
    ).fetchone()[0]


def set_checksums(rows: list[tuple[str, int]]):
    """Batch-store checksums in one transaction. Each pair is (checksum, photo_id),
    matching the UPDATE's ``?`` order so the caller can pass cursor tuples directly."""
    if not rows:
        return
    with transaction() as db:
        db.executemany("UPDATE photos SET checksum=? WHERE id=?", rows)


# ── Orientation backfill ──
# Rows indexed before EXIF orientation was read carry orientation=NULL. is_fresh
# marks them stale so a full rescan would refill them, but that re-reads every
# file; scripts/backfill_orientation.py uses these to refill just the tag cheaply.

def get_photos_missing_orientation(limit: int | None = None) -> list[sqlite3.Row]:
    """Rows whose EXIF orientation hasn't been read yet (orientation IS NULL)."""
    sql = "SELECT id, dir, filename FROM photos WHERE orientation IS NULL ORDER BY id"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return get_db().execute(sql).fetchall()


def count_photos_missing_orientation() -> int:
    return get_db().execute(
        "SELECT COUNT(*) FROM photos WHERE orientation IS NULL"
    ).fetchone()[0]


def set_orientations(rows: list[tuple[int, int]]):
    """Batch-store orientations in one transaction. Each pair is (orientation,
    photo_id), matching the UPDATE's ``?`` order."""
    if not rows:
        return
    with transaction() as db:
        db.executemany("UPDATE photos SET orientation=? WHERE id=?", rows)


def get_photos_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> list[sqlite3.Row]:
    """Get photos within a bounding box using the spatial index."""
    db = get_db()
    # R*Tree requires queries in the form: max_X >= min_query AND min_X <= max_query
    # This finds all items whose bounding box overlaps with the query bounding box
    # Since we store points (min_lat = max_lat), this becomes: lat >= min_lat AND lat <= max_lat
    return db.execute(f"""
        SELECT photos.* FROM photos
        INNER JOIN photos_spatial ON photos.id = photos_spatial.id
        WHERE photos_spatial.max_lat >= ?
          AND photos_spatial.min_lat <= ?
          AND photos_spatial.max_lng >= ?
          AND photos_spatial.min_lng <= ?
        ORDER BY {_CHRONO_ORDER}
    """, (min_lat, max_lat, min_lng, max_lng)).fetchall()


def get_photos_by_time_range(min_time: int, max_time: int, has_geotag: bool | None = None) -> list[sqlite3.Row]:
    """Get dated photos within a time range, optionally filtered by geotag presence.
    Undated rows (0) are excluded even when the range spans 1970-01-01 — every
    caller treats the result as photos it can place in time."""
    db = get_db()
    clauses = ["photo_datetime BETWEEN ? AND ?", HAS_DATE_SQL]
    params = [min_time, max_time]

    if has_geotag is True:
        clauses.append("(lat IS NOT NULL OR geocode_ignored = 1)")
    elif has_geotag is False:
        clauses.append("lat IS NULL AND geocode_ignored = 0")

    where = " AND ".join(clauses)
    return db.execute(f"""
        SELECT * FROM photos
        WHERE {where}
        ORDER BY photo_datetime, filename
    """, params).fetchall()


def get_last_scan_roots() -> list[str]:
    """Return the last scanned roots. Works with both old and new cache directory setups."""
    # If using global cache directory, check there
    cache_dir = get_cache_dir()
    if cache_dir:
        sentinel = cache_dir / ".last_scan_roots"
        if sentinel.exists():
            return [line.strip() for line in sentinel.read_text().splitlines() if line.strip()]
        return []

    # Legacy support: check the per-user sentinel
    sentinel = get_state_dir() / ".geotagger_last_root"
    if sentinel.exists():
        root = sentinel.read_text().strip()
        db_path = Path(root) / CACHE_DIR_NAME / "index.db"
        if db_path.exists():
            return [root]
    return []


def get_last_scan_root() -> str | None:
    """Return the first (primary) last scanned root, for backward compatibility."""
    roots = get_last_scan_roots()
    return roots[0] if roots else None


def save_last_scan_roots(roots: list[str]):
    """Save the list of scanned roots."""
    cache_dir = get_cache_dir()
    if cache_dir:
        sentinel = cache_dir / ".last_scan_roots"
        sentinel.write_text("\n".join(roots))
    else:
        # Legacy: only save first root
        if roots:
            state_dir = get_state_dir()
            state_dir.mkdir(parents=True, exist_ok=True)
            (state_dir / ".geotagger_last_root").write_text(roots[0])


def save_last_scan_root(root: str):
    """Save a single scan root, for backward compatibility."""
    save_last_scan_roots([root])


_FRESH_COLS = "mtime, sidecar_path, sidecar_mtime, camera, photo_datetime, gps_accuracy, orientation"

# Directories per `dir IN (…)` query in fresh_flags. Well under SQLite's
# host-parameter limit (999 on older builds); each chunk is one indexed query.
_FRESH_DIR_CHUNK = 500


def is_fresh(dir_: str, filename: str, mtime: float, sidecar_path: str | None, sidecar_mtime: float | None) -> bool:
    """Return True if the indexed row is up-to-date (no re-scan needed). One
    point query; a scan checks many files at once with fresh_flags instead."""
    row = get_db().execute(
        f"SELECT {_FRESH_COLS} FROM photos WHERE dir=? AND filename=?", (dir_, filename)
    ).fetchone()
    return _row_is_fresh(row, mtime, sidecar_path, sidecar_mtime)


def fresh_flags(entries: list[tuple[str, str, float, str | None, float | None]]) -> list[bool]:
    """is_fresh for many files at once: entries are (dir, filename, mtime,
    sidecar_path, sidecar_mtime), the result is aligned with them.

    One indexed `dir IN (…)` query per _FRESH_DIR_CHUNK distinct directories
    instead of one query per file — a rescan of an unchanged library otherwise
    spends its time on 100Ks of point SELECTs. `dir` is compared exactly as
    is_fresh's `dir=?` does (BINARY collation on the same str(p.parent)
    strings), so no case/separator normalisation creeps in.

    Memory: only one chunk's rows are held at a time (a dict entry of
    (dir, filename) -> small Row per photo, a few hundred bytes each, so even
    one chunk spanning a 500K-photo library stays ~100 MB transient); what is
    kept is one bool per entry. Reads outside a transaction like any other
    read, so a concurrent unit's uncommitted rows may be seen — as with
    is_fresh."""
    by_dir: dict[str, list[int]] = {}
    for i, e in enumerate(entries):
        by_dir.setdefault(e[0], []).append(i)
    flags = [False] * len(entries)
    dirs = list(by_dir)
    db = get_db()
    for start in range(0, len(dirs), _FRESH_DIR_CHUNK):
        chunk = dirs[start:start + _FRESH_DIR_CHUNK]
        placeholders = ",".join("?" * len(chunk))
        rows = {(r["dir"], r["filename"]): r for r in db.execute(
            f"SELECT dir, filename, {_FRESH_COLS} FROM photos WHERE dir IN ({placeholders})",
            chunk,
        ).fetchall()}
        for d in chunk:
            for i in by_dir[d]:
                _, filename, mtime, sidecar_path, sidecar_mtime = entries[i]
                flags[i] = _row_is_fresh(rows.get((d, filename)), mtime, sidecar_path, sidecar_mtime)
    return flags


def _row_is_fresh(row, mtime: float, sidecar_path: str | None, sidecar_mtime: float | None) -> bool:
    """The freshness rule shared by is_fresh and fresh_flags (row has
    _FRESH_COLS, or is None when the file isn't indexed)."""
    if not row:
        return False
    if abs(row["mtime"] - mtime) > 1:
        return False
    if sidecar_path != row["sidecar_path"]:
        return False
    if sidecar_mtime is not None and row["sidecar_mtime"] is not None:
        if abs(row["sidecar_mtime"] - sidecar_mtime) > 1:
            return False
    # Re-index if metadata was never fully read (NULL = not yet indexed). A file
    # with no camera tags stores '' rather than NULL, so it isn't re-read (and
    # re-hashed) on every boot.
    # orientation is included so existing libraries backfill it on the next scan.
    if (row["camera"] is None or row["photo_datetime"] is None
            or row["gps_accuracy"] is None or row["orientation"] is None):
        return False
    return True


# ── Places ──

def get_places() -> list[sqlite3.Row]:
    """Return all saved places."""
    return get_db().execute("SELECT * FROM places ORDER BY name").fetchall()


# Same window the propose bar votes with (geotag_service.DEFAULT_PROPOSE_WINDOW):
# an untagged photo counts as "likely here" when it falls within an hour of one
# of the place's own geotagged photos, same time-neighbour test /api/geotag/guess
# and the propose bar use.
_PLACE_NEARBY_WINDOW_SEC = 3600


def _count_nearby_untagged(tagged_times: list[int], untagged_sorted: list[int],
                           window: int) -> int:
    """How many of `untagged_sorted` fall within `window` seconds of any of
    `tagged_times`.

    The per-place tagged times are turned into windows and merged first, so a
    place with a whole day of back-to-back photos doesn't count the same
    untagged neighbour once per tagged photo it happens to be near. Each merged
    span is then resolved against the sorted untagged array with two bisects
    instead of a per-photo scan.
    """
    import bisect

    if not tagged_times or not untagged_sorted:
        return 0
    spans = sorted((t - window, t + window) for t in tagged_times)
    merged = [spans[0]]
    for lo, hi in spans[1:]:
        if lo <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))
    count = 0
    for lo, hi in merged:
        count += bisect.bisect_right(untagged_sorted, hi) - bisect.bisect_left(untagged_sorted, lo)
    return count


def get_place_stats() -> dict[int, dict]:
    """Photo count, newest photo timestamp, and untagged-nearby count per saved
    place, keyed by place id.

    One R*Tree bbox prefilter per place, narrowed by the same exact predicate
    Search uses (place_distance == 0 means "inside"). Without that second pass a
    circle would count the ~27% of its bounding box lying outside the ring, which
    at a 5 km place is a lot of photos from down the road.

    A place whose box straddles the antimeridian (min_lng > max_lng) reads as an
    empty R*Tree range and counts zero — the same blind spot the rest of the
    saved-place code has, not a new one.

    `untagged_nearby_count` is not a spatial figure — an untagged photo has no
    lat/lng to test against the place's shape — it is time-neighbour inference:
    how many undated-by-location photos fall within _PLACE_NEARBY_WINDOW_SEC of a
    photo already tagged inside this place, the same guess the propose bar and
    /api/geotag/guess make one photo at a time. The untagged timestamp array is
    fetched once and reused across every place rather than requeried per place.
    """
    from geotagger.search_locations import place_bbox
    db = get_db()

    untagged_times = [r["photo_datetime"] for r in db.execute(f"""
        SELECT photo_datetime FROM photos
        WHERE lat IS NULL AND geocode_ignored = 0 AND {HAS_DATE_SQL}
        ORDER BY photo_datetime
    """).fetchall()]

    stats: dict[int, dict] = {}
    for p in db.execute("SELECT id, type, bounds FROM places").fetchall():
        box = place_bbox(p["type"], p["bounds"])
        if box is None:                      # unparseable bounds — report, don't raise
            stats[p["id"]] = {"photo_count": 0, "last_ts": None, "untagged_nearby_count": 0}
            continue
        min_lat, max_lat, min_lng, max_lng = box
        rows = db.execute("""
            SELECT photos.photo_datetime AS ts
            FROM photos
            INNER JOIN photos_spatial ON photos_spatial.id = photos.id
            WHERE photos_spatial.max_lat >= ?
              AND photos_spatial.min_lat <= ?
              AND photos_spatial.max_lng >= ?
              AND photos_spatial.min_lng <= ?
              AND search_place_distance(photos.lat, photos.lng, ?, ?) = 0
        """, (min_lat, max_lat, min_lng, max_lng, p["type"], p["bounds"])).fetchall()
        times = [r["ts"] for r in rows if has_date(r["ts"])]
        stats[p["id"]] = {
            "photo_count": len(rows),
            "last_ts": max(times) if times else None,
            "untagged_nearby_count": _count_nearby_untagged(
                times, untagged_times, _PLACE_NEARBY_WINDOW_SEC),
        }
    return stats


def create_place(name: str, place_type: str, bounds: str) -> int:
    """Create a new place and return its ID."""
    with transaction() as db:
        cursor = db.execute(
            "INSERT INTO places (name, type, bounds, created_at) VALUES (?, ?, ?, ?)",
            (name, place_type, bounds, time.time())
        )
    return cursor.lastrowid


def delete_place(place_id: int):
    """Delete a place by ID."""
    with transaction() as db:
        db.execute("DELETE FROM places WHERE id=?", (place_id,))


def update_place(place_id: int, bounds: str | None = None, name: str | None = None):
    """Update a place's bounds and/or name (only fields that are not None)."""
    sets = []
    params: list = []
    if bounds is not None:
        sets.append("bounds=?")
        params.append(bounds)
    if name is not None:
        sets.append("name=?")
        params.append(name)
    if not sets:
        return
    params.append(place_id)
    with transaction() as db:
        db.execute(f"UPDATE places SET {', '.join(sets)} WHERE id=?", params)


def set_place_representative(place_id: int, photo_id: int | None):
    """Set (or clear, with photo_id=None) a place's representative photo."""
    with transaction() as db:
        db.execute("UPDATE places SET representative_photo_id=? WHERE id=?", (photo_id, place_id))


# ── Reverse geocoding ──

def get_cached_geocode(qlat: int, qlng: int) -> dict | None:
    """Return a cached location for quantized coords, or None on a miss."""
    row = get_db().execute(
        "SELECT city, sublocation, postal_code, state, county, country, country_code "
        "FROM geocode_cache WHERE qlat=? AND qlng=?",
        (qlat, qlng),
    ).fetchone()
    if row is None:
        return None
    return {"city": row["city"], "sublocation": row["sublocation"],
            "postal_code": row["postal_code"],
            "state": row["state"], "county": row["county"],
            "country": row["country"], "country_code": row["country_code"]}


def put_cached_geocode(qlat: int, qlng: int, loc: dict, source: str = "local"):
    """Cache a location result for quantized coords."""
    with transaction() as db:
        db.execute(
            """INSERT OR REPLACE INTO geocode_cache
                   (qlat, qlng, city, sublocation, postal_code, state, county, country,
                    country_code, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (qlat, qlng, loc.get("city"), loc.get("sublocation"), loc.get("postal_code"),
             loc.get("state"), loc.get("county"), loc.get("country"), loc.get("country_code"),
             source, time.time()),
        )


def _location_params(photo_id: int, loc: dict | None, now: float) -> tuple:
    """Bind values for the location UPDATE; loc=None clears the loc_* columns."""
    loc = loc or {}
    return (loc.get("city"), loc.get("sublocation"), loc.get("postal_code"), loc.get("state"),
            loc.get("county"), loc.get("country"), loc.get("country_code"), now, photo_id)


_LOCATION_SQL = ("UPDATE photos SET loc_city=?, loc_sublocation=?, loc_postal_code=?, loc_state=?, "
                 "loc_county=?, loc_country=?, loc_country_code=?, geocoded_at=? WHERE id=?")


def update_photo_location(photo_id: int, loc: dict | None):
    """Store reverse-geocoded place names on a photo. geocoded_at is always set
    (so a no-match isn't retried endlessly); loc=None records 'looked up, no match'."""
    update_photo_locations([(photo_id, loc)])


def update_photo_locations(items: list[tuple[int, dict | None]]):
    """update_photo_location for many photos in ONE transaction (one commit and one
    hold of the global write lock, instead of one per photo). Callers do the
    lookups first, outside any transaction."""
    if not items:
        return
    now = time.time()
    with transaction() as db:
        db.executemany(_LOCATION_SQL, [_location_params(pid, loc, now) for pid, loc in items])


def get_photos_needing_geocode(limit: int | None = None) -> list[sqlite3.Row]:
    """Photos that have coordinates but have not been reverse-geocoded yet."""
    sql = ("SELECT id, lat, lng FROM photos "
           "WHERE lat IS NOT NULL AND lng IS NOT NULL AND geocoded_at IS NULL "
           "ORDER BY id")
    if limit:
        sql += f" LIMIT {int(limit)}"
    return get_db().execute(sql).fetchall()


def count_photos_needing_geocode() -> int:
    return get_db().execute(
        "SELECT COUNT(*) FROM photos "
        "WHERE lat IS NOT NULL AND lng IS NOT NULL AND geocoded_at IS NULL"
    ).fetchone()[0]


def count_geocoded_photos() -> int:
    """Photos that resolved to a location (geocoded with a country)."""
    return get_db().execute(
        "SELECT COUNT(*) FROM photos WHERE loc_country_code IS NOT NULL"
    ).fetchone()[0]


def get_photos_to_export() -> list[sqlite3.Row]:
    """All geotagged photos — used by the on-demand DB-to-sidecar export. Location
    columns are included but may be NULL (not yet reverse-geocoded); the exporter
    only writes place-name tags when they're populated."""
    return get_db().execute(
        "SELECT id, dir, filename, lat, lng, gps_accuracy, "
        "loc_city, loc_state, loc_country, loc_country_code "
        "FROM photos WHERE lat IS NOT NULL AND lng IS NOT NULL"
    ).fetchall()


# ── Faces & persons ──

def get_unscanned_photo_ids() -> list[int]:
    """Return ids of image photos that have not yet had a face-detection pass."""
    rows = get_db().execute(
        "SELECT id FROM photos WHERE media_type='image' AND faces_scanned_at IS NULL"
    ).fetchall()
    return [r["id"] for r in rows]


# ── Semantic-search embeddings ──

def get_unembedded_photo_ids(model: str) -> list[int]:
    """Photos (images and videos — the preview path renders a video poster frame)
    with no embedding row for ``model``. A row for a different model counts as
    missing, so changing SEMANTIC_MODEL_NAME queues everything for re-indexing."""
    rows = get_db().execute(
        "SELECT p.id FROM photos p LEFT JOIN photo_embeddings e ON e.photo_id = p.id "
        "WHERE e.photo_id IS NULL OR e.model != ? ORDER BY p.id",
        (model,),
    ).fetchall()
    return [r["id"] for r in rows]


def store_embeddings(rows: list[tuple[int, bytes | None]], model: str):
    """Insert/replace one batch of (photo_id, fp16 bytes or None-for-failed) in one
    transaction."""
    if not rows:
        return
    with transaction() as db:
        now = time.time()
        db.executemany(
            "INSERT OR REPLACE INTO photo_embeddings (photo_id, model, vec, created_at) VALUES (?, ?, ?, ?)",
            [(pid, model, vec, now) for pid, vec in rows],
        )


def embedding_signature(model: str) -> tuple[int, float]:
    """(count, latest created_at) of usable vectors — changes on any insert, re-embed
    or delete, so semantic.get_matrix() can tell when its cache is stale without a
    full reload."""
    r = get_db().execute(
        "SELECT COUNT(*) AS n, MAX(created_at) AS t FROM photo_embeddings "
        "WHERE model = ? AND vec IS NOT NULL", (model,),
    ).fetchone()
    return int(r["n"]), float(r["t"] or 0.0)


def load_embeddings(model: str):
    """(photo ids int64[N] ascending, float32[N, D]) for every usable vector of
    ``model``. One fp16 buffer join + a single astype, not N small arrays."""
    import numpy as np
    rows = get_db().execute(
        "SELECT photo_id, vec FROM photo_embeddings WHERE model = ? AND vec IS NOT NULL "
        "ORDER BY photo_id", (model,),
    ).fetchall()
    if not rows:
        return np.zeros(0, dtype=np.int64), np.zeros((0, 0), dtype=np.float32)
    ids = np.fromiter((r["photo_id"] for r in rows), dtype=np.int64, count=len(rows))
    mat = np.frombuffer(b"".join(r["vec"] for r in rows), dtype=np.float16)
    return ids, mat.reshape(len(rows), -1).astype(np.float32)


def get_embedding(photo_id: int, model: str) -> bytes | None:
    r = get_db().execute(
        "SELECT vec FROM photo_embeddings WHERE photo_id = ? AND model = ?", (photo_id, model),
    ).fetchone()
    return r["vec"] if r else None


def count_embeddings(model: str) -> dict[str, int]:
    """Indexing progress for the status endpoint."""
    db = get_db()
    total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    r = db.execute(
        "SELECT COUNT(*) AS done, SUM(vec IS NULL) AS failed FROM photo_embeddings e "
        "JOIN photos p ON p.id = e.photo_id WHERE e.model = ?", (model,),
    ).fetchone()
    done = int(r["done"] or 0)
    return {"total": int(total), "embedded": done - int(r["failed"] or 0),
            "failed": int(r["failed"] or 0), "remaining": int(total) - done}


def replace_faces(photo_id: int, faces: list[dict], det_dimension: int | None = None):
    """Replace all detected faces for a photo in one transaction and mark it scanned.

    Each face dict: {bbox: str, det_score: float, embedding: bytes}. ``det_dimension``
    is the long edge (px) of the image detection ran on (see faces.detect_faces);
    stored as photos.faces_det_dimension, NULL when detection used the low-quality
    embedded preview.
    Manually-confirmed assignments are not touched here because detection always
    re-runs from scratch; assignments live by face id and are reapplied by the
    caller if it chooses to. For a first pass, faces start unassigned.

    Intentionally does NOT call bump_faces_generation(): the labeled gallery only
    contains confirmed faces (unaffected by detection), so there is nothing to
    rebuild there. The unlabeled suggestion matrix is pruned in place via
    drop_from_unlabeled_cache so the cache survives the scan. Newly detected
    faces will appear in the suggestion matrix on the next full rebuild (triggered
    by the next label/ignore action by the user).
    """
    with transaction() as db:
        # Capture old face IDs so we can prune them from the in-memory cache below.
        old_ids = [r[0] for r in db.execute(
            "SELECT id FROM faces WHERE photo_id=? AND source='detected'", (photo_id,)
        ).fetchall()]
        if old_ids:
            # Rescan mints new face ids, so negatives keyed on the old ones would
            # otherwise dangle (FKs aren't enforced — no cascade). Known, accepted
            # limitation: a rescan drops negatives, same as it already drops
            # assignments (see docstring above).
            old_json = ids_json(old_ids)
            db.execute("DELETE FROM face_negatives WHERE face_id IN (SELECT value FROM json_each(?))", (old_json,))
            db.execute("DELETE FROM face_embeddings WHERE face_id IN (SELECT value FROM json_each(?))", (old_json,))
        db.execute("DELETE FROM faces WHERE photo_id=? AND source='detected'", (photo_id,))
        now = time.time()
        new_ids = []
        for f in faces:
            cur = db.execute(
                """INSERT INTO faces (photo_id, person_id, bbox, det_score, source, created_at)
                   VALUES (?, NULL, ?, ?, 'detected', ?)""",
                (photo_id, f["bbox"], f["det_score"], now),
            )
            new_ids.append(cur.lastrowid)
        if new_ids:
            db.executemany(
                "INSERT INTO face_embeddings (face_id, embedding) VALUES (?, ?)",
                [(fid, f["embedding"]) for fid, f in zip(new_ids, faces)],
            )
        db.execute("UPDATE photos SET faces_scanned_at=?, faces_det_dimension=? WHERE id=?",
                   (now, det_dimension, photo_id))
    # Prune replaced faces from the cache (re-tags to current generation in place).
    if old_ids:
        from geotagger import faces as _faces
        _faces.drop_from_unlabeled_cache(old_ids)


def delete_photo_faces(photo_ids: list[int]) -> int:
    """Nuclear option: hard-delete every face (detected, assigned, OR ignored) for
    these photos and reset their scan state, so the next face scan re-detects from
    scratch. Unlike replace_faces (a routine rescan, which only replaces
    source='detected' faces and leaves manual assignments alone), this drops
    everything for the photo — for when detection went wrong and the whole slate
    needs wiping. Returns the number of faces deleted.
    """
    if not photo_ids:
        return 0
    with transaction() as db:
        old_ids = [r[0] for r in db.execute(
            "SELECT id FROM faces WHERE photo_id IN (SELECT value FROM json_each(?))",
            (ids_json(photo_ids),),
        ).fetchall()]
        if old_ids:
            # FKs aren't enforced (no cascade) — drop negatives and embeddings
            # explicitly, same as replace_faces does for a routine rescan.
            fjson = ids_json(old_ids)
            db.execute("DELETE FROM face_negatives WHERE face_id IN (SELECT value FROM json_each(?))", (fjson,))
            db.execute("DELETE FROM face_embeddings WHERE face_id IN (SELECT value FROM json_each(?))", (fjson,))
            db.execute("DELETE FROM faces WHERE id IN (SELECT value FROM json_each(?))", (fjson,))
        db.executemany(
            "UPDATE photos SET faces_scanned_at=NULL, faces_det_dimension=NULL WHERE id=?",
            [(pid,) for pid in photo_ids],
        )
    bump_faces_generation()
    if old_ids:
        from geotagger import faces as _faces
        _faces.drop_from_unlabeled_cache(old_ids)
    return len(old_ids)


def add_manual_face(photo_id: int, bbox: str, person_id: int | None = None,
                    det_score: float = 1.0, embedding: bytes | None = None) -> int:
    """Insert one hand-drawn face (source='manual') and return its id.

    ``bbox`` is sensor-space normalized "x1,y1,x2,y2" like every stored box.
    det_score defaults to 1.0 — the user asserted this face, so it outranks the
    detector's own scores in the det_score DESC orderings.

    source='manual' is what keeps it alive across a routine rescan: replace_faces
    only deletes source='detected' rows. (delete_photo_faces / the photo page's
    Rescan still wipe it — that action is explicitly "start over".)

    ``embedding`` may be None when no face could be embedded inside the drawn box
    (see faces.embed_bbox): the row is still a valid tag, it just sits out of the
    recognition gallery and the unlabeled suggestion queue, both of which inner-join
    face_embeddings.
    """
    with transaction() as db:
        now = time.time()
        cur = db.execute(
            """INSERT INTO faces (photo_id, person_id, bbox, det_score, source,
                                  created_at, assigned_at)
               VALUES (?, ?, ?, ?, 'manual', ?, ?)""",
            (photo_id, person_id, bbox, det_score, now, now if person_id else None),
        )
        face_id = cur.lastrowid
        if embedding is not None:
            db.execute("INSERT INTO face_embeddings (face_id, embedding) VALUES (?, ?)",
                       (face_id, embedding))
    bump_faces_generation()
    return face_id


def delete_manual_face(face_id: int) -> bool:
    """Hard-delete one hand-drawn face — the undo for a badly drawn box. Returns
    False (deleting nothing) for a detected face: those are removed by rescanning
    or hidden with ignore, never deleted piecemeal, since the next scan would just
    re-detect them."""
    with transaction() as db:
        row = db.execute("SELECT source FROM faces WHERE id=?", (face_id,)).fetchone()
        if not row or row["source"] != "manual":
            return False
        # FKs aren't enforced (no cascade) — clear the satellites explicitly, same as
        # replace_faces / delete_photo_faces do.
        db.execute("DELETE FROM face_negatives WHERE face_id=?", (face_id,))
        db.execute("DELETE FROM face_embeddings WHERE face_id=?", (face_id,))
        db.execute("DELETE FROM faces WHERE id=?", (face_id,))
    bump_faces_generation()
    from geotagger import faces as _faces
    _faces.drop_from_unlabeled_cache([face_id])
    return True


def get_faces_for_photo(photo_id: int) -> list[sqlite3.Row]:
    return get_db().execute(
        """SELECT f.id, f.photo_id, f.person_id, f.bbox, f.det_score, f.source,
                  fe.embedding, f.assigned_at, f.ignored, f.come_back, p.name AS person_name,
                  ph.orientation
           FROM faces f
           LEFT JOIN face_embeddings fe ON fe.face_id = f.id
           LEFT JOIN persons p ON p.id = f.person_id
           JOIN photos ph ON ph.id = f.photo_id
           WHERE f.photo_id=? ORDER BY f.det_score DESC""",
        (photo_id,),
    ).fetchall()


def get_tagged_faces_for_photo(photo_id: int) -> list[sqlite3.Row]:
    """Faces in a photo already committed to a person — no embeddings, no
    suggestion work, so the detail pane can ask for this on every focus change."""
    return get_db().execute(
        """SELECT f.id, f.person_id, f.bbox, f.assigned_at, p.name AS person_name,
                  ph.orientation
           FROM faces f
           JOIN persons p ON p.id = f.person_id
           JOIN photos ph ON ph.id = f.photo_id
           WHERE f.photo_id=? AND f.person_id IS NOT NULL
           ORDER BY p.name""",
        (photo_id,),
    ).fetchall()


def get_face(face_id: int) -> sqlite3.Row | None:
    return get_db().execute("SELECT * FROM faces WHERE id=?", (face_id,)).fetchone()


def get_labeled_faces() -> list[sqlite3.Row]:
    """All faces assigned to a person (the recognition gallery), with each
    example's photo date and the person's birth date for age-aware matching.

    INDEXED BY forces the labeled rows (a few % of the table) to be found through
    idx_faces_person; without the hint the planner full-scans the faces table —
    which, even with embeddings split out (see face_embeddings), still means a
    face_embeddings point lookup for every unlabeled row instead of just the
    labeled few — ~6x slower here.
    """
    return get_db().execute(
        """SELECT f.person_id, fe.embedding, f.bbox, ph.photo_datetime,
                  p.birth_date, p.not_before, p.not_after
           FROM faces f INDEXED BY idx_faces_person
           JOIN face_embeddings fe ON fe.face_id = f.id
           JOIN photos ph ON ph.id = f.photo_id
           JOIN persons p ON p.id = f.person_id
           WHERE f.person_id IS NOT NULL"""
    ).fetchall()


def get_persons_with_min_labeled_faces(min_faces: int) -> list[int]:
    """Person ids with at least ``min_faces`` labeled examples — the pool
    representative-picking applies to (see faces.compute_representatives_for_person).
    Small/rarely-seen people are left alone; their whole label set already IS the
    representative set."""
    return [r[0] for r in get_db().execute(
        """SELECT person_id FROM faces WHERE person_id IS NOT NULL
           GROUP BY person_id HAVING COUNT(*) >= ?""",
        (min_faces,),
    ).fetchall()]


def get_labeled_faces_for_person(person_id: int) -> list[sqlite3.Row]:
    """One person's labeled faces (id, embedding, representative flag), for
    representative-cluster picking (faces.compute_representatives_for_person)
    and the group-review page (faces.get_representative_groups)."""
    return get_db().execute(
        """SELECT f.id, fe.embedding, f.representative FROM faces f
           JOIN face_embeddings fe ON fe.face_id = f.id
           WHERE f.person_id=?""",
        (person_id,),
    ).fetchall()


def get_persons_with_representatives() -> list[sqlite3.Row]:
    """Persons who currently have at least one representative-flagged face —
    the picker for the Representative Faces review page. Reflects whatever the
    last recompute decided, not live eligibility (see get_persons_with_min_labeled_faces)."""
    return get_db().execute(
        """SELECT p.id, p.name, COUNT(f.id) AS total, SUM(f.representative) AS representative
           FROM persons p JOIN faces f ON f.person_id = p.id
           GROUP BY p.id
           HAVING SUM(f.representative) > 0
           ORDER BY p.name COLLATE NOCASE"""
    ).fetchall()


def set_person_representatives(person_id: int, representative_ids: list[int]):
    """Flag exactly ``representative_ids`` as representative=1 among person_id's
    labeled faces, everyone else representative=0. Recomputed from scratch each
    call (safe to re-run any time — after retagging, or after tuning the dedup
    settings)."""
    with transaction() as db:
        db.execute("UPDATE faces SET representative=0 WHERE person_id=?", (person_id,))
        if representative_ids:
            db.execute(
                "UPDATE faces SET representative=1 WHERE id IN (SELECT value FROM json_each(?))",
                (ids_json(representative_ids),),
            )


def _photo_ids_in_window(start_ts: int | None, end_ts: int | None) -> list[int]:
    """Photo ids with photo_datetime in [start_ts, end_ts] (either bound optional),
    via idx_photos_datetime. Used to pre-resolve a time Focus to a small photo_id
    set — see list_faces for why. Undated photos fall outside every window."""
    conds, params = [HAS_DATE_SQL], []
    if start_ts is not None:
        conds.append("photo_datetime >= ?")
        params.append(start_ts)
    if end_ts is not None:
        conds.append("photo_datetime <= ?")
        params.append(end_ts)
    return [r[0] for r in get_db().execute(
        f"SELECT id FROM photos WHERE {' AND '.join(conds)}", params
    ).fetchall()]


def list_faces(scope: str = "unlabeled", person_id: int | None = None,
               limit: int = 500, min_det_score: float | None = None,
               start_ts: int | None = None,
               end_ts: int | None = None) -> list[sqlite3.Row]:
    """List faces across the whole library for the people UI.

    scope: 'unlabeled' (person_id IS NULL), 'person' (a specific person),
    or 'all'. Joins the photo filename and includes the embedding so the
    caller can compute recognition suggestions. ``min_det_score`` drops faces
    below a detector-confidence floor (used by the suggestion scan to skip
    unreliable tiny/blurry faces; the manual queues pass None to keep them).
    ``start_ts``/``end_ts`` (epoch secs) window by photo_datetime — the People
    page's time Focus passes these for the unlabeled queue; undated faces
    (NULL photo_datetime) fall out of any window.

    A start_ts/end_ts window is resolved to a photo_id set up front (via
    idx_photos_datetime) rather than joined as ``ph.photo_datetime BETWEEN`` —
    measured on a 78K-row
    unlabeled queue: with the direct join, idx_faces_queue drives the scan in
    det_score order (to satisfy ORDER BY for free) and photo_datetime can only
    be checked *after* a rowid lookup into photos per candidate face, so a
    narrow/sparse window can't shortcut LIMIT and ends up probing nearly every
    unlabeled face. Pre-resolving flips the join to drive off the (usually much
    smaller) matching-photos set instead — but only actually pays off once the
    ORDER BY stops preferring idx_faces_queue (see the ``+f.det_score`` trick
    below), since a plain ``photo_id IN (...)`` still lets SQLite keep scanning
    det_score order and Bloom-filter-test each row, which still means reading
    every unlabeled row (embedding blob and all) to get its photo_id.
    """
    clause = ""
    params: list = []
    # 'recent', 'ignored', and 'come_back' are ordered by action time, newest
    # first; the rest by detection score.
    order_by = "f.det_score DESC"
    if scope == "unlabeled":
        clause = "WHERE f.person_id IS NULL AND f.ignored = 0 AND f.come_back = 0"
    elif scope == "ignored":
        clause = "WHERE f.ignored = 1"
        order_by = "f.ignored_at DESC NULLS LAST, f.det_score DESC"
    elif scope == "come_back":
        clause = "WHERE f.come_back = 1"
        order_by = "f.come_back_at DESC NULLS LAST, f.det_score DESC"
    elif scope == "person" and person_id is not None:
        clause = "WHERE f.person_id = ?"
        params.append(person_id)
    elif scope == "recent":
        clause = "WHERE f.assigned_at IS NOT NULL AND f.person_id IS NOT NULL"
        order_by = "f.assigned_at DESC"
    if min_det_score is not None:
        clause += (" AND " if clause else "WHERE ") + "f.det_score >= ?"
        params.append(min_det_score)
    photo_ids = None
    if start_ts is not None or end_ts is not None:
        photo_ids = _photo_ids_in_window(start_ts, end_ts)
    if photo_ids is not None:
        # Time Focus, pre-resolved to a photo_id set (see above / docstring).
        # json_each keeps this to one bound param regardless of how many ids
        # (SQLite has a ~999-variable cap on a literal IN list).
        import json as _json
        clause += (" AND " if clause else "WHERE ") + \
                  "f.photo_id IN (SELECT value FROM json_each(?))"
        params.append(_json.dumps(photo_ids))
        if scope == "unlabeled":
            # Defeat idx_faces_queue's "ORDER BY det_score for free" so the
            # planner actually weighs idx_faces_photo_queue(photo_id, ignored,
            # person_id, det_score) — driven by the small photo_id set, with a
            # real (but cheap, since it's over just the matches) sort after.
            # EXPLAIN QUERY PLAN confirms the switch; measured ~500ms -> <1ms on
            # a sparse window, ~50ms on a window with a full page of matches.
            order_by = "+f.det_score DESC"
    # Only the unlabeled scope's caller decodes embeddings (to build/refresh the
    # suggestion matrix) — every other scope just renders face_item dicts. Skip
    # the face_embeddings join there so those scans (some up to LIMIT 200_000,
    # e.g. the dedup-groups review) don't pay a point lookup per row for a blob
    # nothing reads.
    embed_join = "JOIN face_embeddings fe ON fe.face_id = f.id" if scope == "unlabeled" else ""
    embed_col = "fe.embedding," if scope == "unlabeled" else ""
    return get_db().execute(
        f"""SELECT f.id, f.photo_id, f.person_id, f.bbox, f.det_score, {embed_col}
                   f.ignored, f.assigned_at, f.ignored_at, f.come_back, f.come_back_at,
                   p.name AS person_name, ph.filename,
                   ph.photo_datetime, ph.orientation, ph.dir,
                   ph.loc_city, ph.loc_sublocation, ph.loc_state, ph.loc_country
            FROM faces f
            {embed_join}
            LEFT JOIN persons p ON p.id = f.person_id
            JOIN photos ph ON ph.id = f.photo_id
            {clause}
            ORDER BY {order_by}
            LIMIT ?""",
        params + [limit],
    ).fetchall()


def count_faces(scope: str = "unlabeled", person_id: int | None = None,
                start_ts: int | None = None, end_ts: int | None = None) -> int:
    if scope == "unlabeled":
        # The People page's time Focus windows only the unlabeled count; a window
        # needs the photos join, so keep the plain (unwindowed) path join-free.
        if start_ts is None and end_ts is None:
            return get_db().execute(
                "SELECT COUNT(*) FROM faces WHERE person_id IS NULL AND ignored = 0 AND come_back = 0"
            ).fetchone()[0]
        # Resolve the time window to a photo_id set up front (idx_photos_datetime)
        # instead of joining photos — same reasoning as list_faces: it lets this
        # stay a plain faces-table query (photo_id is already indexed there), no
        # per-candidate-face lookup into photos needed.
        photo_ids = None
        if start_ts is not None or end_ts is not None:
            photo_ids = _photo_ids_in_window(start_ts, end_ts)
        clause = "WHERE f.person_id IS NULL AND f.ignored = 0 AND f.come_back = 0"
        params: list = []
        if photo_ids is not None:
            import json as _json
            clause += " AND f.photo_id IN (SELECT value FROM json_each(?))"
            params.append(_json.dumps(photo_ids))
        return get_db().execute(
            f"SELECT COUNT(*) FROM faces f {clause}",
            params,
        ).fetchone()[0]
    if scope == "ignored":
        return get_db().execute("SELECT COUNT(*) FROM faces WHERE ignored = 1").fetchone()[0]
    if scope == "come_back":
        return get_db().execute("SELECT COUNT(*) FROM faces WHERE come_back = 1").fetchone()[0]
    if scope == "recent":
        return get_db().execute(
            "SELECT COUNT(*) FROM faces WHERE assigned_at IS NOT NULL AND person_id IS NOT NULL"
        ).fetchone()[0]
    if scope == "person" and person_id is not None:
        return get_db().execute(
            "SELECT COUNT(*) FROM faces WHERE person_id = ?", (person_id,)
        ).fetchone()[0]
    return get_db().execute("SELECT COUNT(*) FROM faces").fetchone()[0]


def photo_ids_with_tagged_person(person_ids: list[int]) -> set[int]:
    """Photo ids that contain a tagged, non-ignored face of ANY of these persons.
    Used by the untagged-face search (Scenario A) to drop photos where the
    searched person is already tagged — those are plain-search hits."""
    import json as _json
    ids_json = _json.dumps(person_ids)
    return {r[0] for r in get_db().execute(
        "SELECT DISTINCT photo_id FROM faces "
        "WHERE person_id IN (SELECT value FROM json_each(?)) AND ignored = 0",
        (ids_json,)).fetchall()}


def tagged_person_faces_in_photos(person_ids: list[int]) -> dict[int, list[tuple[int, int]]]:
    """{photo_id: [(person_id, face_id), ...]} for tagged, non-ignored faces of
    these persons. One row per (photo, person, face) — used by the untagged-face
    search (Scenario B) as the "hard edges" half of the per-photo bipartite cover."""
    import json as _json
    ids_json = _json.dumps(person_ids)
    out: dict[int, list[tuple[int, int]]] = {}
    for r in get_db().execute(
        "SELECT photo_id, person_id, id FROM faces "
        "WHERE person_id IN (SELECT value FROM json_each(?)) AND ignored = 0",
        (ids_json,)).fetchall():
        out.setdefault(r["photo_id"], []).append((r["person_id"], r["id"]))
    return out


def get_face_with_photo(face_id: int) -> sqlite3.Row | None:
    """Face row joined with its photo's path/mtime/size (for cropping)."""
    return get_db().execute(
        """SELECT f.id, f.bbox, f.photo_id, ph.dir, ph.filename, ph.mtime, ph.size, ph.orientation
           FROM faces f JOIN photos ph ON ph.id = f.photo_id
           WHERE f.id = ?""",
        (face_id,),
    ).fetchone()


def assign_faces(face_ids: list[int], person_id: int | None):
    """Bulk confirm (or clear, with None) the identity of several faces.

    Labeling or clearing always lifts the ignored and come_back flags (see
    assign_face). Faces confirmed together share one assigned_at, so a batch
    reads as a single tag action for ordering and undo; clearing nulls the
    timestamp.
    """
    if not face_ids:
        return
    with transaction() as db:
        now = time.time() if person_id is not None else None
        db.executemany(
            "UPDATE faces SET person_id=?, ignored=0, come_back=0, come_back_at=NULL, "
            "assigned_at=? WHERE id=?",
            [(person_id, now, fid) for fid in face_ids],
        )
        if person_id is not None:
            # A face can't be both "assigned to P" and "not P" — drop that conflict.
            # Other persons' negatives on these faces are left intact.
            db.executemany(
                "DELETE FROM face_negatives WHERE face_id=? AND person_id=?",
                [(fid, person_id) for fid in face_ids],
            )
    bump_faces_generation()
    if person_id is not None:  # labeled faces leave the unlabeled queue
        from geotagger import faces as _faces
        _faces.drop_from_unlabeled_cache(face_ids)


def set_faces_ignored(face_ids: list[int], ignored: bool):
    """Mark faces as ignored (hidden from the queue) or restore them.

    Ignoring also clears any person assignment and the come_back flag so the
    face states stay mutually exclusive; restoring returns the face to the
    unlabeled queue.
    """
    if not face_ids:
        return
    with transaction() as db:
        now = time.time()
        if ignored:
            db.executemany(
                "UPDATE faces SET ignored=1, person_id=NULL, assigned_at=NULL, ignored_at=?, "
                "come_back=0, come_back_at=NULL WHERE id=?",
                [(now, fid) for fid in face_ids],
            )
        else:
            db.executemany(
                "UPDATE faces SET ignored=0, ignored_at=NULL WHERE id=?",
                [(fid,) for fid in face_ids],
            )
    bump_faces_generation()
    if ignored:  # ignored faces leave the unlabeled queue (restore re-adds → rebuild)
        from geotagger import faces as _faces
        _faces.drop_from_unlabeled_cache(face_ids)


def set_faces_come_back(face_ids: list[int], come_back: bool):
    """Mark faces for the come-back queue (people we know or suspect but
    aren't ready to assign yet), or restore them to the unlabeled queue.

    Mirrors set_faces_ignored: setting come_back also clears any person
    assignment and the ignored flag so the face states stay mutually
    exclusive; restoring just clears the flag, returning the face to the
    unlabeled queue.
    """
    if not face_ids:
        return
    with transaction() as db:
        now = time.time()
        if come_back:
            db.executemany(
                "UPDATE faces SET come_back=1, come_back_at=?, person_id=NULL, assigned_at=NULL, "
                "ignored=0, ignored_at=NULL WHERE id=?",
                [(now, fid) for fid in face_ids],
            )
        else:
            db.executemany(
                "UPDATE faces SET come_back=0, come_back_at=NULL WHERE id=?",
                [(fid,) for fid in face_ids],
            )
    bump_faces_generation()
    if come_back:  # come-back faces leave the unlabeled queue (restore re-adds → rebuild)
        from geotagger import faces as _faces
        _faces.drop_from_unlabeled_cache(face_ids)


def get_face_coverage() -> dict[str, int]:
    """Bucket every scanned image photo by how many of its detected faces are
    labeled. The four buckets partition all scanned image photos (media_type
    'image', faces_scanned_at set):

      full     — no unlabeled faces remain (every face is assigned, ignored,
                 or deferred to the come-back queue)
      partial  — at least one labeled and at least one still-unlabeled face
      none     — faces detected but none labeled yet
      no_faces — scanned, but nothing detected

    'unlabeled' counts only the work queue (person_id NULL, not ignored, not
    come_back), so a photo whose faces are all either assigned, ignored, or
    deferred counts as full."""
    # Aggregate per photo first (LEFT JOIN so no-face photos survive as total=0),
    # then tally the buckets. Aliases avoid the SQLite keyword FULL.
    row = get_db().execute("""
        SELECT
            SUM(CASE WHEN total = 0 THEN 1 ELSE 0 END)                     AS no_faces,
            SUM(CASE WHEN total > 0 AND unlabeled = 0 THEN 1 ELSE 0 END)   AS cov_full,
            SUM(CASE WHEN labeled > 0 AND unlabeled > 0 THEN 1 ELSE 0 END) AS cov_partial,
            SUM(CASE WHEN labeled = 0 AND unlabeled > 0 THEN 1 ELSE 0 END) AS cov_none
        FROM (
            SELECT ph.id AS pid,
                   COUNT(f.id) AS total,
                   COUNT(CASE WHEN f.person_id IS NOT NULL THEN 1 END) AS labeled,
                   COUNT(CASE WHEN f.person_id IS NULL AND f.ignored = 0 AND f.come_back = 0 THEN 1 END) AS unlabeled
            FROM photos ph
            LEFT JOIN faces f ON f.photo_id = ph.id
            WHERE ph.media_type = 'image' AND ph.faces_scanned_at IS NOT NULL
            GROUP BY ph.id
        )
    """).fetchone()
    return {
        "full": row["cov_full"] or 0,
        "partial": row["cov_partial"] or 0,
        "none": row["cov_none"] or 0,
        "no_faces": row["no_faces"] or 0,
    }


def get_crowd_photos(min_faces: int = 50, start_ts: int | None = None,
                     end_ts: int | None = None) -> list[sqlite3.Row]:
    """Return photos with at least `min_faces` detected faces, ordered by
    photo_datetime with every undated photo first (api_crowds groups consecutive
    rows by time gap, so undated must be one contiguous block, not split around
    the pre-1970 photos). Each row includes per-state face counts. ``start_ts``/
    ``end_ts`` (epoch secs) window by photo_datetime — the People page's Focus."""
    clause = "WHERE ph.media_type = 'image' AND ph.faces_scanned_at IS NOT NULL"
    params: list = []
    if start_ts is not None:
        clause += " AND ph.photo_datetime >= ?"
        params.append(start_ts)
    if end_ts is not None:
        clause += " AND ph.photo_datetime <= ?"
        params.append(end_ts)
    if start_ts is not None or end_ts is not None:
        clause += f" AND {has_date_sql('ph')}"
    params.append(min_faces)
    return get_db().execute(
        f"""SELECT ph.id, ph.filename, ph.dir, ph.photo_datetime, ph.orientation,
                  ph.loc_city, ph.loc_sublocation, ph.loc_state, ph.loc_country,
                  COUNT(f.id)                                          AS total_faces,
                  COUNT(CASE WHEN f.person_id IS NOT NULL THEN 1 END) AS labeled_faces,
                  COUNT(CASE WHEN f.person_id IS NULL AND f.ignored=0 AND f.come_back=0 THEN 1 END) AS unlabeled_faces,
                  COUNT(CASE WHEN f.ignored=1 THEN 1 END)             AS ignored_faces,
                  COUNT(CASE WHEN f.come_back=1 THEN 1 END)           AS come_back_faces
           FROM photos ph
           JOIN faces f ON f.photo_id = ph.id
           {clause}
           GROUP BY ph.id
           HAVING total_faces >= ?
           ORDER BY {has_date_sql('ph')}, ph.photo_datetime""",
        params,
    ).fetchall()


def ignore_unlabeled_in_photos(photo_ids: list[int]) -> int:
    """Ignore all unlabeled (unassigned, not already ignored) faces in the
    given photos. Returns the count of faces newly ignored."""
    if not photo_ids:
        return 0
    with transaction() as db:
        face_ids = [
            r[0]
            for r in db.execute(
                "SELECT id FROM faces WHERE photo_id IN (SELECT value FROM json_each(?))"
                " AND person_id IS NULL AND ignored = 0 AND come_back = 0",
                (ids_json(photo_ids),),
            ).fetchall()
        ]
        if not face_ids:
            return 0
        now = time.time()
        db.executemany(
            "UPDATE faces SET ignored=1, person_id=NULL, assigned_at=NULL, ignored_at=? WHERE id=?",
            [(now, fid) for fid in face_ids],
        )
    bump_faces_generation()
    from geotagger import faces as _faces
    _faces.drop_from_unlabeled_cache(face_ids)
    return len(face_ids)


def get_unlabeled_faces() -> list[sqlite3.Row]:
    return get_db().execute(
        """SELECT f.id, f.photo_id, fe.embedding FROM faces f
           JOIN face_embeddings fe ON fe.face_id = f.id
           WHERE f.person_id IS NULL"""
    ).fetchall()


def assign_face(face_id: int, person_id: int | None):
    """Confirm (or clear, with None) the identity of a single face.

    Labeling or clearing always lifts the ignored and come_back flags, keeping
    the face states (labeled / unlabeled / ignored / come-back) mutually
    exclusive.
    """
    with transaction() as db:
        now = time.time() if person_id is not None else None
        db.execute(
            "UPDATE faces SET person_id=?, ignored=0, come_back=0, come_back_at=NULL, "
            "assigned_at=? WHERE id=?",
            (person_id, now, face_id))
        if person_id is not None:
            # A face can't be both "assigned to P" and "not P" — drop that conflict.
            db.execute("DELETE FROM face_negatives WHERE face_id=? AND person_id=?",
                       (face_id, person_id))
    bump_faces_generation()
    if person_id is not None:  # labeled face leaves the unlabeled queue
        from geotagger import faces as _faces
        _faces.drop_from_unlabeled_cache([face_id])


# ── Face negatives ──
# A per-(face, person) exclusion: "this face is definitely NOT this person".
# Orthogonal to the labeled/ignored/unlabeled face state (see faces table
# comment) — the face stays wherever it already was; the excluded person is
# just removed from that one face's candidate ranking in faces.py.

def add_face_negatives(face_ids: list[int], person_id: int):
    """Record 'these faces are NOT person_id'. Idempotent."""
    if not face_ids:
        return
    with transaction() as db:
        now = time.time()
        db.executemany(
            "INSERT OR IGNORE INTO face_negatives (face_id, person_id, created_at) "
            "VALUES (?, ?, ?)",
            [(fid, person_id, now) for fid in face_ids],
        )
    bump_faces_generation()   # invalidate gallery/score caches so the mask applies


def remove_face_negatives(face_ids: list[int], person_id: int):
    """Undo: allow person_id to be suggested for these faces again."""
    if not face_ids:
        return
    with transaction() as db:
        db.executemany(
            "DELETE FROM face_negatives WHERE face_id=? AND person_id=?",
            [(fid, person_id) for fid in face_ids],
        )
    bump_faces_generation()


def get_all_face_negatives() -> dict[int, set[int]]:
    """face_id -> {excluded person_id, ...} for the WHOLE table.

    The table is tiny (only faces the user explicitly rejected), so one read is
    cheap and lets the matcher mask by column with a dict lookup. Cached in
    faces.py keyed on faces_generation()."""
    out: dict[int, set[int]] = {}
    for r in get_db().execute("SELECT face_id, person_id FROM face_negatives"):
        out.setdefault(r["face_id"], set()).add(r["person_id"])
    return out


def get_negatives_for_face(face_id: int) -> list[int]:
    """Excluded person_ids for one face (for the per-photo endpoint / detail pane)."""
    return [r["person_id"] for r in get_db().execute(
        "SELECT person_id FROM face_negatives WHERE face_id=?", (face_id,))]


def get_person(person_id: int) -> sqlite3.Row | None:
    return get_db().execute("SELECT * FROM persons WHERE id=?", (person_id,)).fetchone()


def create_person(name: str) -> int:
    with transaction() as db:
        cursor = db.execute(
            "INSERT INTO persons (name, created_at) VALUES (?, ?)", (name, time.time())
        )
    return cursor.lastrowid


def get_or_create_person(name: str) -> int:
    # Lookup and insert in one unit, or two threads naming the same new person
    # would both miss and both insert.
    with transaction() as db:
        row = db.execute("SELECT id FROM persons WHERE name=?", (name,)).fetchone()
        if row:
            return row["id"]
        return create_person(name)


def get_persons(start_ts: int | None = None,
                end_ts: int | None = None) -> list[sqlite3.Row]:
    """All persons, with family info. No ``face_count`` ever — a live COUNT(*)
    join over the whole faces table on every call was the People page's biggest
    single latency cost at scale, and nothing currently needs the number.

    With a ``start_ts``/``end_ts`` window (epoch secs, the People page's time
    Focus), the list is filtered to just people who have at least one face in
    range.

    The filter is a single uncorrelated ``IN`` subquery over faces (materialized
    once), not a per-person correlated EXISTS — the latter re-runs per person and,
    for a person with no faces in range, only gives up after scanning that
    person's *entire* face history.
    """
    if start_ts is None and end_ts is None:
        return get_db().execute(
            """SELECT p.id, p.name, p.birth_date, p.not_before, p.not_after,
                      p.created_at, p.family_id, fam.name AS family_name
               FROM persons p
               LEFT JOIN families fam ON fam.id = p.family_id
               ORDER BY p.name"""
        ).fetchall()
    conds, params = ["f.person_id IS NOT NULL", has_date_sql("ph")], []
    if start_ts is not None:
        conds.append("ph.photo_datetime >= ?")
        params.append(start_ts)
    if end_ts is not None:
        conds.append("ph.photo_datetime <= ?")
        params.append(end_ts)
    where = " AND ".join(conds)
    join = "JOIN photos ph ON ph.id = f.photo_id"
    return get_db().execute(
        f"""SELECT p.id, p.name, p.birth_date, p.not_before, p.not_after,
                   p.created_at, p.family_id, fam.name AS family_name
            FROM persons p
            LEFT JOIN families fam ON fam.id = p.family_id
            WHERE p.id IN (SELECT f.person_id FROM faces f {join} WHERE {where})
            ORDER BY p.name""",
        params,
    ).fetchall()


def set_person_birth_date(person_id: int, birth_date: str | None) -> bool:
    """Set (or clear, with None) a person's ISO YYYY-MM-DD birth date."""
    with transaction() as db:
        found = db.execute("UPDATE persons SET birth_date=? WHERE id=?",
                           (birth_date, person_id)).rowcount > 0
    bump_faces_generation()  # gallery birth_times feed suggestion scores
    return found


def set_person_not_before(person_id: int, not_before: str | None) -> bool:
    """Set (or clear, with None) a person's ISO YYYY-MM-DD not-before date —
    photos taken before this date never match this person."""
    with transaction() as db:
        found = db.execute("UPDATE persons SET not_before=? WHERE id=?",
                           (not_before, person_id)).rowcount > 0
    bump_faces_generation()  # gallery not_before_times feed suggestion scores
    return found


def set_person_not_after(person_id: int, not_after: str | None) -> bool:
    """Set (or clear, with None) a person's ISO YYYY-MM-DD not-after date —
    photos taken after this date never match this person."""
    with transaction() as db:
        found = db.execute("UPDATE persons SET not_after=? WHERE id=?",
                           (not_after, person_id)).rowcount > 0
    bump_faces_generation()  # gallery not_after_times feed suggestion scores
    return found


def rename_person(person_id: int, name: str) -> bool:
    """Rename a person; bumps the face-recognition generation. False if no such
    person. Raises sqlite3.IntegrityError if the name is taken (UNIQUE)."""
    with transaction() as db:
        found = db.execute("UPDATE persons SET name=? WHERE id=?",
                           (name, person_id)).rowcount > 0
    bump_faces_generation()
    return found


def set_person_family(person_id: int, family_id: int | None) -> bool:
    """Assign (or clear, with None) a person's family membership. False if no
    such person."""
    with transaction() as db:
        return db.execute("UPDATE persons SET family_id=? WHERE id=?",
                          (family_id, person_id)).rowcount > 0


# ── Families ──

def get_families() -> list[sqlite3.Row]:
    """All families with a count of member persons."""
    return get_db().execute(
        """SELECT f.id, f.name, f.created_at, COUNT(p.id) AS person_count
           FROM families f LEFT JOIN persons p ON p.family_id = f.id
           GROUP BY f.id ORDER BY f.name"""
    ).fetchall()


def get_family(family_id: int) -> sqlite3.Row | None:
    return get_db().execute("SELECT * FROM families WHERE id=?", (family_id,)).fetchone()


def create_family(name: str) -> int:
    with transaction() as db:
        cursor = db.execute(
            "INSERT INTO families (name, created_at) VALUES (?, ?)", (name, time.time())
        )
    return cursor.lastrowid


def rename_family(family_id: int, name: str) -> bool:
    """False if no such family; raises sqlite3.IntegrityError if the name is taken."""
    with transaction() as db:
        return db.execute("UPDATE families SET name=? WHERE id=?",
                          (name, family_id)).rowcount > 0


def delete_family(family_id: int) -> bool:
    """Delete a family; its members stay, with no family. False if no such family."""
    with transaction() as db:
        # FKs aren't enforced (no PRAGMA foreign_keys=ON), so ON DELETE SET NULL
        # never fires — detach the members explicitly, before the parent row goes
        # and in the same transaction.
        db.execute("UPDATE persons SET family_id=NULL WHERE family_id=?", (family_id,))
        return db.execute("DELETE FROM families WHERE id=?", (family_id,)).rowcount > 0


def delete_person(person_id: int) -> bool:
    """False if no such person."""
    with transaction() as db:
        # FKs aren't enforced (no PRAGMA foreign_keys=ON), so neither the cascade
        # nor ON DELETE SET NULL fires — do both explicitly before the parent row
        # goes, in the same transaction. Faces left pointing at the dead id would
        # drop out of every queue, and persons.id has no AUTOINCREMENT, so the next
        # person created could reuse the id and inherit them.
        db.execute("DELETE FROM face_negatives WHERE person_id=?", (person_id,))
        db.execute(
            "UPDATE faces SET person_id=NULL, assigned_at=NULL, representative=0 "
            "WHERE person_id=?", (person_id,))
        found = db.execute("DELETE FROM persons WHERE id=?", (person_id,)).rowcount > 0
    bump_faces_generation()  # their faces revert to unlabeled
    return found


# ── Settings (runtime overrides of config.py tuning knobs) ──

def record_dataset_download(dataset: str, region: str | None, url: str | None,
                             size_bytes: int | None, records_loaded: int | None):
    """Log a completed reference-dataset download (see dataset_downloads table)."""
    with transaction() as db:
        db.execute(
            "INSERT INTO dataset_downloads (dataset, region, url, downloaded_at, size_bytes, records_loaded) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (dataset, region, url, time.time(), size_bytes, records_loaded),
        )


def get_dataset_downloads(dataset: str | None = None) -> list[sqlite3.Row]:
    """Download history, newest first — optionally filtered to one dataset."""
    db = get_db()
    if dataset:
        return db.execute(
            "SELECT * FROM dataset_downloads WHERE dataset = ? ORDER BY downloaded_at DESC",
            (dataset,),
        ).fetchall()
    return db.execute("SELECT * FROM dataset_downloads ORDER BY downloaded_at DESC").fetchall()


def get_all_settings() -> dict[str, str]:
    rows = get_db().execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_setting(key: str, value: str):
    with transaction() as db:
        db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, time.time()),
        )


def delete_setting(key: str):
    with transaction() as db:
        db.execute("DELETE FROM settings WHERE key=?", (key,))
