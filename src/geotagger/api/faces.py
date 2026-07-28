"""Faces, persons, families, and crowd management endpoints."""

import asyncio
import logging
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from geotagger import index, faces, thumbnails, serializers, config
from geotagger.executor import get_executor
from geotagger.services import faces_service

logger = logging.getLogger(__name__)
router = APIRouter()


def _in_window(ts, start_ts: int | None, end_ts: int | None) -> bool:
    """True if a photo timestamp falls in an optional [start_ts, end_ts] window.
    Undated photos (ts None/0) fall outside any active window."""
    if start_ts is None and end_ts is None:
        return True
    if not ts:
        return False
    return (start_ts is None or ts >= start_ts) and (end_ts is None or ts <= end_ts)


def _spatial_photo_ids(spatial_context_id: int | None) -> list[int] | None:
    """Resolve the People page's spatial Focus ("also limit to this area") to the
    set of photo ids inside a context's polygon, or None when it's off (the query
    then stays time-only). An empty list is a real answer — the area has no
    geotagged photos — and correctly yields empty windowed views."""
    if spatial_context_id is None:
        return None
    return index.get_context_photo_ids(spatial_context_id)


class CreatePersonRequest(BaseModel):
    name: str

class UpdatePersonRequest(BaseModel):
    name: str | None = None
    birth_date: str | None = None  # ISO YYYY-MM-DD, or null to clear
    not_before: str | None = None  # ISO YYYY-MM-DD, or null to clear
    not_after: str | None = None   # ISO YYYY-MM-DD, or null to clear
    family_id: int | None = None   # family id, or null to clear

class FamilyRequest(BaseModel):
    name: str

class AssignFaceRequest(BaseModel):
    person_id: int | None = None  # None clears the assignment
    name: str | None = None       # convenience: create/lookup a person by name

class BulkAssignRequest(BaseModel):
    face_ids: list[int]
    person_id: int | None = None
    name: str | None = None
    clear: bool = False           # set True to unassign the faces

class IgnoreFacesRequest(BaseModel):
    face_ids: list[int]
    ignored: bool = True          # False restores faces to the unlabeled queue

class ComeBackFacesRequest(BaseModel):
    face_ids: list[int]
    come_back: bool = True        # False restores faces to the unlabeled queue

class NegativeFacesRequest(BaseModel):
    face_ids: list[int]
    person_id: int          # the person these faces are NOT
    negative: bool = True   # False removes the exclusion (undo)

class ScanFacesRequest(BaseModel):
    limit: int = 50  # photos processed per call; repeat to continue

class NukePhotoFacesRequest(BaseModel):
    photo_ids: list[int]  # hard-wipe every face + cached rendition for these photos

class AddManualFaceRequest(BaseModel):
    bbox: list[float]             # [x1, y1, x2, y2], normalized 0..1, DISPLAY space
    person_id: int | None = None  # or name, to create/find a person; both optional
    name: str | None = None


@router.get("/api/persons")
async def api_get_persons(
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
    spatial_context_id: int | None = Query(None),
):
    """List persons. With a start_ts/end_ts window (the People page's time Focus)
    and/or spatial_context_id (its "also limit to this area" Focus — photos inside
    that context's polygon), people with no faces in range are omitted. No
    face_count in either case — see index.get_persons."""
    photo_ids = _spatial_photo_ids(spatial_context_id)
    return [
        {"id": p["id"], "name": p["name"],
         "birth_date": p["birth_date"], "not_before": p["not_before"],
         "not_after": p["not_after"], "created_at": p["created_at"],
         "family_id": p["family_id"], "family_name": p["family_name"]}
        for p in index.get_persons(start_ts=start_ts, end_ts=end_ts, photo_ids=photo_ids)
    ]


def _parse_optional_date(label: str, value: str | None) -> str | None:
    from datetime import datetime as _dt
    v = value.strip() if value else None
    if v:
        try:
            _dt.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, f"{label} must be in YYYY-MM-DD format")
    return v


@router.patch("/api/persons/{person_id}")
async def api_update_person(person_id: int, req: UpdatePersonRequest):
    """Update a person's name, birth/not-before/not-after dates, and/or family.
    Only fields present in the request body are changed — send just the fields
    you want to update."""
    fields = req.model_fields_set
    if "name" in fields:
        name = (req.name or "").strip()
        if not name:
            raise HTTPException(400, "Name cannot be empty")
        index.rename_person(person_id, name)
    if "birth_date" in fields:
        index.set_person_birth_date(person_id, _parse_optional_date("birth_date", req.birth_date))
    if "not_before" in fields:
        index.set_person_not_before(person_id, _parse_optional_date("not_before", req.not_before))
    if "not_after" in fields:
        index.set_person_not_after(person_id, _parse_optional_date("not_after", req.not_after))
    if "family_id" in fields:
        index.set_person_family(person_id, req.family_id)
    return {"id": person_id}


# ── Family endpoints ──

@router.get("/api/families")
async def api_get_families():
    return [{"id": f["id"], "name": f["name"], "person_count": f["person_count"]}
            for f in index.get_families()]


@router.post("/api/families")
async def api_create_family(req: FamilyRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    family_id = index.create_family(name)
    return {"id": family_id, "name": name, "person_count": 0}


@router.patch("/api/families/{family_id}")
async def api_rename_family(family_id: int, req: FamilyRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    index.rename_family(family_id, name)
    return {"id": family_id, "name": name}


@router.delete("/api/families/{family_id}")
async def api_delete_family(family_id: int):
    index.delete_family(family_id)
    return {"success": True}


@router.post("/api/persons")
async def api_create_person(req: CreatePersonRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    person_id = index.get_or_create_person(name)
    return {"id": person_id, "name": name}


@router.delete("/api/persons/{person_id}")
async def api_delete_person(person_id: int):
    index.delete_person(person_id)
    return {"success": True}


@router.get("/api/faces")
async def api_list_faces(
    scope: str = Query("unlabeled", pattern="^(unlabeled|person|ignored|come_back|suggested|recent|all)$"),
    person_id: int | None = Query(None),
    limit: int = Query(500, ge=1, le=20000),
    suggested_only: bool = Query(False),
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
    spatial_context_id: int | None = Query(None),
):
    """List faces. scope=unlabeled attaches a recognition suggestion to each face;
    scope=suggested returns only unlabeled faces whose *best* guess is `person_id`,
    ranked by confidence — for quickly approving one person's guesses in bulk.
    suggested_only (scope=unlabeled) drops faces with no guess, scanning up to the
    suggest cap so it finds matches beyond the first detection-ranked page.

    start_ts/end_ts (epoch secs) are the People page's time Focus; spatial_context_id
    is its "also limit to this area" Focus (photos inside that context's polygon).
    Both window the candidate faces for the unlabeled and suggested scopes only
    (person/all/recent/ignored ignore them, and the recognition gallery stays global
    either way)."""
    neg_map = faces.get_negatives_map()

    if scope == "unlabeled" and suggested_only:
        loop = asyncio.get_running_loop()
        rows, matches = await loop.run_in_executor(
            get_executor(),
            faces.get_suggested_scores,
        )
        names = serializers.person_name_map()
        pid_set = _spatial_photo_ids(spatial_context_id)
        pid_set = set(pid_set) if pid_set is not None else None
        scored = [(r, m) for r, m in zip(rows, matches)
                  if m and _in_window(r["photo_datetime"], start_ts, end_ts)
                     and (pid_set is None or r["photo_id"] in pid_set)]
        scored.sort(key=lambda rm: rm[1][1], reverse=True)  # most confident first
        total = len(scored)
        out = []
        for r, (pid, score) in scored[:limit]:
            item = serializers.face_item(r)
            item["suggestion"] = {"person_id": pid, "person_name": names.get(pid),
                                  "score": round(score, 4)}
            item["negatives"] = sorted(neg_map.get(r["id"], ()))
            out.append(item)
        return {"faces": out, "total": total, "returned": len(out)}

    if scope == "suggested":
        if not person_id:
            raise HTTPException(400, "person_id is required for scope=suggested")
        _t0 = time.perf_counter()
        gallery = faces.build_gallery()
        _t1 = time.perf_counter()
        names = serializers.person_name_map()
        name = names.get(person_id)
        scored = []
        _unlabeled_n = 0
        if len(gallery) > 0:
            rows, unknowns, _u_times = faces.get_unlabeled_matrix()
            # Focus narrows the candidates (gallery stays global): by time, and by
            # a context's polygon when "also limit to this area" is on.
            _pids = _spatial_photo_ids(spatial_context_id)
            rows, unknowns, _u_times = faces.window_rows(
                rows, unknowns, _u_times, start_ts, end_ts, _pids)
            _t2 = time.perf_counter()
            _unlabeled_n = len(rows)
            loop = asyncio.get_running_loop()
            scored = await loop.run_in_executor(
                get_executor(),
                lambda: faces.suggest_for_person(rows, gallery, person_id,
                                                 unknowns=unknowns, times=_u_times),
            )
            _t3 = time.perf_counter()
        else:
            _t2 = _t3 = time.perf_counter()
        scored.sort(key=lambda t: t[1], reverse=True)
        logger.info(
            "scope=suggested person_id=%d gallery=%d unlabeled=%d candidates=%d "
            "build_gallery=%.3fs get_matrix=%.3fs suggest=%.3fs total=%.3fs",
            person_id, len(gallery), _unlabeled_n, len(scored),
            _t1 - _t0, _t2 - _t1, _t3 - _t2, _t3 - _t0,
        )
        out = []
        for r, score, alts in scored[:limit]:
            item = serializers.face_item(r)
            item["suggestion"] = {"person_id": person_id, "person_name": name,
                                  "score": round(score, 4)}
            item["alternatives"] = [
                {"person_id": pid, "person_name": names.get(pid), "score": round(s, 4)}
                for pid, s in alts
            ]
            item["negatives"] = sorted(neg_map.get(r["id"], ()))
            out.append(item)
        return {"faces": out, "total": len(scored), "returned": len(out)}

    # The Focus applies to the unlabeled queue only; other scopes ignore it.
    w_start, w_end = (start_ts, end_ts) if scope == "unlabeled" else (None, None)
    w_pids = _spatial_photo_ids(spatial_context_id) if scope == "unlabeled" else None
    rows = index.list_faces(scope=scope, person_id=person_id, limit=limit,
                            start_ts=w_start, end_ts=w_end, photo_ids=w_pids)
    gallery = faces.build_gallery() if scope == "unlabeled" else None
    matches = (faces.suggest_persons_batch(rows, gallery)
               if gallery is not None and len(gallery) > 0 else [None] * len(rows))
    names = serializers.person_name_map() if any(matches) else {}
    out = []
    for r, match in zip(rows, matches):
        item = serializers.face_item(r)
        if match:
            pid, score = match
            item["suggestion"] = {"person_id": pid, "person_name": names.get(pid),
                                  "score": round(score, 4)}
        item["negatives"] = sorted(neg_map.get(r["id"], ()))
        out.append(item)
    return {
        "faces": out,
        "total": index.count_faces(scope=scope, person_id=person_id,
                                   start_ts=w_start, end_ts=w_end, photo_ids=w_pids),
        "returned": len(out),
    }


@router.get("/api/faces/{face_id}/crop")
async def api_face_crop(face_id: int, request: Request):
    row = index.get_face_with_photo(face_id)
    if not row:
        raise HTTPException(404)
    bbox = tuple(float(v) for v in row["bbox"].split(","))
    etag = f'"{face_id}-{row["mtime"]}-{row["bbox"]}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    try:
        loop = asyncio.get_running_loop()
        data = await loop.run_in_executor(
            get_executor(),
            lambda: thumbnails.get_face_crop(
                Path(index.photo_path(row)), row["mtime"], row["size"], bbox,
                orientation=row["orientation"]),
        )
        return Response(content=data, media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=86400", "ETag": etag})
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/api/faces/assign")
async def api_bulk_assign(req: BulkAssignRequest):
    person_id = None if req.clear else req.person_id
    if person_id is None and not req.clear and req.name and req.name.strip():
        person_id = index.get_or_create_person(req.name.strip())
    index.assign_faces(req.face_ids, person_id)
    return {"assigned": len(req.face_ids), "person_id": person_id}


@router.post("/api/faces/ignore")
async def api_ignore_faces(req: IgnoreFacesRequest):
    """Hide faces from the unlabeled queue (background strangers, false detections),
    or restore them with ignored=false."""
    index.set_faces_ignored(req.face_ids, req.ignored)
    return {"updated": len(req.face_ids), "ignored": req.ignored}


@router.post("/api/faces/come-back")
async def api_come_back_faces(req: ComeBackFacesRequest):
    """Move faces to the come-back queue: people we know or suspect but aren't
    ready to assign yet. Distinct from /ignore (that's for strangers/false
    detections we never want to see again). come_back=false restores faces to
    the unlabeled queue."""
    index.set_faces_come_back(req.face_ids, req.come_back)
    return {"updated": len(req.face_ids), "come_back": req.come_back}


@router.post("/api/faces/nuke")
async def api_nuke_photo_faces(req: NukePhotoFacesRequest):
    """Nuclear option: hard-delete every face (detected, assigned, or ignored) for
    the given photos and wipe every cached rendition (thumbnail, preview, face
    crops) so a rescan starts completely from scratch. Irreversible."""
    if not req.photo_ids:
        raise HTTPException(400, "photo_ids required")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        get_executor(), faces_service.nuke_photo_faces, req.photo_ids)
    return result


@router.post("/api/photos/{photo_id}/faces")
async def api_add_manual_face(photo_id: int, req: AddManualFaceRequest):
    """Add a hand-drawn face box to a photo, optionally already assigned to a
    person. For faces detection missed entirely. ``bbox`` is normalized 0..1 in
    display space (as drawn over the oriented preview); the server maps it to
    sensor space and tries to embed it so the face still joins recognition."""
    if len(req.bbox) != 4:
        raise HTTPException(400, "bbox must be [x1, y1, x2, y2]")
    person_id = req.person_id
    if person_id is None and req.name and req.name.strip():
        person_id = index.get_or_create_person(req.name.strip())
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            get_executor(), faces_service.add_manual_face,
            photo_id, req.bbox, person_id)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@router.delete("/api/faces/{face_id}")
async def api_delete_manual_face(face_id: int):
    """Delete a hand-drawn face (undo for a mis-drawn box). Detected faces are not
    deletable — 400 — because the next scan would re-detect them; use ignore."""
    if not index.get_face(face_id):
        raise HTTPException(404)
    if not index.delete_manual_face(face_id):
        raise HTTPException(400, "Only manually added faces can be deleted; "
                                 "use ignore for detected faces")
    return {"success": True, "face_id": face_id}


@router.post("/api/faces/rescan")
async def api_rescan_photo_faces(req: NukePhotoFacesRequest):
    """Nuke + re-detect in one call: wipe every face and cached rendition for the
    given photos, then run detection over them again. Manual assignments for these
    photos are lost (same as /nuke) — this is the "detection went wrong, start
    over" action, not a routine incremental scan."""
    if not req.photo_ids:
        raise HTTPException(400, "photo_ids required")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        get_executor(), faces_service.rescan_photo_faces, req.photo_ids)
    return result


@router.post("/api/faces/dedup/recompute")
async def api_dedup_recompute():
    """Recompute representative-face flags for every person with enough
    labeled faces (see the Representative faces settings group). Safe to
    re-run any time — e.g. after tagging more photos, retagging, or tuning
    the threshold/fraction settings; always recomputed from scratch."""
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(get_executor(), faces_service.recompute_all_representatives)
    return result


@router.get("/api/faces/dedup/persons")
async def api_dedup_persons():
    """People who currently have representative-flagged faces (from the last
    recompute) — the picker for the Representative Faces review page."""
    return [
        {"person_id": r["id"], "name": r["name"], "total": r["total"], "representative": r["representative"]}
        for r in index.get_persons_with_representatives()
    ]


@router.get("/api/faces/dedup/groups")
async def api_dedup_groups(person_id: int = Query(...), group_limit: int = Query(49, ge=1, le=200)):
    """Representative-led review groups for one person: each stored
    representative face, paired with up to `group_limit` other labeled faces
    (same person) ranked closest-to-representative first. Based on the stored
    representative flags, not a fresh re-cluster — run Recompute first if a
    person doesn't show up in /api/faces/dedup/persons yet."""
    loop = asyncio.get_running_loop()
    clusters = await loop.run_in_executor(
        get_executor(), faces.get_representative_groups, person_id, group_limit)
    if not clusters:
        return {"groups": [], "total": 0}
    rows = index.list_faces(scope="person", person_id=person_id, limit=200_000)
    by_id = {r["id"]: r for r in rows}
    groups = [
        {"representative": serializers.face_item(by_id[c["representative_face_id"]]),
         "others": [serializers.face_item(by_id[fid]) for fid in c["other_face_ids"]],
         "size": c["size"]}
        for c in clusters if c["representative_face_id"] in by_id
    ]
    return {"groups": groups, "total": len(rows)}


@router.post("/api/faces/negatives")
async def api_face_negatives(req: NegativeFacesRequest):
    """Mark faces as 'definitely not person_id' (negative=true), or lift that
    (negative=false). Removes person_id from these faces' recognition ranking so
    they stop being suggested as this person and fall through to their next-best
    match. Distinct from /ignore, which hides a face from every queue."""
    if not index.get_person(req.person_id):
        raise HTTPException(404, "person not found")
    if req.negative:
        index.add_face_negatives(req.face_ids, req.person_id)
    else:
        index.remove_face_negatives(req.face_ids, req.person_id)
    return {"updated": len(req.face_ids), "person_id": req.person_id,
            "negative": req.negative}


@router.get("/api/photos/{photo_id}/faces")
async def api_photo_faces(photo_id: int):
    """List faces in a photo with assigned person and a recognition suggestion."""
    photo = index.get_photo(photo_id)
    if not photo:
        raise HTTPException(404)
    photo_dt = photo["photo_datetime"]
    gallery = faces.build_gallery()
    rows = index.get_faces_for_photo(photo_id)
    out = []
    for r in rows:
        negatives = index.get_negatives_for_face(r["id"])
        item = {
            "id": r["id"],
            "bbox": thumbnails.orient_bbox(r["bbox"].split(","), r["orientation"]),
            "det_score": r["det_score"],
            "source": r["source"],   # 'manual' boxes are deletable; detected ones aren't
            "person_id": r["person_id"],
            "person_name": r["person_name"],
            "assigned_at": r["assigned_at"],
            "ignored": bool(r["ignored"]),
            "come_back": bool(r["come_back"]),
            "suggestion": None,
            "negatives": negatives,
        }
        # Only suggest for unassigned, non-ignored faces that carry an embedding
        # (a hand-drawn box with no face found inside it has none — see
        # faces_service.add_manual_face).
        if (r["person_id"] is None and not r["ignored"] and len(gallery) > 0
                and r["embedding"] is not None):
            vec = faces.decode_embedding(r["embedding"])
            match = faces.suggest_person(vec, photo_dt, gallery, exclude=set(negatives))
            if match:
                pid, score = match
                person = index.get_db().execute(
                    "SELECT name FROM persons WHERE id=?", (pid,)
                ).fetchone()
                item["suggestion"] = {
                    "person_id": pid,
                    "person_name": person["name"] if person else None,
                    "score": round(score, 4),
                }
        out.append(item)
    return out


@router.post("/api/faces/{face_id}/assign")
async def api_assign_face(face_id: int, req: AssignFaceRequest):
    if not index.get_face(face_id):
        raise HTTPException(404)
    person_id = req.person_id
    if person_id is None and req.name and req.name.strip():
        person_id = index.get_or_create_person(req.name.strip())
    index.assign_face(face_id, person_id)
    return {"face_id": face_id, "person_id": person_id}


@router.post("/api/faces/scan")
async def api_faces_scan(req: ScanFacesRequest):
    """Detect faces for up to `limit` not-yet-scanned photos. Repeat to continue."""
    pending = index.get_unscanned_photo_ids()
    batch = pending[: max(1, req.limit)]
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(get_executor(), faces_service.scan_faces_batch, batch)
    result["remaining"] = len(pending) - result["processed"]
    return result


@router.get("/api/faces/scan/status")
async def api_faces_scan_status(
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
    spatial_context_id: int | None = Query(None),
):
    """Face-pipeline counts for the People nav. The Focus (start_ts/end_ts time
    window and/or spatial_context_id polygon) scopes only unlabeled_faces (the one
    windowed nav scope); total/ignored/tagged stay global to match the un-windowed
    All/Ignored/Recently-tagged scopes."""
    remaining = len(index.get_unscanned_photo_ids())
    photo_ids = _spatial_photo_ids(spatial_context_id)
    return {
        "remaining_photos": remaining,
        "total_faces": index.count_faces("all"),
        "unlabeled_faces": index.count_faces("unlabeled", start_ts=start_ts,
                                             end_ts=end_ts, photo_ids=photo_ids),
        "ignored_faces": index.count_faces("ignored"),
        "come_back_faces": index.count_faces("come_back"),
        "tagged_faces": index.count_faces("recent"),
    }


@router.get("/api/faces/clusters")
async def api_face_clusters(
    threshold: float | None = Query(None, ge=0.1, le=1.0),
    min_size: int | None = Query(None, ge=2),
    cap: int | None = Query(None, ge=0),
    full: bool = Query(False),
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
    spatial_context_id: int | None = Query(None),
):
    """Discover groups of likely same-person faces among the unlabeled queue, so a
    new person can be named in one go (no seed example needed). Clusters the top
    `cap` faces by detection score (they cluster cleanest); the rest are reachable
    afterward via per-person 'Find more'. ``full`` returns every face item per
    group (not just a 24-face sample) — total stays bounded by the cluster cap.
    threshold/min_size/cap default to the live config.FACE_CLUSTER_* settings."""
    threshold = config.FACE_CLUSTER_THRESHOLD if threshold is None else threshold
    min_size = config.FACE_CLUSTER_MIN_SIZE if min_size is None else min_size
    cap = config.FACE_CLUSTER_CAP if cap is None else cap
    gallery = faces.build_gallery()
    rows, unknowns, times = faces.get_unlabeled_matrix()
    # Focus narrows the candidates before the det-score cap (gallery stays global):
    # by time, and by a context's polygon when "also limit to this area" is on.
    _pids = _spatial_photo_ids(spatial_context_id)
    rows, unknowns, times = faces.window_rows(rows, unknowns, times, start_ts, end_ts, _pids)
    if cap and 0 < cap < len(rows):
        rows, unknowns, times = rows[:cap], unknowns[:cap], times[:cap]
    names = serializers.person_name_map()
    loop = asyncio.get_running_loop()
    clusters = await loop.run_in_executor(
        get_executor(), faces_service.compute_clusters, rows, unknowns, times, gallery, names,
        threshold, min_size, full)
    return {"clusters": clusters, "scanned": len(rows),
            "grouped": sum(c["size"] for c in clusters)}


class CrowdIgnoreRequest(BaseModel):
    photo_ids: list[int]


@router.get("/api/crowds")
async def api_crowds(
    min_faces: int | None = Query(None, ge=1),
    group_gap: int = Query(86400, ge=60),
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
    spatial_context_id: int | None = Query(None),
):
    """Return crowd photos (>= min_faces detected faces) grouped by time gaps.
    min_faces defaults to the live config.FACE_CROWD_MIN_SIZE setting. The Focus
    (start_ts/end_ts time window and/or spatial_context_id polygon) is the People
    page's Focus."""
    min_faces = config.FACE_CROWD_MIN_SIZE if min_faces is None else min_faces
    photo_ids = _spatial_photo_ids(spatial_context_id)
    rows = index.get_crowd_photos(min_faces, start_ts=start_ts, end_ts=end_ts,
                                  photo_ids=photo_ids)
    groups: list[dict] = []
    for row in rows:
        ts = row["photo_datetime"] or 0
        if groups and ts - groups[-1]["_last_ts"] <= group_gap:
            g = groups[-1]
        else:
            g = {
                "_last_ts": ts,
                "label": serializers.format_crowd_group_label(ts),
                "photos": [],
                "total_faces": 0,
                "unlabeled_faces": 0,
            }
            groups.append(g)
        g["_last_ts"] = ts
        g["photos"].append({
            "id": row["id"],
            "filename": row["filename"],
            "photo_datetime": row["photo_datetime"],
            "orientation": row["orientation"],
            # Place names let the client sort crowd groups by location.
            "location": serializers.row_location(row),
            "total_faces": row["total_faces"],
            "labeled_faces": row["labeled_faces"],
            "unlabeled_faces": row["unlabeled_faces"],
            "ignored_faces": row["ignored_faces"],
            "come_back_faces": row["come_back_faces"],
        })
        g["total_faces"] += row["total_faces"]
        g["unlabeled_faces"] += row["unlabeled_faces"]

    for g in groups:
        del g["_last_ts"]
    return {"groups": groups, "photo_count": len(rows)}


@router.post("/api/crowds/ignore-unlabeled")
async def api_crowds_ignore_unlabeled(req: CrowdIgnoreRequest):
    """Ignore all unlabeled faces in the given crowd photos."""
    count = index.ignore_unlabeled_in_photos(req.photo_ids)
    return {"ignored": count}

