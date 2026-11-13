"""Benchmark CLIP-family embedding models: speed, memory, retrieval quality, zero-shot tags.

    uv run python -m bench.run_embed [model_key ...]      # default: all SPECS

Writes results/embed/<key>.json and results/embed/<key>.npy (image embeddings).
GPU numbers use fp16 batch 32; CPU numbers use fp32 on a small subset (torch CPU,
indicative of — not identical to — an onnxruntime deployment).
"""
from __future__ import annotations

import sys
import time
import traceback

import numpy as np

from bench.common import (RESULTS, free_model, load_images, load_manifest, peak_vram_mb,
                          reset_peak, rss_mb, sync, write_json)
from bench.embedders import SPECS, Embedder
from bench.metrics import evaluate, load_queries

GPU_BATCH = 32
CPU_SUBSET = 16
CPU_BATCH = 8

# Zero-shot tag vocabulary — demonstrates auto-tagging without captions.
TAGS = ["sunset", "sunrise", "night", "city skyline", "skyscraper", "bridge", "highway", "train",
        "helicopter", "airplane", "flower", "wildflower", "garden", "tree", "park", "people",
        "selfie", "portrait", "party", "food", "dog", "cat", "bird", "insect", "beach", "lake",
        "river", "mountain", "snow", "desert", "church", "courthouse", "clock tower", "neon sign",
        "tower", "street", "car", "aerial view", "macro", "landscape", "indoors", "sky", "clouds"]


def bench(spec, images, ids, queries) -> dict:
    out = {"key": spec.key, "model": spec.model, "pretrained": spec.pretrained, "note": spec.note}

    # ── GPU ──
    reset_peak("cuda")
    t0 = time.perf_counter()
    emb = Embedder(spec, "cuda")
    out["load_s"] = time.perf_counter() - t0
    out["params_m"] = emb.n_params() / 1e6
    # Warm up with a full-size batch: cudnn autotunes per input shape, so a small
    # warmup batch left the first real batch paying the autotune cost.
    emb.encode_images(images[:GPU_BATCH]); emb.encode_texts(["warmup"])
    sync("cuda")
    t0 = time.perf_counter()
    vecs = np.concatenate([emb.encode_images(images[i:i + GPU_BATCH])
                           for i in range(0, len(images), GPU_BATCH)])
    sync("cuda")
    dt = time.perf_counter() - t0
    out["gpu_img_per_s"] = len(images) / dt
    out["dim"] = int(vecs.shape[1])
    qtexts = [q["q"] for q in queries]
    t0 = time.perf_counter()
    for t in qtexts:
        emb.encode_texts([t])
    sync("cuda")
    out["gpu_text_ms"] = (time.perf_counter() - t0) / len(qtexts) * 1000
    out["gpu_peak_vram_mb"] = peak_vram_mb("cuda")

    qv = emb.encode_texts(qtexts)
    t0 = time.perf_counter()
    scores = qv @ vecs.T
    out["search_ms"] = (time.perf_counter() - t0) * 1000
    out["retrieval"] = evaluate(scores, queries)

    tv = emb.encode_texts([f"a photo of {t}" for t in TAGS])
    ts = vecs @ tv.T
    out["tags"] = {ids[i]: [TAGS[j] for j in np.argsort(-ts[i])[:4]] for i in range(len(ids))}
    np.save(RESULTS / "embed" / f"{spec.key}.npy", vecs.astype(np.float16))
    free_model(emb)

    # ── CPU (fp32, subset) ──
    rss0 = rss_mb()
    emb = Embedder(spec, "cpu")
    sub = images[:CPU_SUBSET]
    emb.encode_images(sub[:2])
    t0 = time.perf_counter()
    for i in range(0, len(sub), CPU_BATCH):
        emb.encode_images(sub[i:i + CPU_BATCH])
    out["cpu_img_per_s"] = len(sub) / (time.perf_counter() - t0)
    t0 = time.perf_counter()
    for t in qtexts[:8]:
        emb.encode_texts([t])
    out["cpu_text_ms"] = (time.perf_counter() - t0) / 8 * 1000
    out["cpu_rss_delta_mb"] = rss_mb() - rss0
    free_model(emb)
    return out


def main(keys: list[str]) -> None:
    manifest = load_manifest()
    ids = [m["id"] for m in manifest]
    print(f"loading {len(ids)} images…")
    images = load_images(ids)
    queries = load_queries()
    (RESULTS / "embed").mkdir(parents=True, exist_ok=True)
    for spec in SPECS:
        if keys and spec.key not in keys:
            continue
        print(f"\n== {spec.key} ==")
        try:
            r = bench(spec, images, ids, queries)
            write_json(RESULTS / "embed" / f"{spec.key}.json", r)
            m = r["retrieval"]["mean"]
            print(f"  mAP {m['ap']:.3f}  R-prec {m['rprec']:.3f}  P@5 {m['p5']:.3f} | "
                  f"GPU {r['gpu_img_per_s']:.0f} img/s  CPU {r['cpu_img_per_s']:.1f} img/s  "
                  f"text {r['cpu_text_ms']:.0f}ms cpu  dim {r['dim']}  {r['params_m']:.0f}M params")
        except Exception as e:
            traceback.print_exc()
            write_json(RESULTS / "embed" / f"{spec.key}.json", {"key": spec.key, "error": repr(e)})


if __name__ == "__main__":
    main(sys.argv[1:])
