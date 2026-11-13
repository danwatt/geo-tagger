# vision_bench — prototype

This prototype benchmarks local models for **searching photos by a text description**. It is isolated from the geotagger app:

- It has its own `uv` project and venv, with Python 3.12, torch built for CUDA 12.8, and transformers.
- Nothing in `src/geotagger` imports it.
- It never writes to the photo folder.

## Approaches compared

1. **Joint image–text embeddings (CLIP family).** Each photo is embedded once. A query's text is then embedded and ranked against the stored vectors by cosine similarity. These models also do zero-shot tagging from a fixed list of labels. Models tested: OpenAI CLIP B/32, MobileCLIP2 S2/B, SigLIP 2 B/SO400M, Meta PE-Core B/L, DFN L/14, jina-clip-v2, and nomic-embed-vision v1.5.
2. **Captioning VLMs.** Each model writes a 2–3 sentence description of each photo. The descriptions are then searched in three ways:
   - SQLite FTS5 keyword search (BM25)
   - semantic search over captions embedded with bge-small
   - a hybrid that fuses the semantic caption ranking with the best CLIP-family model

   Models tested: Florence-2 base/large, Moondream 2, SmolVLM2 2.2B, Qwen2.5-VL 3B, Qwen3-VL 4B, and Qwen3-VL 8B (NF4).

Quality is scored against a hand-labeled ground truth in `queries.json`: 24 queries over the sample folder, where `relevant` lists image indices in the `cache/manifest.json` order.

## Run

```bash
uv sync
uv run python -m bench.prep "E:\Pictures\07 - Texas Years\2026\2026-08"   # decode to cache/
uv run python -m bench.run_embed          # or: run_embed siglip2-b16-256 pe-core-b16
uv run python -m bench.run_caption        # slow: ~minutes per model on GPU
uv run python -m bench.eval_text          # caption search + hybrid scores
uv run python -m bench.report             # -> results/report.html
uv run python -m bench.onnx_check         # deployment path: Immich SigLIP 2 ONNX on onnxruntime CPU
```

`bench.onnx_check` validates the path the main app would actually ship: no torch, a `tokenizers`-based tokenizer checked for exact parity with open_clip, and PIL preprocessing. See `docs/SEMANTIC_SEARCH_PLAN.md`.

`bench.contact` writes numbered contact sheets to `cache/contact/`. Use them to re-label `queries.json` for a different folder.

Model weights go to the Hugging Face cache (`~/.cache/huggingface`), which takes about 40 GB for every model in the benchmark. Gemma 3 is not included because it is a gated repo and needs `huggingface-cli login`.

## Caveats

- CPU timings use torch in fp32. A production port would use ONNX on the app's existing onnxruntime, which is usually as fast or faster.
- GPU image throughput includes PIL preprocessing on the CPU, so the small models are CPU-bound.
- The sample has 218 photos and 24 queries, which is enough to rank the approaches but not to tell close scores apart.
