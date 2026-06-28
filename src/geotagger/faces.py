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

from geotagger import index, thumbnails
from geotagger.config import (
    CACHE_DIR_NAME, get_cache_dir,
    FACE_MODEL_NAME, FACE_DET_SIZE, FACE_DET_THRESHOLD,
    FACE_MATCH_THRESHOLD, FACE_AMBIGUITY_MARGIN, FACE_SUGGEST_SCAN_CAP,
    FACE_SUGGEST_MIN_DET_SCORE, FACE_PROVIDERS,
    FACE_CLUSTER_THRESHOLD, FACE_CLUSTER_MIN_SIZE,
    FACE_BIRTH_TOLERANCE_YEARS, FACE_AGE_PENALTY_PER_YEAR, FACE_AGE_PENALTY_CAP_YEARS,
)

YEAR_SECONDS = 365.25 * 86400

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

def detect_faces(path: Path, mtime: float, size: int) -> list[dict]:
    """Detect faces in a photo and return their normalized boxes + embeddings.

    Runs on the cached preview JPEG (reusing the thumbnail pipeline's decode of
    RAW/HEIC), so bboxes are normalized to 0..1 and resolution-independent.
    Returns a list of {bbox, det_score, embedding} ready for index.replace_faces.
    """
    import cv2

    preview = thumbnails.get_preview(path, mtime, size)  # cached JPEG bytes
    arr = cv2.imdecode(np.frombuffer(preview, np.uint8), cv2.IMREAD_COLOR)  # BGR
    if arr is None:
        raise RuntimeError(f"Could not decode preview for {path}")
    h, w = arr.shape[:2]

    app = _get_app()
    with _app_lock:
        faces = app.get(arr)

    results = []
    for f in faces:
        x1, y1, x2, y2 = f.bbox
        # Clamp + normalize to the preview dimensions.
        bbox = [
            max(0.0, x1 / w), max(0.0, y1 / h),
            min(1.0, x2 / w), min(1.0, y2 / h),
        ]
        results.append({
            "bbox": ",".join(f"{v:.5f}" for v in bbox),
            "det_score": float(f.det_score),
            "embedding": encode_embedding(f.normed_embedding),
        })
    return results


def detect_and_store(photo_row) -> int:
    """Detect faces for one indexed photo and persist them. Returns face count."""
    faces = detect_faces(Path(photo_row["path"]), photo_row["mtime"], photo_row["size"])
    index.replace_faces(photo_row["id"], faces)
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
            order = np.argsort(person_ids, kind="stable")
            # Contiguous copy in float32 — fast matmul, halves memory vs float64.
            self._s_embs = np.ascontiguousarray(embeddings[order], dtype=np.float32)
            # Convert times to float32 years-since-epoch now, once. Large epoch-second
            # values lose integer-second precision in float32, but age-in-years only
            # needs ~1-day resolution, so float32 is more than adequate.
            self._s_ft_yr = (face_times[order]  / YEAR_SECONDS).astype(np.float32)
            self._s_bt_yr = (birth_times[order] / YEAR_SECONDS).astype(np.float32)
            sorted_pids = person_ids[order]
            _, starts = np.unique(sorted_pids, return_index=True)
            self._group_starts = starts.astype(np.intp)   # (P,) segment boundaries
            self._uniq_pids    = sorted_pids[starts]       # (P,) int64
        else:
            dim = embeddings.shape[1] if embeddings.ndim == 2 and len(embeddings) else EMBED_DIM
            self._s_embs       = np.empty((0, dim), np.float32)
            self._s_ft_yr      = np.empty(0, np.float32)
            self._s_bt_yr      = np.empty(0, np.float32)
            self._group_starts = np.empty(0, np.intp)
            self._uniq_pids    = np.empty(0, np.int64)

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


def build_gallery() -> Gallery:
    """Load all confirmed faces into a matrix for matching (cached, see above)."""
    global _gallery_cache
    gen = index.faces_generation()
    if _gallery_cache is not None and _gallery_cache[0] == gen:
        return _gallery_cache[1]

    labeled = index.get_labeled_faces()
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


def get_unlabeled_matrix(scan_cap: int = FACE_SUGGEST_SCAN_CAP
                         ) -> tuple[list, np.ndarray, np.ndarray]:
    """Cached (rows, embeddings, times) for the unlabeled queue.

    The suggested-faces review refetches after every accept; without caching,
    each call re-reads the embedding blobs from SQLite and re-decodes them into a
    (N, 512) matrix. ``scan_cap`` <= 0 means scan *all* unlabeled faces (SQLite
    ``LIMIT -1``); a positive cap keeps the top ``scan_cap`` by detection score.
    Keyed on the faces-table generation (and the cap). Removals (assign/ignore)
    prune this in place via ``drop_from_unlabeled_cache`` so the exhaustive read
    happens once, not on every accept.
    """
    global _unlabeled_cache
    gen = index.faces_generation()
    if (_unlabeled_cache is not None
            and _unlabeled_cache[0] == gen and _unlabeled_cache[1] == scan_cap):
        return _unlabeled_cache[2], _unlabeled_cache[3], _unlabeled_cache[4]
    limit = scan_cap if scan_cap and scan_cap > 0 else -1   # -1 → unbounded
    floor = FACE_SUGGEST_MIN_DET_SCORE if FACE_SUGGEST_MIN_DET_SCORE > 0 else None
    rows = index.list_faces("unlabeled", None, limit, min_det_score=floor)
    unknowns, times = _stack_rows(rows)
    _unlabeled_cache = (gen, scan_cap, rows, unknowns, times)
    return rows, unknowns, times


def drop_from_unlabeled_cache(face_ids):
    """Prune just-labeled/ignored faces from the cached unlabeled matrix instead
    of forcing a full re-read on the next scan, and re-tag the cache to the
    current generation so it survives the accept loop.

    Only valid for *removals* from the unlabeled set (assign-to-person, ignore).
    Additions (unassign, restore, new detections) bump the generation without
    calling this, so the next ``get_unlabeled_matrix`` rebuilds from scratch.
    """
    global _unlabeled_cache
    if _unlabeled_cache is None:
        return
    _, scan_cap, rows, unknowns, times = _unlabeled_cache
    drop = set(face_ids)
    keep = [i for i, r in enumerate(rows) if r["id"] not in drop]
    if len(keep) != len(rows):
        idx = np.array(keep, dtype=np.int64)
        rows = [rows[i] for i in keep]
        unknowns, times = unknowns[idx], times[idx]
    _unlabeled_cache = (index.faces_generation(), scan_cap, rows, unknowns, times)


def match_embedding(vec: np.ndarray, photo_datetime, gallery: Gallery) -> list[tuple[int, float]]:
    """Rank persons for an embedding by best (age-adjusted) cosine similarity.

    Embeddings are L2-normalized, so the dot product is the cosine. When the
    unknown face is dated and a candidate has a birth date, two age rules apply:
    a photo predating the person's birth excludes them outright, and examples
    taken at a very different age than the unknown are penalized — so a baby
    photo is matched against baby examples, not 5-year-old ones.
    Each person is scored by their single best example after adjustment.
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
        excl      = has_birth & (age_u < np.float32(-FACE_BIRTH_TOLERANCE_YEARS))
        gap       = np.abs(age_u - age_f)
        penalty   = np.minimum(gap, np.float32(FACE_AGE_PENALTY_CAP_YEARS))
        penalty  *= np.float32(FACE_AGE_PENALTY_PER_YEAR)
        np.subtract(scores, penalty, where=can_pen, out=scores)
        scores[excl] = np.float32(-np.inf)

    # Per-person best via reduceat — replaces a 21K-iteration Python loop.
    if len(gallery._group_starts) == 0:
        return []
    per_person = np.maximum.reduceat(scores, gallery._group_starts)  # (P,) f32

    mask  = np.isfinite(per_person)
    pids  = gallery._uniq_pids[mask]
    svals = per_person[mask]
    order = np.argsort(svals)[::-1]
    return [(int(pids[order[i]]), float(svals[order[i]])) for i in range(len(order))]


def suggest_person(vec: np.ndarray, photo_datetime, gallery: Gallery,
                   threshold: float = FACE_MATCH_THRESHOLD) -> tuple[int, float] | None:
    """Return (person_id, score) if the top match clears the threshold, else None."""
    ranked = match_embedding(vec, photo_datetime, gallery)
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

    All float32 throughout (halves working set vs float64) and
    ``np.maximum.reduceat`` for the per-group max (no Python loop, no
    fancy-index copies). Uses the pre-sorted ``_s_*`` fields so the sort
    and group-boundary lookup happen at gallery-build time, not here.
    """
    scores = gallery._s_embs @ unknowns.T   # (N, u) float32

    dated = ~np.isnan(times)
    if dated.any():
        has_birth = ~np.isnan(gallery._s_bt_yr)          # (N,) bool
        has_ft    = ~np.isnan(gallery._s_ft_yr)          # (N,) bool
        can_pen   = has_birth & has_ft                   # (N,) bool

        # Convert to years in float32 here to avoid a large (N, u) float64 broadcast.
        times_yr = (times / YEAR_SECONDS).astype(np.float32)              # (u,)
        age_u    = times_yr[None, :] - gallery._s_bt_yr[:, None]         # (N, u) f32
        age_f    = gallery._s_ft_yr   - gallery._s_bt_yr                 # (N,) f32

        # Capture the exclusion mask before we overwrite age_u in-place below.
        excl = (has_birth[:, None] & dated[None, :]) & (age_u < np.float32(-FACE_BIRTH_TOLERANCE_YEARS))

        # Reuse age_u as the penalty array (saves 88 MB per chunk).
        age_u -= age_f[:, None]
        np.abs(age_u, out=age_u)
        np.minimum(age_u, np.float32(FACE_AGE_PENALTY_CAP_YEARS), out=age_u)
        age_u *= np.float32(FACE_AGE_PENALTY_PER_YEAR)

        mask = can_pen[:, None] & dated[None, :]
        np.subtract(scores, age_u, where=mask, out=scores)
        scores[excl] = np.float32(-np.inf)

    if len(gallery._group_starts) == 0:
        return np.empty((0, unknowns.shape[0]), dtype=np.float32)
    return np.maximum.reduceat(scores, gallery._group_starts, axis=0)  # (P, u) f32


def suggest_persons_batch(rows, gallery: Gallery,
                          threshold: float = FACE_MATCH_THRESHOLD,
                          unknowns: np.ndarray | None = None,
                          times: np.ndarray | None = None
                          ) -> list[tuple[int, float] | None]:
    """Vectorized ``suggest_person`` for many faces at once.

    ``rows`` is a sequence of DB rows each carrying an ``embedding`` blob and a
    ``photo_datetime``. Returns one ``(person_id, score)`` (or ``None``) per row,
    equivalent to calling ``suggest_person`` on each — but the N cosine lookups
    collapse into a single matmul per chunk and the per-person reduction is
    vectorized, instead of an N×gallery Python loop. Pass ``unknowns``/``times``
    (e.g. from ``get_unlabeled_matrix``) to skip decoding the embeddings again.
    """
    n = len(rows)
    if n == 0 or len(gallery) == 0:
        return [None] * n

    if unknowns is None or times is None:
        unknowns, times = _stack_rows(rows)
    uniq = gallery._uniq_pids

    results: list[tuple[int, float] | None] = [None] * n
    for c0 in range(0, n, CHUNK):
        c1 = min(c0 + CHUNK, n)
        per_person = _best_per_person_f32(gallery, unknowns[c0:c1], times[c0:c1])
        best_i     = per_person.argmax(axis=0)
        best_score = per_person[best_i, np.arange(per_person.shape[1])]
        best_pid   = uniq[best_i]
        for j in range(c1 - c0):
            s = float(best_score[j])
            if np.isfinite(s) and s >= threshold:
                results[c0 + j] = (int(best_pid[j]), s)
    return results


def _rank_from_matrix(unknowns: np.ndarray, times: np.ndarray, gallery: Gallery,
                      threshold: float = FACE_MATCH_THRESHOLD
                      ) -> list[list[tuple[int, float]]]:
    """Full per-face ranking from an already-decoded embedding matrix.

    Returns, for each unknown, every person whose best example clears
    ``threshold`` as a ``(person_id, score)`` list ordered best-first. Working
    from a matrix (not DB rows) lets callers reuse embeddings they already
    decoded instead of decoding them twice.
    """
    n = unknowns.shape[0]
    if n == 0 or len(gallery) == 0:
        return [[] for _ in range(n)]

    uniq = gallery._uniq_pids
    results: list[list[tuple[int, float]]] = [[] for _ in range(n)]
    for c0 in range(0, n, CHUNK):
        c1 = min(c0 + CHUNK, n)
        per_person = _best_per_person_f32(gallery, unknowns[c0:c1], times[c0:c1])
        for j in range(c1 - c0):
            col = per_person[:, j]
            order = np.argsort(col)[::-1]   # descending; -inf sinks to the end
            results[c0 + j] = [(int(uniq[i]), float(col[i])) for i in order
                               if np.isfinite(col[i]) and col[i] >= threshold]
    return results



def suggest_for_person(rows, gallery: Gallery, person_id: int,
                       threshold: float = FACE_MATCH_THRESHOLD,
                       margin: float = FACE_AMBIGUITY_MARGIN,
                       unknowns: np.ndarray | None = None,
                       times: np.ndarray | None = None) -> list[tuple]:
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
    list, best-first.

    Pass ``unknowns``/``times`` (the decoded embedding matrix and photo times for
    ``rows``, e.g. from ``get_unlabeled_matrix``) to skip decoding here and in the
    ranking step entirely.
    """
    # Binary search on pre-sorted unique person ids — no 21K boolean scan.
    pid_pos = int(np.searchsorted(gallery._uniq_pids, person_id))
    if pid_pos >= len(gallery._uniq_pids) or gallery._uniq_pids[pid_pos] != person_id:
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
            excl  = (has_birth[:, None] & dated_c[None, :]) & (age_u < np.float32(-FACE_BIRTH_TOLERANCE_YEARS))
            age_u -= age_f[:, None]
            np.abs(age_u, out=age_u)
            np.minimum(age_u, np.float32(FACE_AGE_PENALTY_CAP_YEARS), out=age_u)
            age_u *= np.float32(FACE_AGE_PENALTY_PER_YEAR)
            np.subtract(scores, age_u, where=can_pen[:, None] & dated_c[None, :], out=scores)
            scores[excl] = np.float32(-np.inf)
        best[c0:c1] = scores.max(axis=0)
    _tg1 = _time.perf_counter()

    cand = np.nonzero(best >= threshold)[0]
    if len(cand) == 0:
        _log.debug("suggest_for_person pid=%d unlabeled=%d person_embs=%d "
                   "gate=%.3fs candidates=0", person_id, len(rows), p_end - p_start, _tg1 - _tg0)
        return []
    cand_rows = [rows[i] for i in cand]
    # Rank from the embeddings we already decoded instead of re-reading cand_rows.
    ranked = _rank_from_matrix(unknowns[cand], times[cand], gallery, threshold)
    _tr1 = _time.perf_counter()
    _log.debug("suggest_for_person pid=%d unlabeled=%d person_embs=%d gallery=%d "
               "gate=%.3fs candidates=%d rank=%.3fs",
               person_id, len(rows), p_end - p_start, len(gallery),
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
                      threshold: float = FACE_CLUSTER_THRESHOLD,
                      min_size: int = FACE_CLUSTER_MIN_SIZE) -> list[list[int]]:
    """Group row indices of ``unknowns`` ((N, 512), L2-normalized) into clusters of
    likely same-person faces.

    Builds a cosine-similarity graph (edge when sim >= ``threshold``) in chunks and
    takes its connected components via union-find. Returns clusters (lists of row
    indices) with at least ``min_size`` members, largest first; sparser faces drop
    out as noise. Pure numpy/Python, so it's safe to run off the event loop.

    Connected components can over-merge by chaining (A~B~C), so ``threshold`` is
    kept fairly tight; a graph-relabel method (e.g. Chinese Whispers) would resist
    that better if it becomes a problem.
    """
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
