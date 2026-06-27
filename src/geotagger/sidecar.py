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


def sidecar_path(image_path: Path) -> Path:
    if SIDECAR_MODE == "fullname":
        return image_path.parent / (image_path.name + ".xmp")
    return image_path.parent / (image_path.stem + ".xmp")


def read_metadata(image_path: Path) -> dict:
    """Return dict with keys: lat, lng, geotag_source, camera."""
    et = get_et()
    sc = sidecar_path(image_path)

    lat = lng = None
    source = "none"

    # Try sidecar first for GPS
    if sc.exists():
        result = et.get_tags([str(sc)], tags=["XMP:GPSLatitude", "XMP:GPSLongitude"])
        if result:
            row = result[0]
            _lat = row.get("XMP:GPSLatitude")
            _lng = row.get("XMP:GPSLongitude")
            if _lat is not None and _lng is not None:
                lat, lng, source = float(_lat), float(_lng), "sidecar"

    # Read embedded GPS + camera in one call
    result = et.get_tags([str(image_path)], tags=[
        "Composite:GPSLatitude", "Composite:GPSLongitude",
        "GPS:GPSLatitude", "GPS:GPSLongitude",
        "EXIF:Make", "EXIF:Model",
        "QuickTime:Make", "QuickTime:Model",
        "EXIF:DateTimeOriginal", "QuickTime:CreateDate",
        "XMP:DateTimeOriginal",
        "EXIF:GPSHPositioningError",
        "EXIF:Orientation#",  # '#' → numeric 1..8 rather than "Rotate 90 CW"
    ])
    row = result[0] if result else {}

    if source == "none":
        _lat = row.get("Composite:GPSLatitude") or row.get("GPS:GPSLatitude")
        _lng = row.get("Composite:GPSLongitude") or row.get("GPS:GPSLongitude")
        if _lat is not None and _lng is not None:
            lat, lng, source = float(_lat), float(_lng), "embedded"

    make = (row.get("EXIF:Make") or row.get("QuickTime:Make") or "").strip()
    model = (row.get("EXIF:Model") or row.get("QuickTime:Model") or "").strip()
    camera = f"{make} {model}".strip() or None

    raw_dt = (row.get("EXIF:DateTimeOriginal")
              or row.get("XMP:DateTimeOriginal")
              or row.get("QuickTime:CreateDate"))
    photo_datetime = _parse_exif_datetime(str(raw_dt)) if raw_dt else 0

    raw_acc = row.get("EXIF:GPSHPositioningError")
    gps_accuracy = float(raw_acc) if raw_acc is not None else -1.0

    # EXIF orientation 1..8 (how to rotate/flip for display); 1 = as-stored.
    raw_orient = row.get("EXIF:Orientation")
    try:
        orientation = int(raw_orient) if raw_orient is not None else 1
    except (TypeError, ValueError):
        orientation = 1
    if orientation not in range(1, 9):
        orientation = 1

    return {"lat": lat, "lng": lng, "geotag_source": source,
            "camera": camera, "photo_datetime": photo_datetime,
            "gps_accuracy": gps_accuracy, "orientation": orientation}


def read_gps(image_path: Path) -> tuple[float, float, str] | tuple[None, None, str]:
    m = read_metadata(image_path)
    return m["lat"], m["lng"], m["geotag_source"]


def write_gps(image_path: Path, lat: float, lng: float) -> Path:
    """Write GPS to sidecar (creating it if needed). Returns sidecar path."""
    # Read existing coordinates before updating
    old_lat, old_lng, _ = read_gps(image_path)

    et = get_et()
    sc = sidecar_path(image_path)
    et.execute(
        "-overwrite_original",
        f"-XMP:GPSLatitude={lat}",
        f"-XMP:GPSLongitude={lng}",
        str(sc),
    )

    # Log the change
    if old_lat is not None and old_lng is not None:
        logger.info(f"Updated GPS for {image_path.name}: ({old_lat:.6f}, {old_lng:.6f}) → ({lat:.6f}, {lng:.6f})")
    else:
        logger.info(f"Added GPS to {image_path.name}: ({lat:.6f}, {lng:.6f})")

    return sc


def remove_gps(image_path: Path) -> Path:
    """Remove GPS from sidecar. Returns sidecar path."""
    # Read existing coordinates before removing
    old_lat, old_lng, _ = read_gps(image_path)

    et = get_et()
    sc = sidecar_path(image_path)
    if sc.exists():
        et.execute(
            "-overwrite_original",
            "-XMP:GPSLatitude=",
            "-XMP:GPSLongitude=",
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
