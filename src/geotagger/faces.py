"""Face detection + recognition engine.

Detection/embedding is provided by InsightFace's ``buffalo_l`` pack (SCRFD
detector + ArcFace r50 embeddings) running on ONNX Runtime. "Recognition" is a
nearest-neighbour search: every face becomes a 512-d L2-normalized embedding,
and an unknown face is identified by cosine similarity against the faces the
user has already assigned to a person.

The model object is loaded lazily on first use (it downloads ~275 MB once into
the cache dir) and guarded by a lock, since detection is CPU-heavy and the
underlying sessions are shared.
"""
import logging
import threading
import time as _time
from pathlib import Path

import numpy as np

_log = logging.getLogger(__name__)

from geotagger import index, thumbnails, config
from geotagger.config import (
    CACHE_DIR_NAME, get_cache_dir,
    FACE_MODEL_NAME, FACE_DET_SIZE, FACE_DET_THRESHOLD, FACE_PROVIDERS,
)

YEAR_SECONDS = 365.25 * 86400


def _cfg(value, key: str):
    """Resolve an optional override: fall back to the live (possibly
    settings-page-overridden) config value when the caller didn't pass one.
    Used for knobs in config.SETTINGS_SPEC — a plain `from geotagger.config
    import KEY` default would freeze the env-startup value into this
    function's signature forever, missing later overrides."""
    return getattr(config, key) if value is None else value

_model_dir: Path | None = None
_app = None  # insightface.app.FaceAnalysis, loaded lazily
_app_lock = threading.Lock()

EMBED_DIM = 512


def init_faces(root: Path | None = None):
    """Resolve where model files live. Mirrors thumbnails.init_thumbs.

    Does not load the model — that happens on first detect call so startup
    stays fast and the download only happens when faces are actually used.
    """
    global _model_dir
    cache_dir_from_env = get_cache_dir()
    if cache_dir_from_env:
        cache_dir = cache_dir_from_env
    elif root:
        cache_dir = root / CACHE_DIR_NAME
    else:
        raise RuntimeError("Must specify root directory or set GEOTAGGER_CACHE_DIR")
    _model_dir = cache_dir / "insightface"
    _model_dir.mkdir(parents=True, exist_ok=True)


def _get_app():
    """Lazily construct the FaceAnalysis pipeline (detection + recognition only)."""
    global _app
    if _app is not None:
        return _app
    with _app_lock:
        if _app is not None:
            return _app
        if _model_dir is None:
            raise RuntimeError("Faces not initialized — call init_faces first")
        from insightface.app import FaceAnalysis
        # Only load the detector + recognizer; skip gender/age and landmark
        # models we don't use, which cuts load time and memory.
        app = FaceAnalysis(
            name=FACE_MODEL_NAME,
            root=str(_model_dir),
            allowed_modules=["detection", "recognition"],
            providers=FACE_PROVIDERS,
        )
        ctx_id = 0 if any("CUDA" in p for p in FACE_PROVIDERS) else -1
        app.prepare(ctx_id=ctx_id, det_size=(FACE_DET_SIZE, FACE_DET_SIZE),
                    det_thresh=FACE_DET_THRESHOLD)
        _app = app
    return _app


# ── Embedding (de)serialization ──

def encode_embedding(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float32).tobytes()


def decode_embedding(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


# ── Detection ──

def detect_faces(path: Path, mtime: float, size: int,
                 orientation: int | None = None) -> tuple[list[dict], int | None]:
    """Detect faces in a photo; return ``(faces, det_dimension)``.

    Runs on the UPRIGHT detection image (``thumbnails.get_detection_preview`` — the
    oriented display preview, or a full LibRaw decode rotated upright when
    ``config.RAW_FULL_DECODE`` is on), because SCRFD/ArcFace expect upright faces; a
    sideways face in a rotated photo would otherwise be missed. Detected boxes come out
    in display space and are mapped back to SENSOR space (``unorient_bbox``) for storage,
    keeping the sensor-space convention the rest of the pipeline relies on. ``faces`` is
    a list of {bbox, det_score, embedding} ready for index.replace_faces; boxes are
    normalized to 0..1 and resolution-independent. ``det_dimension`` is the long edge
    (px) of the image detection ran on when that was a full/real decode, else None
    (embedded/normal preview) — persisted so low-res RAW scans can be re-run later.
    """
    import cv2

    preview, is_full = thumbnails.get_detection_preview(path, mtime, size, orientation)
    arr = cv2.imdecode(np.frombuffer(preview, np.uint8), cv2.IMREAD_COLOR)  # BGR
    if arr is None:
        raise RuntimeError(f"Could not decode preview for {path}")
    h, w = arr.shape[:2]
    det_dimension = max(h, w) if is_full else None

    app = _get_app()
    with _app_lock:
        faces = app.get(arr)

    results = []
    for f in faces:
        x1, y1, x2, y2 = f.bbox
        # Clamp + normalize to the (upright) detection image, then map back to sensor
        # space so the stored box follows the sensor-space convention.
        disp_bbox = [
            max(0.0, x1 / w), max(0.0, y1 / h),
            min(1.0, x2 / w), min(1.0, y2 / h),
        ]
        bbox = thumbnails.unorient_bbox(disp_bbox, orientation)
        results.append({
            "bbox": ",".join(f"{v:.5f}" for v in bbox),
            "det_score": float(f.det_score),
            "embedding": encode_embedding(f.normed_embedding),
        })
    return results, det_dimension


def detect_and_store(photo_row) -> int:
    """Detect faces for one indexed photo and persist them. Returns face count."""
    faces, det_dimension = detect_faces(
        Path(index.photo_path(photo_row)), photo_row["mtime"], photo_row["size"],
        photo_row["orientation"])
    index.replace_faces(photo_row["id"], faces, det_dimension)
    return len(faces)


# ── Recognition (nearest-neighbour over labeled faces) ──

def _birth_ts(birth_date: str | None) -> float:
    """ISO YYYY-MM-DD → epoch seconds (UTC, matching photo_datetime), or NaN."""
    if not birth_date:
        return float("nan")
    try:
        import calendar
        from datetime import datetime
        return float(calendar.timegm(datetime.strptime(birth_date[:10], "%Y-%m-%d").timetuple()))
    except Exception:
        return float("nan")


class Gallery:
    """In-memory matrix of confirmed-face embeddings for fast cosine matching,
    plus each example's photo time and its person's birth time for age math."""

    def __init__(self, embeddings: np.ndarray, person_ids: np.ndarray,
                 face_times: np.ndarray, birth_times: np.ndarray):
        self._n = len(person_ids)

        # Pre-sorted by person_id for vectorized reduceat reduction in the hot path.
        # Built once at gallery-build time; the sort is O(N log N) but amortised
        # across every suggestion call until the gallery generation changes.
        # The originals (embeddings, person_ids, face_times, birth_times) are NOT
        # stored — the sorted copies below replace them everywhere, saving ~44 MB of
        # duplicate embedding storage per gallery.
        if self._n > 0:
            # Sort so that all faces of birth-date-having persons form a contiguous
            # prefix [0 .. _K_birth). Since birth dates are per-person (uniform
            # across each person's faces), this keeps each person's group intact.
            # Within each half the secondary sort is person_id ascending, so groups
            # are still contiguous for reduceat.  Contiguous prefix → age-adjustment
            # ops use scores[:_K_birth] (a view, no copy) instead of fancy indexing.
            has_birth_f = ~np.isnan(birth_times)
            not_birth_k = (~has_birth_f).astype(np.int8)        # 0=birth-dated, 1=not
            order = np.lexsort((person_ids, not_birth_k))

            self._s_embs  = np.ascontiguousarray(embeddings[order], dtype=np.float32)
            self._s_ft_yr = (face_times[order]  / YEAR_SECONDS).astype(np.float32)
            self._s_bt_yr = (birth_times[order] / YEAR_SECONDS).astype(np.float32)
            sorted_pids = person_ids[order]
            # Group boundaries: detect person-id changes in the custom-sorted array.
            changes = np.concatenate(([True], sorted_pids[1:] != sorted_pids[:-1]))
            starts  = np.nonzero(changes)[0].astype(np.intp)
            self._group_starts = starts
            self._uniq_pids    = sorted_pids[starts]   # NOT globally sorted; use _pid_to_group

            # O(1) person lookup now that _uniq_pids is not ascending.
            self._pid_to_group: dict[int, int] = {
                int(pid): i for i, pid in enumerate(self._uniq_pids)
            }
            # Pre-baked Python lists used in the per-person max loop (avoids
            # .tolist() in the hot path; faster than np.maximum.reduceat for
            # row-major matrices where reduceat does strided column-wise access).
            self._gs_list: list[int] = self._group_starts.tolist()
            self._ge_list: list[int] = self._gs_list[1:] + [self._n]

            # Birth-prefix metadata — views into the first _K_birth rows.
            self._K_birth    = int(has_birth_f.sum())
            self._bt_yr_birth = self._s_bt_yr[:self._K_birth]   # (K_b,) birth year view
            self._age_f_birth = (                                 # (K_b,) face-age-at-photo
                self._s_ft_yr[:self._K_birth] - self._s_bt_yr[:self._K_birth]
            )
            self._has_ft_birth = ~np.isnan(self._s_ft_yr[:self._K_birth])  # (K_b,) bool
        else:
            dim = embeddings.shape[1] if embeddings.ndim == 2 and len(embeddings) else EMBED_DIM
            self._s_embs       = np.empty((0, dim), np.float32)
            self._s_ft_yr      = np.empty(0, np.float32)
            self._s_bt_yr      = np.empty(0, np.float32)
            self._group_starts = np.empty(0, np.intp)
            self._uniq_pids    = np.empty(0, np.int64)
            self._pid_to_group = {}
            self._K_birth      = 0
            self._bt_yr_birth  = np.empty(0, np.float32)
            self._age_f_birth  = np.empty(0, np.float32)
            self._has_ft_birth = np.empty(0, bool)
            self._gs_list: list[int] = []
            self._ge_list: list[int] = []

    def __len__(self) -> int:
        return self._n


def _embeddings_matrix(rows) -> np.ndarray:
    """Decode many rows' embedding blobs into one (N, 512) float32 matrix.

    Joining the raw bytes and viewing them once is far cheaper than stacking N
    individual ``frombuffer`` arrays — it's the per-call decode cost on the
    suggestion hot path. The result is a read-only view over the joined buffer;
    callers only ever read it (or fancy-index it, which copies).
    """
    buf = b"".join(r["embedding"] for r in rows)
    return np.frombuffer(buf, dtype=np.float32).reshape(len(rows), EMBED_DIM)


# Decoded embedding matrices are expensive to rebuild (SQLite blob reads + numpy
# decode) and the people UI refetches constantly, so both the labeled gallery and
# the unlabeled scan are cached and keyed on index.faces_generation() — any
# assign/ignore/scan/birth-date change bumps it and the next call rebuilds.
_gallery_cache: tuple[int, "Gallery"] | None = None
_unlabeled_cache: tuple[int, int, list, np.ndarray, np.ndarray] | None = None
# Parallel to _unlabeled_cache rows: cached suggest_persons_batch output.
# Keyed on (gen, scan_cap) and pruned in drop_from_unlabeled_cache so the
# full matmul only runs when the generation actually changes, not on every
# accept in the suggested-only review loop.
_suggested_scores_cache: tuple[int, int, list] | None = None
# face_id -> {excluded person_id, ...}, keyed on faces_generation() (see
# get_negatives_map). The table is tiny (only user-rejected pairs), so a full
# read is cheap and refreshed automatically by the same generation bump every
# other face/person mutation already triggers.
_negatives_cache: tuple[int, dict[int, set[int]]] | None = None


def get_negatives_map() -> dict[int, set[int]]:
    """Cached face_id -> {excluded person_id}, keyed on faces_generation()."""
    global _negatives_cache
    gen = index.faces_generation()
    if _negatives_cache is not None and _negatives_cache[0] == gen:
        return _negatives_cache[1]
    m = index.get_all_face_negatives()
    _negatives_cache = (gen, m)
    return m


def _apply_negatives(per_person: np.ndarray, rows, c0: int,
                     gallery: "Gallery", neg_map: dict[int, set[int]] | None) -> None:
    """In-place: -inf out (person, face) cells the user marked as negatives.

    per_person is (P, chunk) for rows[c0 : c0+chunk]. Sparse: only faces present
    in neg_map do any work. Persons not in this gallery (no confirmed examples)
    simply have no group and are skipped."""
    if not neg_map:
        return
    for j in range(per_person.shape[1]):
        excl = neg_map.get(rows[c0 + j]["id"])
        if not excl:
            continue
        for pid in excl:
            g = gallery._pid_to_group.get(pid)
            if g is not None:
                per_person[g, j] = np.float32(-np.inf)


def _bbox_area(bbox: str) -> float:
    """Normalized bbox 'x1,y1,x2,y2' (0..1) -> area as a fraction of the image."""
    x1, y1, x2, y2 = (float(v) for v in bbox.split(","))
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def build_gallery() -> Gallery:
    """Load all confirmed faces into a matrix for matching (cached, see above).

    Labeled faces whose bbox is smaller than ``config.FACE_MIN_GALLERY_BBOX_AREA``
    (fraction of the image) are excluded as match SOURCES — a tiny/distant face
    embeds noisily even when correctly labeled, so it shouldn't anchor matches for
    other unlabeled faces. The face stays labeled and visible; this only trims
    what feeds the gallery matmul.
    """
    global _gallery_cache
    gen = index.faces_generation()
    if _gallery_cache is not None and _gallery_cache[0] == gen:
        return _gallery_cache[1]

    labeled = index.get_labeled_faces()
    min_area = config.FACE_MIN_GALLERY_BBOX_AREA
    if min_area > 0:
        labeled = [r for r in labeled if _bbox_area(r["bbox"]) >= min_area]
    if not labeled:
        z = np.zeros((0,), np.float64)
        gallery = Gallery(np.zeros((0, EMBED_DIM), np.float32), np.zeros((0,), np.int64), z, z)
    else:
        embs = _embeddings_matrix(labeled)
        pids = np.array([r["person_id"] for r in labeled], dtype=np.int64)
        ftimes = np.array([float(r["photo_datetime"]) if r["photo_datetime"] else np.nan
                           for r in labeled], dtype=np.float64)
        births = np.array([_birth_ts(r["birth_date"]) for r in labeled], dtype=np.float64)
        gallery = Gallery(embs, pids, ftimes, births)
    _gallery_cache = (gen, gallery)
    return gallery


def get_unlabeled_matrix(scan_cap: int | None = None
                         ) -> tuple[list, np.ndarray, np.ndarray]:
    """Cached (rows, embeddings, times) for the unlabeled queue.

    The suggested-faces review refetches after every accept; without caching,
    each call re-reads the embedding blobs from SQLite and re-decodes them into a
    (N, 512) matrix. ``scan_cap`` <= 0 means scan *all* unlabeled faces (SQLite
    ``LIMIT -1``); a positive cap keeps the top ``scan_cap`` by detection score.
    Defaults to the live ``config.FACE_SUGGEST_SCAN_CAP`` setting. Keyed on the
    faces-table generation (and the cap). Removals (assign/ignore) prune this in
    place via ``drop_from_unlabeled_cache`` so the exhaustive read happens once,
    not on every accept.
    """
    global _unlabeled_cache
    scan_cap = _cfg(scan_cap, "FACE_SUGGEST_SCAN_CAP")
    gen = index.faces_generation()
    if (_unlabeled_cache is not None
            and _unlabeled_cache[0] == gen and _unlabeled_cache[1] == scan_cap):
        return _unlabeled_cache[2], _unlabeled_cache[3], _unlabeled_cache[4]
    limit = scan_cap if scan_cap and scan_cap > 0 else -1   # -1 → unbounded
    floor = config.FACE_SUGGEST_MIN_DET_SCORE if config.FACE_SUGGEST_MIN_DET_SCORE > 0 else None
    rows = index.list_faces("unlabeled", None, limit, min_det_score=floor)
    unknowns, times = _stack_rows(rows)
    _unlabeled_cache = (gen, scan_cap, rows, unknowns, times)
    return rows, unknowns, times


def get_suggested_scores(scan_cap: int | None = None,
                         ) -> tuple[list, list]:
    """Cached (rows, match_scores) for the suggested-only review endpoint.

    ``match_scores`` is parallel to ``rows``: each element is ``(person_id,
    score)`` or ``None``. On a warm cache the matmul is skipped entirely;
    ``drop_from_unlabeled_cache`` keeps both the row list and this scores list
    in sync after each label/ignore action, so the rebuild only happens when
    faces are added or the gallery changes. Defaults to the live
    ``config.FACE_SUGGEST_SCAN_CAP`` setting.
    """
    global _suggested_scores_cache
    scan_cap = _cfg(scan_cap, "FACE_SUGGEST_SCAN_CAP")
    gen = index.faces_generation()
    rows, unknowns, times = get_unlabeled_matrix(scan_cap)
    if (_suggested_scores_cache is not None
            and _suggested_scores_cache[0] == gen
            and _suggested_scores_cache[1] == scan_cap):
        return rows, _suggested_scores_cache[2]
    gallery = build_gallery()
    scores = (suggest_persons_batch(rows, gallery, unknowns=unknowns, times=times)
              if len(gallery) > 0 else [None] * len(rows))
    _suggested_scores_cache = (gen, scan_cap, scores)
    return rows, scores


def window_rows(rows, unknowns: np.ndarray, times: np.ndarray,
                start_ts: int | None, end_ts: int | None,
                photo_ids: set[int] | list[int] | None = None
                ) -> tuple[list, np.ndarray, np.ndarray]:
    """Filter a decoded unlabeled matrix (rows/embeddings/times) to a Focus window.

    The People page's Focus windows the *candidate* faces (not the gallery),
    reusing the cached full-library matrix from ``get_unlabeled_matrix`` so the
    cache stays warm. ``start_ts``/``end_ts`` window by time (undated faces, NaN
    time, fall out of any time window); ``photo_ids`` (its "also limit to this
    area" spatial Focus) keeps only faces whose photo is inside a context's
    polygon. Returns the filtered ``(rows, unknowns, times)``; an all-None Focus
    returns them unchanged.
    """
    if start_ts is None and end_ts is None and photo_ids is None:
        return rows, unknowns, times
    mask = np.ones(len(rows), dtype=bool)
    if start_ts is not None:
        mask &= ~np.isnan(times) & (times >= start_ts)
    if end_ts is not None:
        mask &= ~np.isnan(times) & (times <= end_ts)
    if photo_ids is not None:
        idset = photo_ids if isinstance(photo_ids, set) else set(photo_ids)
        mask &= np.array([r["photo_id"] in idset for r in rows], dtype=bool)
    idx = np.flatnonzero(mask)
    return [rows[i] for i in idx], unknowns[idx], times[idx]


def drop_from_unlabeled_cache(face_ids):
    """Prune just-labeled/ignored faces from the cached unlabeled matrix instead
    of forcing a full re-read on the next scan, and re-tag the cache to the
    current generation so it survives the accept loop.

    Only valid for *removals* from the unlabeled set (assign-to-person, ignore).
    Additions (unassign, restore, new detections) bump the generation without
    calling this, so the next ``get_unlabeled_matrix`` rebuilds from scratch.
    """
    global _unlabeled_cache, _suggested_scores_cache
    if _unlabeled_cache is None:
        return
    old_gen, scan_cap, rows, unknowns, times = _unlabeled_cache
    drop = set(face_ids)
    keep = [i for i, r in enumerate(rows) if r["id"] not in drop]
    if len(keep) != len(rows):
        idx = np.array(keep, dtype=np.int64)
        rows = [rows[i] for i in keep]
        unknowns, times = unknowns[idx], times[idx]
        # Prune the scores cache in parallel so the next suggested-only call
        # doesn't trigger a full matmul rebuild just because we labeled some faces.
        # Guard: scores must come from the same generation as the unlabeled rows —
        # if they don't match (e.g. an unassign rebuilt the unlabeled cache without
        # clearing the scores cache) the indices would be out of range.
        if (_suggested_scores_cache is not None
                and _suggested_scores_cache[0] == old_gen
                and _suggested_scores_cache[1] == scan_cap):
            _, _, scores = _suggested_scores_cache
            scores = [scores[i] for i in keep]
            _suggested_scores_cache = (index.faces_generation(), scan_cap, scores)
        else:
            _suggested_scores_cache = None
    _unlabeled_cache = (index.faces_generation(), scan_cap, rows, unknowns, times)


def match_embedding(vec: np.ndarray, photo_datetime, gallery: Gallery,
                    exclude: set[int] | None = None) -> list[tuple[int, float]]:
    """Rank persons for an embedding by best (age-adjusted) cosine similarity.

    Embeddings are L2-normalized, so the dot product is the cosine. When the
    unknown face is dated and a candidate has a birth date, two age rules apply:
    a photo predating the person's birth excludes them outright, and examples
    taken at a very different age than the unknown are penalized — so a baby
    photo is matched against baby examples, not 5-year-old ones.
    Each person is scored by their single best example after adjustment.
    ``exclude`` is a set of person_ids to drop from the ranking entirely (this
    single face's negatives — the caller looks them up by face_id, since this
    function only sees the embedding).
    """
    if len(gallery) == 0:
        return []

    # Float32 matmul — no upcast to float64 (saves 21K × 4 bytes and a copy).
    scores = gallery._s_embs @ np.asarray(vec, dtype=np.float32)  # (N,) f32

    if photo_datetime:
        tu_yr     = np.float32(float(photo_datetime) / YEAR_SECONDS)
        has_birth = ~np.isnan(gallery._s_bt_yr)
        has_ft    = ~np.isnan(gallery._s_ft_yr)
        can_pen   = has_birth & has_ft
        age_u     = tu_yr - gallery._s_bt_yr          # (N,) f32: unknown's age per example
        age_f     = gallery._s_ft_yr - gallery._s_bt_yr   # (N,) f32: example's age
        excl      = has_birth & (age_u < np.float32(-config.FACE_BIRTH_TOLERANCE_YEARS))
        gap       = np.abs(age_u - age_f)
        penalty   = np.minimum(gap, np.float32(config.FACE_AGE_PENALTY_CAP_YEARS))
        penalty  *= np.float32(config.FACE_AGE_PENALTY_PER_YEAR)
        np.subtract(scores, penalty, where=can_pen, out=scores)
        scores[excl] = np.float32(-np.inf)

    # Per-person best — same slice-loop trick as _best_per_person_f32 to avoid
    # reduceat's strided-access penalty on row-major data.
    gs = gallery._gs_list; ge = gallery._ge_list; P = len(gs)
    if P == 0:
        return []
    per_person = np.array([scores[gs[i]:ge[i]].max() for i in range(P)], dtype=np.float32)
    if exclude:
        for pid in exclude:
            g = gallery._pid_to_group.get(pid)
            if g is not None:
                per_person[g] = np.float32(-np.inf)

    mask  = np.isfinite(per_person)
    pids  = gallery._uniq_pids[mask]
    svals = per_person[mask]
    order = np.argsort(svals)[::-1]
    return [(int(pids[order[i]]), float(svals[order[i]])) for i in range(len(order))]


def suggest_person(vec: np.ndarray, photo_datetime, gallery: Gallery,
                   threshold: float | None = None,
                   exclude: set[int] | None = None) -> tuple[int, float] | None:
    """Return (person_id, score) if the top match clears the threshold, else None.
    Defaults to the live ``config.FACE_MATCH_THRESHOLD`` setting. ``exclude``
    (person_ids) is forwarded to ``match_embedding``."""
    threshold = _cfg(threshold, "FACE_MATCH_THRESHOLD")
    ranked = match_embedding(vec, photo_datetime, gallery, exclude=exclude)
    if ranked and ranked[0][1] >= threshold:
        return ranked[0]
    return None


CHUNK = 1024  # caps each (gallery × unknown-chunk) score matrix to a few tens of MB


def _stack_rows(rows) -> tuple[np.ndarray, np.ndarray]:
    """Decode a sequence of face rows into an (N, 512) embedding matrix and an
    (N,) array of photo times (epoch secs, NaN where undated)."""
    unknowns = _embeddings_matrix(rows)
    times = np.array([float(r["photo_datetime"]) if r["photo_datetime"] else np.nan
                      for r in rows], dtype=np.float64)
    return unknowns, times


def _best_per_person_f32(gallery: Gallery,
                          unknowns: np.ndarray, times: np.ndarray) -> np.ndarray:
    """(P, u) float32 best age-adjusted cosine per person per unknown.

    All float32 throughout and ``np.maximum.reduceat`` for the per-group max.
    The gallery is sorted so birth-date-having persons occupy a contiguous
    prefix [0 .. _K_birth).  Age-adjustment ops use ``scores[:_K_birth]`` —
    a plain slice (a VIEW, not a copy), so in-place edits feed through to
    ``scores`` with no scatter/gather overhead.
    """
    scores = gallery._s_embs @ unknowns.T   # (N, u) float32

    K_b = gallery._K_birth
    if K_b > 0:
        dated = ~np.isnan(times)
        if dated.any():
            times_yr  = (times / YEAR_SECONDS).astype(np.float32)               # (u,)
            scores_b  = scores[:K_b]                                             # VIEW, no copy
            age_u     = times_yr[None, :] - gallery._bt_yr_birth[:, None]       # (K_b, u)
            excl      = (age_u < np.float32(-config.FACE_BIRTH_TOLERANCE_YEARS)) & dated[None, :]
            # Reuse age_u as the penalty array (saves K_b × u × 4 bytes).
            age_u -= gallery._age_f_birth[:, None]
            np.abs(age_u, out=age_u)
            np.minimum(age_u, np.float32(config.FACE_AGE_PENALTY_CAP_YEARS), out=age_u)
            age_u *= np.float32(config.FACE_AGE_PENALTY_PER_YEAR)
            # Apply where face has BOTH birth date AND a known photo datetime.
            can_b = gallery._has_ft_birth[:, None] & dated[None, :]
            np.subtract(scores_b, age_u, where=can_b, out=scores_b)  # in-place on view
            scores_b[excl] = np.float32(-np.inf)

    gs = gallery._gs_list
    ge = gallery._ge_list
    P  = len(gs)
    if P == 0:
        return np.empty((0, unknowns.shape[0]), dtype=np.float32)
    # Slice-per-person loop: each S[gs[i]:ge[i]] is a contiguous block in the
    # row-major matrix, so .max(axis=0) is cache-friendly.  np.maximum.reduceat
    # does strided column-wise access on the full (N, u) array and is ~50× slower.
    per_person = np.empty((P, scores.shape[1]), dtype=np.float32)
    for i in range(P):
        per_person[i] = scores[gs[i]:ge[i]].max(axis=0)
    return per_person


def suggest_persons_batch(rows, gallery: Gallery,
                          threshold: float | None = None,
                          unknowns: np.ndarray | None = None,
                          times: np.ndarray | None = None,
                          neg_map: dict[int, set[int]] | None = None,
                          ) -> list[tuple[int, float] | None]:
    """Vectorized ``suggest_person`` for many faces at once.

    ``rows`` is a sequence of DB rows each carrying an ``embedding`` blob and a
    ``photo_datetime``. Returns one ``(person_id, score)`` (or ``None``) per row,
    equivalent to calling ``suggest_person`` on each — but the N cosine lookups
    collapse into a single matmul per chunk and the per-person reduction is
    vectorized, instead of an N×gallery Python loop. Pass ``unknowns``/``times``
    (e.g. from ``get_unlabeled_matrix``) to skip decoding the embeddings again.
    ``threshold`` defaults to the live ``config.FACE_MATCH_THRESHOLD`` setting.
    ``neg_map`` (face_id -> excluded person_ids) masks out rejected candidates
    before ranking; defaults to the live ``get_negatives_map()``.
    """
    threshold = _cfg(threshold, "FACE_MATCH_THRESHOLD")
    n = len(rows)
    if n == 0 or len(gallery) == 0:
        return [None] * n

    if unknowns is None or times is None:
        unknowns, times = _stack_rows(rows)
    if neg_map is None:
        neg_map = get_negatives_map()
    uniq = gallery._uniq_pids

    results: list[tuple[int, float] | None] = [None] * n
    for c0 in range(0, n, CHUNK):
        c1 = min(c0 + CHUNK, n)
        per_person = _best_per_person_f32(gallery, unknowns[c0:c1], times[c0:c1])
        _apply_negatives(per_person, rows, c0, gallery, neg_map)
        best_i     = per_person.argmax(axis=0)
        best_score = per_person[best_i, np.arange(per_person.shape[1])]
        best_pid   = uniq[best_i]
        for j in range(c1 - c0):
            s = float(best_score[j])
            if np.isfinite(s) and s >= threshold:
                results[c0 + j] = (int(best_pid[j]), s)
    return results


def _rank_from_matrix(rows, unknowns: np.ndarray, times: np.ndarray, gallery: Gallery,
                      threshold: float | None = None,
                      neg_map: dict[int, set[int]] | None = None,
                      ) -> list[list[tuple[int, float]]]:
    """Full per-face ranking from an already-decoded embedding matrix.

    Returns, for each unknown, every person whose best example clears
    ``threshold`` as a ``(person_id, score)`` list ordered best-first. Working
    from a matrix (not DB rows) lets callers reuse embeddings they already
    decoded instead of decoding them twice. Defaults to the live
    ``config.FACE_MATCH_THRESHOLD`` setting. ``rows`` must line up 1:1 with
    ``unknowns``/``times`` (e.g. a filtered ``cand_rows``, not the full row
    list) — it's only used to key ``neg_map`` (face_id -> excluded person_ids,
    defaults to the live ``get_negatives_map()``).
    """
    threshold = _cfg(threshold, "FACE_MATCH_THRESHOLD")
    n = unknowns.shape[0]
    if n == 0 or len(gallery) == 0:
        return [[] for _ in range(n)]
    if neg_map is None:
        neg_map = get_negatives_map()

    uniq = gallery._uniq_pids
    results: list[list[tuple[int, float]]] = [[] for _ in range(n)]
    for c0 in range(0, n, CHUNK):
        c1         = min(c0 + CHUNK, n)
        per_person = _best_per_person_f32(gallery, unknowns[c0:c1], times[c0:c1])
        _apply_negatives(per_person, rows, c0, gallery, neg_map)
        # Batch argsort across all columns at once (one C call instead of one
        # per face), then filter per column in sorted order.
        order      = np.argsort(per_person, axis=0)[::-1]   # (P, chunk), descending
        pids_list  = uniq.tolist()
        for j in range(c1 - c0):
            ord_j = order[:, j]
            col   = per_person[ord_j, j]          # scores in descending order
            pids  = uniq[ord_j]                   # pids in matching order
            # Find the first index below threshold (scores are sorted descending).
            above = int(np.searchsorted(-col, -np.float32(threshold)))
            if above == 0:
                continue
            results[c0 + j] = list(zip(pids[:above].tolist(), col[:above].tolist()))
    return results



def suggest_for_person(rows, gallery: Gallery, person_id: int,
                       threshold: float | None = None,
                       margin: float | None = None,
                       unknowns: np.ndarray | None = None,
                       times: np.ndarray | None = None,
                       neg_map: dict[int, set[int]] | None = None) -> list[tuple]:
    """Faces from ``rows`` whose best match across all persons is ``person_id``,
    each paired with its score and any ambiguous alternatives.

    A face can only be a suggestion for this person if its score against the
    person's *own* examples clears the threshold, so we compute that cheap
    single-person gate first and run the full all-persons ranking only on the few
    candidates that pass — the win that makes the accept→refetch loop fast. An
    *alternative* is another person whose own best example scores within
    ``margin`` of ``person_id``'s: a near-tie that often means the face is really
    that look-alike family member. Returns ``(row, score, alternatives)`` tuples
    (unordered), where ``alternatives`` is a possibly-empty ``(person_id, score)``
    list, best-first. ``threshold``/``margin`` default to the live
    ``config.FACE_MATCH_THRESHOLD``/``config.FACE_AMBIGUITY_MARGIN`` settings.

    Pass ``unknowns``/``times`` (the decoded embedding matrix and photo times for
    ``rows``, e.g. from ``get_unlabeled_matrix``) to skip decoding here and in the
    ranking step entirely. ``neg_map`` (face_id -> excluded person_ids) drops
    faces the user rejected for ``person_id`` at the gate, before the rank pass
    even sees them; defaults to the live ``get_negatives_map()``.
    """
    threshold = _cfg(threshold, "FACE_MATCH_THRESHOLD")
    margin = _cfg(margin, "FACE_AMBIGUITY_MARGIN")
    if neg_map is None:
        neg_map = get_negatives_map()
    # O(1) dict lookup — _uniq_pids is no longer globally sorted (birth-dated
    # persons come first) so searchsorted would give wrong results.
    pid_pos = gallery._pid_to_group.get(person_id, -1)
    if pid_pos == -1:
        return []
    if len(rows) == 0:
        return []

    if unknowns is None or times is None:
        unknowns, times = _stack_rows(rows)

    # Contiguous float32 slice — no fancy-index copy, no float64 upcast.
    gs      = gallery._group_starts
    p_start = int(gs[pid_pos])
    p_end   = int(gs[pid_pos + 1]) if pid_pos + 1 < len(gs) else len(gallery._s_embs)
    p_embs  = gallery._s_embs[p_start:p_end]    # (K, 512) contiguous slice
    p_ft_yr = gallery._s_ft_yr[p_start:p_end]   # (K,) f32
    p_bt_yr = gallery._s_bt_yr[p_start:p_end]   # (K,) f32

    # Cap examples used in the gate pass so a heavily-labeled person (e.g. 3000+
    # faces) doesn't make the gate as expensive as the full-gallery rank pass.
    # Any genuine match hits at least one of config.FACE_GATE_MAX_EXAMPLES
    # evenly-spread examples; false negatives here are recovered by the rank
    # pass later.
    K = p_embs.shape[0]
    if K > config.FACE_GATE_MAX_EXAMPLES:
        idx     = np.linspace(0, K - 1, config.FACE_GATE_MAX_EXAMPLES, dtype=np.intp)
        p_embs  = np.ascontiguousarray(p_embs[idx])
        p_ft_yr = p_ft_yr[idx]
        p_bt_yr = p_bt_yr[idx]

    has_birth = ~np.isnan(p_bt_yr)
    has_ft    = ~np.isnan(p_ft_yr)
    can_pen   = has_birth & has_ft
    age_f     = p_ft_yr - p_bt_yr               # (K,) example age-at-photo
    times_yr  = (times / YEAR_SECONDS).astype(np.float32)   # (N,)

    _tg0 = _time.perf_counter()
    best = np.full(len(rows), np.float32(-np.inf))
    for c0 in range(0, len(rows), CHUNK):
        c1       = min(c0 + CHUNK, len(rows))
        t_chunk  = times_yr[c0:c1]
        scores   = p_embs @ unknowns[c0:c1].T   # (K, chunk) f32
        dated_c  = ~np.isnan(times[c0:c1])
        if dated_c.any():
            age_u = t_chunk[None, :] - p_bt_yr[:, None]   # (K, chunk) f32
            excl  = (has_birth[:, None] & dated_c[None, :]) & (age_u < np.float32(-config.FACE_BIRTH_TOLERANCE_YEARS))
            age_u -= age_f[:, None]
            np.abs(age_u, out=age_u)
            np.minimum(age_u, np.float32(config.FACE_AGE_PENALTY_CAP_YEARS), out=age_u)
            age_u *= np.float32(config.FACE_AGE_PENALTY_PER_YEAR)
            np.subtract(scores, age_u, where=can_pen[:, None] & dated_c[None, :], out=scores)
            scores[excl] = np.float32(-np.inf)
        best[c0:c1] = scores.max(axis=0)
    _tg1 = _time.perf_counter()

    if neg_map:
        # Faces the user already marked "not person_id" can never be a
        # suggestion for them — drop at the gate, the cheapest possible place.
        for j, r in enumerate(rows):
            if person_id in neg_map.get(r["id"], ()):
                best[j] = np.float32(-np.inf)

    cand = np.nonzero(best >= threshold)[0]
    if len(cand) == 0:
        _log.debug("suggest_for_person pid=%d unlabeled=%d gate_embs=%d(/%d) "
                   "gate=%.3fs candidates=0", person_id, len(rows),
                   p_embs.shape[0], p_end - p_start, _tg1 - _tg0)
        return []
    cand_rows = [rows[i] for i in cand]
    # Rank from the embeddings we already decoded instead of re-reading cand_rows.
    ranked = _rank_from_matrix(cand_rows, unknowns[cand], times[cand], gallery, threshold, neg_map)
    _tr1 = _time.perf_counter()
    _log.debug("suggest_for_person pid=%d unlabeled=%d gate_embs=%d(/%d) gallery=%d "
               "gate=%.3fs candidates=%d rank=%.3fs",
               person_id, len(rows), p_embs.shape[0], p_end - p_start, len(gallery),
               _tg1 - _tg0, len(cand), _tr1 - _tg1)

    out = []
    for row, persons in zip(cand_rows, ranked):
        if not persons or persons[0][0] != person_id:
            continue
        top = persons[0][1]
        alternatives = [(pid, s) for pid, s in persons[1:] if s >= top - margin]
        out.append((row, top, alternatives))
    return out


# ── Unsupervised clustering (discover new people without a seed) ──

def cluster_unlabeled(unknowns: np.ndarray,
                      threshold: float | None = None,
                      min_size: int | None = None) -> list[list[int]]:
    """Group row indices of ``unknowns`` ((N, 512), L2-normalized) into clusters of
    likely same-person faces.

    Builds a cosine-similarity graph (edge when sim >= ``threshold``) in chunks and
    takes its connected components via union-find. Returns clusters (lists of row
    indices) with at least ``min_size`` members, largest first; sparser faces drop
    out as noise. Pure numpy/Python, so it's safe to run off the event loop.
    Defaults to the live ``config.FACE_CLUSTER_THRESHOLD``/
    ``config.FACE_CLUSTER_MIN_SIZE`` settings.

    Connected components can over-merge by chaining (A~B~C), so ``threshold`` is
    kept fairly tight; a graph-relabel method (e.g. Chinese Whispers) would resist
    that better if it becomes a problem.
    """
    threshold = _cfg(threshold, "FACE_CLUSTER_THRESHOLD")
    min_size = _cfg(min_size, "FACE_CLUSTER_MIN_SIZE")
    n = unknowns.shape[0]
    if n == 0:
        return []

    parent = list(range(n))

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:        # path compression
            parent[x], x = root, parent[x]
        return root

    for c0 in range(0, n, CHUNK):
        c1 = min(c0 + CHUNK, n)
        sims = unknowns[c0:c1] @ unknowns.T          # (chunk, N) cosine
        ii, jj = np.nonzero(sims >= threshold)
        gi = ii + c0
        upper = jj > gi                               # one edge per pair, skip self
        for a, b in zip(gi[upper].tolist(), jj[upper].tolist()):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    clusters = [idxs for idxs in groups.values() if len(idxs) >= min_size]
    clusters.sort(key=len, reverse=True)
    return clusters


# ── Representative-face picking ──
# A person tagged 1000s of times (close family) accumulates many near-duplicate
# labels of the same handful of looks. Rather than every label feeding the
# gallery matmul forever, cluster one person's labels and keep only the medoid
# (most-central member) of each look-alike cluster as its "representative".
# Flag-only for now (see index.faces schema note) — nothing is deleted; this
# just marks which examples a later storage-reclamation pass could keep.

def compute_representatives_for_person(
    person_id: int, threshold: float | None = None, max_fraction: float | None = None,
) -> tuple[list[int], int]:
    """Cluster person_id's labeled faces by look and pick one representative
    (the medoid — highest total similarity to the rest of its cluster) per
    cluster. Clusters are capped at ``max_fraction`` of the person's total
    labeled face count, largest (most-repeated) clusters kept first, so an
    unusually diverse prolific person doesn't blow past the target ratio.

    Returns (representative_face_ids, total_labeled_faces). Safe to call for
    anyone — an empty or tiny label set just returns everything as its own
    representative.
    """
    threshold = _cfg(threshold, "FACE_DEDUP_THRESHOLD")
    max_fraction = _cfg(max_fraction, "FACE_DEDUP_MAX_FRACTION")
    rows = index.get_labeled_faces_for_person(person_id)
    n = len(rows)
    if n == 0:
        return [], 0

    embs = _embeddings_matrix(rows)
    clusters = cluster_unlabeled(embs, threshold=threshold, min_size=1)
    cap = max(1, int(n * max_fraction))
    reps = []
    for idxs in clusters[:cap]:
        sub = embs[idxs]
        centrality = (sub @ sub.T).sum(axis=1)   # each member's total similarity to its cluster
        medoid = idxs[int(np.argmax(centrality))]
        reps.append(rows[medoid]["id"])
    return reps, n


def get_representative_groups(person_id: int, group_limit: int = 49) -> list[dict]:
    """Representative-led review groups for one person, from the *stored*
    representative flags (whatever the last recompute decided — this does not
    re-cluster). Every non-representative labeled face is assigned to its
    nearest representative by cosine similarity; each group's ``other_face_ids``
    are capped at ``group_limit``, closest match first, but ``size`` counts the
    whole group (see cluster_unlabeled's ``cl.size`` vs sample-length convention).

    Empty if this person has no representative faces yet (recompute hasn't run
    for them, or they're below config.FACE_DEDUP_MIN_FACES).
    """
    rows = index.get_labeled_faces_for_person(person_id)
    reps = [r for r in rows if r["representative"]]
    if not reps:
        return []
    others = [r for r in rows if not r["representative"]]

    rep_ids = [r["id"] for r in reps]
    groups = {rid: {"representative_face_id": rid, "other_face_ids": [], "size": 1}
              for rid in rep_ids}

    if others:
        rep_embs = _embeddings_matrix(reps)
        other_embs = _embeddings_matrix(others)
        sims = other_embs @ rep_embs.T                     # (O, R) cosine
        best_rep = np.argmax(sims, axis=1)
        best_sim = sims[np.arange(len(others)), best_rep]
        for i in np.argsort(-best_sim):                    # closest matches first, overall
            g = groups[rep_ids[best_rep[i]]]
            g["size"] += 1
            if len(g["other_face_ids"]) < group_limit:
                g["other_face_ids"].append(others[i]["id"])

    result = list(groups.values())
    result.sort(key=lambda g: g["size"], reverse=True)
    return result
