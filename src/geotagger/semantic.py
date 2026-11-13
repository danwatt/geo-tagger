"""Semantic ("describe the photo") search: SigLIP 2 image/text embeddings on onnxruntime.

Each photo gets one L2-normalized 768-d vector from the *visual* tower; a typed
description goes through the *textual* tower into the same space, and search is a
dot product over the stored vectors. Model files are Immich's static ONNX exports of
SigLIP 2 (see docs/SEMANTIC_SEARCH_PLAN.md §3), fetched once from the Data Management
page — nothing here touches the network at query time, and nothing is written to
the media files (vectors are DB-only, like face data).

Two sessions, two locks: the ~350 MB visual session is only needed while indexing
(released afterwards via ``release_visual``), the ~1 GB textual session (mostly its
256k-token embedding table) loads on the first text query and stays resident.
"""
from __future__ import annotations

import logging
import os
import re
import string
import threading
import time
from pathlib import Path

import numpy as np

from geotagger import config
from geotagger.config import CACHE_DIR_NAME, get_cache_dir

logger = logging.getLogger(__name__)

EMBED_DIM = 768
CONTEXT_LENGTH = 64  # SigLIP 2 text tower's fixed token window

# Files that make up one model, relative to its directory (and to the download URL).
MODEL_FILES = ("visual/model.onnx", "visual/preprocess_cfg.json",
               "textual/model.onnx", "textual/tokenizer.json")

_model_root: Path | None = None
_visual = None  # (onnxruntime.InferenceSession, (w, h), mean, std)
_visual_lock = threading.Lock()
_textual = None  # (onnxruntime.InferenceSession, tokenizers.Tokenizer, pad_id)
_textual_lock = threading.Lock()


def init_semantic(root: Path | None = None):
    """Resolve where model files live (mirrors faces.init_faces). Loads nothing."""
    global _model_root
    cache_dir = get_cache_dir()
    if cache_dir is None:
        if root is None:
            raise RuntimeError("Must specify root directory or set GEOTAGGER_CACHE_DIR")
        cache_dir = root / CACHE_DIR_NAME
    _model_root = cache_dir / "semantic"
    _model_root.mkdir(parents=True, exist_ok=True)


def _model_dir() -> Path:
    if _model_root is None:
        raise RuntimeError("Semantic search not initialized — call init_semantic first")
    return _model_root / config.SEMANTIC_MODEL_NAME


# ── Model files ──

def model_status() -> dict:
    """Whether the current model's files are all on disk, for the Data page and the
    409 guards. Doesn't load anything."""
    if _model_root is None:
        return {"available": False, "model_dir": None, "name": config.SEMANTIC_MODEL_NAME,
                "size_bytes": 0}
    d = _model_dir()
    present = [d / f for f in MODEL_FILES if (d / f).is_file()]
    return {"available": len(present) == len(MODEL_FILES), "model_dir": str(d),
            "name": config.SEMANTIC_MODEL_NAME,
            "size_bytes": sum(p.stat().st_size for p in present)}


def download_model(force: bool = False, progress_cb=None) -> None:
    """Fetch every model file (blocking; run on the executor). Each file streams into
    a ``.part`` sibling and is renamed into place only when complete, so an
    interrupted download can never look like a finished one. ``progress_cb(done_bytes,
    file_name)`` is called as bytes arrive. Stdlib urllib on purpose — no
    huggingface_hub dependency for a handful of plain HTTPS GETs."""
    import urllib.request
    d = _model_dir()
    base = config.SEMANTIC_MODEL_URL.format(name=config.SEMANTIC_MODEL_NAME)
    done = 0
    for rel in MODEL_FILES:
        dest = d / rel
        if dest.is_file() and not force:
            done += dest.stat().st_size
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        req = urllib.request.Request(base + rel, headers={"User-Agent": "geotagger"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as f:
            while chunk := resp.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if progress_cb:
                    progress_cb(done, rel)
        os.replace(part, dest)
    reset_model()


def reset_model():
    """Drop both loaded sessions (after a re-download, or a model-name change)."""
    global _visual, _textual
    with _visual_lock:
        _visual = None
    with _textual_lock:
        _textual = None


def release_visual():
    """Free the visual session once indexing is finished — it's only needed to embed
    new photos, and holds ~350 MB."""
    global _visual
    with _visual_lock:
        _visual = None


def _session(path: Path):
    import onnxruntime as ort
    from geotagger import onnx_setup
    onnx_setup.prepare(config.SEMANTIC_PROVIDERS)
    sess = ort.InferenceSession(str(path), providers=config.SEMANTIC_PROVIDERS)
    logger.info(f"Semantic {path.parent.name} session on {onnx_setup.active_providers(sess)}")
    return sess


def _get_visual():
    global _visual
    if _visual is not None:
        return _visual
    with _visual_lock:
        if _visual is None:
            import json as _json
            d = _model_dir()
            if not model_status()["available"]:
                raise RuntimeError("Semantic model not downloaded")
            cfg = _json.loads((d / "visual" / "preprocess_cfg.json").read_text(encoding="utf-8"))
            t0 = time.time()
            _visual = (_session(d / "visual" / "model.onnx"), tuple(cfg["size"]),
                       np.array(cfg["mean"], dtype=np.float32), np.array(cfg["std"], dtype=np.float32))
            logger.info(f"Loaded semantic visual model in {(time.time() - t0) * 1000:.0f}ms")
    return _visual


def _get_textual():
    global _textual
    if _textual is not None:
        return _textual
    with _textual_lock:
        if _textual is None:
            from tokenizers import Tokenizer
            d = _model_dir()
            if not model_status()["available"]:
                raise RuntimeError("Semantic model not downloaded")
            t0 = time.time()
            tok = Tokenizer.from_file(str(d / "textual" / "tokenizer.json"))
            # We pad/truncate ourselves to the model's fixed 64-token input.
            tok.no_padding()
            tok.no_truncation()
            pad_id = tok.token_to_id("<pad>") or 0
            _textual = (_session(d / "textual" / "model.onnx"), tok, pad_id)
            logger.info(f"Loaded semantic text model in {(time.time() - t0) * 1000:.0f}ms")
    return _textual


# ── Encoding ──

def canonicalize(text: str) -> str:
    """open_clip's ``clean='canonicalize'``, which SigLIP 2 was trained with: strip
    punctuation, lowercase, collapse whitespace. Verified token-for-token against
    open_clip in prototypes/vision_bench/bench/onnx_check.py."""
    text = text.replace("_", " ").translate(str.maketrans("", "", string.punctuation))
    return re.sub(r"\s+", " ", text.lower()).strip()


def tokenize(tok, pad_id: int, text: str) -> np.ndarray:
    # tokenizer.json's post-processor appends the EOS the text tower pools on.
    ids = tok.encode(canonicalize(text)).ids[:CONTEXT_LENGTH]
    return np.array([ids + [pad_id] * (CONTEXT_LENGTH - len(ids))], dtype=np.int32)


def preprocess(img, size: tuple[int, int], mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    """Squash-resize (no center crop — matches the export's preprocess_cfg) to the
    model's input size, scale to [0,1], normalize, HWC→NCHW."""
    from PIL import Image
    x = np.asarray(img.convert("RGB").resize(tuple(size), Image.BICUBIC), dtype=np.float32) / 255.0
    return ((x - mean) / std).transpose(2, 0, 1)[None]


def _l2(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32).reshape(-1)
    return v / max(float(np.linalg.norm(v)), 1e-12)


def encode_image(img) -> np.ndarray:
    """PIL image (upright) → unit (768,) float32."""
    sess, size, mean, std = _get_visual()
    x = preprocess(img, size, mean, std)
    with _visual_lock:
        out = sess.run(None, {"image": x})[0]
    return _l2(out)


def encode_text(text: str) -> np.ndarray:
    """Free text → unit (768,) float32, in the same space as encode_image."""
    sess, tok, pad_id = _get_textual()
    ids = tokenize(tok, pad_id, text)
    with _textual_lock:
        out = sess.run(None, {"text": ids})[0]
    return _l2(out)


# ── Vector (de)serialization ──
# fp16 halves storage (~1.5 KB/photo); the prototype saw no quality change from it.

def encode_vec(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float16).tobytes()


def decode_vec(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float16).astype(np.float32)


# ── In-memory matrix + ranking ──
# Brute force over every stored vector: ~5 ms per query at 100k photos, so no ANN
# index. The cache is keyed on a cheap (count, max created_at) signature from the DB
# rather than an explicit generation counter, so inserts, re-embeds and deletes
# (the photos delete trigger) all invalidate it without cross-module hooks.

_matrix_cache: tuple[tuple, np.ndarray, np.ndarray] | None = None
_matrix_lock = threading.Lock()


def get_matrix() -> tuple[np.ndarray, np.ndarray]:
    """(sorted photo ids int64[N], unit vectors float32[N, 768]) for the current model."""
    global _matrix_cache
    from geotagger import index
    model = config.SEMANTIC_MODEL_NAME
    sig = (model, *index.embedding_signature(model))
    with _matrix_lock:
        if _matrix_cache is None or _matrix_cache[0] != sig:
            t0 = time.time()
            ids, mat = index.load_embeddings(model)
            _matrix_cache = (sig, ids, mat)
            logger.info(f"Loaded {len(ids)} semantic vectors in {(time.time() - t0) * 1000:.1f}ms")
        return _matrix_cache[1], _matrix_cache[2]


def rank(query: np.ndarray, candidate_ids: list[int] | None, min_score: float,
         exclude_id: int | None = None) -> list[tuple[int, float]]:
    """Score ``query`` against stored vectors, restricted to ``candidate_ids`` (None =
    every embedded photo). Returns [(photo_id, score)] above ``min_score``, best
    first. Candidates with no vector yet are silently absent."""
    t0 = time.time()
    ids, mat = get_matrix()
    if len(ids) == 0:
        return []
    if candidate_ids is None:
        rows = np.arange(len(ids))
    else:
        # ids is sorted, so map candidates to matrix rows by binary search
        # (O(c log n)) instead of a Python dict over every stored id.
        cand = np.unique(np.asarray(candidate_ids, dtype=np.int64))
        pos = np.searchsorted(ids, cand)
        inside = pos < len(ids)
        pos, cand = pos[inside], cand[inside]
        rows = pos[ids[pos] == cand]
    if len(rows) == 0:
        return []
    scores = mat[rows] @ np.asarray(query, dtype=np.float32)
    keep = scores >= min_score
    rows, scores = rows[keep], scores[keep]
    order = np.argsort(-scores, kind="stable")
    out = [(int(ids[rows[i]]), float(scores[i])) for i in order
           if exclude_id is None or ids[rows[i]] != exclude_id]
    logger.info(f"Semantic rank over {len(ids)} vectors -> {len(out)} hits in {(time.time() - t0) * 1000:.2f}ms")
    return out
