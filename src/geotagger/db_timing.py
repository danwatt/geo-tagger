"""sqlite3.Connection subclass that logs slow SELECTs.

Pass `factory=TimedConnection` to sqlite3.connect() so every .execute()/
.executemany() on that connection is timed transparently — no call sites
need to change.
"""
import logging
import sqlite3
import time

logger = logging.getLogger(__name__)

SLOW_QUERY_THRESHOLD_MS = 100


def _log_if_slow(sql: str, elapsed_ms: float) -> None:
    if elapsed_ms > SLOW_QUERY_THRESHOLD_MS and sql.lstrip().upper().startswith("SELECT"):
        logger.warning(f"Slow query ({elapsed_ms:.1f}ms): {sql}")


class TimedConnection(sqlite3.Connection):
    def execute(self, sql, parameters=()):
        t0 = time.time()
        try:
            return super().execute(sql, parameters)
        finally:
            _log_if_slow(sql, (time.time() - t0) * 1000)

    def executemany(self, sql, parameters):
        t0 = time.time()
        try:
            return super().executemany(sql, parameters)
        finally:
            _log_if_slow(sql, (time.time() - t0) * 1000)
