"""Benchmark captioning VLMs: speed, memory, and the captions themselves.

    uv run python -m bench.run_caption [model_key ...]      # default: all SPECS

Writes results/caption/<key>.json. Search quality over the captions is scored
separately by ``bench.eval_text`` so it can be re-run without re-captioning.
"""
from __future__ import annotations

import sys
import time
import traceback

from bench.common import (RESULTS, free_model, load_images, load_manifest, peak_vram_mb,
                          reset_peak, sync, write_json)
from bench.captioners import SPECS, Captioner

CPU_SUBSET = 3


def bench(spec, images, ids) -> dict:
    out ={"key": spec.key, "model": spec.model, "note": spec.note}
    reset_peak("cuda")
    t0 = time.perf_counter()
    cap = Captioner(spec, "cuda")
    out["load_s"] = time.perf_counter() - t0
    out["params_m"] = cap.n_params() / 1e6
    cap.caption(images[0])  # warmup

    captions, toks, times = {}, [], []
    for n, (iid, img) in enumerate(zip(ids, images), 1):
        sync("cuda")
        t0 = time.perf_counter()
        text, nt = cap.caption(img)
        sync("cuda")
        times.append(time.perf_counter() - t0)
        captions[iid] = text
        if nt:
            toks.append(nt)
        if n % 25 == 0:
            print(f"  {n}/{len(ids)}  {sum(times) / len(times):.2f}s/img")
    out["gpu_s_per_img"] = sum(times) / len(times)
    out["gpu_tok_per_s"] = (sum(toks) / sum(times[:len(toks)])) if toks else None
    out["gpu_peak_vram_mb"] = peak_vram_mb("cuda")
    out["avg_words"] = sum(len(c.split()) for c in captions.values()) / len(captions)
    out["captions"] = captions
    free_model(cap)

    if spec.cpu:
        try:
            cap = Captioner(spec, "cpu")
            t0 = time.perf_counter()
            for img in images[:CPU_SUBSET]:
                cap.caption(img)
            out["cpu_s_per_img"] = (time.perf_counter() - t0) / CPU_SUBSET
            free_model(cap)
        except Exception as e:
            out["cpu_error"] = repr(e)
    return out


def main(keys: list[str]) -> None:
    ids = [m["id"] for m in load_manifest()]
    images = load_images(ids)
    (RESULTS / "caption").mkdir(parents=True, exist_ok=True)
    for spec in SPECS:
        if keys and spec.key not in keys:
            continue
        print(f"\n== {spec.key} ==", flush=True)
        try:
            r = bench(spec, images, ids)
            write_json(RESULTS / "caption" / f"{spec.key}.json", r)
            print(f"  GPU {r['gpu_s_per_img']:.2f}s/img  CPU {r.get('cpu_s_per_img', float('nan')):.1f}s/img  "
                  f"VRAM {r['gpu_peak_vram_mb']:.0f}MB  ~{r['avg_words']:.0f} words", flush=True)
            print("  e.g.", next(iter(r["captions"].values()))[:200], flush=True)
        except Exception as e:
            traceback.print_exc()
            write_json(RESULTS / "caption" / f"{spec.key}.json", {"key": spec.key, "error": repr(e)})


if __name__ == "__main__":
    main(sys.argv[1:])
