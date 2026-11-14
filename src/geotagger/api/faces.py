"""Faces, persons, families, and crowd management endpoints."""

import asyncio
import logging
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from geotagger import index, faces, thumbnails, serializers, config
from geotagger.executor import get_executor
from geotagger.scan_failures import BatchAborted
from geotagger.services import face_undo_service, faces_service
from geotagger.timeutil import has_date

logger = logging.getLogger(__name__)
router = APIRouter()


def _in_window(ts, start_ts: int | None, end_ts: int | None) -> bool:
    """True if a photo timestamp falls in an optional [start_ts, end_ts] window.
    Undated photos (ts None/0) fall outside any active window."""
    if start_ts is None and end_ts is None:
        return True
    if not has_date(ts):
        return False
    return (start_ts is None or ts >= start_ts) and (end_ts is None or ts <= end_ts)


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
    # Exactly one of these three must be given (see _resolve_assign_target).
    person_id: int | None = None
    name: str | None = None       # convenience: create/lookup a person by name
    clear: bool = False           # set True to unassign the face

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
    limit: int = Field(50, ge=1, le=1000)  # photos processed per call; repeat to continue
    # Accept a long run of unreadable files as really unreadable (overrides the
    # consecutive-failure guard for this one batch; see config.SCAN_FAILURE_STREAK_LIMIT).
    allow_failures: bool = False

class FacesByIdsRequest(BaseModel):
    # Same cap as one /api/faces page: a restored staging area (U7) is at most a
    # tagging pass, and the client chunks anything bigger.
    face_ids: list[int] = Field(max_length=20000)

class NukePhotoFacesRequest(BaseModel):
    photo_ids: list[int]  # hard-wipe every face + cached rendition for these photos

class FaceStateSnapshot(BaseModel):
    """A face row's state as face_undo_service snapshots it."""
    person_id: int | None = None
    ignored: bool = False
    ignored_at: float | None = Field(None, allow_inf_nan=False)
    come_back: bool = False
    come_back_at: float | None = Field(None, allow_inf_nan=False)
    representative: bool = False
    assigned_at: float | None = Field(None, allow_inf_nan=False)

    @model_validator(mode="after")
    def _one_state(self):
        # The four face states are mutually exclusive (see index faces table);
        # a token that says otherwise was not produced by this server.
        if sum([self.person_id is not None, self.ignored, self.come_back]) > 1:
            raise ValueError("a face is labeled, ignored or come-back, not several")
        return self

class FaceExpect(BaseModel):
    person_id: int | None = None
    ignored: bool = False
    come_back: bool = False
    assigned_at: float | None = None
    ignored_at: float | None = None
    come_back_at: float | None = None

class FaceNegativeSnapshot(BaseModel):
    person_id: int
    created_at: float = Field(allow_inf_nan=False)

class FaceSnapshot(BaseModel):
    face_id: int
    before: FaceStateSnapshot
    expect: FaceExpect
    negatives: list[FaceNegativeSnapshot] = []

class PersonNegativeSnapshot(BaseModel):
    face_id: int
    created_at: float = Field(allow_inf_nan=False)

class PersonSnapshot(BaseModel):
    id: int
    name: str = Field(min_length=1)
    birth_date: str | None = None
    not_before: str | None = None
    not_after: str | None = None
    created_at: float | None = Field(None, allow_inf_nan=False)
    family_id: int | None = None
    negatives: list[PersonNegativeSnapshot] = []

class UndoFacesRequest(BaseModel):
    """The ``undo`` token a face/person write returned, handed back verbatim
    (see face_undo_service). Client input on the way back, so validated."""
    # A person delete carries every face they labeled; generous but bounded.
    faces: list[FaceSnapshot] = Field([], max_length=200000)
    person: PersonSnapshot | None = None
    created_person_id: int | None = None

class AddManualFaceRequest(BaseModel):
    bbox: list[float]             # [x1, y1, x2, y2], normalized 0..1, DISPLAY space
    person_id: int | None = None  # or name, to create/find a person; both optional
    name: str | None = None


@router.get("/api/persons")
async def api_get_persons(
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
    face_counts: bool = Query(False),
):
    """List persons. With a start_ts/end_ts window (the People page's time Focus),
    people with no faces in range are omitted.

    face_count is opt-in (``face_counts=true``, the Manage page): the hot callers
    (People page, tag pickers) don't need it and index.get_persons dropped the
    count for latency. When requested it is each person's *total* assigned faces
    — exactly what DELETE /api/persons/{id} would unlabel — regardless of any
    time window."""
    counts = index.get_person_face_counts() if face_counts else None
    out = []
    for p in index.get_persons(start_ts=start_ts, end_ts=end_ts):
        row = {"id": p["id"], "name": p["name"],
               "birth_date": p["birth_date"], "not_before": p["not_before"],
               "not_after": p["not_after"], "created_at": p["created_at"],
               "family_id": p["family_id"], "family_name": p["family_name"]}
        if counts is not None:
            row["face_count"] = counts.get(p["id"], 0)
        out.append(row)
    return out


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
    # Validate everything first so a bad field can't leave earlier ones applied.
    name = None
    if "name" in fields:
        name = (req.name or "").strip()
        if not name:
            raise HTTPException(400, "Name cannot be empty")
    birth_date = _parse_optional_date("birth_date", req.birth_date) if "birth_date" in fields else None
    not_before = _parse_optional_date("not_before", req.not_before) if "not_before" in fields else None
    not_after = _parse_optional_date("not_after", req.not_after) if "not_after" in fields else None
    # One transaction: any failure (409/404 below) rolls every field back.
    try:
        with index.transaction():
            if not index.get_person(person_id):
                raise HTTPException(404, "Person not found")
            if ("family_id" in fields and req.family_id is not None
                    and not index.get_family(req.family_id)):
                raise HTTPException(404, "Family not found")
            if "name" in fields:
                index.rename_person(person_id, name)
            if "birth_date" in fields:
                index.set_person_birth_date(person_id, birth_date)
            if "not_before" in fields:
                index.set_person_not_before(person_id, not_before)
            if "not_after" in fields:
                index.set_person_not_after(person_id, not_after)
            if "family_id" in fields:
                index.set_person_family(person_id, req.family_id)
    except sqlite3.IntegrityError:
        # Carry the existing person's id so the client can offer "merge into
        # them?" instead of a dead-end error. {message} is what common.js's
        # httpErrorMessage shows for an object detail.
        existing = index.get_db().execute(
            "SELECT id FROM persons WHERE name=?", (name,)).fetchone()
        raise HTTPException(409, {
            "message": f'A person named "{name}" already exists',
            "existing_person_id": existing["id"] if existing else None,
        })
    return {"id": person_id}


class MergePersonRequest(BaseModel):
    into: int   # the person that survives; the path's person is deleted


@router.post("/api/persons/{person_id}/merge")
async def api_merge_person(person_id: int, req: MergePersonRequest):
    """Merge person ``person_id`` into ``req.into``: every face, representative
    flag and "not this person" negative moves to the target, empty target
    attributes are filled from the source, and the source is deleted — all in
    one transaction (see index.merge_persons for the per-table rules). Returns a
    summary of what moved."""
    try:
        result = index.merge_persons(person_id, req.into)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if result is None:
        raise HTTPException(404, "Person not found")
    return result


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
    try:
        family_id = index.create_family(name)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f'A family named "{name}" already exists')
    return {"id": family_id, "name": name, "person_count": 0}


@router.patch("/api/families/{family_id}")
async def api_rename_family(family_id: int, req: FamilyRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    try:
        found = index.rename_family(family_id, name)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f'A family named "{name}" already exists')
    if not found:
        raise HTTPException(404, "Family not found")
    return {"id": family_id, "name": name}


@router.delete("/api/families/{family_id}")
async def api_delete_family(family_id: int):
    if not index.delete_family(family_id):
        raise HTTPException(404, "Family not found")
    return {"success": True}


@router.post("/api/persons")
async def api_create_person(req: CreatePersonRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    try:
        person_id = index.create_person(name)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f'A person named "{name}" already exists')
    return {"id": person_id, "name": name}


@router.delete("/api/persons/{person_id}")
async def api_delete_person(person_id: int):
    """Delete a person; their faces become unlabeled. ``undo`` is the token
    POST /api/faces/undo takes to bring them back (same id, attributes, faces)."""
    undo = face_undo_service.delete_person(person_id)
    if undo is None:
        raise HTTPException(404, "Person not found")
    return {"success": True, "undo": undo}


@router.get("/api/faces")
async def api_list_faces(
    scope: str = Query("unlabeled", pattern="^(unlabeled|person|ignored|come_back|suggested|recent|all)$"),
    person_id: int | None = Query(None),
    limit: int = Query(500, ge=1, le=20000),
    offset: int = Query(0, ge=0),
    suggested_only: bool = Query(False),
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
):
    """List faces, one page at a time: ``offset``/``limit`` slice a stable
    ordering (every scope's sort ends in a face-id tiebreaker), and the response's
    ``total`` / ``next_offset`` (null on the last page) tell the People grid how
    much is left to "Load more".

    scope=unlabeled attaches a recognition suggestion to each face;
    scope=suggested returns only unlabeled faces whose *best* guess is `person_id`,
    ranked by confidence — for quickly approving one person's guesses in bulk.
    suggested_only (scope=unlabeled) drops faces with no guess, scanning up to the
    suggest cap so it finds matches beyond the first detection-ranked page.

    start_ts/end_ts (epoch secs) are the People page's time Focus. They window the
    candidate faces for the unlabeled and suggested scopes only (person/all/recent/
    ignored ignore them, and the recognition gallery stays global either way)."""
    neg_map = faces.get_negatives_map()

    if scope == "unlabeled" and suggested_only:
        loop = asyncio.get_running_loop()
        rows, matches = await loop.run_in_executor(
            get_executor(),
            faces.get_suggested_scores,
        )
        names = serializers.person_name_map()
        scored = [(r, m) for r, m in zip(rows, matches)
                  if m and _in_window(r["photo_datetime"], start_ts, end_ts)]
        # Most confident first; face id breaks ties so pages never overlap.
        scored.sort(key=lambda rm: (-rm[1][1], rm[0]["id"]))
        total = len(scored)
        out = []
        for r, (pid, score) in scored[offset:offset + limit]:
            item = serializers.face_item(r)
            item["suggestion"] = {"person_id": pid, "person_name": names.get(pid),
                                  "score": round(score, 4)}
            item["negatives"] = sorted(neg_map.get(r["id"], ()))
            out.append(item)
        return _face_page(out, total, offset)

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
            # Focus narrows the candidates by time; the gallery stays global.
            rows, unknowns, _u_times = faces.window_rows(
                rows, unknowns, _u_times, start_ts, end_ts)
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
        scored.sort(key=lambda t: (-t[1], t[0]["id"]))   # id: stable page boundaries
        logger.info(
            "scope=suggested person_id=%d gallery=%d unlabeled=%d candidates=%d "
            "build_gallery=%.3fs get_matrix=%.3fs suggest=%.3fs total=%.3fs",
            person_id, len(gallery), _unlabeled_n, len(scored),
            _t1 - _t0, _t2 - _t1, _t3 - _t2, _t3 - _t0,
        )
        out = []
        for r, score, alts in scored[offset:offset + limit]:
            item = serializers.face_item(r)
            item["suggestion"] = {"person_id": person_id, "person_name": name,
                                  "score": round(score, 4)}
            item["alternatives"] = [
                {"person_id": pid, "person_name": names.get(pid), "score": round(s, 4)}
                for pid, s in alts
            ]
            item["negatives"] = sorted(neg_map.get(r["id"], ()))
            out.append(item)
        return _face_page(out, len(scored), offset)

    # The Focus applies to the unlabeled queue only; other scopes ignore it.
    w_start, w_end = (start_ts, end_ts) if scope == "unlabeled" else (None, None)
    rows = index.list_faces(scope=scope, person_id=person_id, limit=limit,
                            start_ts=w_start, end_ts=w_end, offset=offset)
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
    return _face_page(out, index.count_faces(scope=scope, person_id=person_id,
                                             start_ts=w_start, end_ts=w_end), offset)


def _face_page(out: list[dict], total: int, offset: int) -> dict:
    """The /api/faces response envelope. ``next_offset`` is where the next page
    starts, or None once this page reaches ``total`` — the People grid shows its
    "Load more" banner exactly while it's non-null (U5)."""
    end = offset + len(out)
    return {"faces": out, "total": total, "returned": len(out), "offset": offset,
            "next_offset": end if out and end < total else None}


@router.post("/api/faces/by-ids")
async def api_faces_by_ids(req: FacesByIdsRequest):
    """Current state of an explicit set of faces, as face_item dicts (no
    suggestion), plus the ids that no longer exist. The People page calls it on
    load to re-validate staged decisions restored from sessionStorage (U7):
    a face deleted (nuked, rescanned) since is dropped, one already in its
    staged state is dropped, one changed elsewhere is flagged. POST because the
    id list can run to thousands — too long for a query string."""
    rows = index.get_faces_by_ids(req.face_ids)
    found = {r["id"] for r in rows}
    return {"faces": [serializers.face_item(r) for r in rows],
            "missing": [i for i in dict.fromkeys(req.face_ids) if i not in found]}


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
        return Response(content=data, media_type=thumbnails.media_type(),
                        headers={"Cache-Control": "max-age=86400", "ETag": etag})
    except Exception as e:
        raise HTTPException(500, str(e))


def _require_person(person_id: int | None):
    """404 for an id that names no person (e.g. a stale client holding a person
    deleted in another tab). With FKs unenforced, assigning to it would strand
    the faces: out of every queue and attached to nobody."""
    if person_id is not None and not index.get_person(person_id):
        raise HTTPException(404, "Person not found")


def _resolve_assign_target(person_id: int | None, name: str | None, clear: bool
                           ) -> tuple[int | None, str | None]:
    """Validate the person_id / name / clear triple shared by the assign routes.

    Exactly one intent must be expressed (a blank name counts as absent), so a
    malformed request can never fall through to "unassign" and wipe labels.
    Returns (person_id, name): (None, None) for clear, (id, None) for an existing
    person (404 if it doesn't exist), (None, trimmed_name) for find-or-create by
    name. The name's person is created by the caller, after it has confirmed the
    target faces exist, so a failed request doesn't leave an orphan person.
    """
    name = name.strip() if name else None
    given = [person_id is not None, bool(name), bool(clear)]
    if sum(given) != 1:
        raise HTTPException(400, "Provide exactly one of person_id, name (non-blank), "
                                 "or clear=true")
    _require_person(person_id)
    return person_id, name or None


@router.post("/api/faces/assign")
async def api_bulk_assign(req: BulkAssignRequest):
    """Assign (person_id / name) or unassign (clear=true) faces; exactly one of
    the three. ``assigned`` is the number of faces that exist and were written
    (including faces already on that person); ``not_found`` counts ids matching
    no face. 404 if none of the ids exist, 400 on empty ``face_ids``."""
    person_id, name = _resolve_assign_target(req.person_id, req.name, req.clear)
    ids = list(dict.fromkeys(req.face_ids))
    if not ids:
        raise HTTPException(400, "face_ids required")
    existing = index.count_existing_faces(ids)
    if existing == 0:
        raise HTTPException(404, "No matching faces")
    out, undo = face_undo_service.assign(ids, person_id, name)
    return {"assigned": out["assigned"], "not_found": len(ids) - out["assigned"],
            "person_id": out["person_id"], "undo": undo}


@router.post("/api/faces/ignore")
async def api_ignore_faces(req: IgnoreFacesRequest):
    """Hide faces from the unlabeled queue (background strangers, false detections),
    or restore them with ignored=false. ``undo``: see /api/faces/undo."""
    undo = face_undo_service.set_ignored(req.face_ids, req.ignored)
    return {"updated": len(req.face_ids), "ignored": req.ignored, "undo": undo}


@router.post("/api/faces/come-back")
async def api_come_back_faces(req: ComeBackFacesRequest):
    """Move faces to the come-back queue: people we know or suspect but aren't
    ready to assign yet. Distinct from /ignore (that's for strangers/false
    detections we never want to see again). come_back=false restores faces to
    the unlabeled queue. ``undo``: see /api/faces/undo."""
    undo = face_undo_service.set_come_back(req.face_ids, req.come_back)
    return {"updated": len(req.face_ids), "come_back": req.come_back, "undo": undo}


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
    _require_person(person_id)
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


@router.post("/api/faces/undo")
async def api_undo_faces(req: UndoFacesRequest):
    """Revert one face/person write: hand back the ``undo`` token its reply
    carried (assign, ignore, come-back, crowds/ignore-unlabeled, DELETE person).
    Each face goes back to its exact prior state unless it changed since —
    those come back in ``conflicts`` and are left alone. A deleted person is
    re-created first (same id when still free; ``person_id`` either way); 409
    if their name has been taken meanwhile, with nothing written."""
    if not req.faces and req.person is None and req.created_person_id is None:
        raise HTTPException(400, "nothing to undo")
    token = req.model_dump()
    if req.person is not None:
        p = token["person"]
        p["name"] = p["name"].strip()
        if not p["name"]:
            raise HTTPException(400, "person name required")
        for k in ("birth_date", "not_before", "not_after"):
            p[k] = _parse_optional_date(k, p[k])
    try:
        return face_undo_service.undo(token)
    except face_undo_service.UndoConflict as e:
        raise HTTPException(409, str(e))


@router.post("/api/faces/rescan")
async def api_rescan_photo_faces(req: NukePhotoFacesRequest):
    """Nuke + re-detect in one call: wipe every face and cached rendition for the
    given photos, then run detection over them again. Manual assignments for these
    photos are lost (same as /nuke) — this is the "detection went wrong, start
    over" action, not a routine incremental scan."""
    if not req.photo_ids:
        raise HTTPException(400, "photo_ids required")
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            get_executor(), faces_service.rescan_photo_faces, req.photo_ids)
    except BatchAborted as e:
        raise HTTPException(503, e.as_detail())


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
    photo_precision = photo["date_precision"]
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
            match = faces.suggest_person(vec, photo_dt, gallery, exclude=set(negatives),
                                         date_precision=photo_precision)
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


@router.get("/api/photos/{photo_id}/tagged-people")
async def api_photo_tagged_people(photo_id: int):
    """People already committed to a face in this photo, one entry per face.

    Deliberately lighter than /api/photos/{photo_id}/faces: no embeddings and no
    recognition pass, because the People detail pane hits this every time focus
    moves between faces.
    """
    if not index.get_photo(photo_id):
        raise HTTPException(404)
    return [
        {
            "id": r["id"],
            "person_id": r["person_id"],
            "person_name": r["person_name"],
            "bbox": thumbnails.orient_bbox(r["bbox"].split(","), r["orientation"]),
            "assigned_at": r["assigned_at"],
        }
        for r in index.get_tagged_faces_for_photo(photo_id)
    ]


@router.post("/api/faces/{face_id}/assign")
async def api_assign_face(face_id: int, req: AssignFaceRequest):
    """Assign (person_id / name) or unassign (clear=true) one face; exactly one
    of the three, else 400. 404 for an unknown face or person."""
    if not index.get_face(face_id):
        raise HTTPException(404)
    person_id, name = _resolve_assign_target(req.person_id, req.name, req.clear)
    out, undo = face_undo_service.assign([face_id], person_id, name)
    return {"face_id": face_id, "person_id": out["person_id"], "undo": undo}


@router.post("/api/faces/scan")
async def api_faces_scan(req: ScanFacesRequest):
    """Detect faces for up to `limit` not-yet-scanned photos. Repeat until
    `remaining` is 0. 503 (detail {code, message, errors}) when the batch aborted
    without marking anything — the model failed, or too many files in a row were
    unreadable — and the client must stop rather than walk on (audit F1)."""
    pending = index.get_unscanned_photo_ids()
    batch = pending[: max(1, req.limit)]
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            get_executor(), faces_service.scan_faces_batch, batch, req.allow_failures)
    except BatchAborted as e:
        raise HTTPException(503, e.as_detail())
    result["remaining"] = len(pending) - result["processed"]
    result["failed"] = index.count_face_scan_failures()
    return result


@router.post("/api/faces/scan/retry-failed")
async def api_faces_scan_retry_failed():
    """Put every photo whose file couldn't be read back in the detection queue.
    Those photos were never marked scanned and have no detected faces, so the
    rescan can't touch any tag."""
    return {"requeued": index.clear_face_scan_failures()}


@router.get("/api/faces/scan/status")
async def api_faces_scan_status(
    start_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
):
    """Face-pipeline counts for the People nav. The Focus (start_ts/end_ts time
    window) scopes only unlabeled_faces (the one windowed nav scope);
    total/ignored/tagged stay global to match the un-windowed
    All/Ignored/Recently-tagged scopes."""
    remaining = len(index.get_unscanned_photo_ids())
    return {
        "remaining_photos": remaining,
        "failed_photos": index.count_face_scan_failures(),
        "total_faces": index.count_faces("all"),
        "unlabeled_faces": index.count_faces("unlabeled", start_ts=start_ts,
                                             end_ts=end_ts),
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
    # Focus narrows the candidates before the det-score cap by time; the gallery
    # stays global.
    rows, unknowns, times = faces.window_rows(rows, unknowns, times, start_ts, end_ts)
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
):
    """Return crowd photos (>= min_faces detected faces) grouped by time gaps.
    min_faces defaults to the live config.FACE_CROWD_MIN_SIZE setting.
    start_ts/end_ts is the People page's time Focus."""
    min_faces = config.FACE_CROWD_MIN_SIZE if min_faces is None else min_faces
    rows = index.get_crowd_photos(min_faces, start_ts=start_ts, end_ts=end_ts)
    groups: list[dict] = []
    for row in rows:
        ts = row["photo_datetime"] or 0
        # Rows arrive undated-first (get_crowd_photos). The has_date check keeps
        # the first dated row from joining the undated group: undated reads as 0,
        # and a pre-1970 ts minus 0 is negative, so it would always pass the gap test.
        if (groups and has_date(ts) == groups[-1]["_dated"]
                and ts - groups[-1]["_last_ts"] <= group_gap):
            g = groups[-1]
        else:
            g = {
                "_last_ts": ts,
                "_dated": has_date(ts),
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
            # dir/location let the client sort crowd groups by folder or place.
            "dir": row["dir"],
            "photo_datetime": row["photo_datetime"],
            "orientation": row["orientation"],
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
        del g["_last_ts"], g["_dated"]
    return {"groups": groups, "photo_count": len(rows)}


@router.post("/api/crowds/ignore-unlabeled")
async def api_crowds_ignore_unlabeled(req: CrowdIgnoreRequest):
    """Ignore all unlabeled faces in the given crowd photos. ``undo``: see
    /api/faces/undo."""
    count, undo = face_undo_service.ignore_unlabeled_in_photos(req.photo_ids)
    return {"ignored": count, "undo": undo}

