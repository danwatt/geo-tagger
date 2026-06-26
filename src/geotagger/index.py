import sqlite3
import time
from pathlib import Path
from geotagger.config import CACHE_DIR_NAME, get_cache_dir

_db: sqlite3.Connection | None = None
_db_path: Path | None = None


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
    _db = sqlite3.connect(str(_db_path), check_same_thread=False)
    _db.row_factory = sqlite3.Row
    _db.execute("PRAGMA journal_mode=WAL")
    _db.execute("""
        CREATE TABLE IF NOT EXISTS photos (
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
            scanned_at REAL NOT NULL
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

    # Populate spatial index for existing photos (migration)
    _db.execute("""
        INSERT OR IGNORE INTO photos_spatial (id, min_lat, max_lat, min_lng, max_lng)
        SELECT id, lat, lat, lng, lng FROM photos WHERE lat IS NOT NULL AND lng IS NOT NULL
    """)

    # Create index on photo_datetime for fast time-based queries
    _db.execute("CREATE INDEX IF NOT EXISTS idx_photos_datetime ON photos(photo_datetime)")

    _db.commit()
    return _db


def get_db() -> sqlite3.Connection:
    if _db is None:
        raise RuntimeError("Database not initialized — call init_db first")
    return _db


def upsert_photo(
    path: str, filename: str, dir_: str, ext: str, media_type: str,
    mtime: float, size: int, lat, lng, geotag_source: str,
    sidecar_path: str | None, sidecar_mtime: float | None,
    camera: str | None = None, photo_datetime: int | None = None,
    gps_accuracy: float | None = None,
):
    db = get_db()
    db.execute("""
        INSERT INTO photos
            (path, filename, dir, ext, media_type, mtime, size, lat, lng,
             geotag_source, sidecar_path, sidecar_mtime, camera, photo_datetime,
             gps_accuracy, scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            filename=excluded.filename, dir=excluded.dir, ext=excluded.ext,
            media_type=excluded.media_type, mtime=excluded.mtime, size=excluded.size,
            lat=excluded.lat, lng=excluded.lng, geotag_source=excluded.geotag_source,
            sidecar_path=excluded.sidecar_path, sidecar_mtime=excluded.sidecar_mtime,
            camera=excluded.camera, photo_datetime=excluded.photo_datetime,
            gps_accuracy=excluded.gps_accuracy, scanned_at=excluded.scanned_at
    """, (path, filename, dir_, ext, media_type, mtime, size, lat, lng,
          geotag_source, sidecar_path, sidecar_mtime, camera, photo_datetime,
          gps_accuracy, time.time()))
    db.commit()


def update_geotag(photo_id: int, lat: float | None, lng: float | None,
                  geotag_source: str, sidecar_path: str, sidecar_mtime: float | None):
    db = get_db()
    db.execute("""
        UPDATE photos SET lat=?, lng=?, geotag_source=?, sidecar_path=?, sidecar_mtime=?
        WHERE id=?
    """, (lat, lng, geotag_source, sidecar_path, sidecar_mtime, photo_id))
    db.commit()


def get_photos(geotagged: str = "all", bbox: str | None = None, date_from: str | None = None, date_to: str | None = None) -> list[sqlite3.Row]:
    db = get_db()
    clauses = []
    params: list = []
    if geotagged == "yes":
        clauses.append("lat IS NOT NULL")
    elif geotagged == "no":
        clauses.append("lat IS NULL")
    if bbox:
        # bbox=minLng,minLat,maxLng,maxLat
        try:
            min_lng, min_lat, max_lng, max_lat = map(float, bbox.split(","))
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
        clauses.append("lat IS NOT NULL")
    elif has_geotag is False:
        clauses.append("lat IS NULL")

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


def is_fresh(path: str, mtime: float, sidecar_path: str | None, sidecar_mtime: float | None) -> bool:
    """Return True if the indexed row is up-to-date (no re-scan needed)."""
    row = get_db().execute(
        "SELECT mtime, sidecar_path, sidecar_mtime, camera, photo_datetime, gps_accuracy FROM photos WHERE path=?", (path,)
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
    # Re-index if metadata was never fully read (NULL = not yet indexed)
    if row["camera"] is None or row["photo_datetime"] is None or row["gps_accuracy"] is None:
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
