"""The work queue: untagged photos rolled up into *batches*, each one decision.

"33,109 remaining" is not a task. One outing from one camera, or one scanned
folder, is — the user recognises it from three thumbnails, sees a proposed place,
and commits the lot. This service computes that ranked list; nothing here is
stored, so a batch evaporates on its own as soon as its members are tagged or
ignored.

Two kinds of batch (see docs/work-queue.md §2):
  session — untagged dated photos from one camera with no gap > SESSION_GAP
  folder  — untagged photos sharing a `dir` that is mostly untagged

Blocking (a couple of full-column scans plus geocode lookups); runs in the
executor. Cached until a geotag/ignore write invalidates it.
"""

import bisect
import logging
import threading
import time

from geotagger import config, index
from geotagger.services import geotag_service

logger = logging.getLogger(__name__)

# How far either side of an untagged photo we look for a geotagged neighbour to
# vote for. Same window the propose bar uses, so the label on a queue card is the
# label the user sees on arrival.
PROPOSE_WINDOW = geotag_service.DEFAULT_PROPOSE_WINDOW

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Manufacturer boilerplate that makes a camera name unreadable in a one-line
# title ("NIKON CORPORATION NIKON D300" → "NIKON D300").
_CAMERA_NOISE = {"corporation", "corp", "corp.", "company", "co", "co.",
                 "inc", "inc.", "ltd", "ltd.", "imaging", "optical"}

# {min_size: queue dict}. Small — the UI uses one size — and cheap to drop whole.
_cache: dict[int, dict] = {}
_cache_lock = threading.Lock()


def _cfg(value, key: str):
    """Resolve an optional override against the live (settings-page-overridable)
    config value — see faces._cfg for why this can't be a signature default."""
    return getattr(config, key) if value is None else value


# ── Labels ──

def short_camera(camera: str | None) -> str:
    """Readable camera name for a batch title: drop manufacturer boilerplate and
    words the model already repeats."""
    if not camera:
        return "Unknown camera"
    out: list[str] = []
    for word in camera.split():
        low = word.lower()
        if low in _CAMERA_NOISE or low in {w.lower() for w in out}:
            continue
        out.append(word)
    return " ".join(out) or camera


def short_dir(d: str) -> str:
    """Last two path components of a directory, elided in front. Full paths are
    unreadable in a list row and the tail is what identifies the folder."""
    parts = [p for p in d.replace("\\", "/").split("/") if p]
    if len(parts) <= 2:
        return d
    sep = "\\" if "\\" in d else "/"
    return "…" + sep + sep.join(parts[-2:])


def _ymd(ts: int) -> tuple[int, int, int]:
    """(year, month, day) of a timestamp, read as UTC — photo_datetime is stored
    wall-clock-as-UTC, so local-time conversion would shift dates by the offset."""
    from datetime import datetime, timezone
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.year, dt.month, dt.day


def date_span_label(start_ts: int | None, end_ts: int | None) -> str:
    """"Oct 12 2024", "Oct 12–13 2024", or "Oct 12 – Nov 2 2024"."""
    if not start_ts:
        return "no date"
    y1, m1, d1 = _ymd(start_ts)
    y2, m2, d2 = _ymd(end_ts or start_ts)
    if (y1, m1, d1) == (y2, m2, d2):
        return f"{_MONTHS[m1 - 1]} {d1} {y1}"
    if (y1, m1) == (y2, m2):
        return f"{_MONTHS[m1 - 1]} {d1}–{d2} {y1}"
    if y1 == y2:
        return f"{_MONTHS[m1 - 1]} {d1} – {_MONTHS[m2 - 1]} {d2} {y1}"
    return f"{_MONTHS[m1 - 1]} {d1} {y1} – {_MONTHS[m2 - 1]} {d2} {y2}"


def _samples(ids: list[int]) -> list[int]:
    """First, middle and last member — three frames is enough to recognise an
    outing, and the ends plus the middle show whether the batch is coherent."""
    if len(ids) <= 3:
        return list(ids)
    return [ids[0], ids[len(ids) // 2], ids[-1]]


# ── Building ──

def _collect_votes(db) -> dict[int, tuple[float, float, float | None, int]]:
    """photo_id → the location of its nearest-in-time geotagged photo, for every
    untagged dated photo that has one within PROPOSE_WINDOW.

    Computed once globally rather than once per batch: sort every tagged photo's
    timestamp, bisect each untagged one into it, take the better of the two
    straddling neighbours. Same sweep api_stats_summary runs to count `guessable`,
    but remembering *which* neighbour won.
    """
    neighbors = db.execute("""
        SELECT id, lat, lng, photo_datetime FROM photos
        WHERE lat IS NOT NULL AND lng IS NOT NULL AND photo_datetime > 0
        ORDER BY photo_datetime
    """).fetchall()
    if not neighbors:
        return {}
    times = [r["photo_datetime"] for r in neighbors]

    targets = db.execute("""
        SELECT id, photo_datetime FROM photos
        WHERE lat IS NULL AND geocode_ignored = 0 AND photo_datetime > 0
    """).fetchall()

    votes: dict[int, tuple[float, float, float | None, int]] = {}
    for t in targets:
        ts = t["photo_datetime"]
        i = bisect.bisect_left(times, ts)
        best, best_d = None, PROPOSE_WINDOW
        for j in (i - 1, i):
            if not (0 <= j < len(neighbors)):
                continue
            r = neighbors[j]
            d = abs(r["photo_datetime"] - ts)
            if d <= best_d:
                best, best_d = r, d
        if best is not None:
            votes[t["id"]] = (best["lat"], best["lng"], best["photo_datetime"], best["id"])
    return votes


def _proposal(member_ids: list[int], votes: dict) -> tuple[dict | None, int]:
    """Top candidate for a batch, plus how many of its members voted at all."""
    batch_votes = [votes[pid] for pid in member_ids if pid in votes]
    if not batch_votes:
        return None, 0
    candidates = geotag_service.cluster_votes(batch_votes, limit=1)
    if not candidates:
        return None, len(batch_votes)
    c = candidates[0]
    return {
        "lat": c["lat"], "lng": c["lng"],
        "votes": c["votes"],
        "label": c["label"],
        "location": c["location"],
        "sample_photo_id": c["sample_photo_id"],
    }, len(batch_votes)


def _sessions(rows: list, votes: dict, session_gap: int) -> list[dict]:
    """Split untagged dated photos into one-camera, one-outing runs."""
    dated = sorted((r for r in rows if (r["photo_datetime"] or 0) > 0),
                   key=lambda r: (r["camera"] or "", r["photo_datetime"], r["id"]))
    batches = []
    run: list = []

    def flush():
        if not run:
            return
        ids = [r["id"] for r in run]
        camera = run[0]["camera"] or None  # '' = no camera tags; same as NULL here
        start_ts, end_ts = run[0]["photo_datetime"], run[-1]["photo_datetime"]
        proposal, voted = _proposal(ids, votes)
        batches.append({
            "id": f"s:{camera or ''}:{start_ts}",
            "kind": "session",
            "title": f"{date_span_label(start_ts, end_ts)} · {short_camera(camera)}",
            "count": len(ids),
            "camera": camera,
            "dir": run[0]["dir"],
            "start_ts": start_ts,
            "end_ts": end_ts,
            "sample_photo_ids": _samples(ids),
            "confidence": voted / len(ids),
            "proposal": proposal,
            "member_ids": ids,
        })

    for r in dated:
        if run and ((r["camera"] or "") != (run[-1]["camera"] or "")
                    or r["photo_datetime"] - run[-1]["photo_datetime"] > session_gap):
            flush()
            run = []
        run.append(r)
    flush()
    return batches


def _folders(db, rows: list, votes: dict, folder_min_frac: float) -> list[dict]:
    """Directories that are mostly untagged: the folder *is* the event ("1985 Box")."""
    by_dir: dict[str, list] = {}
    for r in rows:
        by_dir.setdefault(r["dir"], []).append(r)

    totals = {r["dir"]: r["n"] for r in db.execute(
        "SELECT dir, COUNT(*) AS n FROM photos GROUP BY dir").fetchall()}

    batches = []
    for d, members in by_dir.items():
        total = totals.get(d, len(members))
        if total <= 0 or len(members) / total < folder_min_frac:
            continue
        members.sort(key=lambda r: (r["photo_datetime"] or 0, r["id"]))
        ids = [r["id"] for r in members]
        stamps = [r["photo_datetime"] for r in members if (r["photo_datetime"] or 0) > 0]
        proposal, voted = _proposal(ids, votes)
        cameras = [r["camera"] for r in members if r["camera"]]
        batches.append({
            "id": f"f:{d}",
            "kind": "folder",
            "title": "📁 " + short_dir(d),
            "count": len(ids),
            "camera": max(set(cameras), key=cameras.count) if cameras else None,
            "dir": d,
            "start_ts": min(stamps) if stamps else None,
            "end_ts": max(stamps) if stamps else None,
            "sample_photo_ids": _samples(ids),
            "confidence": voted / len(ids),
            "proposal": proposal,
            "member_ids": ids,
        })
    return batches


def build(min_size: int | None = None, session_gap: int | None = None,
          folder_min_frac: float | None = None) -> dict:
    """The full ranked queue. Blocking; call through get_queue(), which caches."""
    t0 = time.time()
    min_size = _cfg(min_size, "WORKQUEUE_MIN_SIZE")
    session_gap = _cfg(session_gap, "WORKQUEUE_SESSION_GAP")
    folder_min_frac = _cfg(folder_min_frac, "WORKQUEUE_FOLDER_MIN_FRAC")

    db = index.get_db()
    rows = db.execute("""
        SELECT id, photo_datetime, camera, dir FROM photos
        WHERE lat IS NULL AND geocode_ignored = 0
    """).fetchall()
    total_photos = len(rows)
    votes = _collect_votes(db) if rows else {}

    batches = _sessions(rows, votes, session_gap) + _folders(db, rows, votes, folder_min_frac)

    kept = []
    for b in batches:
        if b["count"] < min_size:
            continue
        # A 500-photo session with a guess beats a 900-photo one without.
        b["score"] = b["count"] * (1 + b["confidence"])
        kept.append(b)
    # The tail is what no *listed* batch covers. A union, not a sum of the dropped
    # batches: a photo in a too-small session can still be inside a big folder batch.
    covered: set[int] = set()
    for b in kept:
        covered.update(b["member_ids"])
    tail_photos = total_photos - len(covered)
    # Ties break newest-first: recent trips are the ones the user can still place.
    kept.sort(key=lambda b: (-b["score"], -(b["end_ts"] or 0)))

    queue = {
        "built_at": time.time(),
        "batches": kept,
        "tail_photos": tail_photos,
        "total_photos": total_photos,
    }
    logger.info(f"Work queue: {len(kept)} batches over {total_photos} untagged "
                f"photos in {(time.time() - t0) * 1000:.2f}ms")
    return queue


def _queue(min_size: int | None = None) -> dict:
    """Cached build(). A stale queue is harmless — the client re-counts what is
    still untagged on arrival — so there's no TTL, only explicit invalidation."""
    size = _cfg(min_size, "WORKQUEUE_MIN_SIZE")
    with _cache_lock:
        cached = _cache.get(size)
    if cached is not None:
        return cached
    queue = build(min_size=size)
    with _cache_lock:
        _cache[size] = queue
    return queue


def invalidate() -> None:
    """Drop the cached queue. Called wherever a write can tag, untag or ignore a
    photo — the same places hotspots_service.invalidate() is called."""
    with _cache_lock:
        _cache.clear()


# ── Reads ──

def _public(batch: dict) -> dict:
    """The batch as the API returns it — member_ids is an internal bookkeeping
    field (thousands of ints per batch) and never goes over the wire; the client
    gets the live list from get_batch instead."""
    return {k: v for k, v in batch.items() if k != "member_ids"}


def get_queue(limit: int = 20, offset: int = 0, kind: str = "all",
              min_size: int | None = None) -> dict:
    """One page of the queue, plus the totals Home needs to make the numbers add up."""
    q = _queue(min_size)
    batches = q["batches"]
    if kind in ("session", "folder"):
        batches = [b for b in batches if b["kind"] == kind]
    covered: set[int] = set()
    for b in batches:
        covered.update(b["member_ids"])
    return {
        "batches": [_public(b) for b in batches[offset:offset + limit]],
        "total_batches": len(batches),
        "batched_photos": len(covered),
        "total_photos": q["total_photos"],
        "tail_photos": q["tail_photos"],
        "built_at": q["built_at"],
    }


def _live_member_ids(batch: dict) -> list[int]:
    """The batch's *still-untagged* members, read fresh. The cached record is a
    snapshot; after a partial commit the client's selection must be what is left."""
    db = index.get_db()
    if batch["kind"] == "folder":
        rows = db.execute(
            "SELECT id FROM photos WHERE dir = ? AND lat IS NULL AND geocode_ignored = 0 "
            "ORDER BY photo_datetime, id", (batch["dir"],)).fetchall()
    else:
        rows = db.execute(
            # No-camera rows are '' once scanned, NULL on rows from before that
            # sentinel existed; a session groups the two together, so match both.
            "SELECT id FROM photos WHERE (camera = ? OR (? = '' AND camera IS NULL)) "
            "AND photo_datetime BETWEEN ? AND ? "
            "AND lat IS NULL AND geocode_ignored = 0 ORDER BY photo_datetime, id",
            (batch["camera"] or "", batch["camera"] or "",
             batch["start_ts"], batch["end_ts"])).fetchall()
    return [r["id"] for r in rows]


def _resolve(batch_id: str, queue: dict, session_gap: int | None = None) -> dict | None:
    """Find the batch a (possibly stale) id refers to.

    Exact match normally. A partially-committed session is the exception: its id
    carries the first member's timestamp, and tagging the front of it moves that
    head forward, so the rebuilt queue lists the remainder under a new id. The
    surviving session from the same camera that starts within one gap of the old
    head *is* that batch, so adopt it — otherwise a reload mid-batch would 404 on
    a batch the user is still working through.
    """
    exact = next((b for b in queue["batches"] if b["id"] == batch_id), None)
    if exact is not None or not batch_id.startswith("s:"):
        return exact
    _, _, rest = batch_id.partition("s:")
    camera, _, start = rest.rpartition(":")
    try:
        start_ts = int(start)
    except ValueError:
        return None
    gap = _cfg(session_gap, "WORKQUEUE_SESSION_GAP")
    heirs = [b for b in queue["batches"]
             if b["kind"] == "session" and (b["camera"] or "") == camera
             and b["start_ts"] is not None and abs(b["start_ts"] - start_ts) <= gap]
    return min(heirs, key=lambda b: abs(b["start_ts"] - start_ts)) if heirs else None


def get_batch(batch_id: str, min_size: int | None = None) -> dict | None:
    """One batch plus its live member ids; None once nothing in it is untagged."""
    q = _queue(min_size)
    batch = _resolve(batch_id, q)
    if batch is None:
        return None
    ids = _live_member_ids(batch)
    if not ids:
        return None
    position = q["batches"].index(batch)
    return {**_public(batch), "photo_ids": ids,
            "position": position, "total_batches": len(q["batches"])}


def get_next(skip: list[str] | None = None, kind: str = "all",
             min_size: int | None = None) -> dict | None:
    """Head of the queue, ignoring ids the client has skipped this session."""
    skipped = set(skip or ())
    q = _queue(min_size)
    for b in q["batches"]:
        if b["id"] in skipped or (kind in ("session", "folder") and b["kind"] != kind):
            continue
        full = get_batch(b["id"], min_size=min_size)
        if full is not None:
            return full
    return None
