"""Shared paths, image loading, and timing/memory helpers for the vision benchmark.

Deliberately independent of the geotagger package: this prototype has its own venv
(torch, transformers, open_clip) that must never leak into the main app.
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
IMG_DIR = CACHE / "images"     # 1024px long-side upright JPEGs (model input)
THUMB_DIR = CACHE / "thumbs"   # 256px for the HTML report
MANIFEST = CACHE / "manifest.json"
RESULTS = ROOT / "results"
QUERIES = ROOT / "queries.json"

DEFAULT_SOURCE = r"E:\Pictures\07 - Texas Years\2026\2026-08"
EXIFTOOL = ROOT.parent.parent / "tools" / "exiftool.exe"


def load_manifest() -> list[dict]:
    if not MANIFEST.exists():
        raise SystemExit("No manifest — run `uv run python -m bench.prep` first.")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def load_images(ids: list[str]):
    from PIL import Image
    return [Image.open(IMG_DIR / f"{i}.jpg").convert("RGB") for i in ids]


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


# ── Timing / memory ──

@contextmanager
def timer(out: dict, key: str):
    t0 = time.perf_counter()
    yield
    out[key] = time.perf_counter() - t0


def sync(device: str) -> None:
    if device == "cuda":
        import torch
        torch.cuda.synchronize()


def reset_peak(device: str) -> None:
    if device == "cuda":
        import torch
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()


def peak_vram_mb(device: str) -> float | None:
    if device != "cuda":
        return None
    import torch
    return torch.cuda.max_memory_allocated() / 2**20


def rss_mb() -> float:
    import psutil
    return psutil.Process(os.getpid()).memory_info().rss / 2**20


def free_model(*objs) -> None:
    import gc
    import torch
    for o in objs:
        del o
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def hf_cache_size_mb(repo_id: str) -> float | None:
    """On-disk size of a downloaded HF repo (weights size proxy)."""
    try:
        from huggingface_hub import scan_cache_dir
        for r in scan_cache_dir().repos:
            if r.repo_id == repo_id:
                return r.size_on_disk / 2**20
    except Exception:
        pass
    return None
