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
    FACE_MATCH_THRESHOLD, FACE_PROVIDERS,
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


def build_gallery() -> Gallery:
    """Load all confirmed faces into a matrix for matching."""
    labeled = index.get_labeled_faces()
    if not labeled:
        z = np.zeros((0,), np.float64)
        return Gallery(np.zeros((0, EMBED_DIM), np.float32), np.zeros((0,), np.int64), z, z)
    embs = np.stack([decode_embedding(r["embedding"]) for r in labeled])
    pids = np.array([r["person_id"] for r in labeled], dtype=np.int64)
    ftimes = np.array([float(r["photo_datetime"]) if r["photo_datetime"] else np.nan
                       for r in labeled], dtype=np.float64)
    births = np.array([_birth_ts(r["birth_date"]) for r in labeled], dtype=np.float64)
    return Gallery(embs, pids, ftimes, births)


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


def suggest_persons_batch(rows, gallery: Gallery,
                          threshold: float = FACE_MATCH_THRESHOLD
                          ) -> list[tuple[int, float] | None]:
    """Vectorized ``suggest_person`` for many faces at once.

    ``rows`` is a sequence of DB rows each carrying an ``embedding`` blob and a
    ``photo_datetime``. Returns one ``(person_id, score)`` (or ``None``) per row,
    equivalent to calling ``suggest_person`` on each — but the N cosine lookups
    collapse into a single matmul per chunk and the per-person reduction is
    vectorized, instead of an N×gallery Python loop. The age penalty/exclusion
    rules from ``match_embedding`` are applied identically across the batch.
    """
    n = len(rows)
    if n == 0 or len(gallery) == 0:
        return [None] * n

    unknowns = np.stack([decode_embedding(r["embedding"]) for r in rows])  # (N, 512)
    times = np.array([float(r["photo_datetime"]) if r["photo_datetime"] else np.nan
                      for r in rows], dtype=np.float64)

    pids = gallery.person_ids
    uniq = np.unique(pids)
    groups = [np.nonzero(pids == p)[0] for p in uniq]   # gallery rows per person
    has_birth = ~np.isnan(gallery.birth_times)
    age_f = (gallery.face_times - gallery.birth_times) / YEAR_SECONDS
    can_penalize = has_birth & ~np.isnan(gallery.face_times)

    results: list[tuple[int, float] | None] = [None] * n
    CHUNK = 1024  # caps the (gallery × chunk) score matrix to a few tens of MB
    for c0 in range(0, n, CHUNK):
        c1 = min(c0 + CHUNK, n)
        scores = (gallery.embeddings @ unknowns[c0:c1].T).astype(np.float64)  # (G, u)
        tu = times[c0:c1]
        dated = ~np.isnan(tu)
        if dated.any():
            age_u = (tu[None, :] - gallery.birth_times[:, None]) / YEAR_SECONDS
            penalty = FACE_AGE_PENALTY_PER_YEAR * np.minimum(
                np.abs(age_u - age_f[:, None]), FACE_AGE_PENALTY_CAP_YEARS)
            scores = np.where(can_penalize[:, None] & dated[None, :], scores - penalty, scores)
            excluded = (has_birth[:, None] & dated[None, :]) & (age_u < -FACE_BIRTH_TOLERANCE_YEARS)
            scores = np.where(excluded, -np.inf, scores)

        # Best example per person, then the best person, for each face in the chunk.
        per_person = np.full((len(uniq), c1 - c0), -np.inf)
        for i, g in enumerate(groups):
            per_person[i] = scores[g].max(axis=0)
        best_i = per_person.argmax(axis=0)
        best_score = per_person[best_i, np.arange(per_person.shape[1])]
        best_pid = uniq[best_i]
        for j in range(c1 - c0):
            s = best_score[j]
            if np.isfinite(s) and s >= threshold:
                results[c0 + j] = (int(best_pid[j]), float(s))
    return results
