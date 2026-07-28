"""Blocking geotag writes. Framework-free so the API routes can dispatch them to
the executor instead of running ExifTool on the event loop."""

import bisect
from pathlib import Path

from geotagger import config, index, sidecar, geocode
from geotagger.exiftool_session import get_et_lock
from geotagger.services import hotspots_service


def write_geotag(photo_ids: list[int], lat: float, lng: float,
                 gps_accuracy: float | None = None) -> list[dict]:
    """Write one shared point to every photo in `photo_ids`. Blocking; runs in the
    executor. Reverse-geocodes the point once (the geocoder's first call loads a
    KD-tree) and reuses the result for the whole batch — every photo lands on the
    same coordinate, so the place names are identical by construction. `loc` is
    None when no geocode data is installed, in which case place names are skipped.

    The ExifTool lock is taken per file rather than around the whole loop so a
    large commit doesn't starve thumbnail/preview requests for its full duration.
    """
    loc = geocode.lookup(lat, lng)
    lock = get_et_lock()

    results = []
    for photo_id in photo_ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(index.photo_path(row))
        if config.WRITE_XMP_ON_GEOTAG:
            with lock:
                sc = sidecar.write_gps(p, lat, lng, location=loc, gps_accuracy=gps_accuracy)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            source, sc_name = "sidecar", sc.name
        else:
            # DB-only: leave any existing sidecar untouched and record whatever
            # is actually on disk, so a later scan's freshness check (index.is_fresh)
            # doesn't see a mismatch and re-read a stale/absent sidecar over this.
            sc = sidecar.sidecar_path(p)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            source, sc_name = "database", (sc.name if sc.exists() else None)
        index.update_geotag(photo_id, lat, lng, source, sc_name, sc_mtime,
                            gps_accuracy=gps_accuracy)
        if loc is not None:
            index.update_photo_location(photo_id, loc)
        results.append({
            "id": photo_id, "lat": lat, "lng": lng,
            "geotag_source": source, "sidecar_path": sc_name,
            "location": loc,
            "gps_accuracy": gps_accuracy,
        })
    # New coordinates shift the palette. The cache key only tracks how many photos
    # are geotagged, which doesn't move when an already-tagged photo is re-dropped.
    hotspots_service.invalidate()
    return results


def remove_geotag(photo_ids: list[int]) -> list[dict]:
    """Strip GPS from each photo's sidecar and clear it in the DB. Blocking."""
    lock = get_et_lock()
    results = []
    for photo_id in photo_ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(index.photo_path(row))
        with lock:
            sc = sidecar.remove_gps(p)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.update_geotag(photo_id, None, None, "none", str(sc), sc_mtime)
        results.append({"id": photo_id, "geotag_source": "none"})
    hotspots_service.invalidate()
    return results


# ── Proposing a location for a selection ──

# How far either side of a selected photo we'll look for an already-geotagged
# photo to copy from. One hour covers "same outing" without reaching into the
# next stop of the day.
DEFAULT_PROPOSE_WINDOW = 3600


def propose_locations(photo_ids: list[int], window: int = DEFAULT_PROPOSE_WINDOW,
                      limit: int = 3) -> dict:
    """Rank the likely locations for a whole selection, so the common case never
    touches the map.

    Each selected photo votes for the location of its nearest-in-time geotagged
    photo (within `window`), and the votes are clustered the same way the hotspot
    palette clusters drops. Voting per photo — rather than averaging every
    neighbour into one point, the way /api/guess does — is what keeps a selection
    that straddles two places from proposing the empty spot between them.

    Returns candidates richest first with the vote count on each, plus how many of
    the selection voted at all, so the caller can say "12 of 14 → Home".
    """
    def empty(selected: int) -> dict:
        return {"candidates": [], "selected": selected, "voted": 0, "window_sec": window}

    if not photo_ids:
        return empty(0)

    db = index.get_db()
    # Only untagged, dated photos are proposable — `selected` counts those, not the
    # raw selection, so the "N of M" the UI shows matches what a stage would touch.
    qmarks = ",".join("?" * len(photo_ids))
    targets = db.execute(
        f"SELECT id, photo_datetime FROM photos "
        f"WHERE id IN ({qmarks}) AND lat IS NULL AND photo_datetime > 0",
        photo_ids,
    ).fetchall()
    if not targets:
        return empty(0)

    lo = min(r["photo_datetime"] for r in targets) - window
    hi = max(r["photo_datetime"] for r in targets) + window
    neighbors = db.execute("""
        SELECT id, lat, lng, photo_datetime FROM photos
        WHERE lat IS NOT NULL AND lng IS NOT NULL
          AND photo_datetime BETWEEN ? AND ?
        ORDER BY photo_datetime
    """, (lo, hi)).fetchall()
    if not neighbors:
        return empty(len(targets))

    # One sorted pass + a bisect per target beats a per-photo "nearest in time"
    # query; a month-wide selection can easily be several hundred photos. The
    # nearest neighbour in a time-sorted list is always at the insertion point or
    # the slot before it, so two comparisons settle each photo.
    times = [r["photo_datetime"] for r in neighbors]
    votes: list[tuple[float, float, float | None, int | None]] = []
    for t in targets:
        ts = t["photo_datetime"]
        i = bisect.bisect_left(times, ts)
        best = None
        best_d = window
        for j in (i - 1, i):
            if not (0 <= j < len(neighbors)):
                continue
            r = neighbors[j]
            d = abs(r["photo_datetime"] - ts)
            if d <= best_d:
                best, best_d = r, d
        if best is not None:
            votes.append((best["lat"], best["lng"], best["photo_datetime"], best["id"]))

    if not votes:
        return empty(len(targets))

    clusters = hotspots_service.cluster_cells(
        hotspots_service.quantize(votes), hotspots_service.DEFAULT_MERGE_METERS
    )
    clusters.sort(key=lambda c: -c["count"])

    candidates = []
    for c in clusters[:max(1, limit)]:
        loc = geocode.lookup(c["lat"], c["lng"])   # None when no geocode data is installed
        candidates.append({
            "lat": c["lat"], "lng": c["lng"],
            "votes": c["count"],
            "sample_photo_id": c["sample_photo_id"],
            "location": loc,
            "label": hotspots_service.place_label(loc, c["lat"], c["lng"]),
        })
    return {
        "candidates": candidates,
        "selected": len(targets),
        "voted": len(votes),
        "window_sec": window,
    }
