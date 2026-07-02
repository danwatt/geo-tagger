import calendar
import logging
from datetime import datetime
from pathlib import Path
from geotagger.config import SIDECAR_MODE
from geotagger.exiftool_session import get_et

logger = logging.getLogger(__name__)


def _parse_exif_datetime(s: str) -> int | None:
    """Parse '2024:10:02 14:23:45' → Unix timestamp, or None."""
    if not s:
        return None
    try:
        # ExifTool format: 'YYYY:MM:DD HH:MM:SS'
        dt = datetime.strptime(s.strip(), "%Y:%m:%d %H:%M:%S")
        return int(calendar.timegm(dt.timetuple()))
    except Exception:
        return None


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
    result = et.get_tags([str(p) for p in paths], tags=["EXIF:Orientation#"])
    by_path = {Path(r["SourceFile"]): _coerce_orientation(r.get("EXIF:Orientation"))
               for r in result}
    # Fill in anything ExifTool didn't return (e.g. it skipped an unreadable file).
    return {Path(p): by_path.get(Path(p), 1) for p in paths}


def read_all_metadata(paths: list) -> dict[Path, dict]:
    """Batch-read the *full* ExifTool metadata for many files in one call, keyed by
    Path. Used by the EXIF backfill to snapshot every tag into photos.exif_json for
    later searching (orientation is derived from the same read).

    Values come back already JSON-serializable — pyexiftool parses ExifTool's -j
    output, and our common_args ("-G -n") give group-prefixed keys and numeric
    values. Binary tags (thumbnails, previews) are returned as short
    "(Binary data …)" placeholder strings rather than raw bytes, so the JSON stays
    compact. Files ExifTool skips (unreadable) simply won't appear in the result.

    Keys are Path objects (not strings) so callers match reliably despite ExifTool
    echoing forward-slash SourceFile paths on Windows (Path normalizes separators
    and case)."""
    if not paths:
        return {}
    et = get_et()
    result = et.get_metadata([str(p) for p in paths])
    return {Path(r["SourceFile"]): r for r in result}


def dumps_exif(meta: dict) -> str:
    """Serialize an ExifTool metadata dict to the JSON stored in photos.exif_json.
    ensure_ascii=False keeps non-Latin tag values (place/camera names) readable;
    default=str is a safety net for any stray non-JSON-native value. Shared by the
    scanner (read_metadata full=True) and scripts/backfill_orientation.py so both
    produce identical JSON."""
    import json as _json  # local import: keep module import light (see CLAUDE.md)
    return _json.dumps(meta, ensure_ascii=False, default=str)


def sidecar_path(image_path: Path) -> Path:
    if SIDECAR_MODE == "fullname":
        return image_path.parent / (image_path.name + ".xmp")
    return image_path.parent / (image_path.stem + ".xmp")


def read_metadata(image_path: Path, full: bool = False) -> dict:
    """Return dict with keys: lat, lng, geotag_source, camera, photo_datetime,
    gps_accuracy, orientation, exif_json.

    With ``full=True`` (the scan path) the embedded read pulls *every* tag so the
    whole ExifTool dump can be snapshotted into ``exif_json`` for later searching;
    otherwise (interactive GPS/date paths that only need a few fields) it stays on
    the cheaper targeted read and ``exif_json`` is None."""
    et = get_et()
    sc = sidecar_path(image_path)

    lat = lng = None
    source = "none"
    gps_accuracy = -1.0
    sidecar_dt = None

    # Try sidecar first for GPS, and for DateTimeOriginal (a sidecar-only
    # correction written by write_datetime/Time Sync — the original file is
    # never touched, so this is the only place such a correction lives).
    if sc.exists():
        result = et.get_tags([str(sc)], tags=[
            "XMP:GPSLatitude", "XMP:GPSLongitude", "XMP:GPSHPositioningError",
            "XMP:DateTimeOriginal",
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
            sidecar_dt = row.get("XMP:DateTimeOriginal")

    # Read embedded GPS + camera in one call. full=True (scan) pulls every tag for
    # the exif_json snapshot; the fields below are extracted from that same dict, so
    # the '-n' global keeps EXIF:Orientation numeric without the per-tag '#'.
    if full:
        result = et.get_metadata([str(image_path)])
    else:
        result = et.get_tags([str(image_path)], tags=[
            "Composite:GPSLatitude", "Composite:GPSLongitude",
            "GPS:GPSLatitude", "GPS:GPSLongitude",
            "EXIF:Make", "EXIF:Model",
            "QuickTime:Make", "QuickTime:Model",
            "EXIF:DateTimeOriginal", "QuickTime:CreateDate",
            "XMP:DateTimeOriginal",
            "EXIF:GPSHPositioningError",
            "XMP:GPSHPositioningError",
            "EXIF:Orientation#",  # '#' → numeric 1..8 rather than "Rotate 90 CW"
        ])
    row = result[0] if result else {}
    # Snapshot the full dump only on the scan path; None otherwise (and when the
    # file was unreadable) so the row is left exif_json=NULL for the backfill.
    exif_json = dumps_exif(row) if (full and result) else None

    if source == "none":
        _lat = row.get("Composite:GPSLatitude") or row.get("GPS:GPSLatitude")
        _lng = row.get("Composite:GPSLongitude") or row.get("GPS:GPSLongitude")
        if _lat is not None and _lng is not None:
            lat, lng, source = float(_lat), float(_lng), "embedded"

    make = (row.get("EXIF:Make") or row.get("QuickTime:Make") or "").strip()
    model = (row.get("EXIF:Model") or row.get("QuickTime:Model") or "").strip()
    camera = f"{make} {model}".strip() or None

    raw_dt = (sidecar_dt
              or row.get("EXIF:DateTimeOriginal")
              or row.get("XMP:DateTimeOriginal")
              or row.get("QuickTime:CreateDate"))
    photo_datetime = _parse_exif_datetime(str(raw_dt)) if raw_dt else 0

    if gps_accuracy <= 0:
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
            "gps_accuracy": gps_accuracy, "orientation": orientation,
            "exif_json": exif_json}


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
    its place names are written in the same pass. Returns sidecar path."""
    # Read existing coordinates before updating
    old_lat, old_lng, _ = read_gps(image_path)

    et = get_et()
    sc = sidecar_path(image_path)
    args = [
        "-overwrite_original",
        f"-XMP:GPSLatitude={lat}",
        f"-XMP:GPSLongitude={lng}",
    ]
    if gps_accuracy is not None and gps_accuracy > 0:
        args.append(f"-XMP:GPSHPositioningError={gps_accuracy}")
        args.append(f"-GPSHPositioningError={gps_accuracy}")
    else:
        args.append("-XMP:GPSHPositioningError=")
        args.append("-GPSHPositioningError=")

    if location is not None:
        args += _location_args(location)
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
    et.execute("-overwrite_original", *_location_args(location), str(sc))
    logger.info(
        f"Wrote location to {sc.name}: "
        f"{location.get('city')}, {location.get('state')}, {location.get('country')}"
    )
    return sc


def remove_gps(image_path: Path) -> Path:
    """Remove GPS from sidecar. Returns sidecar path."""
    # Read existing coordinates before removing
    old_lat, old_lng, _ = read_gps(image_path)

    et = get_et()
    sc = sidecar_path(image_path)
    if sc.exists():
        # Clear coordinates, accuracy and the derived place names together.
        et.execute(
            "-overwrite_original",
            "-XMP:GPSLatitude=",
            "-XMP:GPSLongitude=",
            "-XMP:GPSHPositioningError=",
            "-GPSHPositioningError=",
            *_location_args(None),
            str(sc),
        )

    # Log the removal
    if old_lat is not None and old_lng is not None:
        logger.info(f"Removed GPS from {image_path.name}: ({old_lat:.6f}, {old_lng:.6f}) → (none)")
    else:
        logger.info(f"Remove GPS called on {image_path.name}: (already had no GPS)")

    return sc


def write_datetime(image_path: Path, timestamp: int) -> Path:
    """Write DateTimeOriginal to sidecar (creating it if needed). Returns sidecar path."""
    # Read existing timestamp from image metadata
    m = read_metadata(image_path)
    old_ts = m["photo_datetime"]

    # Convert Unix timestamp to EXIF format: "YYYY:MM:DD HH:MM:SS"
    dt = datetime.fromtimestamp(timestamp)
    exif_datetime = dt.strftime("%Y:%m:%d %H:%M:%S")

    et = get_et()
    sc = sidecar_path(image_path)
    et.execute(
        "-overwrite_original",
        f"-XMP:DateTimeOriginal={exif_datetime}",
        str(sc),
    )

    # Log the change
    if old_ts and old_ts != 0:
        old_dt = datetime.fromtimestamp(old_ts)
        old_str = old_dt.strftime("%Y-%m-%d %H:%M:%S")
        new_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        diff_seconds = timestamp - old_ts
        logger.info(f"Updated DateTimeOriginal for {image_path.name}: {old_str} → {new_str} ({diff_seconds:+d}s)")
    else:
        logger.info(f"Set DateTimeOriginal for {image_path.name}: {dt.strftime('%Y-%m-%d %H:%M:%S')}")

    return sc
