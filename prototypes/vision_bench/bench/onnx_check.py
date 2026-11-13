"""Validate the deployment path: Immich's pre-exported SigLIP 2 ONNX models on plain
onnxruntime (CPU) with a dependency-light tokenizer + preprocessing — exactly what the
main app would ship (no torch). Checks tokenizer parity with open_clip, then measures
speed and retrieval quality on the same ground truth as run_embed.

    uv run python -m bench.onnx_check
"""
from __future__ import annotations

import json
import os
import re
import string
import time

import numpy as np

from bench.common import RESULTS, load_images, load_manifest, write_json
from bench.metrics import evaluate, load_queries

REPOS = {
    "onnx-siglip2-b16-224": ("immich-app/ViT-B-16-SigLIP2__webli", "ViT-B-16-SigLIP2"),
    "onnx-siglip2-b32-256": ("immich-app/ViT-B-32-SigLIP2-256__webli", "ViT-B-32-SigLIP2-256"),
}
CONTEXT = 64


def canonicalize(text: str) -> str:
    """open_clip's ``clean='canonicalize'``: strip punctuation, lowercase, collapse spaces."""
    text = text.replace("_", " ").translate(str.maketrans("", "", string.punctuation))
    return re.sub(r"\s+", " ", text.lower()).strip()


class OnnxSiglip:
    def __init__(self, repo: str):
        import onnxruntime as ort
        from huggingface_hub import snapshot_download
        from tokenizers import Tokenizer
        d = snapshot_download(repo, allow_patterns=["*.json", "visual/model.onnx", "textual/model.onnx"])
        cfg = json.load(open(os.path.join(d, "visual", "preprocess_cfg.json")))
        self.size = tuple(cfg["size"])
        so = ort.SessionOptions()
        self.vis = ort.InferenceSession(os.path.join(d, "visual", "model.onnx"), so, providers=["CPUExecutionProvider"])
        self.txt = ort.InferenceSession(os.path.join(d, "textual", "model.onnx"), so, providers=["CPUExecutionProvider"])
        self.tok = Tokenizer.from_file(os.path.join(d, "textual", "tokenizer.json"))
        self.tok.no_padding()
        self.tok.no_truncation()
        self.pad_id = self.tok.token_to_id("<pad>") or 0
        self.disk_mb = sum(os.path.getsize(os.path.join(d, t, "model.onnx")) for t in ("visual", "textual")) / 2**20

    def tokenize(self, text: str) -> np.ndarray:
        ids = self.tok.encode(canonicalize(text)).ids[:CONTEXT]
        # SigLIP text tower pools the last token and expects an EOS at the end of
        # the real tokens; the HF tokenizer.json post-processor appends it.
        return np.array([ids + [self.pad_id] * (CONTEXT - len(ids))], dtype=np.int32)

    def preprocess(self, img) -> np.ndarray:
        from PIL import Image
        x = np.asarray(img.convert("RGB").resize(self.size, Image.BICUBIC), dtype=np.float32) / 255.0
        return ((x - 0.5) / 0.5).transpose(2, 0, 1)[None]

    def image(self, img) -> np.ndarray:
        v = self.vis.run(None, {"image": self.preprocess(img)})[0][0]
        return v / np.linalg.norm(v)

    def text(self, t: str) -> np.ndarray:
        v = self.txt.run(None, {"text": self.tokenize(t)})[0][0]
        return v / np.linalg.norm(v)


def main() -> None:
    import open_clip
    ids = [m["id"] for m in load_manifest()]
    images = load_images(ids)
    queries = load_queries()
    out = {}
    for key, (repo, oc_name) in REPOS.items():
        print(f"\n== {key} ({repo}) ==")
        m = OnnxSiglip(repo)
        # Tokenizer parity vs open_clip (the reference the ONNX was exported from).
        oc_tok = open_clip.get_tokenizer(oc_name)
        mism = [q["q"] for q in queries if not np.array_equal(
            m.tokenize(q["q"])[0], oc_tok([q["q"]])[0].numpy().astype(np.int32))]
        print(f"  tokenizer mismatches vs open_clip: {len(mism)} {mism[:3]}")
        m.image(images[0])
        t0 = time.perf_counter()
        vecs = np.stack([m.image(im) for im in images])
        img_s = len(images) / (time.perf_counter() - t0)
        t0 = time.perf_counter()
        qv = np.stack([m.text(q["q"]) for q in queries])
        text_ms = (time.perf_counter() - t0) / len(queries) * 1000
        ev = evaluate(qv @ vecs.T, queries)
        r = {"repo": repo, "cpu_img_per_s": img_s, "cpu_text_ms": text_ms, "disk_mb": m.disk_mb,
             "tokenizer_mismatches": mism, "retrieval": ev}
        out[key] = r
        print(f"  mAP {ev['mean']['ap']:.3f}  R-prec {ev['mean']['rprec']:.3f}  P@5 {ev['mean']['p5']:.3f} | "
              f"ORT CPU {img_s:.1f} img/s  text {text_ms:.0f}ms  {m.disk_mb:.0f}MB on disk")
    write_json(RESULTS / "onnx_check.json", out)


if __name__ == "__main__":
    main()
