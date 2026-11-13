"""One-time onnxruntime GPU setup shared by faces.py and semantic.py.

onnxruntime-gpu's CUDA/cuDNN libraries come in as pip wheels (``nvidia-*``), which
live under site-packages, not on PATH — Windows' loader won't find them on its own,
so the CUDA provider would silently fail to load and every session would fall back
to CPU. ``onnxruntime.preload_dlls()`` loads them from the wheels up front. It must
run before the first InferenceSession that asks for CUDA (InsightFace builds its
sessions internally, so faces calls this before constructing FaceAnalysis).
"""
from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

_prepared = False
_lock = threading.Lock()


def prepare(providers: list[str]) -> None:
    """Preload CUDA DLLs if ``providers`` asks for CUDA. Idempotent and never raises:
    on a machine without a usable GPU, onnxruntime just falls back down the
    provider list."""
    global _prepared
    if _prepared or not any("CUDA" in p or "Tensorrt" in p for p in providers):
        return
    with _lock:
        if _prepared:
            return
        _prepared = True
        try:
            import onnxruntime as ort
            if "CUDAExecutionProvider" not in ort.get_available_providers():
                # CPU-only onnxruntime build — nothing to preload.
                logger.info("onnxruntime has no CUDA provider; running on CPU")
                return
            if hasattr(ort, "preload_dlls"):
                ort.preload_dlls()
        except Exception as e:
            logger.warning(f"onnxruntime CUDA preload failed, will fall back to CPU: {e}")


def active_providers(session) -> list[str]:
    """Providers a built session actually ended up with (after any fallback)."""
    try:
        return list(session.get_providers())
    except Exception:
        return []
