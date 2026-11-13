"""Best-effort date guessing from a filename's embedded YYYYMMDD run, or from a
folder named by year (optionally with a year-month or month subfolder) — for
undated (or wrong-dated) scans dropped in by folder with no reliable EXIF date.
Pure string/regex logic, no I/O — see photos_service.guess_dates for the DB-row
plumbing and sidecar.write_guessed_date/write_approximate_date for the write side.
"""

import re
from datetime import datetime

_MIN_YEAR = 1990  # digital-camera-era filename/folder date conventions only

# An embedded YYYYMMDD run (optionally dash/underscore-separated between the
# groups, e.g. "20111027", "2011-10-27", "2011_10_27"), not part of a longer
# digit run — so a serial number like "3462011102700" doesn't false-match.
_FILENAME_DATE_RE = re.compile(r"(?<!\d)(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?!\d)")

_YEAR_MONTH_SEGMENT_RE = re.compile(r"^(\d{4})[-_](0[1-9]|1[0-2])$")
_YEAR_SEGMENT_RE = re.compile(r"^\d{4}$")
_BARE_MONTH_SEGMENT_RE = re.compile(r"^(0?[1-9]|1[0-2])$")


def _valid_year(y: int) -> bool:
    return _MIN_YEAR <= y <= datetime.now().year + 1


def guess_date_from_filename(filename: str) -> tuple[int, int, int] | None:
    """(year, month, day) from an embedded date-like run in ``filename``, or
    None if no run is found or it isn't a real calendar date."""
    for m in _FILENAME_DATE_RE.finditer(filename):
        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if not _valid_year(year) or not (1 <= month <= 12):
            continue
        try:
            datetime(year, month, day)
        except ValueError:
            continue
        return year, month, day
    return None


def guess_date_from_dir(dir_: str) -> tuple[int, int | None] | None:
    """(year, month|None) from a "YYYY-MM" folder segment, a "YYYY" segment
    followed by a bare-month ("10"/"01") child segment, or a plain "YYYY"
    segment on its own — walking the path in order and returning the first hit.
    """
    segments = [s for s in re.split(r"[\\/]+", dir_.strip("\\/")) if s]
    for i, seg in enumerate(segments):
        m = _YEAR_MONTH_SEGMENT_RE.match(seg)
        if m:
            year, month = int(m.group(1)), int(m.group(2))
            if _valid_year(year):
                return year, month
        elif _YEAR_SEGMENT_RE.match(seg):
            year = int(seg)
            if not _valid_year(year):
                continue
            nxt = segments[i + 1] if i + 1 < len(segments) else None
            if nxt and _BARE_MONTH_SEGMENT_RE.match(nxt):
                return year, int(nxt)
            return year, None
    return None


def guess_date(filename: str, dir_: str) -> dict | None:
    """Best-effort {year, month, day, precision, source} guess for a photo with
    no reliable EXIF date, or None if neither the filename nor the folder
    structure yields one. ``precision`` is None (exact day), 'month', or 'year' —
    matching the date_precision column. Filename wins over folder: an exact day
    beats an approximate one."""
    from_name = guess_date_from_filename(filename)
    if from_name:
        year, month, day = from_name
        return {"year": year, "month": month, "day": day,
                "precision": None, "source": "filename"}

    from_dir = guess_date_from_dir(dir_)
    if from_dir:
        year, month = from_dir
        return {"year": year, "month": month, "day": None,
                "precision": "month" if month else "year", "source": "folder"}

    return None
