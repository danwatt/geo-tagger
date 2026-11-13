"""Score search-over-captions against ground truth, plus caption+embedding hybrids.

For each caption model, three ways to search its captions:
  * fts5    — SQLite FTS5 BM25 keyword search (stdlib, what the app could do with zero deps)
  * semantic — captions embedded with a small text model (bge-small-en-v1.5, 33M params)
  * hybrid  — reciprocal-rank fusion of "semantic" with the best CLIP-family model

    uv run python -m bench.eval_text
"""
from __future__ import annotations

import json
import re
import sqlite3
import time

import numpy as np

from bench.common import RESULTS, load_manifest, write_json
from bench.metrics import evaluate, load_queries

TEXT_MODEL = "BAAI/bge-small-en-v1.5"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
STOP = {"a", "an", "the", "of", "on", "in", "with", "at", "and", "from", "up", "to", "very"}


def fts_scores(captions: list[str], queries: list[str]) -> np.ndarray:
    db = sqlite3.connect(":memory:")
    db.execute("CREATE VIRTUAL TABLE c USING fts5(body, tokenize='porter')")
    db.executemany("INSERT INTO c(rowid, body) VALUES (?, ?)", [(i, t) for i, t in enumerate(captions)])
    out = np.full((len(queries), len(captions)), -1e9, dtype=np.float32)
    for qi, q in enumerate(queries):
        words = [w for w in re.findall(r"[a-z0-9]+", q.lower()) if w not in STOP]
        if not words:
            continue
        match = " OR ".join(f'"{w}"' for w in words)
        for rowid, score in db.execute("SELECT rowid, bm25(c) FROM c WHERE c MATCH ?", (match,)):
            out[qi, rowid] = -score  # bm25() is lower-is-better
    return out


def rrf(*score_mats: np.ndarray, k: int = 60) -> np.ndarray:
    fused = np.zeros_like(score_mats[0])
    for s in score_mats:
        ranks = np.argsort(np.argsort(-s, axis=1), axis=1)
        fused += 1.0 / (k + ranks + 1)
    return fused


def main() -> None:
    from sentence_transformers import SentenceTransformer
    ids = [m["id"] for m in load_manifest()]
    queries = load_queries()
    qtexts = [q["q"] for q in queries]
    tm = SentenceTransformer(TEXT_MODEL, device="cuda")
    qv = tm.encode([QUERY_PREFIX + q for q in qtexts], normalize_embeddings=True)

    # Best embedding model by mAP, for the hybrid.
    best_emb, best_ap = None, -1.0
    for f in (RESULTS / "embed").glob("*.json"):
        r = json.loads(f.read_text(encoding="utf-8"))
        if "retrieval" in r and r["retrieval"]["mean"]["ap"] > best_ap:
            best_emb, best_ap = r["key"], r["retrieval"]["mean"]["ap"]
    emb_scores = None
    if best_emb:
        from bench.embedders import SPECS, Embedder
        spec = next(s for s in SPECS if s.key == best_emb)
        e = Embedder(spec, "cuda")
        emb_scores = e.encode_texts(qtexts) @ np.load(RESULTS / "embed" / f"{best_emb}.npy").astype(np.float32).T
        del e

    summary = {"text_model": TEXT_MODEL, "hybrid_with": best_emb, "models": {}}
    for f in sorted((RESULTS / "caption").glob("*.json")):
        r = json.loads(f.read_text(encoding="utf-8"))
        if "captions" not in r:
            continue
        caps = [r["captions"].get(i, "") for i in ids]
        t0 = time.perf_counter()
        cv = tm.encode(caps, normalize_embeddings=True, batch_size=64)
        embed_ms = (time.perf_counter() - t0) * 1000 / len(caps)
        sem = qv @ cv.T
        res = {"fts5": evaluate(fts_scores(caps, qtexts), queries),
               "semantic": evaluate(sem, queries),
               "caption_embed_ms_per_img": embed_ms}
        if emb_scores is not None:
            res["hybrid"] = evaluate(rrf(sem, emb_scores), queries)
        summary["models"][r["key"]] = res
        print(f"{r['key']:18s} " + "  ".join(
            f"{k} mAP {res[k]['mean']['ap']:.3f}" for k in ("fts5", "semantic", "hybrid") if k in res))
    write_json(RESULTS / "text_eval.json", summary)


if __name__ == "__main__":
    main()
