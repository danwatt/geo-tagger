"""Geotag write/remove/ignore and the time-neighbor location guesser."""

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geotagger import config, index, sidecar, geocode
from geotagger.executor import get_executor

router = APIRouter()


class GeotagRequest(BaseModel):
    ids: list[int]
    lat: float
    lng: float
    gps_accuracy: float | None = None

class RemoveGeotagRequest(BaseModel):
    ids: list[int]

class SetGeocodeIgnoredRequest(BaseModel):
    ids: list[int]
    ignored: bool = True


@router.post("/api/geotag")
async def api_geotag(req: GeotagRequest):
    # Reverse-geocode once for the shared drop point (executor avoids blocking the
    # event loop on the geocoder's one-time KD-tree load). loc is None when the
    # GeoNames data isn't installed, in which case we just skip the place names.
    loop = asyncio.get_running_loop()
    loc = await loop.run_in_executor(get_executor(), geocode.lookup, req.lat, req.lng)

    results = []
    for photo_id in req.ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(index.photo_path(row))
        if config.WRITE_XMP_ON_GEOTAG:
            sc = sidecar.write_gps(p, req.lat, req.lng, location=loc, gps_accuracy=req.gps_accuracy)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            source, sc_name = "sidecar", sc.name
        else:
            # DB-only: leave any existing sidecar untouched and record whatever
            # is actually on disk, so a later scan's freshness check (index.is_fresh)
            # doesn't see a mismatch and re-read a stale/absent sidecar over this.
            sc = sidecar.sidecar_path(p)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            source, sc_name = "database", (sc.name if sc.exists() else None)
        index.update_geotag(photo_id, req.lat, req.lng, source, sc_name, sc_mtime, gps_accuracy=req.gps_accuracy)
        if loc is not None:
            index.update_photo_location(photo_id, loc)
        results.append({
            "id": photo_id, "lat": req.lat, "lng": req.lng,
            "geotag_source": source, "sidecar_path": sc_name,
            "location": loc,
            "gps_accuracy": req.gps_accuracy,
        })
    return results


@router.post("/api/geotag/ignore")
async def api_geotag_ignore(req: SetGeocodeIgnoredRequest):
    """Mark (or unmark) photos as not needing geocoding, e.g. screenshots.
    DB-only — no EXIF/sidecar write. Ignored photos still appear in the grid
    but count as geotagged for the Show filter and geotagged/not-geotagged stats."""
    index.set_geocode_ignored(req.ids, req.ignored)
    return {"ids": req.ids, "geocode_ignored": req.ignored}


@router.get("/api/guess/{photo_id}")
async def api_guess(photo_id: int, window: int = 900):
    """Return a guessed lat/lng from nearby-in-time geotagged photos (±window seconds).
    Falls back to the centroid of a matched Life Context when no time-neighbors exist."""
    import json as _json
    from geotagger.contexts import point_in_polygon, polygon_centroid
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    if row["lat"] is not None:
        raise HTTPException(400, "Photo already has a geotag")
    ts = row["photo_datetime"]
    if not ts or ts <= 0:
        raise HTTPException(400, "Photo has no timestamp — cannot guess location")

    # Look up matching contexts by timestamp (polygon is the answer, not a filter)
    matched_contexts = index.contexts_for_time(ts)
    ctx_payload = [{"id": c["id"], "name": c["name"], "polygon": _json.loads(c["polygon"])}
                   for c in matched_contexts]

    db = index.get_db()
    nearby = db.execute("""
        SELECT id, lat, lng, filename, photo_datetime FROM photos
        WHERE lat IS NOT NULL
          AND photo_datetime > 0
          AND photo_datetime BETWEEN ? AND ?
          AND id != ?
        ORDER BY ABS(photo_datetime - ?) ASC
        LIMIT 50
    """, (ts - window, ts + window, photo_id, ts)).fetchall()

    # When contexts exist, constrain to in-polygon neighbors only
    if nearby and matched_contexts:
        in_ctx = [r for r in nearby if any(
            point_in_polygon(r["lat"], r["lng"], _json.loads(c["polygon"]))
            for c in matched_contexts
        )]
        if in_ctx:
            nearby = in_ctx

    if nearby:
        weights = [1.0 / (abs(r["photo_datetime"] - ts) + 1) for r in nearby]
        total_w = sum(weights)
        avg_lat = sum(r["lat"] * w for r, w in zip(nearby, weights)) / total_w
        avg_lng = sum(r["lng"] * w for r, w in zip(nearby, weights)) / total_w
        return {
            "lat": avg_lat,
            "lng": avg_lng,
            "source": "time-neighbors",
            "source_count": len(nearby),
            "window_sec": window,
            "sources": [{"id": r["id"], "filename": r["filename"],
                         "lat": r["lat"], "lng": r["lng"],
                         "delta_sec": abs(r["photo_datetime"] - ts),
                         "is_before": r["photo_datetime"] < ts} for r in nearby],
            "contexts": ctx_payload,
        }

    # No usable neighbors — fall back to context centroid if a context matched
    if matched_contexts:
        # Pick the most specific (smallest-area) context
        def _area(c):
            verts = _json.loads(c["polygon"])
            lat_span = (c["max_lat"] or 0) - (c["min_lat"] or 0)
            lng_span = (c["max_lng"] or 0) - (c["min_lng"] or 0)
            return lat_span * lng_span
        best = min(matched_contexts, key=_area)
        verts = _json.loads(best["polygon"])
        clat, clng = polygon_centroid(verts)
        return {
            "lat": clat,
            "lng": clng,
            "source": "context-centroid",
            "source_count": 0,
            "window_sec": window,
            "sources": [],
            "contexts": ctx_payload,
        }

    raise HTTPException(404, detail="No geotagged photos found within the time window")


@router.post("/api/geotag/remove")
async def api_geotag_remove(req: RemoveGeotagRequest):
    results = []
    for photo_id in req.ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(index.photo_path(row))
        sc = sidecar.remove_gps(p)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.update_geotag(photo_id, None, None, "none", str(sc), sc_mtime)
        results.append({"id": photo_id, "geotag_source": "none"})
    return results

