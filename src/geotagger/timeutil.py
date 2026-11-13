"""photo_datetime conversions and the "has a date" predicate, dependency-free.

photo_datetime is the camera's wall clock stored as if it were UTC epoch seconds.
Photos from before 1970 (scans assigned a 1955 date, say) are negative, which is
why nothing here goes through the C library: datetime.fromtimestamp() and
time.gmtime()/localtime() raise OSError [Errno 22] for negative values on
Windows, with or without a tz. Epoch + timedelta and calendar.timegm are pure
Python arithmetic and handle any year datetime can represent.

Undated is stored as 0 (read, but no date tag parsed) or NULL (never read: rows
from before the column existed, or from before unparseable dates were stored as
0); both mean the same thing for display. NULL also makes index._row_is_fresh
re-read the file, which is how old rows get repaired to 0. The one value this
convention can't represent is a photo taken at exactly 1970-01-01 00:00:00,
which reads as undated — accepted, since no real camera clock lands there except
by being unset. The SQL twin of has_date() is index.HAS_DATE_SQL.

Kept apart from sidecar.py (which re-exports the conversions) so serializers and
services can use them without importing ExifTool.
"""

import calendar
from datetime import datetime, timedelta

_EPOCH = datetime(1970, 1, 1)


def has_date(ts: int | float | None) -> bool:
    """True if a photo_datetime value is a real date (negative = pre-1970 counts).
    Never test ``ts > 0``: that silently classes every pre-1970 photo as undated."""
    return ts is not None and ts != 0


def wallclock_to_epoch(dt: datetime) -> int:
    """Naive wall-clock datetime → the project's photo_datetime epoch (the wall
    clock read as if it were UTC). Inverse of epoch_to_wallclock."""
    return int(calendar.timegm(dt.timetuple()))


def epoch_to_wallclock(ts: int | float) -> datetime:
    """photo_datetime epoch → naive wall-clock datetime, by pure UTC arithmetic.

    Never use datetime.fromtimestamp() here: photo_datetime is wall-clock-as-UTC,
    so converting through the machine's local zone shifts the value by the local
    UTC offset (and raises OSError for pre-1970 values on Windows). Epoch + a
    timedelta has neither problem."""
    return _EPOCH + timedelta(seconds=ts)
