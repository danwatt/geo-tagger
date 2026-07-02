# Face-recognition testing — status & Tier 2 plan

Handoff doc for testing the face-recognition math in `src/geotagger/faces.py`. Read
`CLAUDE.md` first for repo conventions. This covers **where we are (Tier 1, done)** and
**what's needed to add Tier 2 (frozen real embeddings)**.

## Background: what "the math" is

`faces.py` splits into two very different things with opposite testing needs:

- **Detection/embedding** (`detect_faces`, `detect_and_store`) — needs the InsightFace
  `buffalo_l` model (~275 MB download) + a real image. Untestable without the model, so
  it's treated like exiftool: an opt-in path that skips when the model isn't present. We
  trust the library here.
- **The recognition math** — `match_embedding`, `suggest_person(s_batch)`,
  `suggest_for_person`, `cluster_unlabeled`, the per-person max reductions, the age
  penalty/exclusion, and the thresholds. **This needs no model** — it's pure cosine
  geometry on 512-d L2-normalized vectors. This is the part we actually test, by
  *injecting* embeddings whose similarities we control.

### Two-tier strategy

1. **Tier 1 — synthetic embeddings with controlled geometry.** Manufacture unit vectors
   with known pairwise cosine (near-orthogonal = different people; tight clusters = same
   person). Ground truth is defined by us, so assertions are exact, deterministic, and
   fast. This is the bulk of the coverage. **← done.**
2. **Tier 2 — a small frozen fixture of *real* embeddings.** Generate embeddings once from
   real face images, commit the vectors, and assert realistic invariants against the
   **default thresholds**. This is the only thing that validates that 0.35 / 0.65 are
   actually right for genuine ArcFace output, and that real model output serializes
   correctly. **← this doc's task.**

## Where we are now (Tier 1 complete)

Added and verified (full suite: **158 passing**):

- **`tests/face_fixtures.py`** — the helpers:
  - Generators (pure numpy, no DB/model): `unit_vectors`, `cluster_around(intra_cos=…)`,
    `vec_at_cosine(target)` (exact-cosine, for threshold boundaries), `synthetic_population`.
  - DB seeding (through the real photo/person/face code paths, so `build_gallery`,
    `get_labeled_faces`, `get_unlabeled_matrix` see valid joined rows): `seed_person`,
    `seed_unlabeled`, `epoch(year)`, `reset_faces_caches`.
  - Everything routes through `faces.encode_embedding`, so the blob round-trip and the
    `(N, 512)` reshape in `_embeddings_matrix` stay under test.
- **`tests/test_faces_math.py`** — 6 demonstration tests: blob/matrix round-trip,
  clustering recovers pure identity groups, single + batch matching pick the right person,
  the 0.35 match-threshold boundary, and age exclusion (photo predating birth).
- **`tests/conftest.py`** — the `db` fixture teardown now nulls the three `faces` module
  caches (`_gallery_cache`, `_unlabeled_cache`, `_suggested_scores_cache`), which are
  generation-keyed globals that would otherwise leak a `Gallery` between tests.

**Tier 1's limitation (the reason Tier 2 exists):** synthetic vectors are calibrated to
whatever cosine we ask for, so they can confirm the *arithmetic* is correct but **cannot
tell us the thresholds are right** for real ArcFace output. If someone bumps
`FACE_MATCH_THRESHOLD` to 0.8, every Tier 1 test still passes but real matching breaks.
Tier 2 catches that.

## Tier 2 — what it will do

Load a committed `.npz` of real embeddings (no model at test time) and assert invariants
against the **default** thresholds in `config.py`:

- **Separation:** same-identity pairs score comfortably above `FACE_MATCH_THRESHOLD`
  (0.35); cross-identity pairs below. Report the actual margin so a threshold regression is
  visible.
- **Leave-one-out matching accuracy:** hold out each face, seed the rest as the gallery,
  and check `suggest_persons_batch` names the right person. Assert accuracy ≥ a target
  (e.g. ≥ 95%), not per-face exactness — real data has a hard case or two.
- **Clustering purity:** `cluster_unlabeled` at the default 0.65 recovers the identity
  groups (assert cluster *purity*, i.e. no cluster mixes two people; recovering exactly N
  clusters is a stretch goal, since real intra-person spread can fragment one person).
- **Serialization:** real 512-float32 blobs round-trip through `encode/decode_embedding`.
- **(Optional) age math on real data** — only if the image set includes the same person at
  clearly different ages plus a known birth date.

These run everywhere, fast, with no model — the fixture is committed *output*.

## What I need from you

### 1. The images (your offer works well)

Your idea of **20–30 curated images of several people is exactly right.** To make the
tests above meaningful, aim for:

- **≥ 3 distinct people**, **≥ 5 images each** (clustering's default `min_size` is 3, and
  leave-one-out matching needs ≥ 2 per person; 5–8 each gives headroom). 4–5 people ×
  5–7 images ≈ your 20–30.
- **One clear primary subject per image.** The generator takes the highest-`det_score`
  face per file, so group shots muddy the ground truth — prefer single-subject photos.
- **Some variety** (angle, lighting, expression, year). Variety is what stresses the
  thresholds; a set of near-duplicate frames would pass trivially and prove little.
- **Layout encodes the label** — one folder per person, folder name = identity:
  ```
  <somedir>/
    alice/   img01.jpg img02.jpg …
    bob/     …
    carol/   …
  ```
- **Optional stretch:** if 1–2 people have photos spanning clearly different ages, note
  their birth dates — that lets Tier 2 also exercise the age penalty/exclusion on real
  embeddings.

### 2. Two decisions (privacy + layout)

- **Commit images, or embeddings only?** These are real people's faces. I recommend
  **committing only the `.npz` of embeddings** (~2 KB/face, ~60 KB total) and keeping the
  source images in a **gitignored local dir** referenced by the manifest — so nothing
  identifiable lands in git history, but regeneration is still documented. If the repo is
  private *and* you also want to test `detect_faces` end-to-end reproducibly, we can commit
  a couple of images too. **Your call.**
- **Fixture location** — proposed `tests/fixtures/face_embeddings.npz`. Fine as-is?

## The steps (once you've got the images)

1. **You:** curate the images into the folder-per-person layout above; tell me the path
   and (if doing age tests) the birth dates.
2. **Me:** write `scripts/gen_face_fixtures.py` (mirrors `scripts/scan_faces.py`:
   `init_thumbs` + `init_faces` + `start_et`, then `faces.detect_faces` per image). It walks
   the tree, takes the top-scoring face per image, and writes the fixture below. Run once,
   locally, by you: `uv run python scripts/gen_face_fixtures.py <imagedir> --out tests/fixtures/face_embeddings.npz`
3. **You:** run that command once (needs the model — downloads on first use) and commit the
   resulting `.npz`.
4. **Me:** write `tests/test_faces_real.py` with the assertions in "What it will do" above,
   loading the fixture (no model, no `detect_faces` at test time).
5. Done: Tier 2 runs in normal CI alongside Tier 1.

### Fixture format (`.npz` + manifest)

- `embeddings` — `(N, 512)` float32, L2-normalized (as stored).
- `labels` — `(N,)` integer identity ids.
- `label_names` — id → person name.
- `det_scores`, `filenames` — per face, for debugging.
- Provenance in a sidecar `manifest.json`: `FACE_MODEL_NAME`, `FACE_DET_SIZE`,
  `FACE_DET_THRESHOLD`, `insightface` + `onnxruntime` versions, generation date, and the
  (local) source-image dir. This explains any future drift.

### Determinism caveat (why we freeze, not recompute)

Real ArcFace output shifts slightly across onnxruntime versions and CPU-vs-CUDA providers,
and isn't bit-reproducible. So Tier 2 **freezes** the vectors and asserts with `>=` /
tolerances / accuracy targets — never exact equality. The manifest records the versions the
fixture was built under so a mismatch is explainable rather than mysterious.

## Open questions for you

1. Commit images too, or embeddings-only? (privacy — recommend embeddings-only)
2. OK with `tests/fixtures/face_embeddings.npz`?
3. Include the age-math-on-real-data stretch goal? (needs same-person-different-age photos +
   birth dates)