# Semantic ("describe it") Photo Search — Implementation Handoff

This spec adds a **free-text "describe the photo" search** to the Search page. Typing
*"sunset over the city"* or *"red neon flying horse sign"* ranks photos by visual
similarity to the text.

The feature works with **SigLIP 2** image–text embeddings run through the **onnxruntime
the app already ships**. No torch, no network at query time, and nothing is ever
written to the media files.

> **Paths.** Python lives under `src/geotagger/` and web assets under
> `src/geotagger/web/`. Find code by the **function and symbol names** below, not by
> line numbers, because line numbers drift.

---

## 1. What we're building, and what we're not

**In scope (v1)**

- A one-time background **embedding pass** that stores one 768-d vector per photo.
  It is driven by the same client batch loop as face detection.
- The **SigLIP 2 model** (two ONNX files plus a tokenizer), downloaded once from the
  Data Management page. This is the same one-shot admin action as the InsightFace
  pack and the geodata downloads.
- `/api/search` gains a `text` param. When it's set, the existing filters (date, place,
  people, camera, folder…) narrow the candidates, and those candidates are then
  **ranked by similarity** and cut at a score threshold.
- **"More like this"** (photo → similar photos). It falls out of the same stored
  vectors at almost no extra cost, so it's included as step 5.7.

**Out of scope** (record these, don't build them; §9):

- Captioning with a VLM such as Florence-2 or Qwen3-VL. The benchmark shows it searches
  *worse* than embeddings at 10–40× the cost.
- Zero-shot auto-tags written anywhere, and any XMP or sidecar output. The
  embeddings are **DB-only**, like face data.
- GPU execution providers, `sqlite-vec` or ANN indexes, multilingual queries, and
  video keyframe sets.

---

## 2. Why SigLIP 2 B/16, and the evidence

The isolated prototype in `prototypes/vision_bench/` (own uv venv; see its
`README.md`) benchmarked 10 embedding models and 7 captioning models. The test set
was 218 photos from `E:\Pictures\07 - Texas Years\2026\2026-08`, scored against 24
hand-labeled queries (`prototypes/vision_bench/queries.json`). The interactive report
is `results/report.html`.

| approach | mAP | CPU speed | notes |
|---|---|---|---|
| **SigLIP 2 B/16-224, Immich ONNX on onnxruntime CPU** | **0.971** | **10.2 img/s**, 36 ms/query | **← ship this.** Exact tokenizer parity with open_clip |
| SigLIP 2 B/16-256 (torch) | 0.981 | 10.2 img/s | best overall, but has no ready ONNX export |
| SigLIP 2 B/32-256, Immich ONNX | 0.942 | 24.5 img/s | fallback if indexing speed matters more than quality |
| MobileCLIP2-S2 (torch) | 0.955 | 9.1 img/s | smallest at 99M params, but no ready ONNX |
| OpenAI CLIP B/32 (2021 baseline) | 0.897 | 30 img/s | |
| Best captioner: Qwen3-VL-4B captions + bge-small | 0.909 | GPU only, 4 s/img | 113 GPU-hours per 100k photos |
| Caption ⊕ SigLIP rank fusion | ≤0.971 | — | fusion never beat SigLIP alone |

**Budget for a 100k-photo library on CPU:** about 2.7 h for the one-time pass. Vectors
take about 150 MB as fp16 (or 300 MB as fp32). A query costs about 36 ms for the text
encode plus a few ms for the matmul.

**Known weak spots** (set user expectations): distant or small objects ("radio antenna
tower" scored 0.75), counting, negation ("no people"), and personal identity, which the
face pipeline already covers.

---

## 3. The model and how to run it

**Source:** `https://huggingface.co/immich-app/ViT-B-16-SigLIP2__webli` (Apache-2.0
weights). These are static ONNX exports maintained by Immich for exactly this use.
Download them with **stdlib `urllib`** from
`https://huggingface.co/immich-app/ViT-B-16-SigLIP2__webli/resolve/main/<file>`.
Don't add `huggingface_hub`.

| file | size | IO |
|---|---|---|
| `visual/model.onnx` | 354 MB | in `image` float32 `[1,3,224,224]` → out `embedding` `[1,768]` |
| `textual/model.onnx` | 1077 MB | in `text` **int32** `[1,64]` → out `embedding` `[1,768]` |
| `textual/tokenizer.json` | — | HF `tokenizers` format (Gemma SentencePiece, 256k vocab) |
| `visual/preprocess_cfg.json` | — | `{"size":[224,224],"mean":[.5,.5,.5],"std":[.5,.5,.5],"interpolation":"bicubic","resize_mode":"squash"}` |

The batch size is fixed at 1 because the export uses static shapes. That's fine: the
benchmark's 10 img/s was measured one image at a time.

**Image preprocessing** (the reference is `OnnxSiglip.preprocess` in
`prototypes/vision_bench/bench/onnx_check.py`):

1. Take the photo **upright**, using the cached display preview
   (`thumbnails.get_preview_oriented`). It's already decoded from RAW/HEIC and cached,
   so there's no second RAW decode.
2. `img.convert("RGB").resize((224, 224), Image.BICUBIC)`. This is a **squash**, not a
   center-crop.
3. `x = asarray(float32)/255; x = (x-0.5)/0.5; x = x.transpose(2,0,1)[None]`.
4. Run it, then L2-normalize the output.

**Text tokenization** (the reference is `canonicalize` and `OnnxSiglip.tokenize` in
the same file; verified to give **0 mismatches** against open_clip on all 24 queries):

1. Apply `canonicalize(text)`: replace `_` with a space, strip `string.punctuation`,
   lowercase, and collapse whitespace.
2. `tok = tokenizers.Tokenizer.from_file(...)`, then call `tok.no_padding()` and
   `tok.no_truncation()`. Take `ids = tok.encode(text).ids[:64]` (the tokenizer.json
   post-processor appends EOS), then right-pad with the `<pad>` id to 64 as int32.
3. Run it, then L2-normalize.

**New dependency:** `tokenizers` (`uv add tokenizers`, a small Rust wheel with no
torch). `onnxruntime`, `numpy` and `Pillow` are already dependencies.

**Memory:** the text session holds about 1 GB, mostly the 256k-token embedding table.
Load it **lazily on the first text query** and keep it resident. The visual session is
about 350 MB, and it should be released once the embedding pass finishes (see
`reset_model` in §5.2).

---

## 4. Conventions to follow (from CLAUDE.md; don't deviate)

- **Module singleton** shape: copy `faces.py` (`_model_dir`, `_app`, `_app_lock`,
  `init_faces`, `_get_app`, `model_status`, `ensure_model_downloaded`, `reset_model`).
- **Never block the event loop.** Encoding, matrix loads and downloads go through
  `loop.run_in_executor(get_executor(), …)`.
- **Config knobs** live in `config.py` as `GEOTAGGER_*` env vars. Anything
  user-tunable goes in `SETTINGS_SPEC`, and consumers read `config.KEY`.
- **Additive migrations** in `index.init_db()` using `CREATE TABLE IF NOT EXISTS` and
  `PRAGMA table_info` guards. Never assume a fresh DB.
- **Routes** go in a new `api/semantic.py` `APIRouter`, listed in `api/__init__.py`
  `ROUTERS`. Blocking logic goes in `services/semantic_service.py`, which must stay
  framework-free.
- **Batch work** uses the client loop: POST `{limit}`, read `remaining`, repeat. Copy
  `runFacesScan` in `home.js`.
- `# ── Section ──` separators, comments that explain *why*, type hints, and
  `logger` timing lines for the encode and search paths.

---

## 5. Implementation steps

### 5.1 Config (`config.py`)

```python
# ── Semantic (text → photo) search ──
SEMANTIC_MODEL_NAME = os.environ.get("GEOTAGGER_SEMANTIC_MODEL", "ViT-B-16-SigLIP2__webli")
SEMANTIC_MODEL_URL = os.environ.get(
    "GEOTAGGER_SEMANTIC_MODEL_URL",
    "https://huggingface.co/immich-app/{name}/resolve/main/")
SEMANTIC_PROVIDERS = [...]  # same parsing as FACE_PROVIDERS, default CUDA then CPU (onnxruntime-gpu)
```

Add a `SETTINGS_SPEC` entry for `SEMANTIC_MIN_SCORE` (float, default **0.09**, group
"Search", help text: *"Minimum text-match score. Lower = more results, more noise."*).

The default comes from the prototype's score distribution with the ONNX B/16 model:

| threshold | recall | irrelevant photos passing |
|---|---|---|
| 0.08 | 99% | 6.8% |
| 0.10 | 92% | 2.4% |
| 0.12 | 70% | 0.4% |

A value of 0.09 is a balanced start. Results are *ranked*, so the noise that gets
through lands at the bottom.

`SEMANTIC_MODEL_NAME` is also stored per vector (§5.3), so swapping to the B/32-256
export later is just a config change plus a re-index.

### 5.2 `geotagger/semantic.py` (new module)

This module is framework-free. Use local imports for `onnxruntime`, `tokenizers` and
`PIL`. Required pieces:

- `init_semantic(root)` resolves `<cache>/semantic/<SEMANTIC_MODEL_NAME>/`, mirroring
  `init_faces`.
- `model_status() -> dict` returns `{"available", "model_dir", "name", "size_mb"}`.
  "Available" means all four files from §3 are present.
- `download_model(force=False, progress_cb=None)` streams each file with `urllib` into
  a `.part` file and then does `os.replace`, so an interrupted download never looks
  complete. Use a 1 MB chunked read and report bytes for the progress UI.
- `_get_visual()` / `_get_textual()` are lazy, double-checked loads under separate
  `threading.Lock()`s. Text and image use never contend.
- `encode_image(img: Image.Image) -> np.ndarray` and `encode_text(text: str) ->
  np.ndarray` return L2-normalized float32 `(768,)` vectors. Hold the lock only around
  `session.run`.
- `reset_model()` drops both sessions. Use it on forced re-download, and drop the
  visual session after the indexing loop reports `remaining == 0`, to free about
  350 MB.
- `encode_vec` / `decode_vec` convert between **float16** bytes and float32 arrays.
  fp16 halves storage, and the prototype stored fp16 with no measurable quality loss.

### 5.3 DB (`index.py`)

Use a separate table rather than a column on `photos`. This keeps hot `photos` rows
small and lets a model swap coexist with old vectors until re-indexing finishes.

```sql
CREATE TABLE IF NOT EXISTS photo_embeddings (
    photo_id   INTEGER PRIMARY KEY,
    model      TEXT    NOT NULL,
    vec        BLOB,             -- fp16 × 768; NULL = tried and failed (don't retry forever)
    created_at REAL    NOT NULL
);
CREATE TRIGGER IF NOT EXISTS photo_embeddings_delete AFTER DELETE ON photos
BEGIN DELETE FROM photo_embeddings WHERE photo_id = OLD.id; END;
```

The trigger is needed because FKs are **not** enforced in this DB. It mirrors the
`photos_spatial_delete` trigger.

Helpers to add:

- `get_unembedded_photo_ids(model)`: the `photos` rows (`media_type` image *and*
  video, since the preview path handles video posters) with no `photo_embeddings` row
  for this model. Use `LEFT JOIN … WHERE e.photo_id IS NULL OR e.model != ?`.
- `store_embeddings(rows: list[tuple[int, bytes | None]], model)` uses `INSERT OR
  REPLACE` in one transaction per batch, then `db.commit()`.
- `load_embeddings(model) -> (ids: np.ndarray[int64], mat: np.ndarray[float32 N×768])`
  for the cache.
- `count_embeddings(model)`.

### 5.4 In-memory matrix cache (`semantic.py`)

For brute-force search, keep `(_gen, ids, mat)` module-global. Bump `_gen` in
`store_embeddings` and on photo deletion. The getter rebuilds the matrix when the
generation is stale, following the faces `_gallery_cache` pattern. At 100k photos the
matrix is 300 MB as float32. If that's a concern, keep it fp16 and upcast per query
chunk.

`rank(text_vec, candidate_ids | None) -> list[tuple[photo_id, score]]`:

1. Map the candidates to row indices with `np.searchsorted` on the sorted `ids`.
2. Compute `mat[idx] @ q`.
3. Filter by `config.SEMANTIC_MIN_SCORE` and sort descending.
4. Log timing in the house style.

### 5.5 Service (`services/semantic_service.py`)

- `embed_batch(photo_ids) -> {"processed", "errors"}`, modelled on
  `faces_service.scan_faces_batch`. For each id: get the preview bytes →
  `Image.open(BytesIO)` → `encode_image` → collect. On exception, store `vec=NULL`
  (marks it tried) and append the error. Write to the DB once per batch.
- `search_text(text, candidate_ids) -> list[(id, score)]` covers the text encode plus
  `rank`.
- `similar_to(photo_id, candidate_ids)` uses the stored vector as the query (§5.7).
- The model download job and its status mirror `_run_face_model_download`,
  `start_face_model_download` and `face_model_job_status` in `data_service.py`, with
  byte progress.

### 5.6 API (`api/semantic.py`, plus `/api/search` changes)

- `POST /api/semantic/scan {limit: int = 32}` returns `{processed, remaining, errors}`.
  If the model is missing, raise `HTTPException(409, "Semantic model not downloaded")`.
- `GET /api/semantic/status` returns `{model, available, embedded, total, remaining}`.
- `POST /api/data/semantic-model/download {force}` and its `GET …/status` go next to
  the face-model routes in `api/data.py`.
- In `/api/search` (`api/search.py::api_search`), add `text: str | None =
  Query(None, max_length=300)` and `sort` value `relevance`.
  - When `text` is set: call `index.search_photos(...)` with the other filters and
    `limit=20000` to get the candidate set. Then run `search_text` in the executor and
    reorder the rows by score.
  - Each photo dict gets a `score` (round to 3 dp). Apply the caller's `limit` *after*
    ranking.
  - The default sort becomes `relevance` whenever `text` is present.
  - If the model is unavailable or nothing is embedded yet, return 409 with a clear
    message. Don't silently return unranked results.
- `GET /api/photos/{id}/similar?limit=60` returns `{"photos": [...with score]}`.

### 5.7 "More like this"

The query is the photo's own stored vector, with the same `rank()` and no text
encoder. Image-to-image scores run much higher than text-to-image, so it has its
own threshold, `SEMANTIC_SIMILAR_MIN_SCORE`, default **0.8**. On the sample set the
median of *all* photo pairs is 0.64; 0.8 kept 83% of same-subject pairs while
passing 14% of all pairs. An initial guess of 0.5 matched nearly everything. It
also helps find burst near-duplicates.

### 5.8 Frontend

- **Home / Data Management.** Add a "Text search index" card that mirrors the faces
  card: model status, a Download button with byte progress (copy the face-model
  polling in `data.js`), an **"Index photos"** button running a `runSemanticScan()`
  loop (copy of `runFacesScan`, `limit: 32`, label `Indexing… N left`), and a Stop
  button.
- **Search page** (`search.html` / `search.js` / `search.css`):
  - Add a text input "Describe the photo…" at the top of the filter panel. Enter runs
    the search, and the input combines with all the other filters.
  - Add a "Relevance" option to the sort select, selected automatically when the text
    box is non-empty.
  - Optionally show each result's score as a small badge, behind a toggle. It helps
    users tune `SEMANTIC_MIN_SCORE`.
  - If status reports `remaining > 0`, show an inline hint: *"N photos not indexed
    yet — results are partial"*.
- **Photo viewer.** Add a "More like this" action that opens Search seeded with
  `similar_to=<id>`.
- Add a `SEMANTIC_MIN_SCORE` field on the Settings page; `SETTINGS_SPEC` renders it
  automatically.

### 5.9 Lifespan

Call `semantic.init_semantic(root)` next to `faces.init_faces(...)` in `lifespan.py`.
Don't load any model at startup.

---

## 6. Tests (`uv run pytest`)

The real model is 1.4 GB and must never be needed in CI. Monkeypatch
`semantic.encode_image` and `semantic.encode_text` with deterministic fakes, such as
hashing text into a fixed unit vector.

- `test_semantic.py`:
  - `canonicalize` cases (punctuation, case, underscores, whitespace).
  - fp16 round-trip of `encode_vec` / `decode_vec`.
  - `rank`: candidate filtering, threshold, ordering, and an empty candidate list.
  - The cache rebuilds after a generation bump.
- `test_index.py`:
  - The `photo_embeddings` migration on an *existing* DB without the table.
  - `get_unembedded_photo_ids` respects `model`.
  - The delete trigger removes the embedding.
  - A `vec=NULL` row is not retried.
- `tests/api/`:
  - `/api/semantic/scan` walks `remaining` down to 0 with the fake encoder.
  - `/api/search?text=…` with and without other filters returns `score` and is
    ordered.
  - 409 when the model is missing.
  - `/api/photos/{id}/similar`.
- Optional manual test with the real model, skipped unless `GEOTAGGER_SEMANTIC_E2E=1`:
  - Download the model and embed 5 fixture images.
  - Assert that "a photo of a flower" ranks the flower fixture first.

---

## 7. Acceptance checks (manual, after the tests pass)

1. Run on a random port (not 8000), download the model from Data Management, and
   index the `2026-08` sample folder. It should take about 25 s on CPU.
2. Search *"red neon flying horse sign"*: the Pegasus photos (prototype indices
   122/124/130–137) come first.
3. Search *"sunset"* combined with a date range and a people filter: the text ranking
   respects the other filters.
4. Use "More like this" on a lantana photo: the other lantana photos come back.
5. Delete a photo from the library: its `photo_embeddings` row is gone.
6. While searching, the UI and other API calls stay responsive, so the event loop
   isn't blocked.

---

## 8. Risks and notes

- **First text query cold start:** about 1–2 s to load the 1 GB text session.
  Optionally warm it in the background the first time the Search page opens.
- **Score scale:** SigLIP cosine values are small (relevant photos are around
  0.10–0.15). Don't show them as percentages.
- **Orientation:** embed the *upright* preview. CLIP-family models degrade on sideways
  images.
- **Model swap:** changing `SEMANTIC_MODEL_NAME` leaves old vectors in place. Those
  photos count as `remaining` until re-indexed, and search uses only the current
  model's rows.
- **Licensing:** the SigLIP 2 weights are Apache-2.0. The Immich ONNX repos carry the
  same license. Credit both in the README "Third-party" section.

---

## 9. Future work (backlog for IDEAS.md)

- **Zero-shot tags:** score each photo against a fixed vocabulary (≈40–200 labels) and
  expose them as facets. The prototype's `TAGS` list in `bench/run_embed.py` is a
  starting point.
- **Captions for display:** Florence-2-large (1.35 s/img on GPU, 11 s on CPU) or
  Qwen3-VL-4B (best wording and landmark names, GPU only). Captions should be for
  *display*, not for ranking.
- **Better recall on small objects:** SigLIP 2 SO400M or B/16-256, via our own ONNX
  export.
- **GPU or DirectML provider** through `SEMANTIC_PROVIDERS`, with batched visual
  inference after re-exporting the model with a dynamic batch dimension.
- **Multilingual queries:** SigLIP 2 is multilingual-trained, so check non-English
  queries before adding anything.
- **`sqlite-vec` or an ANN index:** only needed past about 1M photos.
