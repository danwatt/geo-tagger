# Face Recognition Performance Improvements

This document summarises every optimisation applied to the face-recognition
pipeline during the review session.  The primary target was
`GET /api/faces?scope=suggested&limit=1000&person_id=6`, which started at
**12.2 s cold / 5.5 s warm** and ended at **~0.7 s warm**.

---

## Baseline (before work began)

| Phase | Time |
|-------|------|
| `build_gallery` | 0.27 s |
| `get_unlabeled_matrix` | 1.43 s (cold) |
| `suggest_for_person` | **10.5 s** |
| **Total** | **12.2 s** |

Library state: 21 K labeled faces, 93 K unlabeled, 200 persons.

---

## Change 1 — Scan events no longer invalidate the unlabeled matrix cache

**File:** `src/geotagger/index.py` — `replace_faces()`

**Problem:** Every face-detection scan called `bump_faces_generation()`, which
invalidated both the gallery cache and the 93 K-face unlabeled embedding matrix.
The matrix takes ~1.4 s to rebuild from SQLite.  After a scan of even one photo,
the next suggestion request paid the full cold-start cost.

**Fix:** `replace_faces` now skips the generation bump.  Instead it calls
`faces.drop_from_unlabeled_cache(old_ids)`, which prunes only the replaced face
rows from the cached matrix in place (index update + numpy fancy-index removal).
Unrelated mutations (assign, ignore, unassign) still bump the generation and
trigger a full rebuild, as they always did.

**Saving:** eliminates the 1.4 s cold-start penalty after every scan pass.

---

## Change 2 — Float32 matmul + `reduceat` instead of float64 + Python loop

**File:** `src/geotagger/faces.py` — new `_best_per_person_f32()`

**Problem:** The old `_best_per_person()` function:
- Cast the gallery embedding matrix from float32 → float64 inside
  `_adjusted_cosines()`, doubling memory bandwidth.
- Reduced per-person scores with a Python loop over person groups: one
  fancy-index copy (~175 MB across 200 persons) plus one `.max()` call per
  person — ~200 Python iterations per chunk.

**Fix:** New `_best_per_person_f32()` stays float32 throughout and uses
`np.maximum.reduceat()` to reduce per-person in a single C call with no
intermediate copies.  Working set per chunk: **~700 MB → ~220 MB**.

**Saving:** `suggest=10.5 s → ~1.7 s` at the time of this change.

---

## Change 3 — `run_in_executor` moves numpy work off the async event loop

**File:** `src/geotagger/main.py` — `api_list_faces()` (scope=suggested)

**Problem:** `suggest_for_person` was called directly on the FastAPI event loop,
blocking all other requests for the full duration of the numpy computation.

**Fix:** Wrapped in `await loop.run_in_executor(_executor, lambda: ...)`.
The computation runs in a ThreadPoolExecutor thread; the event loop stays free.

---

## Change 4 — Pre-sorted gallery eliminates per-request sort overhead

**File:** `src/geotagger/faces.py` — `Gallery.__init__()`

**Problem:** The hot path re-derived per-person group boundaries on every call.

**Fix:** `Gallery.__init__` now pre-sorts embeddings by person_id (stable) and
stores:

| Field | Content | Size (21 K gallery) |
|-------|---------|---------------------|
| `_s_embs` | contiguous float32 embeddings, sorted by person_id | 44 MB |
| `_s_ft_yr` | face photo-times in float32 years | 85 KB |
| `_s_bt_yr` | person birth-times in float32 years | 85 KB |
| `_group_starts` | segment start indices for reduceat | ~1 KB |
| `_uniq_pids` | unique person IDs in sorted order | ~2 KB |

Sort and group-boundary computation happen once at gallery-build time; the hot
path just uses these pre-baked arrays.

---

## Change 5 — Gallery no longer stores duplicate embedding data

**File:** `src/geotagger/faces.py` — `Gallery.__init__()`

**Problem:** Gallery stored both the original unsorted `embeddings` array (44 MB)
and the sorted `_s_embs` copy (44 MB).  `person_ids`, `face_times`, and
`birth_times` were also held alongside their sorted counterparts.  None of the
originals were used after `__init__`; only `match_embedding` and the gate pass
in `suggest_for_person` still referenced them — both since replaced.

**Fix:** The originals are no longer stored as instance attributes.  `__init__`
processes the inputs and discards them.

**Saving:** ~44 MB RAM per gallery lifetime.

---

## Change 6 — `match_embedding` vectorised

**File:** `src/geotagger/faces.py` — `match_embedding()`

**Problem:** Photo-view face suggestions ran a 21 K-element Python dict-update
loop to reduce per-person scores:

```python
for pid, s in zip(gallery.person_ids.tolist(), adjusted.tolist()):
    if s > best.get(pid, -np.inf):
        best[pid] = s
```

Also cast to float64 via `.astype(np.float64)`.

**Fix:** `gallery._s_embs @ vec` (float32 matmul) followed by the same
slice-per-group `.max()` loop used elsewhere — no Python loop over 21 K rows,
no float64 allocation.

---

## Change 7 — `suggest_for_person` gate pass: no mask, no copy, no float64

**File:** `src/geotagger/faces.py` — `suggest_for_person()`

**Problem:** The single-person gate pass did three expensive things:

1. `gallery.person_ids == person_id` — boolean scan over 21 K elements.
2. `gallery.embeddings[sel]` — fancy-index copy of the person's K rows.
3. `_adjusted_cosines(emb, ft, bt, ...)` — upcasted to float64 internally.

**Fix:**

1. `gallery._pid_to_group.get(person_id)` — O(1) dict lookup.
2. `gallery._s_embs[p_start:p_end]` — contiguous slice, zero copy.
3. Inline float32 age math matching `_best_per_person_f32`.

---

## Change 8 — Gate examples capped at `FACE_GATE_MAX_EXAMPLES`

**File:** `src/geotagger/faces.py` — `suggest_for_person()`  
**Config:** `GEOTAGGER_FACE_GATE_MAX_EXAMPLES` (default 200)

**Problem:** Person 6 had 3 245 labeled examples.  The gate matmul
`(3245, 512) @ (512, 1024)` across 91 chunks cost **2.3 s** — as expensive as
the full-gallery rank pass.

**Root cause analysis:**

| K (examples) | Gate time (91 chunks) |
|--|--|
| 3 245 (uncapped) | 2.3 s |
| 200 (capped) | 0.13 s |

**Fix:** If the person has more than `FACE_GATE_MAX_EXAMPLES` labeled faces,
take `np.linspace(0, K-1, MAX, dtype=np.intp)` as evenly-spaced indices into
the pre-sorted slice.  This gives temporal diversity across the person's history.
False negatives (faces the sampled 200 miss but the full 3 245 would catch) are
rare and recoverable — the rank pass uses all gallery faces anyway.

**Saving:** Gate 2.3 s → 0.13 s.

---

## Change 9 — Gallery sorted so birth-dated persons form a contiguous prefix

**File:** `src/geotagger/faces.py` — `Gallery.__init__()`

**Problem:** Age-adjustment in the rank pass needed only the ~60% of gallery rows
that have a birth date.  These rows were scattered across the gallery (one group
per birth-dated person, interleaved with non-birth-dated persons).  Accessing
them via fancy index (`scores[cp_idx]`) caused scattered gather/scatter I/O.

**Fix:** Gallery sort key changed from `argsort(person_ids)` to
`lexsort((person_ids, ~has_birth_per_face))`.  Since birth dates are per-person
(uniform within each person's rows), this keeps every person's rows contiguous
while placing all birth-dated persons' faces in a leading prefix `[0 .. K_birth)`.

Age-adjustment now uses `scores[:K_birth]` — a **zero-copy view** of the
matmul output.  In-place operations on the view modify `scores` directly; no
extract copy, no scatter write-back.

Side effect: `_uniq_pids` is no longer globally sorted ascending, so
`np.searchsorted` was replaced with an O(1) `_pid_to_group` dict.

---

## Change 10 — `np.maximum.reduceat` replaced with per-group slice `.max()`

**File:** `src/geotagger/faces.py` — `_best_per_person_f32()` and `match_embedding()`

**Problem:** `np.maximum.reduceat(scores, starts, axis=0)` on a
`(21 658, 1024)` C-order (row-major) float32 matrix reduces along **axis 0**.
This requires reading one element per row for each of 1024 columns — a strided
access pattern that is maximally cache-unfriendly on a row-major layout.

Benchmark on the real library:

| Method | Time per chunk |
|--------|---------------|
| `np.maximum.reduceat` (axis=0) | **242 ms** |
| Python loop of `scores[s:e].max(axis=0)` | **4.7 ms** |
| `reduceat` on transposed matrix | 7.8 ms |

The slice loop wins because each `scores[s:e]` is a **contiguous block** in
memory; `.max(axis=0)` on it reads sequentially and benefits from SIMD.

**Fix:** Replaced `reduceat` with:

```python
per_person = np.empty((P, scores.shape[1]), dtype=np.float32)
for i in range(P):
    per_person[i] = scores[gs[i]:ge[i]].max(axis=0)
```

Group start/end lists (`_gs_list`, `_ge_list`) are pre-baked as Python lists in
`Gallery.__init__` so `.tolist()` is never called in the hot path.

**Saving:** 5 chunks × (242 − 5) ms = **1.2 s** per request.

---

## Change 11 — Batch argsort in `_rank_from_matrix`

**File:** `src/geotagger/faces.py` — `_rank_from_matrix()`

**Problem:** For each of N candidate faces, the inner loop called
`np.argsort(col)[::-1]` (sorting 252 person scores) and iterated over all 252
results with a Python list comprehension.  For 4 900 candidates: 4 900 argsort
calls + 4 900 × 252 = 1.2 M Python comparisons.  Inner loop cost: **1.06 s**.

**Fix:** One `np.argsort(per_person, axis=0)[::-1]` call per chunk sorts all
columns at once.  A `np.searchsorted(-col, -threshold)` call finds the
above-threshold cutoff without iterating over below-threshold persons.  The
result list is built only from the above-threshold slice (average 1.3 persons
per face).

**Saving:** Inner loop 1.06 s → **0.05 s**.

---

## Change 12 — SQLite page cache raised to 64 MB

**File:** `src/geotagger/index.py` — `init_db()`

```python
_db.execute("PRAGMA cache_size = -65536")   # 65 536 KB = 64 MB
```

**Problem:** SQLite's default page cache is 2 MB, far too small for a `faces`
table holding 93 K × 2 KB embedding blobs (≈ 186 MB).  Every cold-start read
of `get_unlabeled_matrix` or `get_labeled_faces` required repeated disk I/O for
the same pages.

**Saving:** Repeated reads of the same face rows (e.g. `build_gallery` called
on each suggestion-view load) now hit the in-process page cache.

---

## Change 13 — Removed dead code

**File:** `src/geotagger/faces.py`

Functions removed:

| Function | Why removed |
|----------|-------------|
| `_adjusted_cosines` | replaced by inline float32 math in gate pass |
| `_person_groups` | replaced by pre-sorted `_group_starts` |
| `_best_per_person` (old float64) | replaced by `_best_per_person_f32` |
| `rank_persons_batch` | never called from any live path |

~90 lines of dead code removed.

---

## Net result

| Metric | Before | After |
|--------|--------|-------|
| `suggest` (warm cache, person w/ 3 245 examples) | **5.5 s** | **0.68 s** |
| `suggest` (cold start, same person) | **12.2 s** | **~2.1 s** |
| Gallery RAM (21 K faces) | ~90 MB | **~46 MB** |
| Age-math intermediate arrays per chunk | 88.5 MB (21 K × 1024 × f32) | 54 MB (13 K × 1024 × f32), zero-copy view |
| Scan event impact on suggestion cache | full rebuild (~1.4 s) | in-place prune (~0 ms) |

---

## Key lessons

**Profile before optimising.** The first assumption (cache invalidation) was
correct but only partly explained the slowness.  Each round of profiling exposed
a different bottleneck, in this order:

1. Cache invalidation on every scan → fix generation bump
2. Float64 matmul + Python reduction loop → float32 + reduceat
3. Gate pass too large (K=3 245 examples) → cap at 200
4. `reduceat` on row-major axis-0 → 51× slower than slice-per-group `.max()`
5. Inner argsort loop → batch argsort + searchsorted

**Memory layout matters.** The single biggest per-chunk win (Change 10) came
from recognising that NumPy's `reduceat` on axis=0 of a row-major matrix is
pathologically cache-unfriendly.  Switching to a short Python loop of contiguous
row slices — which looks naive — was 51× faster.

**Pre-sort at build time, not query time.** Sorting the gallery once
(`Gallery.__init__`) and storing the result as pre-sorted contiguous arrays paid
dividends across the gate pass (contiguous slice), the age-math prefix (zero-copy
view), and the per-person reduction (contiguous slice `.max()`).
