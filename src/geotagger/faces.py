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

# Extra age-tolerance (years) for a photo whose date is a manually-assigned
# approximate one (see photos_service.assign_approximate_dates), on top of
# config.FACE_BIRTH_TOLERANCE_YEARS — half the width of the period the true
# date could fall anywhere within, since photo_datetime is pinned to its start.
PRECISION_TOLERANCE_YEARS = {"year": 0.5, "month": 1 / 24}


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
        from geotagger import onnx_setup
        onnx_setup.prepare(FACE_PROVIDERS)
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
        det = app.models.get("detection")
        _log.info(f"Face models on {onnx_setup.active_providers(det.session) if det else '?'}")
        _app = app
    return _app


def model_status() -> dict:
    """Whether the InsightFace model pack has been downloaded, for the Data
    Management page. Doesn't load the model — just checks the on-disk files
    FaceAnalysis's downloader would have written."""
    if _model_dir is None:
        return {"available": False, "model_dir": None, "name": FACE_MODEL_NAME}
    model_path = _model_dir / "models" / FACE_MODEL_NAME
    present = model_path.is_dir() and any(model_path.glob("*.onnx"))
    return {"available": present, "model_dir": str(_model_dir), "name": FACE_MODEL_NAME}


def load_model():
    """Load the detection pipeline now (no-op once loaded). The batch scan calls this
    before its loop so a missing/corrupt model or a broken onnxruntime fails the
    whole batch up front, instead of failing once per photo (audit F1)."""
    return _get_app()


def ensure_model_downloaded():
    """Force the lazy model load, triggering InsightFace's one-time download if
    the pack isn't already on disk. Used by the Data Management page's pre-fetch
    button — the same load that would otherwise happen on first detect call."""
    _get_app()


def reset_model():
    """Drop the loaded FaceAnalysis pipeline so the next detect call (or
    ensure_model_downloaded()) re-triggers _get_app()'s lazy load. Needed before
    a forced model re-download — otherwise a pipeline already loaded in this
    process would short-circuit past the on-disk check ensure_model_downloaded()
    is supposed to redo."""
    global _app
    with _app_lock:
        _app = None


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
    from geotagger import scan_failures

    # Only the read/decode of this one file can raise FileUnreadable (see
    # scan_failures). The model load and inference below raise as-is, so the batch
    # loop aborts on them instead of writing the photo off.
    try:
        preview, is_full = thumbnails.get_detection_preview(path, mtime, size, orientation)
        arr = cv2.imdecode(np.frombuffer(preview, np.uint8), cv2.IMREAD_COLOR)  # BGR
    except Exception as e:
        scan_failures.raise_classified(e, path)
    if arr is None:
        raise scan_failures.FileUnreadable(f"Could not decode preview for {path}")
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


def _iou(a, b) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    return inter / (area_a + area_b - inter)


# A hand-drawn box only has to overlap the model's own box this much to be treated
# as "the same face" — loose on purpose, since people draw generously around a head
# while SCRFD boxes the face tightly.
_MANUAL_MATCH_IOU = 0.3
# Padding added around the drawn box before the fallback re-detect, as a fraction of
# the box. SCRFD needs some context around a face; a tight crop often detects nothing.
_MANUAL_CROP_MARGIN = 0.6


def embed_bbox(path: Path, mtime: float, size: int, disp_bbox: list[float],
               orientation: int | None = None) -> tuple[bytes | None, float | None]:
    """Embed the face inside a hand-drawn box; return ``(embedding, det_score)``.

    ``disp_bbox`` is normalized 0..1 in DISPLAY space (what the user drew over the
    oriented preview), matching the detection image's own space.

    Two passes, because a manual box is usually drawn exactly where detection came
    up short:
      1. Detect over the whole (upright) image and take the box that overlaps the
         drawn one — cheap when the face WAS found and just mis-assigned or
         mis-labeled, and it reuses the model's proper landmark alignment.
      2. Otherwise crop the drawn region with margin, upscale it, and detect again.
         Blowing up a small/soft face is often enough to get SCRFD over its
         threshold on the second look.

    Returns ``(None, None)`` when neither pass finds a face — the caller still
    stores the box, just without recognition data (see index.add_manual_face)."""
    import cv2

    preview, _ = thumbnails.get_detection_preview(path, mtime, size, orientation)
    arr = cv2.imdecode(np.frombuffer(preview, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise RuntimeError(f"Could not decode preview for {path}")
    h, w = arr.shape[:2]

    app = _get_app()
    with _app_lock:
        found = app.get(arr)

    best, best_iou = None, 0.0
    for f in found:
        x1, y1, x2, y2 = f.bbox
        norm = [x1 / w, y1 / h, x2 / w, y2 / h]
        score = _iou(norm, disp_bbox)
        if score > best_iou:
            best, best_iou = f, score
    if best is not None and best_iou >= _MANUAL_MATCH_IOU:
        return encode_embedding(best.normed_embedding), float(best.det_score)

    # Pass 2: re-detect inside the drawn region alone, padded and upscaled.
    bw, bh = disp_bbox[2] - disp_bbox[0], disp_bbox[3] - disp_bbox[1]
    px, py = bw * _MANUAL_CROP_MARGIN, bh * _MANUAL_CROP_MARGIN
    cx1 = max(0, int((disp_bbox[0] - px) * w))
    cy1 = max(0, int((disp_bbox[1] - py) * h))
    cx2 = min(w, int((disp_bbox[2] + px) * w))
    cy2 = min(h, int((disp_bbox[3] + py) * h))
    if cx2 - cx1 < 8 or cy2 - cy1 < 8:
        return None, None
    crop = arr[cy1:cy2, cx1:cx2]
    ch, cw = crop.shape[:2]
    # SCRFD's smallest reliable face is ~40px; scale the crop so the drawn box
    # comfortably clears that, but don't blow tiny selections up without limit.
    scale = min(4.0, max(1.0, config.FACE_MANUAL_CROP_DIM / max(ch, cw)))
    if scale > 1.0:
        crop = cv2.resize(crop, (int(cw * scale), int(ch * scale)),
                          interpolation=cv2.INTER_CUBIC)
    with _app_lock:
        found = app.get(crop)
    if not found:
        return None, None
    # Largest face in the crop — the one the user was pointing at.
    f = max(found, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    return encode_embedding(f.normed_embedding), float(f.det_score)


def detect_and_store(photo_row) -> int:
    """Detect faces for one indexed photo and persist them. Returns face count."""
    faces, det_dimension = detect_faces(
        Path(index.photo_path(photo_row)), photo_row["mtime"], photo_row["size"],
        photo_row["orientation"])
    index.replace_faces(photo_row["id"], faces, det_dimension)
    return len(faces)


# ── Recognition (nearest-neighbour over labeled faces) ──

def _birth_ts(birth_date: str | None) -> float:
    """ISO YYYY-MM-DD → epoch seconds (UTC, matching photo_datetime), or NaN.
    Also used for the not_before/not_after person date bounds — same format."""
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
    plus each example's photo time and its person's birth/not-before/not-after
    times for age math and date-window exclusion."""

    def __init__(self, embeddings: np.ndarray, person_ids: np.ndarray,
                 face_times: np.ndarray, birth_times: np.ndarray,
                 not_before_times: np.ndarray, not_after_times: np.ndarray,
                 face_uncs: np.ndarray | None = None):
        # face_uncs: per-example date uncertainty in years (see
        # _precision_years) — an approximate-dated example's age-at-photo is as
        # fuzzy as an approximate-dated unknown's. None = every example exact.
        self._n = len(person_ids)
        if face_uncs is None:
            face_uncs = np.zeros(self._n, np.float32)

        # Pre-sorted by person_id for vectorized reduceat reduction in the hot path.
        # Built once at gallery-build time; the sort is O(N log N) but amortised
        # across every suggestion call until the gallery generation changes.
        # The originals (embeddings, person_ids, face_times, birth_times,
        # not_before_times, not_after_times) are NOT stored — the sorted copies
        # below replace them everywhere, saving ~44 MB of duplicate embedding
        # storage per gallery.
        if self._n > 0:
            # Sort so that all faces of date-bounded persons (birth date and/or
            # not_before and/or not_after) form a contiguous prefix [0 .. _K_bound).
            # Since these are per-person (uniform across each person's faces), this
            # keeps each person's group intact. Within each half the secondary sort
            # is person_id ascending, so groups are still contiguous for reduceat.
            # Contiguous prefix → date-adjustment ops use scores[:_K_bound] (a
            # view, no copy) instead of fancy indexing.
            has_birth_f = ~np.isnan(birth_times)
            has_nb_f    = ~np.isnan(not_before_times)
            has_na_f    = ~np.isnan(not_after_times)
            has_bound_f = has_birth_f | has_nb_f | has_na_f
            not_bound_k = (~has_bound_f).astype(np.int8)        # 0=date-bounded, 1=not
            order = np.lexsort((person_ids, not_bound_k))

            self._s_embs  = np.ascontiguousarray(embeddings[order], dtype=np.float32)
            self._s_ft_yr = (face_times[order]  / YEAR_SECONDS).astype(np.float32)
            self._s_bt_yr = (birth_times[order] / YEAR_SECONDS).astype(np.float32)
            self._s_nb_yr = (not_before_times[order] / YEAR_SECONDS).astype(np.float32)
            self._s_na_yr = (not_after_times[order]  / YEAR_SECONDS).astype(np.float32)
            self._s_fu_yr = np.asarray(face_uncs, dtype=np.float32)[order]
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

            # Rows [0 .. _K_bound) are the date-bounded prefix (see
            # _gallery_prefix / _apply_date_rules).
            self._K_bound     = int(has_bound_f.sum())
        else:
            dim = embeddings.shape[1] if embeddings.ndim == 2 and len(embeddings) else EMBED_DIM
            self._s_embs       = np.empty((0, dim), np.float32)
            self._s_ft_yr      = np.empty(0, np.float32)
            self._s_bt_yr      = np.empty(0, np.float32)
            self._s_nb_yr      = np.empty(0, np.float32)
            self._s_na_yr      = np.empty(0, np.float32)
            self._s_fu_yr      = np.empty(0, np.float32)
            self._group_starts = np.empty(0, np.intp)
            self._uniq_pids    = np.empty(0, np.int64)
            self._pid_to_group = {}
            self._K_bound      = 0
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
# assign/ignore/birth-date change bumps it and the next call rebuilds. A face
# scan's new detections only invalidate the unlabeled side (_unlabeled_epoch).
# Settings the caches bake in have their own epochs (see SETTING_INVALIDATORS).
#
# ((gen, _gallery_epoch), gallery). The epoch is bumped by
# invalidate_gallery_cache when FACE_MIN_GALLERY_BBOX_AREA changes: the cached
# gallery has already dropped the small-bbox faces, so a new floor needs a
# rebuild — but the faces table didn't change, so bumping the generation (which
# also throws away the exhaustive unlabeled read and the negatives map) would
# be paying for far more than the setting touched.
_gallery_cache: tuple[tuple[int, int], "Gallery"] | None = None
_gallery_epoch = 0
# (gen, epoch, scan_cap, rows, unknowns, times). `gen` is faces_generation();
# `epoch` is _unlabeled_epoch, bumped by invalidate_unlabeled_cache for changes
# that add unlabeled faces but must not rebuild the labeled gallery (a face scan
# inserting detections — bumping the generation per scanned photo would rebuild
# the gallery on every refetch for the whole scan).
_unlabeled_cache: tuple[int, int, int, list, np.ndarray, np.ndarray] | None = None
_unlabeled_epoch = 0
# Parallel to _unlabeled_cache rows: cached suggest_persons_batch output, as
# ((gen, epoch, scan_cap) of the rows it was computed for + _scores_epoch,
# scores). Pruned in drop_from_unlabeled_cache so the full matmul only runs when
# the rows actually rebuild, not on every accept in the suggested-only review
# loop. The scores are *thresholded and age-adjusted* (a None below
# FACE_MATCH_THRESHOLD, penalties already subtracted), so _scores_epoch is
# bumped by invalidate_suggestion_scores when one of those knobs changes — the
# rows and gallery underneath are still valid and stay cached.
_suggested_scores_cache: tuple[tuple[int, int, int, int], list] | None = None
_scores_epoch = 0
# Serializes read-modify-write of the caches above and their epochs (the
# in-place prune in drop_from_unlabeled_cache, an invalidation, a rebuild's
# store) between request threads, a face scan's writes and a settings change. Never held across the DB read or the matmul:
# readers snapshot the key *before* reading, so a rebuild that raced a write is
# stored under the older key and simply misses next time.
_unlabeled_lock = threading.Lock()
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
    # Key snapshotted before reading the DB *and* the bbox floor, so a build
    # that raced a write or a settings change is filed under the older key.
    key = (index.faces_generation(), _gallery_epoch)
    cached = _gallery_cache
    if cached is not None and cached[0] == key:
        return cached[1]

    labeled = index.get_labeled_faces()
    min_area = config.FACE_MIN_GALLERY_BBOX_AREA
    if min_area > 0:
        labeled = [r for r in labeled if _bbox_area(r["bbox"]) >= min_area]
    if not labeled:
        z = np.zeros((0,), np.float64)
        gallery = Gallery(np.zeros((0, EMBED_DIM), np.float32), np.zeros((0,), np.int64),
                          z, z, z, z)
    else:
        embs = _embeddings_matrix(labeled)
        pids = np.array([r["person_id"] for r in labeled], dtype=np.int64)
        ftimes = np.array([float(r["photo_datetime"]) if r["photo_datetime"] else np.nan
                           for r in labeled], dtype=np.float64)
        births = np.array([_birth_ts(r["birth_date"]) for r in labeled], dtype=np.float64)
        not_befores = np.array([_birth_ts(r["not_before"]) for r in labeled], dtype=np.float64)
        not_afters = np.array([_birth_ts(r["not_after"]) for r in labeled], dtype=np.float64)
        gallery = Gallery(embs, pids, ftimes, births, not_befores, not_afters,
                          face_uncs=_precision_years(labeled))
    with _unlabeled_lock:
        _gallery_cache = (key, gallery)
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
    not on every accept; additions (new detections) invalidate it.
    """
    entry = _unlabeled_entry(_cfg(scan_cap, "FACE_SUGGEST_SCAN_CAP"))
    return entry[3], entry[4], entry[5]


def _unlabeled_entry(scan_cap: int) -> tuple[int, int, int, list, np.ndarray, np.ndarray]:
    """The whole cache tuple, so get_suggested_scores can key its scores on the
    exact rows they were computed for."""
    global _unlabeled_cache
    # Key snapshotted BEFORE the read: a write that lands mid-read bumps one of
    # them, so this entry is stored under the older key and rebuilt next call.
    gen, epoch = index.faces_generation(), _unlabeled_epoch
    cached = _unlabeled_cache   # one read of the global; tuple swaps are atomic
    if cached is not None and cached[:3] == (gen, epoch, scan_cap):
        return cached
    limit = scan_cap if scan_cap and scan_cap > 0 else -1   # -1 → unbounded
    floor = config.FACE_SUGGEST_MIN_DET_SCORE if config.FACE_SUGGEST_MIN_DET_SCORE > 0 else None
    rows = index.list_faces("unlabeled", None, limit, min_det_score=floor)
    unknowns, times = _stack_rows(rows)
    # The joined matrix is now the only copy of the embeddings: drop each row's
    # blob (a Row is immutable, so rebuild as a dict with the same r["col"] /
    # .keys() surface) or ~2 KB/face of blobs stay pinned beside the matrix.
    rows = [{k: r[k] for k in r.keys() if k != "embedding"} for r in rows]
    entry = (gen, epoch, scan_cap, rows, unknowns, times)
    with _unlabeled_lock:
        _unlabeled_cache = entry
    return entry


def invalidate_unlabeled_cache():
    """Force the next unlabeled read to rebuild, WITHOUT bumping the faces
    generation (so the labeled gallery and negatives caches survive).

    For writes that add unlabeled faces or replace them under new ids — a face
    scan's replace_faces. Bumping the epoch (not just clearing the cache) is what
    makes it race-safe: a rebuild already in flight on a request thread read the
    DB before this write and will store itself under the old epoch, so it can't
    pass as current."""
    global _unlabeled_cache, _suggested_scores_cache, _unlabeled_epoch
    with _unlabeled_lock:
        _unlabeled_epoch += 1
        _unlabeled_cache = None
        _suggested_scores_cache = None


def invalidate_suggestion_scores():
    """Force the next get_suggested_scores to redo the matmul, keeping the
    unlabeled rows and the gallery. For settings that only change how scores
    are adjusted or thresholded. Epoch-bumped for the same race reason as
    invalidate_unlabeled_cache: a matmul already running under the old knobs
    files its result under the old epoch."""
    global _suggested_scores_cache, _scores_epoch
    with _unlabeled_lock:
        _scores_epoch += 1
        _suggested_scores_cache = None


def invalidate_gallery_cache():
    """Force the next build_gallery to re-read the labeled faces, WITHOUT
    bumping the faces generation. The cached scores were computed against the
    old gallery, so they go too."""
    global _gallery_cache, _gallery_epoch
    with _unlabeled_lock:
        _gallery_epoch += 1
        _gallery_cache = None
    invalidate_suggestion_scores()


# ── Settings → cache dependencies ──
# Which cache bakes in which runtime-tunable setting (config.SETTINGS_SPEC), so a
# settings change drops exactly what it made wrong — see
# settings_service.invalidate_for, the one place that dispatches these. Face
# settings NOT listed are read fresh on every call (suggest_for_person's
# ambiguity knob, clustering and crowd params, the People page's frontend
# knobs) or key their cache already (FACE_SUGGEST_SCAN_CAP is part of the
# unlabeled key); settings_service.CACHE_FREE_SETTINGS lists them with reasons.
SETTING_INVALIDATORS = {
    # build_gallery drops small-bbox labeled faces before caching.
    "FACE_MIN_GALLERY_BBOX_AREA": invalidate_gallery_cache,
    # _unlabeled_entry drops low-det-score faces before caching (and the scores
    # computed over those rows go with them).
    "FACE_SUGGEST_MIN_DET_SCORE": invalidate_unlabeled_cache,
    # Baked into the cached suggest_persons_batch output: the threshold decides
    # which rows got a None, and the birth/age knobs were already applied to the
    # scores. The gallery stores raw dates, not adjusted scores, so it stays.
    "FACE_MATCH_THRESHOLD": invalidate_suggestion_scores,
    "FACE_BIRTH_TOLERANCE_YEARS": invalidate_suggestion_scores,
    "FACE_AGE_PENALTY_PER_YEAR": invalidate_suggestion_scores,
    "FACE_AGE_PENALTY_CAP_YEARS": invalidate_suggestion_scores,
}


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
    # Scores epoch snapshotted before the rows, the gallery and the knobs are
    # read, so a settings change landing mid-matmul leaves this under the old key.
    scores_epoch = _scores_epoch
    entry = _unlabeled_entry(_cfg(scan_cap, "FACE_SUGGEST_SCAN_CAP"))
    key, rows, unknowns, times = entry[:3] + (scores_epoch,), entry[3], entry[4], entry[5]
    cached = _suggested_scores_cache
    if cached is not None and cached[0] == key:
        return rows, cached[1]
    gallery = build_gallery()
    scores = (suggest_persons_batch(rows, gallery, unknowns=unknowns, times=times)
              if len(gallery) > 0 else [None] * len(rows))
    with _unlabeled_lock:
        _suggested_scores_cache = (key, scores)
    return rows, scores


def window_rows(rows, unknowns: np.ndarray, times: np.ndarray,
                start_ts: int | None, end_ts: int | None,
                photo_ids: set[int] | list[int] | None = None
                ) -> tuple[list, np.ndarray, np.ndarray]:
    """Filter a decoded unlabeled matrix (rows/embeddings/times) to a window.

    The People page's Focus windows the *candidate* faces (not the gallery),
    reusing the cached full-library matrix from ``get_unlabeled_matrix`` so the
    cache stays warm. ``start_ts``/``end_ts`` window by time (undated faces, NaN
    time, fall out of any time window); ``photo_ids`` restricts to an explicit
    photo set — the Search page's untagged-face candidate scan passes the photos
    a person could appear in. Returns the filtered ``(rows, unknowns, times)``;
    an all-None window returns them unchanged.
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


def drop_from_unlabeled_cache(face_ids, gen: int | None = None):
    """Prune just-labeled/ignored/deleted faces from the cached unlabeled matrix
    instead of forcing a full re-read, and (with ``gen``) re-tag the cache to
    that generation so it survives the accept loop.

    Only valid for *removals* from the unlabeled set (assign-to-person, ignore,
    delete). Additions (unassign, restore) bump the generation without calling
    this; new detections call invalidate_unlabeled_cache.

    ``gen`` is the value the caller's own ``index.bump_faces_generation()``
    returned. Re-tagging claims "this cache now reflects every change up to
    gen", which only holds if the cache was current just before that bump
    (built at ``gen - 1``) and nothing has bumped since (``gen`` is still
    current). Otherwise some other change — an unassign, a restore, a second
    writer — went unseen, and re-tagging would hide it until restart; the cache
    is left stale and the next read rebuilds. ``gen=None`` (a removal with no
    bump) prunes but keeps the existing tag: dropping rows that no longer exist
    is correct for any cache, stale or not.
    """
    global _unlabeled_cache, _suggested_scores_cache
    with _unlabeled_lock:
        cached = _unlabeled_cache
        if cached is None:
            return
        old_gen, epoch, scan_cap, rows, unknowns, times = cached
        if gen is None:
            new_gen = old_gen
        elif old_gen == gen and gen == index.faces_generation():
            return  # rebuilt after the caller's commit+bump: already excludes them
        elif old_gen == gen - 1 and gen == index.faces_generation():
            new_gen = gen
        else:
            return  # stale: leave the old tag so the next read rebuilds
        old_key = (old_gen, epoch, scan_cap)
        drop = set(face_ids)
        keep = [i for i, r in enumerate(rows) if r["id"] not in drop]
        scores_cached = _suggested_scores_cache
        if len(keep) != len(rows):
            idx = np.array(keep, dtype=np.int64)
            rows = [rows[i] for i in keep]
            unknowns, times = unknowns[idx], times[idx]
        # Carry the scores cache along (pruned in parallel) so the next
        # suggested-only call doesn't redo the full matmul just because some
        # faces were labeled. Only if it was computed for exactly these rows —
        # otherwise its indices don't line up with them. Its scores epoch is
        # carried unchanged: pruning doesn't make stale-knob scores current.
        if scores_cached is not None and scores_cached[0][:3] == old_key:
            scores = scores_cached[1]
            if len(keep) != len(scores):
                scores = [scores[i] for i in keep]
            _suggested_scores_cache = ((new_gen, epoch, scan_cap, scores_cached[0][3]), scores)
        else:
            _suggested_scores_cache = None
        _unlabeled_cache = (new_gen, epoch, scan_cap, rows, unknowns, times)


# ── Date/age adjustment (shared by every scoring path) ──
# The single-face lookup, the batch scorer and the per-person gate all apply
# exactly this rule via _apply_date_rules, so they can't disagree about a face
# (audit F6: the batch and gate paths once ignored date_precision, so a
# year-precision photo could be suggested by one and not the other).

def _precision_years(rows) -> np.ndarray:
    """(n,) float32 date uncertainty in years per row, from its date_precision
    column via PRECISION_TOLERANCE_YEARS; 0 for exact dates. Rows lacking the
    column (hand-built test dicts, older callers) count as exact."""
    get = PRECISION_TOLERANCE_YEARS.get
    out = np.zeros(len(rows), np.float32)
    for i, r in enumerate(rows):
        try:
            p = r["date_precision"]
        except (KeyError, IndexError):   # dict / sqlite3.Row without the column
            continue
        if p:
            out[i] = get(p, 0.0)
    return out


def _gallery_prefix(gallery: Gallery) -> tuple[np.ndarray, ...]:
    """(birth, face time, face uncertainty, not_before, not_after) year arrays
    for the date-bounded prefix [0 .. _K_bound) — views, no copies. Rows past the
    prefix have no birth/window, so no rule can touch them."""
    k = gallery._K_bound
    return (gallery._s_bt_yr[:k], gallery._s_ft_yr[:k], gallery._s_fu_yr[:k],
            gallery._s_nb_yr[:k], gallery._s_na_yr[:k])


def _apply_date_rules(scores: np.ndarray, examples: tuple[np.ndarray, ...],
                      t_yr: np.ndarray, unc_u: np.ndarray) -> None:
    """In place: age-adjust a (K, u) example×unknown cosine block.

    ``examples`` is (birth, face time, face uncertainty, not_before, not_after),
    each (K,) float32 years, NaN where unknown; ``t_yr``/``unc_u`` are the
    unknowns' (u,) photo times (NaN = undated, untouched) and date uncertainty
    in years. The rules:

    * the photo predating birth, or falling outside not_before/not_after, by
      more than FACE_BIRTH_TOLERANCE_YEARS + the unknown's uncertainty → -inf;
    * otherwise, where birth and the example's date are known, subtract
      FACE_AGE_PENALTY_PER_YEAR × min(gap, FACE_AGE_PENALTY_CAP_YEARS), gap being
      the age difference less both dates' uncertainty (floored at 0) — an
      approximate date could truly be anywhere in its period.

    Only ever lowers a score for non-negative penalty knobs (the gap is floored
    at 0 and exclusion is -inf), which suggest_for_person's raw-cosine stage-1
    cut relies on.
    """
    bt, ft, fu, nb, na = examples
    dated = ~np.isnan(t_yr)
    if not dated.any():
        return
    tol = np.float32(config.FACE_BIRTH_TOLERANCE_YEARS) + unc_u        # (u,)
    excl = np.zeros(scores.shape, dtype=bool)
    has_birth = ~np.isnan(bt)
    if has_birth.any():
        age_u = t_yr[None, :] - bt[:, None]                             # (K, u)
        excl |= has_birth[:, None] & dated[None, :] & (age_u < -tol[None, :])
        # Reuse age_u as the penalty array (saves K × u × 4 bytes).
        age_u -= (ft - bt)[:, None]                                     # minus example's age
        np.abs(age_u, out=age_u)
        age_u -= unc_u[None, :]
        age_u -= fu[:, None]
        np.maximum(age_u, np.float32(0.0), out=age_u)
        np.minimum(age_u, np.float32(config.FACE_AGE_PENALTY_CAP_YEARS), out=age_u)
        age_u *= np.float32(config.FACE_AGE_PENALTY_PER_YEAR)
        can_pen = (has_birth & ~np.isnan(ft))[:, None] & dated[None, :]
        np.subtract(scores, age_u, where=can_pen, out=scores)
    has_nb = ~np.isnan(nb)
    if has_nb.any():
        excl |= has_nb[:, None] & dated[None, :] & (t_yr[None, :] < nb[:, None] - tol[None, :])
    has_na = ~np.isnan(na)
    if has_na.any():
        excl |= has_na[:, None] & dated[None, :] & (t_yr[None, :] > na[:, None] + tol[None, :])
    scores[excl] = np.float32(-np.inf)


def match_embedding(vec: np.ndarray, photo_datetime, gallery: Gallery,
                    exclude: set[int] | None = None,
                    date_precision: str | None = None) -> list[tuple[int, float]]:
    """Rank persons for an embedding by best (age-adjusted) cosine similarity.

    Embeddings are L2-normalized, so the dot product is the cosine. When the
    unknown face is dated and a candidate has a birth date, two age rules apply:
    a photo predating the person's birth excludes them outright, and examples
    taken at a very different age than the unknown are penalized — so a baby
    photo is matched against baby examples, not 5-year-old ones. A candidate
    with a not_before/not_after window is likewise excluded outright if the
    unknown's photo date falls outside that window (independent of birth date —
    e.g. a person known to only appear in photos from a certain year onward).
    Each person is scored by their single best example after adjustment.
    ``exclude`` is a set of person_ids to drop from the ranking entirely (this
    single face's negatives — the caller looks them up by face_id, since this
    function only sees the embedding). ``date_precision`` ('year'/'month', from
    the photo's date_precision column) widens the birth/window exclusion
    tolerance and softens the age-gap penalty by PRECISION_TOLERANCE_YEARS, since
    an approximate date's true day could fall anywhere in that period (an
    approximate-dated *example* softens the gap the same way). The rule itself
    lives in _apply_date_rules, shared with the batch and per-person paths.
    """
    if len(gallery) == 0:
        return []

    # Float32 matmul — no upcast to float64 (saves 21K × 4 bytes and a copy).
    scores = gallery._s_embs @ np.asarray(vec, dtype=np.float32)  # (N,) f32

    K_b = gallery._K_bound
    if photo_datetime and K_b > 0:
        # Same shared rule as the batch and per-person paths (one-column case).
        # Only the date-bounded prefix can be adjusted; [:K_b][:, None] is a view.
        _apply_date_rules(
            scores[:K_b][:, None], _gallery_prefix(gallery),
            np.array([float(photo_datetime) / YEAR_SECONDS], np.float32),
            np.array([PRECISION_TOLERANCE_YEARS.get(date_precision, 0.0)], np.float32))

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
                   exclude: set[int] | None = None,
                   date_precision: str | None = None) -> tuple[int, float] | None:
    """Return (person_id, score) if the top match clears the threshold, else None.
    Defaults to the live ``config.FACE_MATCH_THRESHOLD`` setting. ``exclude``
    (person_ids) and ``date_precision`` are forwarded to ``match_embedding``."""
    threshold = _cfg(threshold, "FACE_MATCH_THRESHOLD")
    ranked = match_embedding(vec, photo_datetime, gallery, exclude=exclude,
                             date_precision=date_precision)
    if ranked and ranked[0][1] >= threshold:
        return ranked[0]
    return None


_CLUSTER_CHUNK = 256  # rows per slab in cluster_unlabeled (see there)
CHUNK = 1024  # caps each (gallery × unknown-chunk) score matrix to a few tens of MB


def _stack_rows(rows) -> tuple[np.ndarray, np.ndarray]:
    """Decode a sequence of face rows into an (N, 512) embedding matrix and an
    (N,) array of photo times (epoch secs, NaN where undated)."""
    unknowns = _embeddings_matrix(rows)
    times = np.array([float(r["photo_datetime"]) if r["photo_datetime"] else np.nan
                      for r in rows], dtype=np.float64)
    return unknowns, times


def _best_per_person_f32(gallery: Gallery,
                          unknowns: np.ndarray, times: np.ndarray,
                          uncs: np.ndarray | None = None) -> np.ndarray:
    """(P, u) float32 best age-adjusted cosine per person per unknown.

    All float32 throughout and ``np.maximum.reduceat`` for the per-group max.
    The gallery is sorted so date-bounded persons (birth date and/or
    not_before/not_after) occupy a contiguous prefix [0 .. _K_bound).
    Age-adjustment ops use ``scores[:_K_bound]`` — a plain slice (a VIEW, not a
    copy), so in-place edits feed through to ``scores`` with no scatter/gather
    overhead. ``uncs`` is the unknowns' (u,) date uncertainty in years (see
    _precision_years; None = all exact).
    """
    scores = gallery._s_embs @ unknowns.T   # (N, u) float32

    K_b = gallery._K_bound
    if K_b > 0:
        if uncs is None:
            uncs = np.zeros(len(times), np.float32)
        _apply_date_rules(scores[:K_b], _gallery_prefix(gallery),
                          (times / YEAR_SECONDS).astype(np.float32),
                          np.asarray(uncs, dtype=np.float32))

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
        # Only date-bounded galleries read the uncertainty; skip the per-row
        # Python pass otherwise.
        uncs = _precision_years(rows[c0:c1]) if gallery._K_bound else None
        per_person = _best_per_person_f32(gallery, unknowns[c0:c1], times[c0:c1], uncs)
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
        # Only date-bounded galleries read the uncertainty; skip the per-row
        # Python pass otherwise.
        uncs = _precision_years(rows[c0:c1]) if gallery._K_bound else None
        per_person = _best_per_person_f32(gallery, unknowns[c0:c1], times[c0:c1], uncs)
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
    single-person gate first (exact, over all of the person's examples) and run
    the full all-persons ranking only on the few candidates that pass — the win
    that makes the accept→refetch loop fast. The result is therefore the same
    face set ``suggest_persons_batch`` attributes to ``person_id``. An
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
    p_nb_yr = gallery._s_nb_yr[p_start:p_end]   # (K,) f32
    p_na_yr = gallery._s_na_yr[p_start:p_end]   # (K,) f32

    # The gate must be exact against EVERY example: the rank pass below only
    # sees faces that pass it, so a face dropped here is lost for good (it used
    # to subsample heavily-labeled persons to 200 examples, silently dropping
    # faces whose only good match was a skipped example — audit F4). Two stages
    # keep that cheap. Age adjustment only ever lowers a score (penalty >= 0,
    # exclusion -> -inf), so the raw cosine max is an upper bound: stage 1 is a
    # plain chunked matmul over all examples that discards every face whose raw
    # best is under threshold — nearly all of them. Stage 2 applies the
    # age/window math, the expensive elementwise part (~3x the matmul), to the
    # few survivors only. Measured at 2000 examples × 20000 unlabeled, dated:
    # ~0.3s with age math on everything vs ~0.1s for this.
    K = p_embs.shape[0]
    _tg0 = _time.perf_counter()
    raw_best = np.empty(len(rows), dtype=np.float32)
    for c0 in range(0, len(rows), CHUNK):
        c1 = min(c0 + CHUNK, len(rows))
        raw_best[c0:c1] = (p_embs @ unknowns[c0:c1].T).max(axis=0)
    if neg_map:
        # Faces the user already marked "not person_id" can never be a
        # suggestion for them — drop at the gate, the cheapest possible place.
        for j, r in enumerate(rows):
            if person_id in neg_map.get(r["id"], ()):
                raw_best[j] = np.float32(-np.inf)
    if config.FACE_AGE_PENALTY_PER_YEAR >= 0 and config.FACE_AGE_PENALTY_CAP_YEARS >= 0:
        surv = np.flatnonzero(raw_best >= threshold)
    else:
        # A negative penalty (only reachable via env var — the settings UI
        # floors it at 0) is a bonus, so raw cosine stops being an upper bound.
        surv = np.flatnonzero(raw_best > -np.inf)
    s_unknowns = unknowns[surv]
    times_yr   = (times[surv] / YEAR_SECONDS).astype(np.float32)   # (S,)
    # Per-row Python pass over the survivors only — a handful, not the queue.
    s_uncs     = _precision_years([rows[i] for i in surv])
    examples   = (p_bt_yr, p_ft_yr, gallery._s_fu_yr[p_start:p_end], p_nb_yr, p_na_yr)

    # Stage 2: exact age-adjusted best over all K examples, survivors only —
    # the same _apply_date_rules the batch and single-face paths use.
    best = np.full(len(surv), np.float32(-np.inf))
    for c0 in range(0, len(surv), CHUNK):
        c1     = min(c0 + CHUNK, len(surv))
        scores = p_embs @ s_unknowns[c0:c1].T   # (K, chunk) f32
        _apply_date_rules(scores, examples, times_yr[c0:c1], s_uncs[c0:c1])
        best[c0:c1] = scores.max(axis=0)
    _tg1 = _time.perf_counter()

    cand = surv[best >= threshold]
    if len(cand) == 0:
        _log.debug("suggest_for_person pid=%d unlabeled=%d gate_embs=%d "
                   "gate=%.3fs survivors=%d candidates=0", person_id, len(rows),
                   K, _tg1 - _tg0, len(surv))
        return []
    cand_rows = [rows[i] for i in cand]
    # Rank from the embeddings we already decoded instead of re-reading cand_rows.
    ranked = _rank_from_matrix(cand_rows, unknowns[cand], times[cand], gallery, threshold, neg_map)
    _tr1 = _time.perf_counter()
    _log.debug("suggest_for_person pid=%d unlabeled=%d gate_embs=%d gallery=%d "
               "gate=%.3fs survivors=%d candidates=%d rank=%.3fs",
               person_id, len(rows), K, len(gallery),
               _tg1 - _tg0, len(surv), len(cand), _tr1 - _tg1)

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

    # Smaller chunk than CHUNK and reused out= buffers: the (chunk, N) float32
    # sims plus its bool mask were the whole peak (~100 MB at N=20k with 1024
    # rows) and were reallocated every chunk. Same pairs either way — only the
    # slab size changes — and the matmul stays big enough to be BLAS-bound.
    step = min(_CLUSTER_CHUNK, n)
    sims_buf = np.empty((step, n), dtype=unknowns.dtype)   # keep caller dtype: identical scores
    mask_buf = np.empty((step, n), dtype=bool)
    for c0 in range(0, n, step):
        c1 = min(c0 + step, n)
        sims = sims_buf[:c1 - c0]
        mask = mask_buf[:c1 - c0]
        np.matmul(unknowns[c0:c1], unknowns.T, out=sims)   # (chunk, N) cosine
        np.greater_equal(sims, threshold, out=mask)
        ii, jj = np.nonzero(mask)
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
