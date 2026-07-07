import sqlite3
import time
from pathlib import Path
from geotagger.config import CACHE_DIR_NAME, get_cache_dir
from geotagger.db_timing import TimedConnection

_db: sqlite3.Connection | None = None
_db_path: Path | None = None

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


def init_db(root: Path | None = None) -> sqlite3.Connection:
    """Initialize the database. If CACHE_DIR is set, use that; otherwise use root / CACHE_DIR_NAME."""
    global _db, _db_path

    cache_dir_from_env = get_cache_dir()
    if cache_dir_from_env:
        cache_dir = cache_dir_from_env
    elif root:
        cache_dir = root / CACHE_DIR_NAME
    else:
        raise RuntimeError("Must specify root directory or set GEOTAGGER_CACHE_DIR")

    cache_dir.mkdir(parents=True, exist_ok=True)
    _db_path = cache_dir / "index.db"
    _db = sqlite3.connect(str(_db_path), check_same_thread=False, factory=TimedConnection)
    _db.row_factory = sqlite3.Row
    _db.execute("PRAGMA journal_mode=WAL")
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
    if "geocoded_at" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN geocoded_at REAL")
    # Files that don't matter for geocoding (e.g. screenshots). They still show
    # in the grid, but the Show filter and geotagged/not-geotagged counts treat
    # them as if they were already geotagged.
    if "geocode_ignored" not in cols:
        _db.execute("ALTER TABLE photos ADD COLUMN geocode_ignored INTEGER NOT NULL DEFAULT 0")

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
                loc_landmark TEXT,
                loc_landmark_type TEXT,
                geocoded_at REAL,
                geocode_ignored INTEGER NOT NULL DEFAULT 0,
                UNIQUE(dir, filename)
            )
        """)
        _db.execute(f"INSERT INTO photos ({col_list}) SELECT {col_list} FROM photos_old")
        _db.execute("DROP TABLE photos_old")

    _db.execute("""
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY,
            root TEXT NOT NULL,
            scanned_at REAL NOT NULL
        )
    """)
    _db.execute("""
        CREATE TABLE IF NOT EXISTS places (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            bounds TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)

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

    _db.execute("""
        CREATE TABLE IF NOT EXISTS contexts (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            polygon TEXT NOT NULL,
            start_ts INTEGER,
            end_ts INTEGER,
            min_lat REAL, max_lat REAL,
            min_lng REAL, max_lng REAL,
            created_at REAL NOT NULL
        )
    """)
    _db.execute("""
        CREATE TABLE IF NOT EXISTS context_persons (
            context_id INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
            person_id  INTEGER NOT NULL REFERENCES persons(id)  ON DELETE CASCADE,
            PRIMARY KEY (context_id, person_id)
        )
    """)

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

    # Update trigger
    _db.execute("""
        CREATE TRIGGER IF NOT EXISTS photos_spatial_update AFTER UPDATE ON photos
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

    _db.commit()
    return _db


def get_db() -> sqlite3.Connection:
    if _db is None:
        raise RuntimeError("Database not initialized — call init_db first")
    return _db


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
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute(f"PRAGMA page_size={int(target_page_size)}")
    db.execute("VACUUM")
    if resize:
        db.execute("PRAGMA journal_mode=WAL")
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
    db = get_db()
    db.execute("""
        INSERT INTO photos
            (filename, dir, ext, media_type, mtime, size, lat, lng,
             geotag_source, sidecar_path, sidecar_mtime, camera, photo_datetime,
             gps_accuracy, orientation, checksum, scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dir, filename) DO UPDATE SET
            ext=excluded.ext,
            media_type=excluded.media_type, mtime=excluded.mtime, size=excluded.size,
            lat=excluded.lat, lng=excluded.lng, geotag_source=excluded.geotag_source,
            sidecar_path=excluded.sidecar_path, sidecar_mtime=excluded.sidecar_mtime,
            camera=excluded.camera, photo_datetime=excluded.photo_datetime,
            gps_accuracy=excluded.gps_accuracy, orientation=excluded.orientation,
            checksum=excluded.checksum,
            scanned_at=excluded.scanned_at
    """, (filename, dir_, ext, media_type, mtime, size, lat, lng,
          geotag_source, sidecar_path, sidecar_mtime, camera, photo_datetime,
          gps_accuracy, orientation, checksum, time.time()))
    db.commit()


def update_geotag(photo_id: int, lat: float | None, lng: float | None,
                  geotag_source: str, sidecar_path: str, sidecar_mtime: float | None,
                  gps_accuracy: float | None = None):
    db = get_db()
    # Coordinates changed, so any previously-derived location names are stale.
    # Clear them and reset geocoded_at so the point is re-geocoded; the caller
    # repopulates them (api_geotag does this immediately after).
    db.execute("""
        UPDATE photos SET lat=?, lng=?, gps_accuracy=?, geotag_source=?, sidecar_path=?, sidecar_mtime=?,
            loc_city=NULL, loc_state=NULL, loc_county=NULL, loc_country=NULL,
            loc_country_code=NULL, geocoded_at=NULL
        WHERE id=?
    """, (lat, lng, gps_accuracy, geotag_source, sidecar_path, sidecar_mtime, photo_id))
    db.commit()


def set_geocode_ignored(photo_ids: list[int], ignored: bool):
    """Mark (or unmark) photos as not needing geocoding, e.g. screenshots.
    Ignored photos keep showing in the grid but count as geotagged for the
    Show filter and geotagged/not-geotagged stats."""
    if not photo_ids:
        return
    db = get_db()
    db.executemany(
        "UPDATE photos SET geocode_ignored=? WHERE id=?",
        [(1 if ignored else 0, pid) for pid in photo_ids],
    )
    db.commit()


def get_photos(geotagged: str = "all", bbox: str | None = None, date_from: str | None = None,
               date_to: str | None = None, undated: bool = False) -> list[sqlite3.Row]:
    db = get_db()
    clauses = []
    params: list = []
    if geotagged == "yes":
        clauses.append("(lat IS NOT NULL OR geocode_ignored = 1)")
    elif geotagged == "no":
        clauses.append("lat IS NULL AND geocode_ignored = 0")
    if undated:
        # No timestamp to filter by — date_from/date_to don't apply.
        clauses.append("(photo_datetime IS NULL OR photo_datetime <= 0)")
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        return db.execute(f"SELECT * FROM photos {where} ORDER BY filename", params).fetchall()
    if bbox:
        # bbox=minLng,minLat,maxLng,maxLat
        try:
            from geotagger.contexts import normalize_lng_bbox
            min_lng, min_lat, max_lng, max_lat = map(float, bbox.split(","))
            min_lng, max_lng = normalize_lng_bbox(min_lng, max_lng)
            clauses.append("lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?")
            params += [min_lat, max_lat, min_lng, max_lng]
        except ValueError:
            pass
    if date_from:
        # Convert YYYY-MM-DD to Unix timestamp (start of day)
        try:
            from datetime import datetime
            dt = datetime.strptime(date_from, "%Y-%m-%d")
            ts = int(dt.timestamp())
            clauses.append("photo_datetime >= ?")
            params.append(ts)
        except ValueError:
            pass
    if date_to:
        # Convert YYYY-MM-DD to Unix timestamp (end of day)
        try:
            from datetime import datetime
            dt = datetime.strptime(date_to, "%Y-%m-%d")
            # Add 24 hours to include the entire day
            ts = int(dt.timestamp()) + 86400
            clauses.append("photo_datetime < ?")
            params.append(ts)
        except ValueError:
            pass
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return db.execute(f"SELECT * FROM photos {where} ORDER BY photo_datetime, filename", params).fetchall()


def get_photo(photo_id: int) -> sqlite3.Row | None:
    return get_db().execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()


def search_photos(date_from: str | None = None, date_to: str | None = None,
                  bbox: str | None = None, location: str | None = None,
                  person_ids: list[int] | None = None, person_mode: str = "all",
                  geotagged: str = "all", limit: int = 2000) -> list[sqlite3.Row]:
    """Flexible multi-criteria photo search: date range, location (bbox and/or a
    free-text match against the reverse-geocoded place columns), and people.

    ``person_ids``/``person_mode`` answers "find photos with these people" —
    person_mode='all' requires every listed person to have an (assigned,
    non-ignored) face in the same photo (e.g. two people together);
    person_mode='any' matches a photo containing at least one of them.
    Every criterion is optional and they combine with AND.
    """
    db = get_db()
    clauses: list[str] = []
    params: list = []

    if geotagged == "yes":
        clauses.append("(lat IS NOT NULL OR geocode_ignored = 1)")
    elif geotagged == "no":
        clauses.append("lat IS NULL AND geocode_ignored = 0")

    if date_from:
        try:
            from datetime import datetime
            ts = int(datetime.strptime(date_from, "%Y-%m-%d").timestamp())
            clauses.append("photo_datetime >= ?")
            params.append(ts)
        except ValueError:
            pass
    if date_to:
        try:
            from datetime import datetime
            # Add 24 hours to include the entire day
            ts = int(datetime.strptime(date_to, "%Y-%m-%d").timestamp()) + 86400
            clauses.append("photo_datetime < ?")
            params.append(ts)
        except ValueError:
            pass

    if bbox:
        # bbox=minLng,minLat,maxLng,maxLat
        try:
            from geotagger.contexts import normalize_lng_bbox
            min_lng, min_lat, max_lng, max_lat = map(float, bbox.split(","))
            min_lng, max_lng = normalize_lng_bbox(min_lng, max_lng)
            clauses.append("lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?")
            params += [min_lat, max_lat, min_lng, max_lng]
        except ValueError:
            pass

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

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = f"SELECT * FROM photos {where} ORDER BY photo_datetime, filename LIMIT ?"
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
    db = get_db()
    db.executemany("UPDATE photos SET checksum=? WHERE id=?", rows)
    db.commit()


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
    db = get_db()
    db.executemany("UPDATE photos SET orientation=? WHERE id=?", rows)
    db.commit()


def get_photos_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> list[sqlite3.Row]:
    """Get photos within a bounding box using the spatial index."""
    db = get_db()
    # R*Tree requires queries in the form: max_X >= min_query AND min_X <= max_query
    # This finds all items whose bounding box overlaps with the query bounding box
    # Since we store points (min_lat = max_lat), this becomes: lat >= min_lat AND lat <= max_lat
    return db.execute("""
        SELECT photos.* FROM photos
        INNER JOIN photos_spatial ON photos.id = photos_spatial.id
        WHERE photos_spatial.max_lat >= ?
          AND photos_spatial.min_lat <= ?
          AND photos_spatial.max_lng >= ?
          AND photos_spatial.min_lng <= ?
        ORDER BY photo_datetime, filename
    """, (min_lat, max_lat, min_lng, max_lng)).fetchall()


def get_photos_by_time_range(min_time: int, max_time: int, has_geotag: bool | None = None) -> list[sqlite3.Row]:
    """Get photos within a time range, optionally filtered by geotag presence."""
    db = get_db()
    clauses = ["photo_datetime BETWEEN ? AND ?"]
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


def record_scan_root(root: str):
    db = get_db()
    db.execute("DELETE FROM scans")
    db.execute("INSERT INTO scans (root, scanned_at) VALUES (?, ?)", (root, time.time()))
    db.commit()


def get_last_scan_roots() -> list[str]:
    """Return the last scanned roots. Works with both old and new cache directory setups."""
    # If using global cache directory, check there
    cache_dir = get_cache_dir()
    if cache_dir:
        sentinel = cache_dir / ".last_scan_roots"
        if sentinel.exists():
            return [line.strip() for line in sentinel.read_text().splitlines() if line.strip()]
        return []

    # Legacy support: check project-level sentinel
    sentinel = Path(__file__).parent.parent.parent / ".geotagger_last_root"
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
        sentinel = Path(__file__).parent.parent.parent / ".geotagger_last_root"
        if roots:
            sentinel.write_text(roots[0])


def save_last_scan_root(root: str):
    """Save a single scan root, for backward compatibility."""
    save_last_scan_roots([root])


def is_fresh(dir_: str, filename: str, mtime: float, sidecar_path: str | None, sidecar_mtime: float | None) -> bool:
    """Return True if the indexed row is up-to-date (no re-scan needed)."""
    row = get_db().execute(
        "SELECT mtime, sidecar_path, sidecar_mtime, camera, photo_datetime, gps_accuracy, orientation "
        "FROM photos WHERE dir=? AND filename=?", (dir_, filename)
    ).fetchone()
    if not row:
        return False
    if abs(row["mtime"] - mtime) > 1:
        return False
    if sidecar_path != row["sidecar_path"]:
        return False
    if sidecar_mtime is not None and row["sidecar_mtime"] is not None:
        if abs(row["sidecar_mtime"] - sidecar_mtime) > 1:
            return False
    # Re-index if metadata was never fully read (NULL = not yet indexed).
    # orientation is included so existing libraries backfill it on the next scan.
    if (row["camera"] is None or row["photo_datetime"] is None
            or row["gps_accuracy"] is None or row["orientation"] is None):
        return False
    return True


# ── Places ──

def get_places() -> list[sqlite3.Row]:
    """Return all saved places."""
    return get_db().execute("SELECT * FROM places ORDER BY name").fetchall()


def create_place(name: str, place_type: str, bounds: str) -> int:
    """Create a new place and return its ID."""
    db = get_db()
    cursor = db.execute(
        "INSERT INTO places (name, type, bounds, created_at) VALUES (?, ?, ?, ?)",
        (name, place_type, bounds, time.time())
    )
    db.commit()
    return cursor.lastrowid


def delete_place(place_id: int):
    """Delete a place by ID."""
    db = get_db()
    db.execute("DELETE FROM places WHERE id=?", (place_id,))
    db.commit()


def update_place(place_id: int, bounds: str):
    """Update a place's bounds."""
    db = get_db()
    db.execute("UPDATE places SET bounds=? WHERE id=?", (bounds, place_id))
    db.commit()


# ── Contexts ──

def get_contexts() -> list[dict]:
    """All contexts, each with a bbox-approximate photo count (no exact polygon
    test — see get_context_photo_ids for that).

    Computed as one targeted, indexed query per context rather than a single SQL
    statement with a correlated subquery: the ``c.start_ts IS NULL OR
    p.photo_datetime >= c.start_ts``-style conditions reference the outer row, so
    SQLite can't use idx_photos_datetime or the photos_spatial R*Tree — every
    context forced a full table scan of photos. Per-context, the filters are
    concrete params instead, so each query can actually use those indexes."""
    db = get_db()
    contexts = db.execute("SELECT * FROM contexts ORDER BY name").fetchall()
    out = []
    for c in contexts:
        conds, params = [], []
        if c["start_ts"] is not None:
            conds.append("p.photo_datetime >= ?")
            params.append(c["start_ts"])
        if c["end_ts"] is not None:
            conds.append("p.photo_datetime <= ?")
            params.append(c["end_ts"])
        if c["min_lat"] is not None:
            # R*Tree bbox prefilter (indexed), same pattern as get_context_photo_ids.
            sql = f"""SELECT COUNT(*) FROM photos_spatial s
                      JOIN photos p ON p.id = s.id
                      WHERE s.max_lat >= ? AND s.min_lat <= ?
                        AND s.max_lng >= ? AND s.min_lng <= ?
                        {"AND " + " AND ".join(conds) if conds else ""}"""
            bbox_params = [c["min_lat"], c["max_lat"], c["min_lng"], c["max_lng"], *params]
        else:
            where = " AND ".join(conds) if conds else "1=1"
            sql = f"SELECT COUNT(*) FROM photos p WHERE {where}"
            bbox_params = params
        count = db.execute(sql, bbox_params).fetchone()[0]
        out.append({**dict(c), "photo_count_approx": count})
    return out


def get_context(context_id: int) -> sqlite3.Row | None:
    return get_db().execute("SELECT * FROM contexts WHERE id=?", (context_id,)).fetchone()


def get_context_photo_ids(context_id: int) -> list[int] | None:
    """Photo IDs whose GPS falls inside a context's polygon — the spatial half of
    the People page's Focus ("also limit to this area").

    Uses the context's cached polygon bbox as an R*Tree prefilter (photos_spatial),
    then the exact ray-casting point_in_polygon test, matching the app's spatial
    pattern elsewhere. Returns None when the context is missing or has no polygon
    (→ caller applies no spatial constraint); an empty list means the area holds no
    geotagged photos (→ the windowed views come back empty, which is correct)."""
    import json as _json
    from geotagger.contexts import point_in_polygon
    c = get_context(context_id)
    if not c or c["polygon"] is None or c["min_lat"] is None:
        return None
    polygon = _json.loads(c["polygon"])
    rows = get_db().execute(
        """SELECT ph.id, ph.lat, ph.lng
           FROM photos_spatial s JOIN photos ph ON ph.id = s.id
           WHERE s.max_lat >= ? AND s.min_lat <= ?
             AND s.max_lng >= ? AND s.min_lng <= ?""",
        (c["min_lat"], c["max_lat"], c["min_lng"], c["max_lng"]),
    ).fetchall()
    return [r["id"] for r in rows if point_in_polygon(r["lat"], r["lng"], polygon)]


def create_context(name: str, polygon_json: str, start_ts: int | None, end_ts: int | None,
                   min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> int:
    db = get_db()
    cursor = db.execute(
        """INSERT INTO contexts (name, polygon, start_ts, end_ts, min_lat, max_lat, min_lng, max_lng, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (name, polygon_json, start_ts, end_ts, min_lat, max_lat, min_lng, max_lng, time.time())
    )
    db.commit()
    return cursor.lastrowid


def update_context(context_id: int, **fields):
    if not fields:
        return
    db = get_db()
    set_clause = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE contexts SET {set_clause} WHERE id=?", (*fields.values(), context_id))
    db.commit()


def delete_context(context_id: int):
    db = get_db()
    db.execute("DELETE FROM context_persons WHERE context_id=?", (context_id,))
    db.execute("DELETE FROM contexts WHERE id=?", (context_id,))
    db.commit()


def get_context_persons(context_id: int) -> list[sqlite3.Row]:
    return get_db().execute(
        """SELECT p.id, p.name FROM persons p
           JOIN context_persons cp ON cp.person_id = p.id
           WHERE cp.context_id = ?
           ORDER BY p.name""",
        (context_id,)
    ).fetchall()


def set_context_persons(context_id: int, person_ids: list[int]):
    db = get_db()
    db.execute("DELETE FROM context_persons WHERE context_id=?", (context_id,))
    if person_ids:
        db.executemany(
            "INSERT INTO context_persons (context_id, person_id) VALUES (?, ?)",
            [(context_id, pid) for pid in person_ids]
        )
    db.commit()


def contexts_for_time(ts: int) -> list[sqlite3.Row]:
    return get_db().execute(
        "SELECT * FROM contexts "
        "WHERE (start_ts IS NULL OR start_ts <= ?) "
        "  AND (end_ts   IS NULL OR end_ts   >= ?)",
        (ts, ts),
    ).fetchall()


def contexts_for_point_time(lat: float, lng: float, ts: int) -> list[sqlite3.Row]:
    import json as _json
    from geotagger.contexts import point_in_polygon
    rows = contexts_for_time(ts)
    out = []
    for r in rows:
        if r["min_lat"] is not None and not (
            r["min_lat"] <= lat <= r["max_lat"] and r["min_lng"] <= lng <= r["max_lng"]
        ):
            continue
        if point_in_polygon(lat, lng, _json.loads(r["polygon"])):
            out.append(r)
    return out


# ── Reverse geocoding ──

def get_cached_geocode(qlat: int, qlng: int) -> dict | None:
    """Return a cached location for quantized coords, or None on a miss."""
    row = get_db().execute(
        "SELECT city, sublocation, state, county, country, country_code FROM geocode_cache "
        "WHERE qlat=? AND qlng=?",
        (qlat, qlng),
    ).fetchone()
    if row is None:
        return None
    return {"city": row["city"], "sublocation": row["sublocation"],
            "state": row["state"], "county": row["county"],
            "country": row["country"], "country_code": row["country_code"]}


def put_cached_geocode(qlat: int, qlng: int, loc: dict, source: str = "local"):
    """Cache a location result for quantized coords."""
    db = get_db()
    db.execute(
        """INSERT OR REPLACE INTO geocode_cache
               (qlat, qlng, city, sublocation, state, county, country, country_code, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (qlat, qlng, loc.get("city"), loc.get("sublocation"), loc.get("state"),
         loc.get("county"), loc.get("country"), loc.get("country_code"), source, time.time()),
    )
    db.commit()


def update_photo_location(photo_id: int, loc: dict | None):
    """Store reverse-geocoded place names on a photo. geocoded_at is always set
    (so a no-match isn't retried endlessly); loc=None records 'looked up, no match'."""
    db = get_db()
    if loc is None:
        db.execute(
            "UPDATE photos SET loc_city=NULL, loc_sublocation=NULL, loc_state=NULL, "
            "loc_county=NULL, loc_country=NULL, loc_country_code=NULL, geocoded_at=? WHERE id=?",
            (time.time(), photo_id),
        )
    else:
        db.execute(
            "UPDATE photos SET loc_city=?, loc_sublocation=?, loc_state=?, loc_county=?, "
            "loc_country=?, loc_country_code=?, geocoded_at=? WHERE id=?",
            (loc.get("city"), loc.get("sublocation"), loc.get("state"), loc.get("county"),
             loc.get("country"), loc.get("country_code"), time.time(), photo_id),
        )
    db.commit()


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
    db = get_db()
    # Capture old face IDs so we can prune them from the in-memory cache below.
    old_ids = [r[0] for r in db.execute(
        "SELECT id FROM faces WHERE photo_id=? AND source='detected'", (photo_id,)
    ).fetchall()]
    if old_ids:
        # Rescan mints new face ids, so negatives keyed on the old ones would
        # otherwise dangle (FKs aren't enforced — no cascade). Known, accepted
        # limitation: a rescan drops negatives, same as it already drops
        # assignments (see docstring above).
        placeholders = ','.join('?' * len(old_ids))
        db.execute(f"DELETE FROM face_negatives WHERE face_id IN ({placeholders})", old_ids)
        db.execute(f"DELETE FROM face_embeddings WHERE face_id IN ({placeholders})", old_ids)
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
    db.commit()
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
    db = get_db()
    placeholders = ",".join("?" * len(photo_ids))
    old_ids = [r[0] for r in db.execute(
        f"SELECT id FROM faces WHERE photo_id IN ({placeholders})", photo_ids
    ).fetchall()]
    if old_ids:
        # FKs aren't enforced (no cascade) — drop negatives and embeddings
        # explicitly, same as replace_faces does for a routine rescan.
        fplaceholders = ",".join("?" * len(old_ids))
        db.execute(f"DELETE FROM face_negatives WHERE face_id IN ({fplaceholders})", old_ids)
        db.execute(f"DELETE FROM face_embeddings WHERE face_id IN ({fplaceholders})", old_ids)
        db.execute(f"DELETE FROM faces WHERE id IN ({fplaceholders})", old_ids)
    db.executemany(
        "UPDATE photos SET faces_scanned_at=NULL, faces_det_dimension=NULL WHERE id=?",
        [(pid,) for pid in photo_ids],
    )
    db.commit()
    bump_faces_generation()
    if old_ids:
        from geotagger import faces as _faces
        _faces.drop_from_unlabeled_cache(old_ids)
    return len(old_ids)


def get_faces_for_photo(photo_id: int) -> list[sqlite3.Row]:
    return get_db().execute(
        """SELECT f.id, f.photo_id, f.person_id, f.bbox, f.det_score, f.source,
                  fe.embedding, f.assigned_at, f.ignored, f.come_back, p.name AS person_name,
                  ph.orientation
           FROM faces f
           JOIN face_embeddings fe ON fe.face_id = f.id
           LEFT JOIN persons p ON p.id = f.person_id
           JOIN photos ph ON ph.id = f.photo_id
           WHERE f.photo_id=? ORDER BY f.det_score DESC""",
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
        """SELECT f.person_id, fe.embedding, f.bbox, ph.photo_datetime, p.birth_date
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
    db = get_db()
    db.execute("UPDATE faces SET representative=0 WHERE person_id=?", (person_id,))
    if representative_ids:
        placeholders = ",".join("?" * len(representative_ids))
        db.execute(
            f"UPDATE faces SET representative=1 WHERE id IN ({placeholders})",
            representative_ids,
        )
    db.commit()


def _photo_ids_in_window(start_ts: int | None, end_ts: int | None) -> list[int]:
    """Photo ids with photo_datetime in [start_ts, end_ts] (either bound optional),
    via idx_photos_datetime. Used to pre-resolve a time Focus to a small photo_id
    set — see list_faces for why."""
    conds, params = [], []
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
               start_ts: int | None = None, end_ts: int | None = None,
               photo_ids: list[int] | None = None) -> list[sqlite3.Row]:
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
    idx_photos_datetime) rather than joined as ``ph.photo_datetime BETWEEN``,
    same as the ``photo_ids`` spatial Focus below — measured on a 78K-row
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
    if start_ts is not None or end_ts is not None:
        window_ids = _photo_ids_in_window(start_ts, end_ts)
        photo_ids = window_ids if photo_ids is None else list(set(window_ids) & set(photo_ids))
    if photo_ids is not None:
        # Time and/or spatial Focus, pre-resolved to a photo_id set (see above /
        # docstring). json_each keeps this to one bound param regardless of how
        # many ids (SQLite has a ~999-variable cap on a literal IN list).
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
                start_ts: int | None = None, end_ts: int | None = None,
                photo_ids: list[int] | None = None) -> int:
    if scope == "unlabeled":
        # The People page's Focus windows only the unlabeled count; a window (time
        # and/or a context's polygon) needs the photos join, so keep the plain
        # (unwindowed) path join-free.
        if start_ts is None and end_ts is None and photo_ids is None:
            return get_db().execute(
                "SELECT COUNT(*) FROM faces WHERE person_id IS NULL AND ignored = 0 AND come_back = 0"
            ).fetchone()[0]
        # Resolve the time window to a photo_id set up front (idx_photos_datetime)
        # instead of joining photos — same reasoning as list_faces: it lets this
        # stay a plain faces-table query (photo_id is already indexed there), no
        # per-candidate-face lookup into photos needed.
        if start_ts is not None or end_ts is not None:
            window_ids = _photo_ids_in_window(start_ts, end_ts)
            photo_ids = window_ids if photo_ids is None else list(set(window_ids) & set(photo_ids))
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
    db = get_db()
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
    db.commit()
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
    db = get_db()
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
    db.commit()
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
    db = get_db()
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
    db.commit()
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
                     end_ts: int | None = None,
                     photo_ids: list[int] | None = None) -> list[sqlite3.Row]:
    """Return photos with at least `min_faces` detected faces, ordered by
    photo_datetime. Each row includes per-state face counts. ``start_ts``/
    ``end_ts`` (epoch secs) window by photo_datetime and ``photo_ids`` restricts to
    a context's polygon — both for the People page's Focus."""
    clause = "WHERE ph.media_type = 'image' AND ph.faces_scanned_at IS NOT NULL"
    params: list = []
    if start_ts is not None:
        clause += " AND ph.photo_datetime >= ?"
        params.append(start_ts)
    if end_ts is not None:
        clause += " AND ph.photo_datetime <= ?"
        params.append(end_ts)
    if photo_ids is not None:
        import json as _json
        clause += " AND ph.id IN (SELECT value FROM json_each(?))"
        params.append(_json.dumps(photo_ids))
    params.append(min_faces)
    return get_db().execute(
        f"""SELECT ph.id, ph.filename, ph.photo_datetime, ph.orientation,
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
           ORDER BY ph.photo_datetime""",
        params,
    ).fetchall()


def ignore_unlabeled_in_photos(photo_ids: list[int]) -> int:
    """Ignore all unlabeled (unassigned, not already ignored) faces in the
    given photos. Returns the count of faces newly ignored."""
    if not photo_ids:
        return 0
    db = get_db()
    face_ids = [
        r[0]
        for r in db.execute(
            f"SELECT id FROM faces WHERE photo_id IN ({','.join('?' * len(photo_ids))})"
            " AND person_id IS NULL AND ignored = 0 AND come_back = 0",
            photo_ids,
        ).fetchall()
    ]
    if not face_ids:
        return 0
    now = time.time()
    db.executemany(
        "UPDATE faces SET ignored=1, person_id=NULL, assigned_at=NULL, ignored_at=? WHERE id=?",
        [(now, fid) for fid in face_ids],
    )
    db.commit()
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
    db = get_db()
    now = time.time() if person_id is not None else None
    db.execute(
        "UPDATE faces SET person_id=?, ignored=0, come_back=0, come_back_at=NULL, "
        "assigned_at=? WHERE id=?",
        (person_id, now, face_id))
    if person_id is not None:
        # A face can't be both "assigned to P" and "not P" — drop that conflict.
        db.execute("DELETE FROM face_negatives WHERE face_id=? AND person_id=?",
                   (face_id, person_id))
    db.commit()
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
    db = get_db()
    now = time.time()
    db.executemany(
        "INSERT OR IGNORE INTO face_negatives (face_id, person_id, created_at) "
        "VALUES (?, ?, ?)",
        [(fid, person_id, now) for fid in face_ids],
    )
    db.commit()
    bump_faces_generation()   # invalidate gallery/score caches so the mask applies


def remove_face_negatives(face_ids: list[int], person_id: int):
    """Undo: allow person_id to be suggested for these faces again."""
    if not face_ids:
        return
    db = get_db()
    db.executemany(
        "DELETE FROM face_negatives WHERE face_id=? AND person_id=?",
        [(fid, person_id) for fid in face_ids],
    )
    db.commit()
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
    db = get_db()
    cursor = db.execute(
        "INSERT INTO persons (name, created_at) VALUES (?, ?)", (name, time.time())
    )
    db.commit()
    return cursor.lastrowid


def get_or_create_person(name: str) -> int:
    db = get_db()
    row = db.execute("SELECT id FROM persons WHERE name=?", (name,)).fetchone()
    if row:
        return row["id"]
    return create_person(name)


def get_persons(start_ts: int | None = None, end_ts: int | None = None,
                photo_ids: list[int] | None = None) -> list[sqlite3.Row]:
    """All persons, with family info. No ``face_count`` ever — a live COUNT(*)
    join over the whole faces table on every call was the People page's biggest
    single latency cost at scale, and nothing currently needs the number.

    With a ``start_ts``/``end_ts`` window (epoch secs, the People page's time
    Focus) and/or ``photo_ids`` (its "also limit to this area" spatial Focus —
    photos inside a context's polygon), the list is filtered to just people who
    have at least one face in range.

    The filter is a single uncorrelated ``IN`` subquery over faces (materialized
    once), not a per-person correlated EXISTS — the latter re-runs per person and,
    for a person with no faces in range, only gives up after scanning that
    person's *entire* face history. The photos join is skipped entirely when only
    photo_ids is given (no time bound), since faces.photo_id alone is enough.
    """
    if start_ts is None and end_ts is None and photo_ids is None:
        return get_db().execute(
            """SELECT p.id, p.name, p.birth_date, p.created_at, p.family_id,
                      fam.name AS family_name
               FROM persons p
               LEFT JOIN families fam ON fam.id = p.family_id
               ORDER BY p.name"""
        ).fetchall()
    conds, params = ["f.person_id IS NOT NULL"], []
    needs_photos = start_ts is not None or end_ts is not None
    if start_ts is not None:
        conds.append("ph.photo_datetime >= ?")
        params.append(start_ts)
    if end_ts is not None:
        conds.append("ph.photo_datetime <= ?")
        params.append(end_ts)
    if photo_ids is not None:
        import json as _json
        photo_col = "ph.id" if needs_photos else "f.photo_id"
        conds.append(f"{photo_col} IN (SELECT value FROM json_each(?))")
        params.append(_json.dumps(photo_ids))
    where = " AND ".join(conds)
    join = "JOIN photos ph ON ph.id = f.photo_id" if needs_photos else ""
    return get_db().execute(
        f"""SELECT p.id, p.name, p.birth_date, p.created_at, p.family_id,
                   fam.name AS family_name
            FROM persons p
            LEFT JOIN families fam ON fam.id = p.family_id
            WHERE p.id IN (SELECT f.person_id FROM faces f {join} WHERE {where})
            ORDER BY p.name""",
        params,
    ).fetchall()


def set_person_birth_date(person_id: int, birth_date: str | None):
    """Set (or clear, with None) a person's ISO YYYY-MM-DD birth date."""
    db = get_db()
    db.execute("UPDATE persons SET birth_date=? WHERE id=?", (birth_date, person_id))
    db.commit()
    bump_faces_generation()  # gallery birth_times feed suggestion scores


def rename_person(person_id: int, name: str):
    """Rename a person; bumps the face-recognition generation."""
    db = get_db()
    db.execute("UPDATE persons SET name=? WHERE id=?", (name, person_id))
    db.commit()
    bump_faces_generation()


def set_person_family(person_id: int, family_id: int | None):
    """Assign (or clear, with None) a person's family membership."""
    db = get_db()
    db.execute("UPDATE persons SET family_id=? WHERE id=?", (family_id, person_id))
    db.commit()


# ── Families ──

def get_families() -> list[sqlite3.Row]:
    """All families with a count of member persons."""
    return get_db().execute(
        """SELECT f.id, f.name, f.created_at, COUNT(p.id) AS person_count
           FROM families f LEFT JOIN persons p ON p.family_id = f.id
           GROUP BY f.id ORDER BY f.name"""
    ).fetchall()


def create_family(name: str) -> int:
    db = get_db()
    cursor = db.execute(
        "INSERT INTO families (name, created_at) VALUES (?, ?)", (name, time.time())
    )
    db.commit()
    return cursor.lastrowid


def rename_family(family_id: int, name: str):
    db = get_db()
    db.execute("UPDATE families SET name=? WHERE id=?", (name, family_id))
    db.commit()


def delete_family(family_id: int):
    """Delete a family; member persons have their family_id NULLed by FK."""
    db = get_db()
    db.execute("DELETE FROM families WHERE id=?", (family_id,))
    db.commit()


def delete_person(person_id: int):
    db = get_db()
    # FKs aren't enforced (no PRAGMA foreign_keys=ON), so cascade won't fire —
    # clean up their negative exclusions explicitly before the parent row goes.
    db.execute("DELETE FROM face_negatives WHERE person_id=?", (person_id,))
    db.execute("DELETE FROM persons WHERE id=?", (person_id,))
    db.commit()
    bump_faces_generation()  # their faces revert to unlabeled


# ── Settings (runtime overrides of config.py tuning knobs) ──

def get_all_settings() -> dict[str, str]:
    rows = get_db().execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_setting(key: str, value: str):
    db = get_db()
    db.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, value, time.time()),
    )
    db.commit()


def delete_setting(key: str):
    db = get_db()
    db.execute("DELETE FROM settings WHERE key=?", (key,))
    db.commit()
