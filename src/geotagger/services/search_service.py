"""/api/search's blocking work: run the filters, optionally rank by the semantic
model, and cut one page — reporting the true match count, paging cursors and a
timeline histogram for the *whole* result set (A3: the page used to be the
result set, so "2,000 photos found" silently meant "the first 2,000").
Framework-free; called from the route via run_in_executor."""

import logging
import math
import time

from geotagger import index, serializers
from geotagger.services import semantic_service

logger = logging.getLogger(__name__)

_DAY = 86400


def run_search(filters: dict, *, sort: str, text: str | None, similar_to: int | None,
               limit: int, offset: int, ids_only: bool) -> dict:
    """One page of matches for ``filters`` (index.search_photos keywords).

    Plain search pages in SQL (LIMIT/OFFSET over a stable, id-tiebroken order) and
    counts with a separate unordered scan of one column. Ranked search (``text`` /
    ``similar_to``) has to score the whole filtered candidate set anyway, so it
    takes ids only for every candidate, ranks them, and fetches full rows for just
    the page — "truncated" there means "the top N by relevance".

    ``ids_only`` skips the page and returns every match's id and photo_datetime in
    result order (Select all / Open in Geocode across a truncated result)."""
    t0 = time.perf_counter()
    ranked = bool(text or similar_to)
    if not ranked:
        if ids_only:
            keys = index.search_photos(**filters, sort=sort, limit=None, ids_only=True)
            return _ids_response([(r["id"], r["photo_datetime"]) for r in keys])
        datetimes = index.search_photo_datetimes(**filters)
        rows = index.search_photos(**filters, sort=sort, limit=limit, offset=offset)
        photos = [serializers.photo_to_dict(r) for r in rows]
        out = _page(photos, len(datetimes), offset, limit, datetimes)
    else:
        # Candidate set in the requested order (date order stands in for
        # relevance until scoring reorders it). Ids only: this can be the whole
        # library, and only one page of it needs full rows.
        keys = index.search_photos(**filters, sort="date_asc" if sort == "relevance" else sort,
                                   limit=None, ids_only=True)
        dt_by_id = {r["id"]: r["photo_datetime"] for r in keys}
        hits = (semantic_service.search_text(text, list(dt_by_id)) if text
                else semantic_service.similar_to(similar_to, list(dt_by_id)))
        if sort != "relevance":
            # Keep the score filter but honour the requested ordering.
            keep = dict(hits)
            ordered = [(r["id"], keep[r["id"]]) for r in keys if r["id"] in keep]
        else:
            # semantic.rank is a stable argsort over id-ordered vectors, so equal
            # scores already come back in id order; pages stay disjoint.
            ordered = hits
        if ids_only:
            return _ids_response([(pid, dt_by_id[pid]) for pid, _ in ordered])
        page = ordered[offset:offset + limit]
        rows = {r["id"]: r for r in index.get_photos(ids=[pid for pid, _ in page])}
        photos = []
        for pid, score in page:
            if pid not in rows:   # deleted between the two queries
                continue
            d = serializers.photo_to_dict(rows[pid])
            d["score"] = round(score, 3)
            photos.append(d)
        out = _page(photos, len(ordered), offset, limit,
                    [dt_by_id[pid] for pid, _ in ordered])
    logger.info(f"search ranked={ranked} total={out['total']} offset={offset} "
                f"returned={len(out['photos'])} {(time.perf_counter() - t0) * 1000:.2f}ms")
    return out


def _page(photos: list[dict], total: int, offset: int, limit: int,
          datetimes: list[int | None]) -> dict:
    """The /api/search envelope. ``next_offset`` is where the next page starts, or
    None once this page reaches ``total``; ``truncated`` is true whenever this
    response holds fewer than every match (any page but a complete first one)."""
    end = offset + len(photos)
    return {
        "photos": photos, "total": total, "offset": offset, "limit": limit,
        "next_offset": end if photos and end < total else None,
        "truncated": len(photos) < total,
        "histogram": timeline_histogram(datetimes),
    }


def _ids_response(pairs: list[tuple[int, int | None]]) -> dict:
    return {"ids": [p for p, _ in pairs], "datetimes": [d for _, d in pairs],
            "total": len(pairs)}


def timeline_histogram(datetimes: list[int | None]) -> dict | None:
    """Bucketed counts of the dated matches for the Search page's timeline, or None
    with fewer than two dated photos (nothing to draw a span for). NULL and 0 are
    both "undated" (index.has_date_sql); pre-1970 dates are negative and kept.

    Buckets are a day for spans up to 90 days, a week up to a year, else 30 days;
    bucket ``i`` starts at ``min + i * bucket_secs``."""
    dated = [t for t in datetimes if t]
    if len(dated) < 2:
        return None
    lo, hi = min(dated), max(dated)
    span_days = (hi - lo) / _DAY
    bucket = _DAY if span_days <= 90 else 7 * _DAY if span_days <= 365 else 30 * _DAY
    counts = [0] * (math.ceil((hi - lo) / bucket) + 1)
    for t in dated:
        counts[(t - lo) // bucket] += 1
    return {"min": lo, "max": hi, "bucket_secs": bucket, "counts": counts}
