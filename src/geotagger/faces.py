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
import threading
from pathlib import Path

import numpy as np

from geotagger import index, thumbnails
from geotagger.config import (
    CACHE_DIR_NAME, get_cache_dir,
    FACE_MODEL_NAME, FACE_DET_SIZE, FACE_DET_THRESHOLD,
    FACE_MATCH_THRESHOLD, FACE_AMBIGUITY_MARGIN, FACE_SUGGEST_SCAN_CAP, FACE_PROVIDERS,
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
        self.embeddings = embeddings    # (N, 512), each row L2-normalized
        self.person_ids = person_ids    # (N,) int
        self.face_times = face_times     # (N,) epoch secs, NaN if undated
        self.birth_times = birth_times   # (N,) epoch secs, NaN if person has no birth date

    def __len__(self) -> int:
        return len(self.person_ids)


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
    each call re-reads up to ``scan_cap`` embedding blobs from SQLite and
    re-decodes them into a (N, 512) matrix. Keyed on the faces-table generation
    (and the cap), so a single assign/ignore/scan invalidates it.
    """
    global _unlabeled_cache
    gen = index.faces_generation()
    if (_unlabeled_cache is not None
            and _unlabeled_cache[0] == gen and _unlabeled_cache[1] == scan_cap):
        return _unlabeled_cache[2], _unlabeled_cache[3], _unlabeled_cache[4]
    rows = index.list_faces("unlabeled", None, scan_cap)
    unknowns, times = _stack_rows(rows)
    _unlabeled_cache = (gen, scan_cap, rows, unknowns, times)
    return rows, unknowns, times


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
    adjusted = (gallery.embeddings @ vec).astype(np.float64)  # cosine per example

    if photo_datetime:
        tu = float(photo_datetime)
        births = gallery.birth_times
        has_birth = ~np.isnan(births)
        age_u = (tu - births) / YEAR_SECONDS                     # unknown's age for each person
        excluded = has_birth & (age_u < -FACE_BIRTH_TOLERANCE_YEARS)
        age_f = (gallery.face_times - births) / YEAR_SECONDS      # each example's age
        gap = np.abs(age_u - age_f)
        penalty = FACE_AGE_PENALTY_PER_YEAR * np.minimum(gap, FACE_AGE_PENALTY_CAP_YEARS)
        can_penalize = has_birth & ~np.isnan(gallery.face_times)
        adjusted = np.where(can_penalize, adjusted - penalty, adjusted)
        adjusted = np.where(excluded, -np.inf, adjusted)

    best: dict[int, float] = {}
    for pid, s in zip(gallery.person_ids.tolist(), adjusted.tolist()):
        if s > best.get(pid, -np.inf):
            best[pid] = s
    ranked = [(pid, s) for pid, s in best.items() if np.isfinite(s)]
    ranked.sort(key=lambda kv: kv[1], reverse=True)
    return ranked


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


def _adjusted_cosines(emb: np.ndarray, ftimes: np.ndarray, births: np.ndarray,
                      unknowns: np.ndarray, times: np.ndarray) -> np.ndarray:
    """Age-adjusted cosine matrix between gallery rows and a chunk of unknowns.

    ``emb`` is (M, 512); ``unknowns`` is (u, 512). Returns (M, u). Applies the
    same per-example age penalty and birth-date exclusion as ``match_embedding``,
    so any reduction over the result matches the single-face path.
    """
    scores = (emb @ unknowns.T).astype(np.float64)   # (M, u) cosine
    dated = ~np.isnan(times)
    if dated.any():
        has_birth = ~np.isnan(births)
        age_f = (ftimes - births) / YEAR_SECONDS
        can_penalize = has_birth & ~np.isnan(ftimes)
        age_u = (times[None, :] - births[:, None]) / YEAR_SECONDS
        penalty = FACE_AGE_PENALTY_PER_YEAR * np.minimum(
            np.abs(age_u - age_f[:, None]), FACE_AGE_PENALTY_CAP_YEARS)
        scores = np.where(can_penalize[:, None] & dated[None, :], scores - penalty, scores)
        excluded = (has_birth[:, None] & dated[None, :]) & (age_u < -FACE_BIRTH_TOLERANCE_YEARS)
        scores = np.where(excluded, -np.inf, scores)
    return scores


def _person_groups(gallery: Gallery) -> tuple[np.ndarray, list[np.ndarray]]:
    """Unique person ids and, for each, the gallery row indices belonging to them."""
    uniq = np.unique(gallery.person_ids)
    groups = [np.nonzero(gallery.person_ids == p)[0] for p in uniq]
    return uniq, groups


def _best_per_person(gallery: Gallery, uniq: np.ndarray, groups: list[np.ndarray],
                     unknowns: np.ndarray, times: np.ndarray) -> np.ndarray:
    """(len(uniq), u) matrix: each person's single best age-adjusted score per unknown."""
    scores = _adjusted_cosines(gallery.embeddings, gallery.face_times,
                               gallery.birth_times, unknowns, times)
    per_person = np.full((len(uniq), unknowns.shape[0]), -np.inf)
    for i, g in enumerate(groups):
        per_person[i] = scores[g].max(axis=0)
    return per_person


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
    uniq, groups = _person_groups(gallery)

    results: list[tuple[int, float] | None] = [None] * n
    for c0 in range(0, n, CHUNK):
        c1 = min(c0 + CHUNK, n)
        # Best example per person, then the best person, for each face in the chunk.
        per_person = _best_per_person(gallery, uniq, groups, unknowns[c0:c1], times[c0:c1])
        best_i = per_person.argmax(axis=0)
        best_score = per_person[best_i, np.arange(per_person.shape[1])]
        best_pid = uniq[best_i]
        for j in range(c1 - c0):
            s = best_score[j]
            if np.isfinite(s) and s >= threshold:
                results[c0 + j] = (int(best_pid[j]), float(s))
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

    uniq, groups = _person_groups(gallery)
    results: list[list[tuple[int, float]]] = [[] for _ in range(n)]
    for c0 in range(0, n, CHUNK):
        c1 = min(c0 + CHUNK, n)
        per_person = _best_per_person(gallery, uniq, groups, unknowns[c0:c1], times[c0:c1])
        for j in range(c1 - c0):
            col = per_person[:, j]
            order = np.argsort(col)[::-1]   # descending; -inf sinks to the end
            results[c0 + j] = [(int(uniq[i]), float(col[i])) for i in order
                               if np.isfinite(col[i]) and col[i] >= threshold]
    return results


def rank_persons_batch(rows, gallery: Gallery,
                       threshold: float = FACE_MATCH_THRESHOLD
                       ) -> list[list[tuple[int, float]]]:
    """Like ``suggest_persons_batch`` but keeps the full ranking per face,
    decoding ``rows`` then delegating to ``_rank_from_matrix``."""
    if len(rows) == 0 or len(gallery) == 0:
        return [[] for _ in range(len(rows))]
    unknowns, times = _stack_rows(rows)
    return _rank_from_matrix(unknowns, times, gallery, threshold)


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
    sel = gallery.person_ids == person_id
    if not sel.any() or len(rows) == 0:
        return []

    if unknowns is None or times is None:
        unknowns, times = _stack_rows(rows)
    emb, ft, bt = gallery.embeddings[sel], gallery.face_times[sel], gallery.birth_times[sel]
    best = np.full(len(rows), -np.inf)
    for c0 in range(0, len(rows), CHUNK):
        c1 = min(c0 + CHUNK, len(rows))
        best[c0:c1] = _adjusted_cosines(emb, ft, bt, unknowns[c0:c1], times[c0:c1]).max(axis=0)

    cand = np.nonzero(best >= threshold)[0]
    if len(cand) == 0:
        return []
    cand_rows = [rows[i] for i in cand]
    # Rank from the embeddings we already decoded instead of re-reading cand_rows.
    ranked = _rank_from_matrix(unknowns[cand], times[cand], gallery, threshold)

    out = []
    for row, persons in zip(cand_rows, ranked):
        if not persons or persons[0][0] != person_id:
            continue
        top = persons[0][1]
        alternatives = [(pid, s) for pid, s in persons[1:] if s >= top - margin]
        out.append((row, top, alternatives))
    return out
