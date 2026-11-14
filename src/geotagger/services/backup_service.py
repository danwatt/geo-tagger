"""Backup and restore of the user-authored data: the parts of index.db nothing else
can regenerate. A rescan rebuilds photos, thumbnails and face detections, but not
what the user did with them.

Included: families; persons (name, birth/not-before/not-after dates, family);
custom places (bounds, representative photo); runtime settings; per photo the
geotag (lat/lng/source/accuracy) or its removal marker, geocode_ignored, and an
approximate date (date_precision + photo_datetime); per face the person
assignment, ignored / come-back flags (with their timestamps), the representative
flag and face_negatives; hand-drawn (source='manual') faces in full, embedding
included — the only face that can't come back from detection, and few enough
that their ~2 KB vectors don't matter.

Deliberately skipped (derived, rebuilt by a rescan/backfill, and each expensive to
serialize): reverse-geocode results (photos.loc_*, geocoded_at, geocode_cache),
detected faces' embeddings and detected faces with no user state, semantic
embeddings, photo scan metadata (mtime/camera/orientation/sidecar tracking/
faces_scanned_at), exact dates (they live in the file or its sidecar), and
dataset_downloads (download-history bookkeeping).

── Identity ──
DB ids change on every fresh scan, and absolute paths change when the library
moves. A photo is identified by the scan root it sits under (by label, the root
folder's name) plus its path RELATIVE to that root (POSIX separators, case kept),
with its size and checksum so a reorganised file can still be found by content.
A photo under no known root (no --scan-dir known when the backup was made) keeps
its absolute path instead. A face is identified by its photo plus its normalized
bbox, and matched on restore by IoU against the faces currently on that photo.

── Format history ──
1  (no "format" key; "version": 1): absolute (dir, filename) anchors, geotags
   without gps_accuracy, no geocode_ignored / geotag_removed / dates, every face.
   Still accepted on restore; photos then match only by absolute path.
2  ("format": 2): the shape build_backup writes now (see build_backup).
"""

import base64
import logging
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import PurePath

from geotagger import config, index

logger = logging.getLogger(__name__)

BACKUP_FORMAT = 2
_SUPPORTED_FORMATS = (1, 2)

# Detected-vs-redetected face boxes on the same photo overlap almost exactly (same
# model, same image; a different decode resolution shifts edges by a few percent,
# IoU still > 0.7), while two different faces rarely overlap by half even in a
# crowd. Stricter than faces._MANUAL_MATCH_IOU (0.3), which compares a generous
# hand-drawn box with the model's tight one.
FACE_MATCH_IOU = 0.5

# Coordinates within this many degrees (~10 cm) count as the same geotag. Looser
# than index._COORD_EPSILON_DEG: a backed-up value may have been round-tripped
# through a sidecar (degrees + decimal minutes) on the restoring side.
_COORD_MATCH_DEG = 1e-6

# Caps on the report's example lists — a restore against the wrong library can
# leave every photo unmatched, and the report must stay readable.
_SAMPLE_CAP = 50


class BackupFormatError(ValueError):
    """The input isn't a backup this code can read (surfaced as HTTP 400)."""


# ── Scan roots ──

def configured_roots() -> list[str]:
    """The scan roots this app instance serves: --scan-dir (GEOTAGGER_SCAN_DIRS,
    set by __main__) or, on a flag-less start, the remembered last roots."""
    env = os.environ.get("GEOTAGGER_SCAN_DIRS")
    if env:
        roots = [d.strip() for d in env.split("\n") if d.strip()]
        if roots:
            return roots
    return index.get_last_scan_roots()


class _Rooter:
    """Maps a photo's stored `dir` to (root label, relative dir). Labels are the
    root folders' names, de-duplicated with a "#2" suffix (two drives can each
    have a "Photos"). Compared by path components with os.path.normcase, so on
    Windows "c:\\photos" and "C:/Photos" are the same root; the relative part keeps
    the stored case."""

    def __init__(self, roots: list[str]):
        self.labels: list[str] = []
        self.paths: dict[str, str] = {}
        entries = []
        used: set[str] = set()
        for r in roots:
            p = PurePath(os.path.normpath(r))
            base = p.name or p.drive.rstrip(":\\/") or p.as_posix().strip("/") or "root"
            label, n = base, 1
            while label.casefold() in used:
                n += 1
                label = f"{base}#{n}"
            used.add(label.casefold())
            self.labels.append(label)
            self.paths[label] = p.as_posix()
            entries.append((label, tuple(os.path.normcase(part) for part in p.parts)))
        # Longest first: with nested roots a photo belongs to the innermost one.
        self._roots = sorted(entries, key=lambda e: len(e[1]), reverse=True)
        self._cache: dict[str, tuple[str | None, str | None]] = {}

    def locate(self, dir_: str) -> tuple[str | None, str | None]:
        hit = self._cache.get(dir_)
        if hit is not None:
            return hit
        parts = PurePath(os.path.normpath(dir_)).parts
        folded = tuple(os.path.normcase(part) for part in parts)
        out: tuple[str | None, str | None] = (None, None)
        for label, rparts in self._roots:
            if folded[:len(rparts)] == rparts:
                out = (label, "/".join(parts[len(rparts):]))
                break
        self._cache[dir_] = out
        return out

    def identity(self, dir_: str, filename: str) -> tuple[str | None, str | None, str | None]:
        """(root label, relative POSIX path, absolute POSIX path-or-None). The
        absolute path is only filled in for a photo under no known root."""
        label, rel_dir = self.locate(dir_)
        if label is None:
            return None, None, PurePath(dir_, filename).as_posix()
        return label, f"{rel_dir}/{filename}" if rel_dir else filename, None


def _abs_key(path: str) -> str:
    """Comparable form of an absolute path (separators + case per the OS)."""
    return os.path.normcase(os.path.normpath(path))


# ── Build ──

_PHOTO_COLS = ("id, dir, filename, size, checksum, lat, lng, geotag_source, gps_accuracy, "
               "geotag_removed, geocode_ignored, photo_datetime, date_precision")


def build_backup(roots: list[str] | None = None) -> dict:
    """Assemble the backup dict (format 2). ``roots`` defaults to the configured
    scan roots. Reads only the rows carrying user data (plus the photos they hang
    off), so it stays cheap on a large library.

    Shape (lists are referenced by position: a face's "photo" is an index into
    "photos", a negative's "face" an index into "faces"):
        {"format": 2, "app": "geotagger", "exported_at": <epoch>,
         "roots": [{"label": "Photos", "path": "D:/Photos"}],   # path: informational
         "settings": {key: value}, "families": [...], "persons": [...],
         "places": [{..., "representative_photo": <photo index> | null}],
         "photos": [{"root": "Photos", "rel": "2019/IMG_1.jpg", "abs": null,
                     "size": 123, "checksum": "<sha256>" | null,
                     "lat", "lng", "geotag_source", "gps_accuracy",
                     "geotag_removed", "geocode_ignored",
                     "photo_datetime", "date_precision"}],
         "faces": [{"photo": 0, "bbox": "x1,y1,x2,y2", "det_score", "source",
                    "person": name | null, "ignored", "come_back", "representative",
                    "created_at", "assigned_at", "ignored_at", "come_back_at",
                    "embedding_b64": <manual faces only> | null}],
         "face_negatives": [{"face": 0, "person": name, "created_at"}]}
    """
    import json as _json

    db = index.get_db()
    rooter = _Rooter(configured_roots() if roots is None else roots)

    families_rows = db.execute("SELECT id, name, created_at FROM families ORDER BY id").fetchall()
    family_names = {r["id"]: r["name"] for r in families_rows}
    persons_rows = db.execute(
        "SELECT id, name, birth_date, not_before, not_after, family_id, created_at "
        "FROM persons ORDER BY id"
    ).fetchall()
    person_names = {r["id"]: r["name"] for r in persons_rows}

    neg_rows = db.execute("SELECT face_id, person_id, created_at FROM face_negatives").fetchall()
    # Faces carrying user state. An unlabeled detected face with no negative is
    # exactly what a face scan recreates, so it is left out. The embedding is
    # joined for manual faces only.
    face_rows = db.execute(
        "SELECT f.id, f.photo_id, f.person_id, f.bbox, f.det_score, f.source, f.ignored, "
        "f.come_back, f.representative, f.created_at, f.assigned_at, f.ignored_at, "
        "f.come_back_at, e.embedding "
        "FROM faces f LEFT JOIN face_embeddings e ON e.face_id = f.id AND f.source = 'manual' "
        "WHERE f.person_id IS NOT NULL OR f.ignored = 1 OR f.come_back = 1 "
        "OR f.representative = 1 OR f.source = 'manual' "
        "OR f.id IN (SELECT face_id FROM face_negatives) "
        "ORDER BY f.id"
    ).fetchall()
    place_rows = db.execute(
        "SELECT name, type, bounds, created_at, representative_photo_id FROM places ORDER BY id"
    ).fetchall()

    extra_ids = {r["photo_id"] for r in face_rows}
    extra_ids.update(r["representative_photo_id"] for r in place_rows
                     if r["representative_photo_id"] is not None)
    photo_rows = db.execute(
        f"SELECT {_PHOTO_COLS} FROM photos "
        "WHERE lat IS NOT NULL OR geotag_removed = 1 OR geocode_ignored = 1 "
        "OR date_precision IS NOT NULL OR id IN (SELECT value FROM json_each(?)) "
        "ORDER BY id", (_json.dumps(sorted(extra_ids)),)
    ).fetchall()

    photos = []
    photo_index: dict[int, int] = {}
    for r in photo_rows:
        label, rel, abs_path = rooter.identity(r["dir"], r["filename"])
        has_coords = r["lat"] is not None and r["lng"] is not None
        photo_index[r["id"]] = len(photos)
        photos.append({
            "root": label, "rel": rel, "abs": abs_path,
            "size": r["size"], "checksum": r["checksum"],
            "lat": r["lat"] if has_coords else None,
            "lng": r["lng"] if has_coords else None,
            "geotag_source": r["geotag_source"] if has_coords else None,
            "gps_accuracy": r["gps_accuracy"] if has_coords else None,
            "geotag_removed": bool(r["geotag_removed"]),
            "geocode_ignored": bool(r["geocode_ignored"]),
            # Exact dates live in the file/sidecar; only an approximate one (whose
            # precision flag is DB-only) is user data worth carrying.
            "photo_datetime": r["photo_datetime"] if r["date_precision"] else None,
            "date_precision": r["date_precision"],
        })

    faces = []
    face_index: dict[int, int] = {}
    for r in face_rows:
        pidx = photo_index.get(r["photo_id"])
        if pidx is None:
            continue  # orphaned row (photo since pruned) — nothing to anchor it to
        face_index[r["id"]] = len(faces)
        emb = r["embedding"]
        faces.append({
            "photo": pidx, "bbox": r["bbox"], "det_score": r["det_score"],
            "source": r["source"],
            "person": person_names.get(r["person_id"]),
            "ignored": bool(r["ignored"]), "come_back": bool(r["come_back"]),
            "representative": bool(r["representative"]),
            "created_at": r["created_at"], "assigned_at": r["assigned_at"],
            "ignored_at": r["ignored_at"], "come_back_at": r["come_back_at"],
            "embedding_b64": base64.b64encode(emb).decode("ascii") if emb is not None else None,
        })

    negatives = []
    for r in neg_rows:
        fidx = face_index.get(r["face_id"])
        person = person_names.get(r["person_id"])
        if fidx is None or person is None:
            continue
        negatives.append({"face": fidx, "person": person, "created_at": r["created_at"]})

    return {
        "format": BACKUP_FORMAT,
        "app": "geotagger",
        "exported_at": time.time(),
        "roots": [{"label": lb, "path": rooter.paths[lb]} for lb in rooter.labels],
        "settings": index.get_all_settings(),
        "families": [{"name": r["name"], "created_at": r["created_at"]} for r in families_rows],
        "persons": [
            {
                "name": r["name"], "birth_date": r["birth_date"],
                "not_before": r["not_before"], "not_after": r["not_after"],
                "family": family_names.get(r["family_id"]),
                "created_at": r["created_at"],
            }
            for r in persons_rows
        ],
        "places": [
            {
                "name": r["name"], "type": r["type"], "bounds": r["bounds"],
                "created_at": r["created_at"],
                "representative_photo": photo_index.get(r["representative_photo_id"]),
            }
            for r in place_rows
        ],
        "photos": photos,
        "faces": faces,
        "face_negatives": negatives,
    }


# ── Parse / normalize ──

def parse_backup(body: bytes) -> dict:
    """Decode an uploaded backup file. Raises BackupFormatError (a ValueError)."""
    import json as _json
    try:
        data = _json.loads(body)
    except (ValueError, UnicodeDecodeError) as e:
        raise BackupFormatError(f"not valid JSON: {e}") from None
    if not isinstance(data, dict):
        raise BackupFormatError("not a geotagger backup (expected a JSON object)")
    return data


def _detect_format(data: dict) -> int:
    fmt = data.get("format")
    if fmt is None and data.get("version") == 1 and "geotags" in data:
        return 1  # the original export, which had no "format" key
    if not isinstance(fmt, int) or isinstance(fmt, bool):
        raise BackupFormatError("not a geotagger backup (no recognised \"format\" field)")
    if fmt not in _SUPPORTED_FORMATS:
        newer = " (made by a newer version of the app)" if fmt > BACKUP_FORMAT else ""
        raise BackupFormatError(f"unsupported backup format {fmt}{newer}; this app reads "
                                f"formats {', '.join(map(str, _SUPPORTED_FORMATS))}")
    return fmt


def _list(data: dict, key: str) -> list:
    v = data.get(key, [])
    if not isinstance(v, list) or not all(isinstance(x, dict) for x in v):
        raise BackupFormatError(f"\"{key}\" must be a list of objects")
    return v


def _blank_photo(**kw) -> dict:
    p = {"root": None, "rel": None, "abs": None, "size": None, "checksum": None,
         "lat": None, "lng": None, "geotag_source": None, "gps_accuracy": None,
         "geotag_removed": False, "geocode_ignored": False,
         "photo_datetime": None, "date_precision": None}
    p.update(kw)
    return p


_PHOTO_KEYS = frozenset(_blank_photo())


def _upgrade_v1(data: dict) -> dict:
    """Rewrite a format-1 backup into the format-2 shape. Its photos carry only an
    absolute path (no root, size or checksum), so they match only where the
    library still sits at the same absolute location."""
    photos: list[dict] = []
    by_path: dict[tuple, int] = {}

    def ref(dir_, filename) -> int:
        if not isinstance(dir_, str) or not isinstance(filename, str):
            raise BackupFormatError("format-1 photo reference without dir/filename")
        key = (dir_, filename)
        if key not in by_path:
            by_path[key] = len(photos)
            photos.append(_blank_photo(abs=os.path.join(dir_, filename)))
        return by_path[key]

    for g in _list(data, "geotags"):
        p = photos[ref(g.get("dir"), g.get("filename"))]
        p.update(lat=g.get("lat"), lng=g.get("lng"), geotag_source=g.get("geotag_source"))
    places = []
    for pl in _list(data, "places"):
        rep = pl.get("representative_photo")
        places.append({**pl, "representative_photo":
                       ref(rep.get("dir"), rep.get("filename")) if isinstance(rep, dict) else None})
    faces = []
    for f in _list(data, "faces"):
        faces.append({**f, "photo": ref(f.get("photo_dir"), f.get("photo_filename")),
                      "embedding_b64": None})
    return {**data, "format": 2, "roots": [], "photos": photos, "places": places,
            "faces": faces}


def _normalize(data: dict) -> dict:
    """Validate structure and return the format-2 view of any supported backup."""
    if not isinstance(data, dict):
        raise BackupFormatError("not a geotagger backup (expected a JSON object)")
    fmt = _detect_format(data)
    if fmt == 1:
        data = _upgrade_v1(data)
    settings = data.get("settings", {})
    if not isinstance(settings, dict):
        raise BackupFormatError("\"settings\" must be an object")
    out = {
        "source_format": fmt,
        "roots": _list(data, "roots"),
        "settings": settings,
        "families": _list(data, "families"),
        "persons": _list(data, "persons"),
        "places": _list(data, "places"),
        "photos": [_blank_photo(**{k: v for k, v in p.items() if k in _PHOTO_KEYS})
                   for p in _list(data, "photos")],
        "faces": _list(data, "faces"),
        "face_negatives": _list(data, "face_negatives"),
    }
    n_photos, n_faces = len(out["photos"]), len(out["faces"])
    for fam in out["families"]:
        if not isinstance(fam.get("name"), str):
            raise BackupFormatError("a family has no name")
    for p in out["persons"]:
        if not isinstance(p.get("name"), str):
            raise BackupFormatError("a person has no name")
    for pl in out["places"]:
        if not all(isinstance(pl.get(k), str) for k in ("name", "type", "bounds")):
            raise BackupFormatError("a place needs name, type and bounds")
        rep = pl.get("representative_photo")
        if rep is not None and not (isinstance(rep, int) and 0 <= rep < n_photos):
            raise BackupFormatError("a place's representative_photo is out of range")
    for f in out["faces"]:
        if not (isinstance(f.get("photo"), int) and 0 <= f["photo"] < n_photos):
            raise BackupFormatError("a face's photo index is out of range")
        if _parse_bbox(f.get("bbox")) is None:
            raise BackupFormatError("a face has no valid bbox")
    for n in out["face_negatives"]:
        if not (isinstance(n.get("face"), int) and 0 <= n["face"] < n_faces):
            raise BackupFormatError("a face negative's face index is out of range")
        if not isinstance(n.get("person"), str):
            raise BackupFormatError("a face negative has no person")
    return out


def _parse_bbox(bbox) -> list[float] | None:
    if not isinstance(bbox, str):
        return None
    try:
        vals = [float(v) for v in bbox.split(",")]
    except ValueError:
        return None
    return vals if len(vals) == 4 else None


# ── Matching (reads only; runs before the write transaction) ──

def _photo_label(p: dict) -> str:
    if p["rel"] is not None:
        return f"{p['root']}/{p['rel']}" if p["root"] else p["rel"]
    return p["abs"] or "?"


def _match_photos(b: dict, roots: list[str]) -> tuple[list[int | None], dict]:
    """Backup photo index -> current photo id (or None), one-to-one. Order:
      1. same root label (or the only root on both sides, if renamed) + same
         relative path; exact case first, then case-insensitive if unique.
      2. root label not present here: a current path ending in "<label>/<rel>"
         (the restoring server may not know its roots), else the relative path
         alone — each only when exactly one current photo fits.
      3. a backed-up absolute path (unrooted photo, or a format-1 backup).
      4. checksum (+ size when both known), only when the checksum names exactly
         one current photo and appears once in the backup: duplicates of one file
         are indistinguishable, and guessing would graft one copy's tags onto
         another.
    """
    db = index.get_db()
    rooter = _Rooter(roots)
    by_key: dict[tuple[str, str], int] = {}
    by_key_fold: dict[tuple[str, str], list[int]] = {}
    by_rel: dict[str, list[int]] = {}
    by_abs: dict[str, int] = {}
    by_name: dict[str, list[tuple[int, str]]] = {}
    by_sum: dict[str, list[tuple[int, int]]] = {}
    for r in db.execute("SELECT id, dir, filename, size, checksum FROM photos"):
        label, rel, _ = rooter.identity(r["dir"], r["filename"])
        full = PurePath(r["dir"], r["filename"]).as_posix()
        if label is not None:
            by_key[(label, rel)] = r["id"]
            by_key_fold.setdefault((label.casefold(), rel.casefold()), []).append(r["id"])
            by_rel.setdefault(rel, []).append(r["id"])
        by_abs[_abs_key(full)] = r["id"]
        by_name.setdefault(r["filename"].casefold(), []).append((r["id"], full.casefold()))
        if r["checksum"]:
            by_sum.setdefault(r["checksum"], []).append((r["id"], r["size"]))

    backup_labels = [rt.get("label") for rt in b["roots"] if isinstance(rt.get("label"), str)]
    current = {lb.casefold(): lb for lb in rooter.labels}
    label_map: dict[str, str] = {}
    for lb in backup_labels:
        if lb.casefold() in current:
            label_map[lb] = current[lb.casefold()]
    if len(backup_labels) == 1 and len(rooter.labels) == 1 and not label_map:
        label_map[backup_labels[0]] = rooter.labels[0]  # the one root was renamed

    photos = b["photos"]
    matched: list[int | None] = [None] * len(photos)
    claimed: set[int] = set()
    stats = {"in_backup": len(photos), "matched_by_path": 0, "matched_by_checksum": 0,
             "unmatched": 0, "ambiguous_checksum": 0}

    def take(i: int, pid: int | None) -> bool:
        if pid is None or pid in claimed:
            return False
        matched[i] = pid
        claimed.add(pid)
        return True

    def unique(ids: list[int] | None) -> int | None:
        return ids[0] if ids and len(ids) == 1 else None

    for i, p in enumerate(photos):
        rel, root = p["rel"], p["root"]
        hit = None
        if isinstance(rel, str):
            mapped = label_map.get(root) if isinstance(root, str) else None
            if mapped is not None:
                hit = by_key.get((mapped, rel))
                if hit is None:
                    hit = unique(by_key_fold.get((mapped.casefold(), rel.casefold())))
            else:
                suffix = f"/{root}/{rel}".casefold() if isinstance(root, str) else f"/{rel}".casefold()
                name = rel.rsplit("/", 1)[-1].casefold()
                hit = unique([pid for pid, full in by_name.get(name, ()) if full.endswith(suffix)])
                if hit is None:
                    hit = unique(by_rel.get(rel))
        elif isinstance(p["abs"], str):
            hit = by_abs.get(_abs_key(p["abs"]))
        if take(i, hit):
            stats["matched_by_path"] += 1

    sum_counts: dict[str, int] = {}
    for p in photos:
        if p["checksum"]:
            sum_counts[p["checksum"]] = sum_counts.get(p["checksum"], 0) + 1
    samples = []
    for i, p in enumerate(photos):
        if matched[i] is not None:
            continue
        cs = p["checksum"]
        if cs and cs in by_sum:
            cands = [(pid, size) for pid, size in by_sum[cs] if pid not in claimed]
            if (len(by_sum[cs]) == 1 and sum_counts[cs] == 1 and cands
                    and (p["size"] is None or cands[0][1] is None or cands[0][1] == p["size"])):
                take(i, cands[0][0])
                stats["matched_by_checksum"] += 1
                continue
            if len(by_sum[cs]) > 1 or sum_counts[cs] > 1:
                stats["ambiguous_checksum"] += 1
        stats["unmatched"] += 1
        if len(samples) < _SAMPLE_CAP:
            samples.append(_photo_label(p))
    stats["unmatched_sample"] = samples
    return matched, stats


def _match_faces(b: dict, photo_ids: list[int | None]) -> list[int | None]:
    """Backup face index -> current face id (or None). Per photo, backup and
    current boxes of the same kind (detected vs manual) are paired greedily by
    descending IoU, one-to-one, at FACE_MATCH_IOU or better. A detected face is
    never paired with a manual one: a manual box records that detection missed,
    and a backed-up manual face with no manual twin here is re-created."""
    import json as _json
    from geotagger.faces import _iou

    faces = b["faces"]
    out: list[int | None] = [None] * len(faces)
    wanted: dict[int, list[int]] = {}
    for i, f in enumerate(faces):
        pid = photo_ids[f["photo"]]
        if pid is not None:
            wanted.setdefault(pid, []).append(i)
    if not wanted:
        return out
    current: dict[int, list] = {}
    for r in index.get_db().execute(
            "SELECT id, photo_id, bbox, source FROM faces "
            "WHERE photo_id IN (SELECT value FROM json_each(?))",
            (_json.dumps(sorted(wanted)),)):
        box = _parse_bbox(r["bbox"])
        if box is not None:
            current.setdefault(r["photo_id"], []).append((r["id"], box, r["source"] == "manual"))
    for pid, idxs in wanted.items():
        pairs = []
        for i in idxs:
            bbox = _parse_bbox(faces[i]["bbox"])
            manual = faces[i].get("source") == "manual"
            for fid, box, cur_manual in current.get(pid, ()):
                if cur_manual != manual:
                    continue
                score = _iou(bbox, box)
                if score >= FACE_MATCH_IOU:
                    pairs.append((score, i, fid))
        used_b: set[int] = set()
        used_c: set[int] = set()
        for _score, i, fid in sorted(pairs, key=lambda t: t[0], reverse=True):
            if i in used_b or fid in used_c:
                continue
            out[i] = fid
            used_b.add(i)
            used_c.add(fid)
    return out


# ── Apply (inside the one write transaction) ──

_CATEGORIES = ("families", "persons", "settings", "places", "geotags", "geocode_ignored",
               "dates", "faces", "representatives", "face_negatives")


@dataclass
class _Ctx:
    db: sqlite3.Connection
    b: dict
    overwrite: bool
    photo_ids: list
    face_ids: list
    counts: dict = field(default_factory=lambda: {
        c: {"applied": 0, "already_present": 0, "conflict": 0, "unmatched": 0}
        for c in _CATEGORIES})
    conflicts: list = field(default_factory=list)
    unmatched_faces: list = field(default_factory=list)
    unknown_settings: list = field(default_factory=list)
    family_ids: dict = field(default_factory=dict)
    person_ids: dict = field(default_factory=dict)
    applied_settings: dict = field(default_factory=dict)
    faces_changed: bool = False
    geotags_changed: bool = False

    def __post_init__(self):
        self.counts["faces"]["created"] = 0  # manual faces re-created (subset of applied)

    def count(self, category: str, outcome: str):
        self.counts[category][outcome] += 1

    def conflict(self, category: str, key, current, backup, applied: bool):
        """A different user value is already here. Skipped unless overwrite."""
        self.count(category, "applied" if applied else "conflict")
        if len(self.conflicts) < _SAMPLE_CAP:
            self.conflicts.append({"category": category, "key": key, "current": current,
                                   "backup": backup, "overwritten": applied})


def _restore_families(ctx: _Ctx):
    db = ctx.db
    ctx.family_ids = {r["name"]: r["id"] for r in db.execute("SELECT id, name FROM families")}
    for fam in ctx.b["families"]:
        if fam["name"] in ctx.family_ids:
            ctx.count("families", "already_present")
            continue
        _family_id(ctx, fam["name"], fam.get("created_at"))


def _family_id(ctx: _Ctx, name: str, created_at=None) -> int:
    fid = ctx.family_ids.get(name)
    if fid is None:
        fid = ctx.db.execute("INSERT INTO families (name, created_at) VALUES (?, ?)",
                             (name, created_at or time.time())).lastrowid
        ctx.family_ids[name] = fid
        ctx.count("families", "applied")
    return fid


def _restore_persons(ctx: _Ctx):
    db = ctx.db
    rows = {r["name"]: r for r in db.execute(
        "SELECT id, name, birth_date, not_before, not_after, family_id FROM persons")}
    ctx.person_ids = {name: r["id"] for name, r in rows.items()}
    for p in ctx.b["persons"]:
        name = p["name"]
        fam = p.get("family")
        fam_id = _family_id(ctx, fam) if isinstance(fam, str) else None
        row = rows.get(name)
        if row is None:
            ctx.person_ids[name] = db.execute(
                "INSERT INTO persons (name, birth_date, not_before, not_after, family_id, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (name, p.get("birth_date"), p.get("not_before"), p.get("not_after"), fam_id,
                 p.get("created_at") or time.time())).lastrowid
            ctx.count("persons", "applied")
            continue
        # Existing person (names are UNIQUE): fill what's unset; a different value
        # already here is the user's newer word unless overwrite. Unset fields are
        # still filled when another field conflicts.
        changes: dict[str, object] = {}
        conflicted = False
        for col, bval, cval in (("birth_date", p.get("birth_date"), row["birth_date"]),
                                ("not_before", p.get("not_before"), row["not_before"]),
                                ("not_after", p.get("not_after"), row["not_after"]),
                                ("family_id", fam_id, row["family_id"])):
            if bval is None or bval == cval:
                continue
            if cval is None or ctx.overwrite:
                changes[col] = bval
            if cval is not None:
                conflicted = True
                if len(ctx.conflicts) < _SAMPLE_CAP:
                    ctx.conflicts.append({"category": "persons", "key": f"{name}.{col}",
                                          "current": cval, "backup": bval,
                                          "overwritten": ctx.overwrite})
        if changes:
            # Column names come from the fixed tuple above, never from the input.
            sets = ", ".join(f"{c}=?" for c in changes)
            db.execute(f"UPDATE persons SET {sets} WHERE id=?", (*changes.values(), row["id"]))
        if conflicted and not ctx.overwrite:
            ctx.count("persons", "conflict")
        elif changes:
            ctx.count("persons", "applied")
        else:
            ctx.count("persons", "already_present")


def _person_id(ctx: _Ctx, name: str) -> int:
    """Id of a person a face/negative names, creating it if the backup's persons
    list somehow lacks it (a hand-edited file)."""
    pid = ctx.person_ids.get(name)
    if pid is None:
        pid = ctx.db.execute("INSERT INTO persons (name, created_at) VALUES (?, ?)",
                             (name, time.time())).lastrowid
        ctx.person_ids[name] = pid
        ctx.count("persons", "applied")
    return pid


def _restore_settings(ctx: _Ctx):
    db = ctx.db
    current = {r["key"]: r["value"] for r in db.execute("SELECT key, value FROM settings")}
    for key, raw in ctx.b["settings"].items():
        try:
            value = str(config.coerce_setting(key, raw))
        except (KeyError, ValueError, TypeError):
            # Unknown here (a setting since removed) or out of today's range.
            ctx.count("settings", "unmatched")
            ctx.unknown_settings.append(key)
            continue
        cur = current.get(key)
        if cur == value:
            ctx.count("settings", "already_present")
            continue
        if cur is not None:
            ctx.conflict("settings", key, cur, value, ctx.overwrite)
            if not ctx.overwrite:
                continue
        db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, time.time()))
        if cur is None:
            ctx.count("settings", "applied")
        ctx.applied_settings[key] = value


def _restore_places(ctx: _Ctx):
    db = ctx.db
    rows = [dict(r) for r in db.execute(
        "SELECT id, name, type, bounds, representative_photo_id FROM places")]
    live = {r["id"] for r in db.execute(
        "SELECT id FROM photos WHERE id IN (SELECT value FROM json_each(?))",
        (index.ids_json([r["representative_photo_id"] for r in rows
                         if r["representative_photo_id"] is not None]),))}
    for pl in ctx.b["places"]:
        rep_idx = pl.get("representative_photo")
        rep_id = ctx.photo_ids[rep_idx] if rep_idx is not None else None
        same_name = [r for r in rows if r["name"] == pl["name"] and r["type"] == pl["type"]]
        if not same_name:
            new_id = db.execute(
                "INSERT INTO places (name, type, bounds, created_at, representative_photo_id) "
                "VALUES (?, ?, ?, ?, ?)",
                (pl["name"], pl["type"], pl["bounds"], pl.get("created_at") or time.time(),
                 rep_id)).lastrowid
            rows.append({"id": new_id, "name": pl["name"], "type": pl["type"],
                         "bounds": pl["bounds"], "representative_photo_id": rep_id})
            ctx.count("places", "applied")
            continue
        target = next((r for r in same_name if r["bounds"] == pl["bounds"]), None)
        if target is None:
            # Same name, different shape. Names aren't unique, so this may be the
            # user's redrawn version; only overwrite replaces it, and only when the
            # name picks out a single place.
            apply = ctx.overwrite and len(same_name) == 1
            ctx.conflict("places", pl["name"], same_name[0]["bounds"], pl["bounds"], apply)
            if not apply:
                continue
            target = same_name[0]
            db.execute("UPDATE places SET bounds=? WHERE id=?", (pl["bounds"], target["id"]))
            target["bounds"] = pl["bounds"]
            if rep_id is not None:
                db.execute("UPDATE places SET representative_photo_id=? WHERE id=?",
                           (rep_id, target["id"]))
            continue
        cur_rep = target["representative_photo_id"]
        if cur_rep not in live:
            cur_rep = None  # dangling (photo pruned) counts as unset
        if rep_id is None or rep_id == cur_rep:
            ctx.count("places", "already_present")
        elif cur_rep is None or ctx.overwrite:
            db.execute("UPDATE places SET representative_photo_id=? WHERE id=?",
                       (rep_id, target["id"]))
            target["representative_photo_id"] = rep_id
            live.add(rep_id)
            if cur_rep is None:
                ctx.count("places", "applied")
            else:
                ctx.conflict("places", f"{pl['name']}.representative_photo", cur_rep, rep_id, True)
        else:
            ctx.conflict("places", f"{pl['name']}.representative_photo", cur_rep, rep_id, False)


def _same_coords(a_lat, a_lng, b_lat, b_lng) -> bool:
    return (abs(a_lat - b_lat) <= _COORD_MATCH_DEG and abs(a_lng - b_lng) <= _COORD_MATCH_DEG)


def _restore_photos(ctx: _Ctx):
    """Geotags, removal markers, geocode_ignored and approximate dates — DB only.
    Restore never writes a sidecar (nor touches sidecar tracking), so a restored
    geotag is stored as geotag_source='database': the form a rescan preserves
    (upsert_photo's keep rule) and the on-demand sidecar export picks up."""
    db = ctx.db
    photos = ctx.b["photos"]
    ids = [pid for pid in ctx.photo_ids if pid is not None]
    cur = {r["id"]: r for r in db.execute(
        "SELECT id, lat, lng, geotag_source, geotag_removed, geocode_ignored, "
        "photo_datetime, date_precision FROM photos "
        "WHERE id IN (SELECT value FROM json_each(?))", (index.ids_json(ids),))}
    set_coords, set_removed, set_ignored, set_dates = [], [], [], []
    for i, p in enumerate(photos):
        has_coords = isinstance(p["lat"], (int, float)) and isinstance(p["lng"], (int, float))
        wants = {"geotags": has_coords or bool(p["geotag_removed"]),
                 "geocode_ignored": bool(p["geocode_ignored"]),
                 "dates": bool(p["date_precision"])}
        row = cur.get(ctx.photo_ids[i])
        if row is None:
            for cat, w in wants.items():
                if w:
                    ctx.count(cat, "unmatched")
            continue
        key = _photo_label(p)

        if wants["geotags"]:
            c_coords = row["lat"] is not None and row["lng"] is not None
            c_src, c_removed = row["geotag_source"], bool(row["geotag_removed"])
            # A user geotag (DB or sidecar) beats GPS embedded in the file — the
            # same precedence upsert_photo applies on a rescan.
            c_from_file = c_coords and c_src == "embedded"
            unset = not c_coords and not c_removed
            if has_coords:
                b_user = p["geotag_source"] in ("database", "sidecar")
                if c_coords and _same_coords(row["lat"], row["lng"], p["lat"], p["lng"]):
                    ctx.count("geotags", "already_present")
                elif unset or (c_from_file and b_user):
                    set_coords.append((p["lat"], p["lng"], p["gps_accuracy"], row["id"]))
                    ctx.count("geotags", "applied")
                else:
                    current = [row["lat"], row["lng"]] if c_coords else "removed"
                    ctx.conflict("geotags", key, current, [p["lat"], p["lng"]], ctx.overwrite)
                    if ctx.overwrite:
                        set_coords.append((p["lat"], p["lng"], p["gps_accuracy"], row["id"]))
            else:  # backed up as removed
                if c_removed:
                    ctx.count("geotags", "already_present")
                elif unset or c_from_file:
                    set_removed.append((row["id"],))
                    ctx.count("geotags", "applied")
                else:
                    ctx.conflict("geotags", key, [row["lat"], row["lng"]], "removed", ctx.overwrite)
                    if ctx.overwrite:
                        set_removed.append((row["id"],))

        if wants["geocode_ignored"]:
            if row["geocode_ignored"]:
                ctx.count("geocode_ignored", "already_present")
            else:
                set_ignored.append((row["id"],))
                ctx.count("geocode_ignored", "applied")

        if wants["dates"]:
            b_dt, b_prec = p["photo_datetime"], p["date_precision"]
            c_dt, c_prec = row["photo_datetime"], row["date_precision"]
            if c_prec == b_prec and c_dt == b_dt:
                ctx.count("dates", "already_present")
            elif c_prec is None and (c_dt == b_dt or not c_dt):
                # The sidecar already brought the date back (only its precision
                # flag is DB-only), or the photo is undated here.
                set_dates.append((b_dt, b_prec, row["id"]))
                ctx.count("dates", "applied")
            else:
                ctx.conflict("dates", key, [c_dt, c_prec], [b_dt, b_prec], ctx.overwrite)
                if ctx.overwrite:
                    set_dates.append((b_dt, b_prec, row["id"]))

    clear = index.DERIVED_LOCATION_CLEAR_SQL
    if set_coords:
        db.executemany(
            f"UPDATE photos SET lat=?, lng=?, gps_accuracy=?, geotag_source='database', "
            f"geotag_removed=0, {clear} WHERE id=?", set_coords)
    if set_removed:
        db.executemany(
            f"UPDATE photos SET lat=NULL, lng=NULL, gps_accuracy=NULL, geotag_source='none', "
            f"geotag_removed=1, {clear} WHERE id=?", set_removed)
    if set_ignored:
        db.executemany("UPDATE photos SET geocode_ignored=1 WHERE id=?", set_ignored)
    if set_dates:
        db.executemany("UPDATE photos SET photo_datetime=?, date_precision=? WHERE id=?",
                       set_dates)
        ctx.faces_changed = True  # photo times feed age-aware suggestions
    if set_coords or set_removed or set_ignored:
        ctx.geotags_changed = True


def _face_label(ctx: _Ctx, f: dict) -> str:
    return f"{_photo_label(ctx.b['photos'][f['photo']])} [{f['bbox']}]"


def _restore_faces(ctx: _Ctx):
    """Person assignment + ignored/come-back state on matched faces; manual faces
    without a twin here are re-created. A face's state counts as unset only when
    it is unlabeled (no person, not ignored, not come-back)."""
    db = ctx.db
    faces = ctx.b["faces"]
    matched = [fid for fid in ctx.face_ids if fid is not None]
    cur = {r["id"]: r for r in db.execute(
        "SELECT id, person_id, ignored, come_back, representative FROM faces "
        "WHERE id IN (SELECT value FROM json_each(?))", (index.ids_json(matched),))}
    names = {pid: name for name, pid in ctx.person_ids.items()}
    updates, rep_updates = [], []
    now = time.time()
    for i, f in enumerate(faces):
        person = f.get("person") if isinstance(f.get("person"), str) else None
        ignored, come_back = bool(f.get("ignored")), bool(f.get("come_back"))
        if person is not None:
            ignored = come_back = False  # one state per face (see index.init_db)
        rep = bool(f.get("representative")) and person is not None
        state = (person, ignored, come_back)
        pid = ctx.photo_ids[f["photo"]]
        fid = ctx.face_ids[i]
        if fid is not None and fid not in cur:
            fid = ctx.face_ids[i] = None  # rescanned away since matching
        if fid is None:
            if pid is not None and f.get("source") == "manual":
                emb = f.get("embedding_b64")
                new_id = db.execute(
                    "INSERT INTO faces (photo_id, person_id, bbox, det_score, source, ignored, "
                    "come_back, representative, created_at, assigned_at, ignored_at, "
                    "come_back_at) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)",
                    (pid, _person_id(ctx, person) if person else None, f["bbox"],
                     f.get("det_score") or 1.0, int(ignored), int(come_back), int(rep),
                     f.get("created_at") or now,
                     *_face_times(f, person, ignored, come_back, now))).lastrowid
                if emb:
                    db.execute("INSERT INTO face_embeddings (face_id, embedding) VALUES (?, ?)",
                               (new_id, base64.b64decode(emb)))
                ctx.face_ids[i] = new_id
                ctx.count("faces", "applied")
                ctx.count("faces", "created")
                if rep:
                    ctx.count("representatives", "applied")
                ctx.faces_changed = True
            else:
                ctx.count("faces", "unmatched")
                if rep:
                    ctx.count("representatives", "unmatched")
                if len(ctx.unmatched_faces) < _SAMPLE_CAP:
                    ctx.unmatched_faces.append(
                        _face_label(ctx, f) + ("" if pid is not None else " (photo unmatched)"))
            continue

        row = cur[fid]
        c_state = (names.get(row["person_id"]), bool(row["ignored"]), bool(row["come_back"]))
        unlabeled = (None, False, False)
        if state == c_state or state == unlabeled:
            ctx.count("faces", "already_present")
            apply_state = False
        elif c_state == unlabeled:
            ctx.count("faces", "applied")
            apply_state = True
        else:
            ctx.conflict("faces", _face_label(ctx, f), _state_json(c_state), _state_json(state),
                         ctx.overwrite)
            apply_state = ctx.overwrite
        if apply_state:
            updates.append((
                _person_id(ctx, person) if person else None, int(ignored), int(come_back),
                int(rep), *_face_times(f, person, ignored, come_back, now), fid))
            if rep:
                ctx.count("representatives", "applied")
        elif rep:
            if state != c_state:
                ctx.count("representatives", "conflict")
            elif row["representative"]:
                ctx.count("representatives", "already_present")
            else:
                rep_updates.append((fid,))
                ctx.count("representatives", "applied")
    if updates:
        db.executemany(
            "UPDATE faces SET person_id=?, ignored=?, come_back=?, representative=?, "
            "assigned_at=?, ignored_at=?, come_back_at=? WHERE id=?", updates)
    if rep_updates:
        db.executemany("UPDATE faces SET representative=1 WHERE id=?", rep_updates)
    if updates or rep_updates:
        ctx.faces_changed = True


def _face_times(f: dict, person, ignored: bool, come_back: bool, now: float) -> tuple:
    """(assigned_at, ignored_at, come_back_at) as backed up — kept verbatim, since
    the app's own writes can leave e.g. an ignored_at behind on a later-assigned
    face — with ``now`` standing in only when a state is set but its time is
    missing (a hand-edited or format-1 file)."""
    def t(key, active):
        v = f.get(key)
        return v if isinstance(v, (int, float)) else (now if active else None)
    return t("assigned_at", person is not None), t("ignored_at", ignored), t("come_back_at", come_back)


def _state_json(state: tuple) -> dict:
    person, ignored, come_back = state
    return {"person": person, "ignored": ignored, "come_back": come_back}


def _restore_face_negatives(ctx: _Ctx):
    db = ctx.db
    ids = [fid for fid in ctx.face_ids if fid is not None]
    existing = {(r["face_id"], r["person_id"]) for r in db.execute(
        "SELECT face_id, person_id FROM face_negatives "
        "WHERE face_id IN (SELECT value FROM json_each(?))", (index.ids_json(ids),))}
    rows = []
    for n in ctx.b["face_negatives"]:
        fid = ctx.face_ids[n["face"]]
        if fid is None:
            ctx.count("face_negatives", "unmatched")
            continue
        key = (fid, _person_id(ctx, n["person"]))
        if key in existing:
            ctx.count("face_negatives", "already_present")
            continue
        existing.add(key)
        rows.append((*key, n.get("created_at") or time.time()))
        ctx.count("face_negatives", "applied")
    if rows:
        db.executemany(
            "INSERT INTO face_negatives (face_id, person_id, created_at) VALUES (?, ?, ?)", rows)
        ctx.faces_changed = True


# Run in this order: persons need families, places/photos/faces need the photo
# match, negatives need faces (manual ones are created by _restore_faces).
# Looked up on the module at call time so a test can make one step fail.
_STEPS = ("_restore_families", "_restore_persons", "_restore_settings", "_restore_places",
          "_restore_photos", "_restore_faces", "_restore_face_negatives")


def restore_backup(data: dict, *, dry_run: bool = True, overwrite: bool = False,
                   roots: list[str] | None = None) -> dict:
    """Re-attach a backup's user data to the current library. Additive: nothing is
    ever deleted, and a different user value already here is reported as a
    conflict and left alone unless ``overwrite``. ``roots`` defaults to the
    configured scan roots.

    All writes run in ONE index.transaction(), so any failure rolls back the whole
    restore. ``dry_run`` (the default) runs exactly the same code inside a
    savepoint that is rolled back, so its report is the real run's report and the
    database is left untouched. Matching reads (photos by path/checksum, faces by
    IoU) run before the transaction; no ExifTool, hashing or file access at all —
    stored checksums only. Returns the report (see _report)."""
    t0 = time.time()
    b = _normalize(data)
    photo_ids, photo_stats = _match_photos(b, configured_roots() if roots is None else roots)
    face_ids = _match_faces(b, photo_ids)

    with index.transaction() as db:
        if dry_run:
            db.execute("SAVEPOINT backup_dry_run")
        ctx = _Ctx(db=db, b=b, overwrite=overwrite, photo_ids=photo_ids, face_ids=face_ids)
        try:
            for step in _STEPS:
                globals()[step](ctx)
        finally:
            if dry_run:
                db.execute("ROLLBACK TO backup_dry_run")
                db.execute("RELEASE backup_dry_run")

    if not dry_run:
        _after_commit(ctx)
    report = _report(ctx, b, photo_stats, dry_run, overwrite)
    logger.info(f"Backup restore ({'dry run' if dry_run else 'applied'}) in "
                f"{(time.time() - t0) * 1000:.2f}ms: "
                + ", ".join(f"{c}={v['applied']}" for c, v in ctx.counts.items()))
    return report


def _after_commit(ctx: _Ctx):
    """Invalidate what the restored rows make stale, once the commit has landed."""
    for key, value in ctx.applied_settings.items():
        config.apply_setting_override(key, value)
    if ctx.faces_changed or ctx.counts["persons"]["applied"]:
        index.bump_faces_generation()
    from geotagger.services import hotspots_service, settings_service, work_queue_service
    if ctx.geotags_changed:
        index.bump_geotag_generation()
        hotspots_service.invalidate()
        # The work queue is built from untagged/not-ignored photos.
        work_queue_service.invalidate()
    # Restored settings make stale whatever caches bake them in (work queue
    # grouping, face gallery/suggestion scores) — the same map the settings
    # routes use, applied after the overrides above.
    settings_service.invalidate_for(ctx.applied_settings)


def _report(ctx: _Ctx, b: dict, photo_stats: dict, dry_run: bool, overwrite: bool) -> dict:
    return {
        "dry_run": dry_run,
        "overwrite": overwrite,
        "source_format": b["source_format"],
        "photos": photo_stats,
        **ctx.counts,
        "conflicts_sample": ctx.conflicts,
        "unmatched_faces_sample": ctx.unmatched_faces,
        "unknown_settings": ctx.unknown_settings,
        "note": ("Nothing was changed (dry run). Re-run with dry_run=false to apply."
                 if dry_run else
                 "Restored values are stored in the database only; no sidecar was "
                 "written. Use the sidecar export to write restored geotags to XMP."),
    }
