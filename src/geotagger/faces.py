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
)

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

class Gallery:
    """In-memory matrix of confirmed-face embeddings for fast cosine matching."""

    def __init__(self, embeddings: np.ndarray, person_ids: np.ndarray):
        self.embeddings = embeddings  # (N, 512), each row L2-normalized
        self.person_ids = person_ids  # (N,) int

    def __len__(self) -> int:
        return len(self.person_ids)


def build_gallery() -> Gallery:
    """Load all confirmed faces into a matrix for matching."""
    labeled = index.get_labeled_faces()
    if not labeled:
        return Gallery(np.zeros((0, EMBED_DIM), np.float32), np.zeros((0,), np.int64))
    embs = np.stack([decode_embedding(r["embedding"]) for r in labeled])
    pids = np.array([r["person_id"] for r in labeled], dtype=np.int64)
    return Gallery(embs, pids)


def match_embedding(vec: np.ndarray, gallery: Gallery) -> list[tuple[int, float]]:
    """Rank persons for an embedding by best cosine similarity. Best first.

    Embeddings are already L2-normalized, so the dot product is the cosine.
    Each person is scored by their single most-similar confirmed face.
    """
    if len(gallery) == 0:
        return []
    sims = gallery.embeddings @ vec  # (N,)
    best: dict[int, float] = {}
    for pid, s in zip(gallery.person_ids.tolist(), sims.tolist()):
        if s > best.get(pid, -1.0):
            best[pid] = s
    return sorted(best.items(), key=lambda kv: kv[1], reverse=True)


def suggest_person(vec: np.ndarray, gallery: Gallery,
                   threshold: float = FACE_MATCH_THRESHOLD) -> tuple[int, float] | None:
    """Return (person_id, score) if the top match clears the threshold, else None."""
    ranked = match_embedding(vec, gallery)
    if ranked and ranked[0][1] >= threshold:
        return ranked[0]
    return None
