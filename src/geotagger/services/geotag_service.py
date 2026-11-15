"""Blocking geotag writes. Framework-free so the API routes can dispatch them to
the executor instead of running ExifTool on the event loop."""

import bisect
import logging
import math
from pathlib import Path

from geotagger import config, index, sidecar, geocode
from geotagger.exiftool_session import ExifToolDied, ExifToolTimeout, get_et_lock
from geotagger.services import hotspots_service

logger = logging.getLogger(__name__)


def validate_point(lat: float, lng: float, gps_accuracy: float | None = None) -> None:
    """Raise ValueError unless this is a real WGS84 point. The API validates the
    same bounds at the request boundary; this is the guard for non-API callers, so
    no path can put `lat=999` (or NaN) into a sidecar."""
    for name, v in (("lat", lat), ("lng", lng)):
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError(f"{name} must be a finite number")
    if not -90 <= lat <= 90:
        raise ValueError("lat must be between -90 and 90")
    if not -180 <= lng <= 180:
        raise ValueError("lng must be between -180 and 180")
    if gps_accuracy is not None and (not math.isfinite(gps_accuracy) or gps_accuracy < 0):
        raise ValueError("gps_accuracy must be a non-negative finite number")


def _short_error(e: Exception) -> str:
    """A one-line reason safe to show in the UI (no traceback, no long reprs)."""
    if isinstance(e, ExifToolTimeout):
        return "ExifTool timed out"
    if isinstance(e, ExifToolDied):
        return "ExifTool stopped"
    if isinstance(e, FileNotFoundError):
        return "file not found"
    if isinstance(e, PermissionError):
        return "permission denied"
    msg = (str(e) or type(e).__name__).splitlines()[0]
    return msg[:160]


def _invalidate_caches() -> None:
    """Drop what was derived from the old coordinates. update_geotag already bumped
    the geotag generation the hotspot cache keys on; dropping it here just frees the
    old clustering now rather than on the next palette request."""
    hotspots_service.invalidate()
    # Local import: work_queue_service imports this module for its proposals.
    from geotagger.services import work_queue_service
    work_queue_service.invalidate()


# ── Undo snapshots ──
# Every commit-path writer (write_geotag, remove_geotag, set_geocode_ignored)
# returns, per photo it changed, a `previous` snapshot of what the row held just
# before, plus `expect`: what the write left. The client keeps the snapshots of
# its last commit and hands them back to undo_geotags (POST /api/geotag/undo),
# which puts that state back — sidecar and row — unless the photo has been changed
# again since (its row no longer matches `expect`). Same contract as
# photos_service.commit_guessed_dates / undo_date_commit.

GEOTAG_SOURCES = ("sidecar", "database", "embedded", "none")


def _geotag_state(row) -> dict:
    """The geotag half of a snapshot, verbatim from the row (gps_accuracy raw,
    -1.0/NULL included, so the restored row reads the same to is_fresh)."""
    return {"lat": row["lat"], "lng": row["lng"], "gps_accuracy": row["gps_accuracy"],
            "geotag_source": row["geotag_source"], "geotag_removed": bool(row["geotag_removed"])}


def write_geotag(photo_ids: list[int], lat: float, lng: float,
                 gps_accuracy: float | None = None) -> dict:
    """Write one shared point to every photo in `photo_ids`. Blocking; runs in the
    executor. Reverse-geocodes the point once (the geocoder's first call loads a
    KD-tree) and reuses the result for the whole batch — every photo lands on the
    same coordinate, so the place names are identical by construction. `loc` is
    None when no geocode data is installed, in which case place names are skipped.

    The ExifTool lock is taken per file rather than around the whole loop so a
    large commit doesn't starve thumbnail/preview requests for its full duration.

    Each photo is isolated: a failure (ExifTool error, missing file, timeout) is
    reported in `failed` and the rest of the batch still runs. Sidecar first, then
    the DB row, so a failed sidecar write leaves the row untouched; a DB failure
    after a successful sidecar write is reported as failed and the next scan
    reconciles — the row's sidecar_mtime no longer matches the file, so
    index.is_fresh() is False and the file is re-read.

    Returns {"results": [per-photo dicts for the written ones], "written": [ids],
    "failed": [{"id", "error"}], "not_found": [ids]}. Raises ValueError for an
    out-of-range point, before anything is touched."""
    validate_point(lat, lng, gps_accuracy)
    results: list[dict] = []
    failed: list[dict] = []
    not_found: list[int] = []
    try:
        loc = geocode.lookup(lat, lng)
        lock = get_et_lock()
        for photo_id in photo_ids:
            row = index.get_photo(photo_id)
            if not row:
                not_found.append(photo_id)
                continue
            try:
                p = Path(index.photo_path(row))
                if config.WRITE_XMP_ON_GEOTAG:
                    with lock:
                        sidecar.write_gps(p, lat, lng, location=loc, gps_accuracy=gps_accuracy)
                    source = "sidecar"
                else:
                    # DB-only: leave any existing sidecar untouched.
                    source = "database"
                # Either way record whatever is actually on disk, as the scan will see it,
                # so a later scan's freshness check (index.is_fresh) doesn't see a mismatch
                # and re-read the file over this.
                sc_name, sc_mtime = sidecar.sidecar_tracking(p)
                # One unit: update_geotag clears the derived place names and the
                # follow-up repopulates them, so a failure between the two can't
                # leave a tagged photo with its location columns wiped.
                with index.transaction():
                    index.update_geotag(photo_id, lat, lng, source, sc_name, sc_mtime,
                                        gps_accuracy=gps_accuracy)
                    if loc is not None:
                        index.update_photo_location(photo_id, loc)
            except Exception as e:
                logger.exception("Geotag write failed for photo %s", photo_id)
                failed.append({"id": photo_id, "error": _short_error(e)})
                continue
            results.append({
                "id": photo_id, "lat": lat, "lng": lng,
                "geotag_source": source, "sidecar_path": sc_name,
                "location": loc,
                "gps_accuracy": gps_accuracy,
                "previous": {"id": photo_id, "geotag": _geotag_state(row),
                             "expect": {"lat": lat, "lng": lng}},
            })
    finally:
        # Even a partial (or aborted) batch moved coordinates.
        _invalidate_caches()
    return {"results": results, "written": [r["id"] for r in results],
            "failed": failed, "not_found": not_found}


def remove_geotag(photo_ids: list[int]) -> dict:
    """Strip GPS from each photo's sidecar and clear it in the DB. Blocking.

    The removal must outlast a re-read even when the ORIGINAL has embedded GPS
    (which can't be stripped): update_geotag sets the DB marker upsert_photo
    honours, and the sidecar — when one exists, or is created here in
    sidecar-writing mode — carries sidecar.GPS_VOID, which also survives a DB
    rebuild. In DB-only mode with no sidecar the DB marker is the only record.

    Per-photo isolation and result shape as write_geotag."""
    lock = get_et_lock()
    results: list[dict] = []
    failed: list[dict] = []
    not_found: list[int] = []
    try:
        for photo_id in photo_ids:
            row = index.get_photo(photo_id)
            if not row:
                not_found.append(photo_id)
                continue
            try:
                p = Path(index.photo_path(row))
                with lock:
                    sidecar.remove_gps(p, create=config.WRITE_XMP_ON_GEOTAG)
                sc_name, sc_mtime = sidecar.sidecar_tracking(p)
                # gps_accuracy -1.0 ("none", as read_metadata reports it), not NULL, which
                # the freshness check reads as "never read" and would re-read the file.
                index.update_geotag(photo_id, None, None, "none", sc_name, sc_mtime,
                                    gps_accuracy=-1.0)
            except Exception as e:
                logger.exception("Geotag removal failed for photo %s", photo_id)
                failed.append({"id": photo_id, "error": _short_error(e)})
                continue
            results.append({"id": photo_id, "geotag_source": "none",
                            "previous": {"id": photo_id, "geotag": _geotag_state(row),
                                         "expect": {"lat": None, "lng": None}}})
    finally:
        _invalidate_caches()
    return {"results": results, "written": [r["id"] for r in results],
            "failed": failed, "not_found": not_found}


def set_geocode_ignored(photo_ids: list[int], ignored: bool) -> dict:
    """Mark (or unmark) photos as needing no location. DB-only; one transaction.
    Returns {"results": [{"id", "previous"}] for the photos that exist} — the
    snapshot undo_geotags takes to put each flag back."""
    db = index.get_db()
    before = {r["id"]: bool(r["geocode_ignored"]) for r in db.execute(
        "SELECT id, geocode_ignored FROM photos WHERE id IN (SELECT value FROM json_each(?))",
        (index.ids_json(photo_ids),))}
    index.set_geocode_ignored(photo_ids, ignored)
    # Not _invalidate_caches: no coordinate moved, so the hotspot clustering stands.
    from geotagger.services import work_queue_service
    work_queue_service.invalidate()
    return {"results": [
        {"id": pid, "previous": {"id": pid, "geocode_ignored": was,
                                 "expect": {"geocode_ignored": ignored}}}
        for pid, was in before.items()]}


def _same_coord(a: float | None, b: float | None) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= 1e-7  # index._COORD_EPSILON_DEG: float noise, not a move


def _changed_since(row, snap: dict) -> bool:
    """Whether the photo no longer holds what the commit being undone left — then
    someone (another tab, a rescan of an externally edited sidecar) has changed it
    since, and undo must not clobber that."""
    expect = snap.get("expect") or {}
    if snap.get("geotag") is not None:
        if not (_same_coord(row["lat"], expect.get("lat"))
                and _same_coord(row["lng"], expect.get("lng"))):
            return True
    if snap.get("geocode_ignored") is not None:
        if bool(row["geocode_ignored"]) != bool(expect.get("geocode_ignored")):
            return True
    return False


def _restore_geotag(row, state: dict) -> tuple[dict | None, str]:
    """Put one photo's geotag back to `state` (a _geotag_state snapshot), sidecar
    first and then the row, exactly as write_geotag orders it. Returns (location,
    source) for the reply.

    The sidecar is restored to what that state implies it held, not to a copy of
    the coordinates — a re-read has to land on the same state again:
      * 'sidecar': the location lived in the sidecar → write it back there (with
        the place names geocoded from it, as write_geotag would have written).
      * removed ('none' + geotag_removed): remove again — GPS_VOID in the sidecar
        (created only in sidecar-writing mode, like remove_geotag) + the DB marker.
      * 'embedded', 'database', or never located ('none', no marker): the sidecar
        held no location then, so clear_gps takes ours out of it; a re-read falls
        through to the original's GPS (embedded) or to nothing, and a 'database'
        row is kept by upsert_photo's keep rule. Writing the embedded coordinates
        INTO the sidecar instead would turn them into a user geotag that outranks
        the original forever after.
    Derived place names (loc_*) are re-geocoded from the restored point rather
    than copied from the snapshot: they are a function of the coordinates (D3/D5)
    and this keeps the row and the sidecar's names in agreement."""
    src = state["geotag_source"]
    lat, lng = state.get("lat"), state.get("lng")
    acc = state.get("gps_accuracy")
    has_point = lat is not None and lng is not None
    if src not in GEOTAG_SOURCES:
        raise ValueError(f"unknown geotag_source {src!r}")
    if has_point:
        validate_point(lat, lng)
    elif src != "none":
        raise ValueError(f"a {src!r} geotag needs coordinates")
    if src == "none":
        lat = lng = None
    removed = src == "none" and bool(state.get("geotag_removed"))

    p = Path(index.photo_path(row))
    loc = geocode.lookup(lat, lng) if lat is not None else None
    lock = get_et_lock()
    with lock:
        if src == "sidecar":
            sidecar.write_gps(p, lat, lng, location=loc,
                              gps_accuracy=sidecar.known_accuracy(acc))
        elif removed:
            sidecar.remove_gps(p, create=config.WRITE_XMP_ON_GEOTAG)
        else:
            sidecar.clear_gps(p)
    sc_name, sc_mtime = sidecar.sidecar_tracking(p)
    with index.transaction():
        index.update_geotag(row["id"], lat, lng, src, sc_name, sc_mtime,
                            gps_accuracy=acc, geotag_removed=removed)
        if loc is not None:
            index.update_photo_location(row["id"], loc)
    return loc, src


def undo_geotags(snapshots: list[dict]) -> dict:
    """Revert a commit using the `previous` snapshots its writers returned.
    Blocking; runs in the executor. Per-photo isolation and the result shape of
    write_geotag; a photo changed since the commit is reported in `failed` with
    `conflict: true` and left as it is now. Each result carries the photo's
    restored state so the client can update it without a refetch."""
    results: list[dict] = []
    failed: list[dict] = []
    not_found: list[int] = []
    try:
        for snap in snapshots:
            pid = snap["id"]
            row = index.get_photo(pid)
            if not row:
                not_found.append(pid)
                continue
            if _changed_since(row, snap):
                failed.append({"id": pid, "error": "changed since the commit", "conflict": True})
                continue
            try:
                loc = None
                if snap.get("geotag") is not None:
                    loc, _ = _restore_geotag(row, snap["geotag"])
                if snap.get("geocode_ignored") is not None:
                    index.set_geocode_ignored([pid], bool(snap["geocode_ignored"]))
            except Exception as e:
                logger.exception("Geotag undo failed for photo %s", pid)
                failed.append({"id": pid, "error": _short_error(e)})
                continue
            now = index.get_photo(pid)
            acc = now["gps_accuracy"]
            out = {
                "id": pid, "lat": now["lat"], "lng": now["lng"],
                "geotag_source": now["geotag_source"],
                "gps_accuracy": sidecar.known_accuracy(acc),
                "geocode_ignored": bool(now["geocode_ignored"]),
            }
            # Only a restored geotag changes the place names; an ignore-only undo
            # leaves them (and says nothing about them).
            if snap.get("geotag") is not None:
                out["location"] = loc
            results.append(out)
    finally:
        _invalidate_caches()
    return {"results": results, "written": [r["id"] for r in results],
            "failed": failed, "not_found": not_found}


# ── Proposing a location for a selection ──

# How far either side of a selected photo we'll look for an already-geotagged
# photo to copy from. One hour covers "same outing" without reaching into the
# next stop of the day.
DEFAULT_PROPOSE_WINDOW = 3600


def cluster_votes(votes: list[tuple[float, float, float | None, int | None]],
                  limit: int = 3) -> list[dict]:
    """Turn per-photo location votes into ranked candidates, richest first.

    Factored out of propose_locations so work_queue_service can label a batch
    with exactly what the propose bar will say when the user lands on it — the
    two must not drift.
    """
    if not votes:
        return []
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
    return candidates


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
    targets = db.execute(
        "SELECT id, photo_datetime FROM photos "
        f"WHERE id IN (SELECT value FROM json_each(?)) AND lat IS NULL AND {index.HAS_DATE_SQL}",
        (index.ids_json(photo_ids),),
    ).fetchall()
    if not targets:
        return empty(0)

    lo = min(r["photo_datetime"] for r in targets) - window
    hi = max(r["photo_datetime"] for r in targets) + window
    neighbors = db.execute(f"""
        SELECT id, lat, lng, photo_datetime FROM photos
        WHERE lat IS NOT NULL AND lng IS NOT NULL
          AND photo_datetime BETWEEN ? AND ? AND {index.HAS_DATE_SQL}
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

    candidates = cluster_votes(votes, limit)
    return {
        "candidates": candidates,
        "selected": len(targets),
        "voted": len(votes),
        "window_sec": window,
    }
