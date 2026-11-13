import calendar
import logging
import re
from datetime import datetime
from pathlib import Path
from geotagger.config import IMAGE_EXTENSIONS, SIDECAR_MODE, VIDEO_EXTENSIONS
from geotagger.exiftool_session import get_et, get_et_lock
# Re-exported: the conversions live in the dependency-free timeutil so modules
# that must not pull in ExifTool (serializers, services) can share them.
from geotagger.timeutil import epoch_to_wallclock, wallclock_to_epoch  # noqa: F401

logger = logging.getLogger(__name__)


# ExifTool's 'YYYY:MM:DD HH:MM:SS', optionally followed by sub-seconds ('.123')
# and/or a UTC offset ('Z', '+05:30', '-0800'). XMP dates and newer cameras'
# EXIF carry both suffixes; strptime on the bare format rejected them, which
# left the row's date NULL and so permanently stale (audit S1).
_EXIF_DT_RE = re.compile(
    r"(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})"
    r"(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?"
)


def _parse_exif_datetime(s: str, utc: bool = False) -> int | None:
    """Parse '2024:10:02 14:23:45' → photo_datetime epoch, or None if unparseable.

    The offset suffix is matched but deliberately ignored: photo_datetime is the
    camera's wall clock (stored as if UTC, see timeutil), so the wall-clock part
    is kept as written rather than converted to UTC. All-zero placeholders
    ('0000:00:00 00:00:00', common in QuickTime CreateDate) and other impossible
    values fail datetime() and return None, so read_metadata moves on to the
    next candidate tag.

    ``utc=True`` is for tags that hold UTC by spec (QuickTime:CreateDate, audit
    S6): a bare value is converted to wall clock with _utc_to_wallclock. One
    that carries an offset (ExifTool run with -api QuickTimeUTC prints the local
    time plus offset) is already a wall clock and is kept as written."""
    if not s:
        return None
    m = _EXIF_DT_RE.fullmatch(s.strip())
    if not m:
        return None
    try:
        ts = wallclock_to_epoch(datetime(*(int(g) for g in m.groups()[:6])))
    except ValueError:  # year 0, month 13, Feb 30, …
        return None
    if utc and m.group(7) is None:
        return _utc_to_wallclock(ts)
    return ts


def _local_utc_offset(utc_ts: int) -> int:
    """This machine's UTC offset, in seconds, at the UTC instant ``utc_ts`` —
    DST-aware, from the OS's zone rules (what ExifTool's QuickTimeUTC option
    does too). The tz source for _utc_to_wallclock; tests monkeypatch it, since
    Windows has no time.tzset to switch the process's zone.

    time.localtime, not zoneinfo: Windows has no IANA database unless the tzdata
    package is installed, and no stdlib way to name the local zone anyway.
    localtime raises OSError for negative values on Windows (see timeutil), so a
    pre-1970 instant — which only a hand-set CreateDate can hold; real QuickTime
    files are all post-1970 — falls back to the zone's standard offset."""
    import time
    try:
        return time.localtime(utc_ts).tm_gmtoff
    except (OSError, OverflowError, ValueError):
        return -time.timezone


def _utc_to_wallclock(utc_ts: int) -> int:
    """A UTC epoch → photo_datetime (wall clock stored as if UTC).

    The capture timezone of a UTC-only video is unknown. The machine's local
    zone at that instant is the best guess on offer: it is what ExifTool and
    most desktop viewers show for such files, and it is right for a library
    shot mostly at home — the common case. A neighbouring photo's offset would
    be better when travelling, but nothing in the library records photos'
    offsets (photo_datetime drops them), so there is nothing to borrow from.

    Known limit: some non-phone cameras (certain GoPro/Sony/Canon models) write
    local time into CreateDate against the spec. Neither we nor ExifTool can
    tell such a file apart, so those land shifted by the local offset — the
    sidecar date (Time Sync) is the fix for them."""
    return utc_ts + _local_utc_offset(utc_ts)


def _pick_datetime(candidates: list, utc_candidates: list = ()) -> int:
    """First candidate (in priority order) that parses, else 0. ``candidates``
    are wall-clock tags; ``utc_candidates`` hold UTC (see _parse_exif_datetime's
    ``utc``) and are tried only after every wall-clock one, since a converted
    UTC time is a guess at the offset while a wall-clock tag is the real thing.

    Each one is parsed in turn rather than taking the first truthy value: a
    present-but-garbage tag (a zeroed QuickTime CreateDate, say) must not hide
    a good one further down. 0 — not None — when nothing parses: it means "read,
    undated" (timeutil.has_date), whereas NULL means "never read" to
    index._row_is_fresh, which would re-read and re-hash the file every scan."""
    for utc, raws in ((False, candidates), (True, utc_candidates)):
        for raw in raws:
            if raw is None:
                continue
            ts = _parse_exif_datetime(str(raw), utc=utc)
            if ts is not None:
                return ts
    return 0


def _coerce_orientation(raw) -> int:
    """Normalize a raw EXIF orientation value to 1..8, defaulting to 1 (as-stored)
    when it's absent or unparseable. 1 is the common landscape/no-rotation case."""
    try:
        orientation = int(raw) if raw is not None else 1
    except (TypeError, ValueError):
        return 1
    return orientation if orientation in range(1, 9) else 1


def read_orientations(paths: list) -> dict[Path, int]:
    """Batch-read EXIF orientation (1..8) for many files in one ExifTool call,
    keyed by Path. Used by the one-time orientation backfill; a file that returns
    no result (missing tag or unreadable) defaults to 1, matching read_metadata.

    Keys are Path objects, not strings, so callers match reliably despite ExifTool
    echoing forward-slash SourceFile paths on Windows (Path normalizes separators
    and case)."""
    if not paths:
        return {}
    et = get_et()
    with get_et_lock():
        result = et.get_tags([str(p) for p in paths], tags=["EXIF:Orientation#"])
    by_path = {Path(r["SourceFile"]): _coerce_orientation(r.get("EXIF:Orientation"))
               for r in result}
    # Fill in anything ExifTool didn't return (e.g. it skipped an unreadable file).
    return {Path(p): by_path.get(Path(p), 1) for p in paths}


def _has_image_sibling(video_path: Path) -> bool:
    """Whether an image with the same stem sits next to this video — an iPhone
    Live Photo pair (IMG_1.HEIC + IMG_1.MOV) being the common case. A stat per
    image extension, in its listed and upper-case spelling (a case-sensitive
    filesystem would miss 'IMG_1.HEIC' otherwise; on a case-insensitive one the
    second stat is just a repeat hit or miss). Only ever asked for videos."""
    import os
    parent, stem = video_path.parent, video_path.stem
    for ext in IMAGE_EXTENSIONS:
        for spelling in {ext, ext.upper()}:
            if os.path.isfile(parent / (stem + spelling)):
                return True
    return False


def sidecar_path(image_path: Path) -> Path:
    """The sidecar this file reads and writes.

    basename mode: IMG_1.NEF → IMG_1.xmp, except for a video that shares its stem
    with an image in the same folder (a Live Photo pair, audit S5). There the
    basename sidecar belongs to the image (it is the convention's subject — what
    Lightroom/digiKam associate IMG_1.xmp with) and the video takes the
    fullname-style IMG_1.MOV.xmp, so geotagging one never silently applies to
    the other. A lone video keeps IMG_1.xmp, as before. Image+image collisions
    (IMG_1.JPG + IMG_1.NEF) still share, deliberately: that's the RAW+JPEG
    convention, and the scan warns about it (scanner.find_sidecar_collisions).

    Existing libraries: a video row that recorded the shared IMG_1.xmp under the
    old rule is split by the scan (scanning._split_legacy_shared_sidecars), which
    copies the shared file to IMG_1.MOV.xmp so the video keeps what it showed."""
    if SIDECAR_MODE == "fullname":
        return image_path.parent / (image_path.name + ".xmp")
    if image_path.suffix.lower() in VIDEO_EXTENSIONS and _has_image_sibling(image_path):
        return image_path.parent / (image_path.name + ".xmp")
    return image_path.parent / (image_path.stem + ".xmp")


def sidecar_name_candidates(path: Path) -> tuple[str, ...]:
    """Every name sidecar_path(path) can resolve to, worked out without touching
    the disk. The scan tests these against the directory's .xmp listing so a
    file with no sidecar costs no stat — in particular a video skips the sibling
    probe in sidecar_path unless one of its two possible sidecars exists."""
    if SIDECAR_MODE == "fullname":
        return (path.name + ".xmp",)
    if path.suffix.lower() in VIDEO_EXTENSIONS:
        return (path.stem + ".xmp", path.name + ".xmp")
    return (path.stem + ".xmp",)


def split_shared_sidecar(video_path: Path) -> Path:
    """Give a Live Photo video its own sidecar by copying the basename one it
    used to share with its image (IMG_1.xmp → IMG_1.MOV.xmp); returns the new
    path. Only the scan calls this, and only for a video whose row proves it was
    reading the shared file (see scanning._split_legacy_shared_sidecars).

    A copy, not a move: the image keeps IMG_1.xmp, and right after the split both
    files hold what both rows already showed, so nothing the user wrote is lost
    whichever of the two it was meant for. Opened exclusive ('xb') so a sidecar
    that appeared meanwhile (a web write) is never overwritten — that raises
    FileExistsError, and the caller just uses the file that is there."""
    import shutil
    shared = video_path.parent / (video_path.stem + ".xmp")
    own = video_path.parent / (video_path.name + ".xmp")
    with open(shared, "rb") as src, open(own, "xb") as dst:
        shutil.copyfileobj(src, dst)
    logger.info(f"Split shared sidecar {shared.name} → {own.name} for {video_path.name}")
    return own


def sidecar_tracking(image_path: Path) -> tuple[str | None, float | None]:
    """The (photos.sidecar_path, photos.sidecar_mtime) pair for an image, exactly
    as the scan computes it: the sidecar's file NAME (it always sits next to the
    image, in `dir`) and its mtime, or (None, None) when there is no sidecar.

    Every writer that touches a sidecar and then updates the row must store this,
    not its own idea of the path: index._row_is_fresh compares the two verbatim,
    so any other representation (a full path, a name for a sidecar that isn't on
    disk) makes the next scan re-read the file and re-derive the row from it."""
    sc = sidecar_path(image_path)
    try:
        return sc.name, sc.stat().st_mtime
    except OSError:  # absent / vanished / dangling link: same as "no sidecar"
        return None, None


# XMP-exif:GPSStatus 'V' ("measurement void") in a sidecar that has no
# coordinates is how a removed geotag is recorded there. The original can't be
# edited, so if it carries embedded GPS, "no location" has to be said somewhere
# a re-read will see; this is a standard EXIF/XMP tag ExifTool writes without a
# config file, and its meaning ("the GPS fix is not valid") is the one wanted.
# Coordinates in the sidecar always beat it, so a tool that later writes GPS
# into the sidecar (without knowing about the marker) still wins.
GPS_VOID = "V"


def read_metadata(image_path: Path) -> dict:
    """Return dict with keys: lat, lng, geotag_source, camera, photo_datetime,
    gps_accuracy, orientation."""
    et = get_et()
    sc = sidecar_path(image_path)

    lat = lng = None
    source = "none"
    gps_accuracy = -1.0
    sidecar_dt = None
    gps_void = False  # sidecar says the location was removed (see GPS_VOID)

    # Try sidecar first for GPS, and for DateTimeOriginal (a sidecar-only
    # correction written by write_datetime/Time Sync — the original file is
    # never touched, so this is the only place such a correction lives).
    if sc.exists():
        # Lock each native call, not the whole function: scan workers call this
        # concurrently, and two threads interleaving on the shared -stay_open
        # pipe deadlock each other.
        with get_et_lock():
            result = et.get_tags([str(sc)], tags=[
                "XMP:GPSLatitude", "XMP:GPSLongitude", "XMP:GPSHPositioningError",
                "XMP:DateTimeOriginal", "XMP:GPSStatus",
            ])
        if result:
            row = result[0]
            _lat = row.get("XMP:GPSLatitude")
            _lng = row.get("XMP:GPSLongitude")
            _acc = row.get("XMP:GPSHPositioningError")
            if _lat is not None and _lng is not None:
                lat, lng, source = float(_lat), float(_lng), "sidecar"
                if _acc is not None:
                    try:
                        gps_accuracy = float(_acc)
                    except (TypeError, ValueError):
                        pass
            else:
                gps_void = str(row.get("XMP:GPSStatus") or "").strip().upper() == GPS_VOID
            sidecar_dt = row.get("XMP:DateTimeOriginal")

    # Read embedded GPS + camera in one targeted call — cheaper than pulling
    # every tag, since only these fields are ever extracted from it.
    with get_et_lock():
        result = et.get_tags([str(image_path)], tags=[
            "Composite:GPSLatitude", "Composite:GPSLongitude",
            "GPS:GPSLatitude", "GPS:GPSLongitude",
            "EXIF:Make", "EXIF:Model",
            "QuickTime:Make", "QuickTime:Model",
            "EXIF:DateTimeOriginal", "QuickTime:CreateDate",
            # Keys/UserData CreationDate: the local wall clock plus its offset
            # ('2024:06:01 14:23:45-07:00'), written by iPhones and most recent
            # phones. Reported under group 0 'QuickTime' because of -G.
            "QuickTime:CreationDate",
            "XMP:DateTimeOriginal",
            "EXIF:GPSHPositioningError",
            "XMP:GPSHPositioningError",
            "EXIF:Orientation#",  # '#' → numeric 1..8 rather than "Rotate 90 CW"
        ])
    row = result[0] if result else {}

    # A removed geotag (gps_void) hides the embedded position and its accuracy.
    if source == "none" and not gps_void:
        _lat = row.get("Composite:GPSLatitude") or row.get("GPS:GPSLatitude")
        _lng = row.get("Composite:GPSLongitude") or row.get("GPS:GPSLongitude")
        if _lat is not None and _lng is not None:
            lat, lng, source = float(_lat), float(_lng), "embedded"

    make = (row.get("EXIF:Make") or row.get("QuickTime:Make") or "").strip()
    model = (row.get("EXIF:Model") or row.get("QuickTime:Model") or "").strip()
    # '' (not None) when the file has no Make/Model: NULL in the DB means "never
    # read" to index.is_fresh, which would re-scan scans/screenshots every boot.
    camera = f"{make} {model}".strip()

    # Wall-clock tags first, QuickTime:CreateDate last: it is UTC by spec (audit
    # S6), so it was landing phone videos hours away from the photos shot beside
    # them. The sidecar date stays first — it is written as a bare wall clock
    # (write_datetime), so a video whose date was derived here and then saved by
    # Time Sync reads back as exactly the value saved, never re-converted.
    photo_datetime = _pick_datetime([
        sidecar_dt,
        row.get("EXIF:DateTimeOriginal"),
        row.get("XMP:DateTimeOriginal"),
        row.get("QuickTime:CreationDate"),
    ], utc_candidates=[row.get("QuickTime:CreateDate")])

    if gps_accuracy <= 0 and not gps_void:
        raw_acc = row.get("EXIF:GPSHPositioningError") or row.get("XMP:GPSHPositioningError")
        if raw_acc is not None:
            try:
                gps_accuracy = float(raw_acc)
            except (TypeError, ValueError):
                gps_accuracy = -1.0

    # EXIF orientation 1..8 (how to rotate/flip for display); 1 = as-stored.
    orientation = _coerce_orientation(row.get("EXIF:Orientation"))

    return {"lat": lat, "lng": lng, "geotag_source": source,
            "camera": camera, "photo_datetime": photo_datetime,
            "gps_accuracy": gps_accuracy, "orientation": orientation}


def read_gps(image_path: Path) -> tuple[float, float, str] | tuple[None, None, str]:
    m = read_metadata(image_path)
    return m["lat"], m["lng"], m["geotag_source"]


# XMP location fields. We use the legacy IPTC/Photoshop tags because they're the
# most widely-read place-name fields (Lightroom, Bridge, digiKam, Photos, etc.).
# CountryCode is ISO 3166-1 alpha-2, matching GeoNames.
def _location_args(location: dict | None) -> list[str]:
    """ExifTool args to write (or clear, with location=None) the place-name tags.
    Empty values clear the tag so stale names never linger."""
    loc = location or {}
    return [
        f"-XMP-photoshop:City={loc.get('city') or ''}",
        f"-XMP-photoshop:State={loc.get('state') or ''}",
        f"-XMP-photoshop:Country={loc.get('country') or ''}",
        f"-XMP-iptcCore:CountryCode={loc.get('country_code') or ''}",
    ]


def write_gps(image_path: Path, lat: float, lng: float, location: dict | None = None, gps_accuracy: float | None = None) -> Path:
    """Write GPS to sidecar (creating it if needed). When ``location`` is given,
    its place names are written in the same pass. Returns sidecar path.
    Raises ValueError for a point outside WGS84 range (or NaN/inf), so no caller can
    put e.g. lat=999 into a sidecar."""
    import math
    if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError(f"invalid coordinates: lat={lat}, lng={lng}")
    if gps_accuracy is not None and (not math.isfinite(gps_accuracy) or gps_accuracy < 0):
        raise ValueError(f"invalid gps_accuracy: {gps_accuracy}")
    # Read existing coordinates before updating
    old_lat, old_lng, _ = read_gps(image_path)

    et = get_et()
    sc = sidecar_path(image_path)
    args = [
        "-overwrite_original",
        f"-XMP:GPSLatitude={lat}",
        f"-XMP:GPSLongitude={lng}",
        # Drop any removed-geotag marker (GPS_VOID): this photo has a location again.
        "-XMP-exif:GPSStatus=",
    ]
    if gps_accuracy is not None and gps_accuracy > 0:
        args.append(f"-XMP:GPSHPositioningError={gps_accuracy}")
        args.append(f"-GPSHPositioningError={gps_accuracy}")
    else:
        args.append("-XMP:GPSHPositioningError=")
        args.append("-GPSHPositioningError=")

    if location is not None:
        args += _location_args(location)
    with get_et_lock():
        et.execute(*args, str(sc))

    # Log the change
    acc_log = f" (accuracy: {gps_accuracy}m)" if gps_accuracy and gps_accuracy > 0 else ""
    if old_lat is not None and old_lng is not None:
        logger.info(f"Updated GPS for {image_path.name}: ({old_lat:.6f}, {old_lng:.6f}) → ({lat:.6f}, {lng:.6f}){acc_log}")
    else:
        logger.info(f"Added GPS to {image_path.name}: ({lat:.6f}, {lng:.6f}){acc_log}")

    return sc


def write_location(image_path: Path, location: dict) -> Path:
    """Write only the reverse-geocoded place names to the sidecar (creating it if
    needed) — used by the bulk 'export locations to sidecars' action. Returns the
    sidecar path."""
    et = get_et()
    sc = sidecar_path(image_path)
    with get_et_lock():
        et.execute("-overwrite_original", *_location_args(location), str(sc))
    logger.info(
        f"Wrote location to {sc.name}: "
        f"{location.get('city')}, {location.get('state')}, {location.get('country')}"
    )
    return sc


def remove_gps(image_path: Path, create: bool = False) -> Path:
    """Remove GPS from the sidecar and mark the location removed (GPS_VOID), so a
    later read ignores GPS embedded in the original. An existing sidecar is always
    updated; a missing one is created only when ``create`` (sidecar-writing mode),
    otherwise the removal is recorded in the DB alone. Returns sidecar path."""
    # Read existing coordinates before removing
    old_lat, old_lng, _ = read_gps(image_path)

    et = get_et()
    sc = sidecar_path(image_path)
    if create or sc.exists():
        # Clear coordinates, accuracy and the derived place names together.
        with get_et_lock():
            et.execute(
                "-overwrite_original",
                "-XMP:GPSLatitude=",
                "-XMP:GPSLongitude=",
                "-XMP:GPSHPositioningError=",
                "-GPSHPositioningError=",
                f"-XMP-exif:GPSStatus={GPS_VOID}",
                *_location_args(None),
                str(sc),
            )

    # Log the removal
    if old_lat is not None and old_lng is not None:
        logger.info(f"Removed GPS from {image_path.name}: ({old_lat:.6f}, {old_lng:.6f}) → (none)")
    else:
        logger.info(f"Remove GPS called on {image_path.name}: (already had no GPS)")

    return sc


def read_sidecar_datetime_raw(image_path: Path) -> str | None:
    """The literal ``XMP:DateTimeOriginal`` string currently in the sidecar, or
    None if there's no sidecar or no such tag (i.e. the file's own embedded date,
    or nothing, currently governs). Used to snapshot state before a batch date
    write so Undo can restore it byte-for-byte, without reconstructing it from a
    parsed/re-derived timestamp."""
    sc = sidecar_path(image_path)
    if not sc.exists():
        return None
    et = get_et()
    with get_et_lock():
        result = et.get_tags([str(sc)], tags=["XMP:DateTimeOriginal"])
    return result[0].get("XMP:DateTimeOriginal") if result else None


def write_datetime_raw(image_path: Path, exif_datetime: str | None) -> Path:
    """Write (or clear, with None) the sidecar's XMP:DateTimeOriginal to an exact
    literal EXIF-format string ('YYYY:MM:DD HH:MM:SS'). The one place that
    actually calls ExifTool for this tag — write_datetime/write_approximate_date/
    write_guessed_date all format a string and hand it here; Undo uses it
    directly with a snapshot from read_sidecar_datetime_raw."""
    et = get_et()
    sc = sidecar_path(image_path)
    with get_et_lock():
        et.execute("-overwrite_original", f"-XMP:DateTimeOriginal={exif_datetime or ''}", str(sc))
    return sc


def write_guessed_date(image_path: Path, year: int, month: int, day: int) -> tuple[Path, int]:
    """Write a fully-specified (exact day) date guessed from a filename's embedded
    YYYYMMDD or a folder's full-date segment — see date_guess.py. Unlike
    write_approximate_date, ``day`` is a real observed value, not a period-start
    stand-in, so the caller should record date_precision=None (exact) for it.
    Returns (sidecar_path, photo_datetime)."""
    exif_datetime = f"{year:04d}:{month:02d}:{day:02d} 00:00:00"
    timestamp = int(calendar.timegm(datetime(year, month, day).timetuple()))
    sc = write_datetime_raw(image_path, exif_datetime)
    logger.info(f"Set guessed date for {image_path.name}: {exif_datetime}")
    return sc, timestamp


def write_approximate_date(image_path: Path, year: int, month: int | None) -> tuple[Path, int]:
    """Write a year- or month-precision date to the sidecar (creating it if needed).

    Stores the first instant of the year/month — day 1, 00:00:00 — as the
    conventional stand-in for "somewhere in this period". Built directly as an
    EXIF-format string, and the returned timestamp is computed the same way
    _parse_exif_datetime will read it back (UTC, via calendar.timegm) so a rescan
    reproduces exactly this value.
    Returns (sidecar_path, photo_datetime).
    """
    exif_datetime = f"{year:04d}:{month or 1:02d}:01 00:00:00"
    timestamp = int(calendar.timegm(datetime(year, month or 1, 1).timetuple()))
    sc = write_datetime_raw(image_path, exif_datetime)
    logger.info(f"Set approximate ({'month' if month else 'year'}-precision) date for "
                f"{image_path.name}: {exif_datetime}")
    return sc, timestamp


def write_datetime(image_path: Path, timestamp: int) -> Path:
    """Write DateTimeOriginal to sidecar (creating it if needed). Returns sidecar path."""
    # Read existing timestamp from image metadata
    m = read_metadata(image_path)
    old_ts = m["photo_datetime"]

    # Convert Unix timestamp to EXIF format: "YYYY:MM:DD HH:MM:SS"
    # The stored value is wall-clock-as-UTC, so format it with UTC arithmetic: the
    # string written is exactly the wall clock the DB holds, and _parse_exif_datetime
    # reads it back to the same epoch regardless of the machine's timezone.
    dt = epoch_to_wallclock(timestamp)
    exif_datetime = dt.strftime("%Y:%m:%d %H:%M:%S")
    sc = write_datetime_raw(image_path, exif_datetime)

    # Log the change
    if old_ts and old_ts != 0:
        old_dt = epoch_to_wallclock(old_ts)
        old_str = old_dt.strftime("%Y-%m-%d %H:%M:%S")
        new_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        diff_seconds = timestamp - old_ts
        logger.info(f"Updated DateTimeOriginal for {image_path.name}: {old_str} → {new_str} ({diff_seconds:+d}s)")
    else:
        logger.info(f"Set DateTimeOriginal for {image_path.name}: {dt.strftime('%Y-%m-%d %H:%M:%S')}")

    return sc
