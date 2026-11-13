"""Retrieval metrics against the hand-labeled ``queries.json`` ground truth."""
from __future__ import annotations

import json

import numpy as np

from bench.common import QUERIES


def load_queries() -> list[dict]:
    return json.loads(QUERIES.read_text(encoding="utf-8"))["queries"]


def score_ranking(order: list[int], relevant: set[int]) -> dict[str, float]:
    """order = image indices best-first. Returns P@5, R-precision, AP."""
    R = len(relevant)
    hits = [1 if i in relevant else 0 for i in order]
    p5 = sum(hits[:5]) / min(5, R) if R else 0.0     # capped so 3-relevant queries can hit 1.0
    rprec = sum(hits[:R]) / R if R else 0.0
    ap, h = 0.0, 0
    for rank, hit in enumerate(hits, 1):
        if hit:
            h += 1
            ap += h / rank
    return {"p5": min(p5, 1.0), "rprec": rprec, "ap": ap / R if R else 0.0}


def evaluate(scores: np.ndarray, queries: list[dict], top_k: int = 12) -> dict:
    """scores: [n_queries, n_images] similarity. Returns per-query + mean metrics."""
    per = []
    for qi, q in enumerate(queries):
        order = np.argsort(-scores[qi]).tolist()
        m = score_ranking(order, set(q["relevant"]))
        per.append({"q": q["q"], **m, "top": order[:top_k]})
    mean = {k: float(np.mean([p[k] for p in per])) for k in ("p5", "rprec", "ap")}
    return {"mean": mean, "per_query": per}
