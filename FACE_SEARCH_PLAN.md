# Untagged-Face Search — Implementation Handoff

A self-contained spec for adding an **"Search for untagged faces"** action to the
Search page. When the user has put one or more people into the search
parameters, this feature discovers photos where those people **appear but are
not yet tagged** — using the same age-aware recognition machinery the People
page already relies on — and offers them for one-click confirmation, with links
into the People page for deeper review.

> **Heads-up on paths.** Every Python module lives under `src/geotagger/`, web
> assets under `src/geotagger/web/`. Line numbers drift; anchor on
> function/symbol names.

---

## 1. What we're building

The Search page (`web/search.html` + `search.js`) already answers *"find photos
containing these tagged people"* via `GET /api/search`
(`api/search.py` → `index.search_photos`). Those results only ever include
photos where each person has an **assigned** (tagged) face.

This feature adds the inverse: *"find photos where these people appear but a
face is still **untagged**"* — the photos the plain search **misses** because
recognition hasn't been confirmed yet.

The action only appears **when at least one person is in the search parameters**
(`selectedPersons.length >= 1`). Its behaviour depends on how many:

### Scenario A — one person selected ("discovery")

Exhaustively scan **every untagged face** in the (optionally date/location/geotag
filtered) set and surface any that are a near-match for the selected person `p`.
This is the same computation as the People page's *"suggested for person"* review
(`faces.suggest_for_person`), re-presented as a photo grid on the Search page.

Result: photos containing an untagged face that recognizes as `p`, excluding
photos where `p` is **already tagged** (those are already plain-search results).

### Scenario B — two or more people selected ("together, some/none tagged")

Find photos where the whole selected group `P = {p1, p2, …, pk}` appears
**together**, where each member is accounted for by a **distinct face** in the
photo that is either that member's **already-tagged** face **or** a **near-match
untagged face**. The photo may be fully untagged, partly tagged, or anything in
between — the only hard rule is *cover every searched person with a distinct
face*.

A face **covers** person `p` if either:

- it is a **tagged** (assigned, non-ignored) face of `p`, **or**
- it is an **untagged** face whose recognition score for `p` clears the match
  threshold.

Formal requirement for a photo to qualify:

- The photo must have **at least `k` faces** (you cannot cover `k` distinct
  people with fewer), and there must be a way to assign **each** person in `P` to
  a **distinct** covering face — a **perfect matching** in the bipartite graph
  *persons ↔ covering faces* (see §4.3). Each face is used for at most one person.
- **Exclude the fully-tagged case**: if the only perfect matching uses tagged
  faces exclusively (everyone in `P` is already tagged), the photo is a
  plain-search result, not a candidate here. A qualifying photo must have at
  least one person covered by an **untagged** face (something to confirm).

So for `A, B, C`: a photo with at least 3 faces where at least 3 of them are near
matches for `A`, `B`, and `C` respectively (some of those "near matches" may
instead be existing tags) — with the distinctness constraint that no single face
is credited to two people.

Result: photos where the group is together but incompletely tagged, each with a
proposed `untagged-face → person` assignment the user can confirm in one click
(plus the already-tagged members shown for context).

This is genuinely exhaustive: it scans photos with **no** tagged members too, not
just ones we already partly recognize. §4.3 bounds the cost by intersecting, per
searched person, the photos where they're coverable at all before running the
per-photo matching.

---

## 2. Conventions to follow (already in this codebase)

- **Routes are thin**, blocking work goes to the executor
  (`await loop.run_in_executor(get_executor(), fn, …)`). See every handler in
  `api/faces.py`. Pure DB+numpy scoring lives in a framework-free helper — put
  the new logic in `services/faces_service.py` (it may import `index`, `faces`,
  `serializers`; never FastAPI).
- **Recognition is already vectorized and cached.** Reuse, don't reinvent:
  - `faces.build_gallery()` — cached per-person confirmed-face matrix, age-aware,
    keyed on `index.faces_generation()`.
  - `faces.get_unlabeled_matrix()` — cached `(rows, embeddings, times)` for the
    whole unlabeled queue.
  - `faces.window_rows(rows, embeddings, times, start_ts, end_ts, photo_ids)` —
    filters that matrix to a photo-id set and/or time window (perfect for scoping
    to candidate photos).
  - `faces._best_per_person_f32(gallery, embs, times)` — returns a `(P, F)`
    float32 matrix of the **best age-adjusted cosine of each face `F` to each
    gallery person `P`**. This is the single primitive both scenarios need.
  - `gallery._pid_to_group[pid]` — row index of person `pid` in that `(P, F)`
    matrix (the gallery is **not** globally pid-sorted; always go through this map).
  - `faces.suggest_for_person(rows, gallery, person_id, unknowns=, times=)` —
    ready-made Scenario A (returns `(row, score, alternatives)` per candidate).
  - `faces.get_negatives_map()` — `face_id → {excluded person_id}` (user said
    "this face is NOT that person"); use it to drop edges/candidates.
  - Config threshold: `config.FACE_MATCH_THRESHOLD` (read as `config.KEY`, never
    `from config import`).
- **Serialization**: `serializers.face_item(row)`, `serializers.photo_to_dict(row)`,
  `serializers.person_name_map()`.
- **Frontend**: vanilla JS, `fetch` + `async/await`, grid rendering already
  exists in `search.js` (`renderGrid`, `makeThumbCell`, `faceGroupHeader` from
  `face-grid.js`). Face crops come from `GET /api/faces/{id}/crop`.

---

## 3. Backend — new endpoint

Add to `api/search.py` (same router):

```
GET /api/search/untagged-faces
    person_ids   : str   (comma-separated, required — 400 if empty)
    date_from    : str | None   (YYYY-MM-DD)   ]
    date_to      : str | None   (YYYY-MM-DD)   ] same base filters as /api/search
    bbox         : str | None                  ] (intersect the candidate photos
    location     : str | None                  ]  with this filtered photo set)
    geotagged    : str = "all"                 ]
    threshold    : float | None  (default config.FACE_MATCH_THRESHOLD)
    limit        : int = 500
```

Response:

```jsonc
{
  "mode": "single" | "together",
  "threshold": 0.42,
  "total": 137,           // qualifying photos found (pre-limit)
  "candidates": [
    {
      "photo": { …serializers.photo_to_dict… },
      "tagged":   [ {"person_id":3,"person_name":"Alice","face_id":900} ],   // already-tagged members shown for context; [] in single mode or a fully-untagged Scenario B photo
      "proposed": [ {"person_id":7,"person_name":"Bob","face_id":1201,
                     "score":0.55,"bbox":"…"} ]   // untagged near-matches to confirm
    }
  ]
}
```

Route body (thin — push the compute into a service call):

```python
@router.get("/api/search/untagged-faces")
async def api_search_untagged_faces(
    person_ids: str = Query(...),
    date_from: str | None = Query(None), date_to: str | None = Query(None),
    bbox: str | None = Query(None), location: str | None = Query(None),
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    threshold: float | None = Query(None, ge=0.0, le=1.0),
    limit: int = Query(500, ge=1, le=5000),
):
    pids = _parse_person_ids(person_ids)   # reuse the parse from api_search; 400 on bad input
    if not pids:
        raise HTTPException(400, "person_ids is required")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        get_executor(),
        faces_service.find_untagged_face_photos,
        pids, date_from, date_to, bbox, location, geotagged, threshold, limit,
    )
    return result
```

---

## 4. Algorithm (`services/faces_service.py`)

One entry point, branching on `len(pids)`.

```python
def find_untagged_face_photos(pids, date_from, date_to, bbox, location,
                              geotagged, threshold, limit) -> dict:
```

### 4.1 Shared setup

1. `threshold = config.FACE_MATCH_THRESHOLD if threshold is None else threshold`.
2. **Resolve the base filter to an allowed photo-id set.** Reuse the existing
   search with people removed so we honor date/location/geotag exactly like the
   plain search does:
   ```python
   allowed_rows = index.search_photos(
       date_from=date_from, date_to=date_to, bbox=bbox, location=location,
       person_ids=None, geotagged=geotagged, limit=10_000_000)
   allowed_ids = {r["id"] for r in allowed_rows}
   allowed_photo = {r["id"]: r for r in allowed_rows}   # reuse for photo_to_dict
   ```
   (If **no** base filters are set, `allowed_ids` is the whole library — Scenario
   A then equals the People page's full-library suggestion scan, which is the
   intended "exhaustive" behaviour.)
3. `gallery = faces.build_gallery()`. If a searched person has **no** confirmed
   examples, they have no entry in `gallery._pid_to_group` and cannot be matched
   by face — collect these into a `warnings: ["No examples for <name>; …"]` list
   and (Scenario A) return empty, (Scenario B) treat them as impossible-to-cover
   so any photo needing them fails. Surface `warnings` in the response.
4. `rows, unknowns, times = faces.get_unlabeled_matrix()` — the unlabeled queue.
5. `neg_map = faces.get_negatives_map()`.

### 4.2 Scenario A (single person, `mode="single"`)

Simplest correct implementation reuses the existing primitive verbatim:

```python
p = pids[0]
# scope the unlabeled matrix to the base-filtered photos
cand_rows, cand_embs, cand_times = faces.window_rows(
    rows, unknowns, times, None, None, allowed_ids)
scored = faces.suggest_for_person(cand_rows, gallery, p,
                                  unknowns=cand_embs, times=cand_times,
                                  threshold=threshold)   # [(row, score, alts)]
```

Then:

- Drop faces whose photo **already has `p` tagged** (they're plain-search hits).
  Precompute `already_tagged = index.photo_ids_with_tagged_person([p])` (§5) and
  skip `row["photo_id"] in already_tagged`.
- Group surviving faces by `photo_id`; one candidate per photo, `tagged=[]`,
  `proposed=[{person_id:p, face_id, score, bbox}]` (a photo may contribute more
  than one untagged face — keep all in `proposed`).
- Sort photos by best proposed score desc, take `limit`.

> Note: `suggest_for_person` already applies the negatives map, age exclusion,
> and the ambiguity-margin alternatives. Keep the `alternatives` if you want to
> warn "this face might instead be <look-alike>" in the UI.

### 4.3 Scenario B (two+ people, `mode="together"`)

There is **no tagged anchor** anymore — a photo with zero tagged members can
qualify if enough untagged faces near-match. So candidate discovery scores the
whole (base-filtered) unlabeled queue, then keeps only photos where **every**
searched person is coverable, before the per-photo matching verifies distinctness.

**Step 1 — score every base-filtered untagged face against the searched persons.**

```python
# Untagged faces inside the base-filtered photo set (the "exhaustive" scan).
u_rows, u_embs, u_times = faces.window_rows(rows, unknowns, times, None, None, allowed_ids)
per_person = faces._best_per_person_f32(gallery, u_embs, u_times)   # (P_all, F)
# Score row of each searched person (skip persons with no gallery group — they
# can only be covered by an already-tagged face, handled in Step 2's tagged set).
p_row = {pp: gallery._pid_to_group[pp] for pp in pids if pp in gallery._pid_to_group}

def uscore(face_j, pp):   # untagged face j's age-aware score for person pp
    r = p_row.get(pp)
    return per_person[r, face_j] if r is not None else float("-inf")
```

Apply negatives while iterating: if `pp in neg_map.get(u_rows[j]["id"], ())`,
treat `uscore(j, pp)` as `-inf` so it can never form an edge.

**Step 2 — tagged faces of the searched persons.** These are hard edges (a tagged
face of `pp` covers only `pp`):

```python
tagged_in = index.tagged_person_faces_in_photos(pids)   # §5
# -> {photo_id: [(person_id, face_id), ...]}  (searched persons only, ignored=0)
```

**Step 3 — candidate photos = every searched person coverable.** For each
searched person `pp`, the photos where `pp` is coverable is the union of:
its tagged photos (from `tagged_in`) and the photos of its untagged near-match
faces (`uscore(j, pp) >= threshold`). Candidate photos are the **intersection**
across all `pp` (necessary condition — the matching then confirms distinctness):

```python
coverable = {pp: set() for pp in pids}
for ph, tset in tagged_in.items():
    if ph in allowed_ids:
        for pp, _fid in tset:
            coverable[pp].add(ph)
for j, r in enumerate(u_rows):                 # untagged near-matches
    for pp in pids:
        if uscore(j, pp) >= threshold:
            coverable[pp].add(r["photo_id"])
candidate_photos = set.intersection(*coverable.values()) if pids else set()
```

Group the candidate photos' tagged faces (`tagged_in`) and untagged faces
(`u_rows` with their `score_vec` over `pids`) by `photo_id` for the next step.

**Step 4 — per-photo bipartite cover.** For each candidate photo build the graph
*persons `P` ↔ covering faces* and require a perfect matching of all `k` persons:

```python
faces_here = tagged faces (each -> its one person) + untagged faces (-> any pp
             with score >= threshold) in this photo, as distinct face nodes

# edges: person pp -> face f
#   tagged face of q:   edge only to q
#   untagged face j:    edge to every pp with uscore(j, pp) >= threshold
adj = { pp: [f for f in faces_here if covers(f, pp)] for pp in pids }

if len(faces_here) < len(pids):        # cannot cover k people with < k faces
    skip
matching = max_bipartite_matching(pids, faces_here, adj)   # Kuhn's, {person: face}
if len(matching) == len(pids):         # every searched person got a distinct face
    used_untagged = [pp for pp in pids if matching[pp] is an untagged face]
    if not used_untagged:
        skip     # everyone matched to a tagged face => plain-search result, nothing to confirm
    build candidate:
        tagged   = [{person_id, person_name, face_id}
                    for pp in pids if matching[pp] is a tagged face]
        proposed = [{person_id: pp, person_name, face_id: matching[pp],
                     score: uscore(matching[pp], pp), bbox}
                    for pp in used_untagged]
```

The `>= k faces` check is a cheap early-out; the matching is the real test. The
`used_untagged` guard is what excludes fully-tagged photos (the plain-search
results) — a qualifying photo must confirm at least one untagged face.

Counts here are tiny (single-digit persons and faces per photo), so a plain
**Kuhn's augmenting-path** matcher is more than enough:

```python
def max_bipartite_matching(left, right, adj):
    """left = searched persons, right = covering faces, adj[l] = eligible faces.
    Returns {left_node: right_node}. O(V*E) — fine for single-digit sizes."""
    match_face = {}           # face node -> person
    def try_assign(l, seen):
        for f in adj[l]:
            if f in seen:
                continue
            seen.add(f)
            if f not in match_face or try_assign(match_face[f], seen):
                match_face[f] = l
                return True
        return False
    for l in left:
        try_assign(l, set())
    return {l: f for f, l in match_face.items()}
```

> **Tie-breaking / quality.** Plain matching only guarantees *coverage*, not the
> highest-scoring assignment. Good enough for v1. If two people are look-alikes
> and could swap faces, prefer the higher-score assignment: order each `adj[m]`
> by score desc (greedy augmenting then tends to keep strong edges), or upgrade
> to a min-cost matching later. Note it, don't block on it.

**Step 5.** Sort qualifying photos (e.g. fewest untagged-to-confirm first, or
best proposed score), take `limit`, shape into the response with
`serializers.photo_to_dict` (reuse `allowed_photo[photo_id]`) and
`serializers.person_name_map()`.

### 4.4 Why this reuses, not duplicates

`_best_per_person_f32` already does the age-aware cosine (birth-date exclusion +
age penalty) for **all** persons in one matmul; selecting the searched-person
rows out of its `(P, F)` output is free and keeps the **cached full gallery**
warm. No sub-gallery construction, no second embedding decode.

---

## 5. New `index.py` helpers

Small, parameterized, `db.commit()` not needed (reads only). Follow the existing
query style (`sqlite3.Row`, `json_each` for id lists as in `search_photos`).

```python
def photo_ids_with_tagged_person(person_ids: list[int]) -> set[int]:
    """Photo ids that contain a tagged, non-ignored face of ANY of these persons."""
    ids_json = _json.dumps(person_ids)
    return {r[0] for r in get_db().execute(
        "SELECT DISTINCT photo_id FROM faces "
        "WHERE person_id IN (SELECT value FROM json_each(?)) AND ignored = 0",
        (ids_json,)).fetchall()}

def tagged_person_faces_in_photos(person_ids: list[int]) -> dict[int, list[tuple[int, int]]]:
    """{photo_id: [(person_id, face_id), ...]} for tagged, non-ignored faces of
    these persons. One row per (photo, person, face)."""
    ids_json = _json.dumps(person_ids)
    out: dict[int, list[tuple[int, int]]] = {}
    for r in get_db().execute(
        "SELECT photo_id, person_id, id FROM faces "
        "WHERE person_id IN (SELECT value FROM json_each(?)) AND ignored = 0",
        (ids_json,)).fetchall():
        out.setdefault(r["photo_id"], []).append((r["person_id"], r["id"]))
    return out
```

The untagged faces per candidate photo are obtained via
`faces.window_rows(..., photo_ids=cphoto_ids)` on the cached unlabeled matrix —
**no new query needed** (each row already carries `photo_id`, `bbox`, `id`,
`photo_datetime`). Only if profiling shows the full-library window is too broad,
add a targeted `get_unlabeled_faces_for_photos(photo_ids)` that joins
`face_embeddings` and filters `person_id IS NULL AND ignored=0 AND come_back=0`.

`json` is imported locally (`import json as _json`) inside these helpers, per the
project's local-import convention for `search_photos`.

---

## 6. Frontend (`web/search.html`, `search.js`, `search.css`)

### 6.1 Trigger

The "Search for untagged faces" control is shown only when
`selectedPersons.length >= 1`. Extend `updatePersonModeVisibility()` (already
toggles the together/any mode field) to also toggle a new button/field:

- **1 person**: button label `🔎 Find untagged faces of <name>`.
- **2+ people**: button label `🔎 Find where they appear together (untagged)`.

Add near the search actions in `search.html`:

```html
<div class="search-field search-field-untagged" id="untagged-field" style="display:none">
  <button id="untagged-btn">🔎 Find untagged faces</button>
</div>
```

### 6.2 Fetch + render

New `runUntaggedSearch()` mirrors `runSearch()`:

- Build the query from the **same** date/location/geotag inputs plus
  `person_ids` (reuse `buildQuery()`; it already emits those params — just call
  `/api/search/untagged-faces` instead and ignore `person_mode`).
- Render candidates into the existing grid, but each cell is a **candidate photo
  card**: the photo thumbnail plus a small strip of the **proposed** untagged
  face crops (`/api/faces/{face_id}/crop`), each labeled with the person name and
  score, and (Scenario B) a muted strip of the already-`tagged` people.
- Per card, a **Confirm** action calls `POST /api/faces/assign`
  (`{face_ids:[…], person_id:…}`, one call per proposed person, or the bulk
  endpoint) then removes the card. This is the existing assign endpoint — no new
  write path, and it bumps `faces_generation()` so caches refresh.
- Show `warnings` (people with no examples) in the status bar.

Reuse `renderGrid`'s year/month grouping and `faceGroupHeader` for consistency;
the cards can live in the same `#grid` with a mode flag so the timeline/histogram
code keeps working unchanged.

### 6.3 Link to the People page (the requested cross-link)

Each candidate — and each person chip — gets a link into the People page for
deeper review:

- **Scenario A**: `People — review suggestions for <name>` linking to the People
  page seeded to that person's **suggested** review (the People page already has
  `scope=suggested&person_id=…`; deep-link via a query param the People page
  reads on load, e.g. `people.html?person=<id>&review=suggested`). Confirm the
  exact param People page expects — check `web/people.js` for how it reads
  initial state; add a small `URLSearchParams` bootstrap there if absent.
- **Scenario B**: link each proposed person the same way, so the user can jump to
  that person's suggestion queue if a single photo's guess looks off.

If `people.js` has no deep-link bootstrap yet, adding one is a minor, isolated
change — read the top-level init in `people.js` and mirror how it currently
selects a person/scope.

---

## 7. Performance notes

- Scenario B now scans the whole base-filtered unlabeled queue (no tagged anchor),
  so the cost is one `_best_per_person_f32` matmul over those faces — same order as
  the People page's full suggestion scan, and it reuses the **warm cached** gallery
  + matrix. The `coverable`-intersection prune (Step 3) then cuts candidate photos
  to a small set before the per-photo matching, whose per-photo cost is trivial
  (single-digit persons × faces). Encourage a base date/location filter for very
  large libraries to keep the scanned face set bounded.
- The single expensive op is `_best_per_person_f32` over the windowed unlabeled
  faces; it's one chunked matmul. Scenario A with no base filter degenerates to
  the existing full-library `suggest_for_person`, whose cost is already accepted
  on the People page.
- Add a timing log in the service (`t0 = time.perf_counter(); … logger.info(...)`)
  matching the `scope=suggested` log in `api/faces.py`.
- Everything runs in the executor (never on the event loop), consistent with the
  face pipeline.

---

## 8. Edge cases

- **Searched person with zero confirmed examples** → cannot match by an untagged
  face (no gallery group). Scenario A returns empty for them; Scenario B can only
  cover them via an already-tagged face, so any photo lacking a tag for them
  fails. Surface as a `warnings` entry, not an error.
- **Fewer than `k` faces in the photo** (Scenario B) → cannot cover `k` distinct
  people; early-out skip before matching.
- **One untagged face near-matches two searched persons** → the distinctness of
  the bipartite matching forbids crediting it to both; the photo qualifies only
  if a *second* distinct face covers the other person. (This is exactly the
  "at least 3 faces near-matching A, B, C" rule for `k=3`.)
- **Face already marked "not this person"** (`neg_map`) → edge forced to `-inf`;
  never used.
- **Age exclusion** — a photo predating a person's birth date already scores
  `-inf` inside `_best_per_person_f32`; such faces silently don't match. Correct.
- **`come_back` faces** — the unlabeled matrix already excludes them
  (`list_faces("unlabeled")` filters `come_back=0`); they won't appear. Decide
  whether that's desired; if you want them included, that's a separate scope.
- **Photo where all searched persons already tagged** (Scenario B) → excluded by
  the `used_untagged` guard (the matching used only tagged faces → nothing to
  confirm → it's a plain-search result).
- **Undated photos** — age adjustment is skipped (NaN time), plain cosine used;
  they still match. No special handling.

---

## 9. Testing (`tests/`)

Add endpoint smoke tests using the `client` fixture + a seeded in-memory-ish DB
(follow existing face tests; see `FACE_TESTING_PLAN.md` and any
`tests/test_faces*.py`). Cover:

1. **Single, positive**: person `p` with examples; an untagged face in a filtered
   photo scoring above threshold → appears in `candidates`, `mode=="single"`,
   photos where `p` is already tagged are **excluded**.
2. **Single, no examples** → empty `candidates`, `warnings` non-empty.
3. **Together, partly tagged**: photo with `A` tagged and an untagged near-match
   for `B` → qualifies; `tagged` lists `A`, `proposed` lists `B` with its face.
4. **Together, fully untagged**: photo with `A, B, C` searched, **none** tagged,
   but three distinct untagged faces near-matching `A`, `B`, `C` respectively →
   **qualifies** (the new exhaustive case), `tagged` empty, `proposed` has all 3.
5. **Together, too few faces**: `A, B, C` searched, photo has only two untagged
   faces (even if both near-match) → **not** a candidate (< k faces).
6. **Together, distinctness**: `A, B, C` searched, one untagged face near-matches
   **both** `B` and `C` plus a face for `A` (only 2 faces total) → does **not**
   qualify; add a distinct near-match face so `B` and `C` map to different faces
   → qualifies.
7. **Together, fully tagged excluded**: photo where `A`, `B` are **both** already
   tagged → **not** a candidate (nothing untagged to confirm).
8. **Negatives respected**: mark the untagged face "not `B`" → no longer proposed.
9. **Base filter honored**: a qualifying photo outside the `date_from/date_to`
   window is excluded.

Unit-test the `max_bipartite_matching` helper directly (perfect vs impossible
covers, the "one face two people" case).

Run `uv run pytest`, then boot the app on a random non-8000 port and exercise
both flows in the browser (confirm crops render and the Confirm/assign round-trip
refreshes the queue).

---

## 10. Config knobs (optional)

The match threshold defaults to `config.FACE_MATCH_THRESHOLD`. If discovery wants
a looser bar than in-photo suggestion, add a dedicated knob to `config.py`
(`GEOTAGGER_FACE_SEARCH_THRESHOLD`, in `SETTINGS_SPEC` if runtime-tunable) and
default the endpoint's `threshold` to it. Not required for v1 — reuse
`FACE_MATCH_THRESHOLD` and expose the `threshold` query param for experimentation.

---

## 11. Build order

1. `index.py`: `photo_ids_with_tagged_person`, `tagged_person_faces_in_photos`
   (+ tests).
2. `services/faces_service.py`: `find_untagged_face_photos` with the
   `max_bipartite_matching` helper; Scenario A first (wraps `suggest_for_person`),
   then Scenario B.
3. `api/search.py`: the `/api/search/untagged-faces` route.
4. Endpoint tests (§9) — green before touching the frontend.
5. `search.html`/`search.js`/`search.css`: trigger, candidate cards, Confirm,
   People-page links.
6. People-page deep-link bootstrap in `people.js` if absent.
7. Manual browser pass.
</content>
</invoke>
