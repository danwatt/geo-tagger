# Face Negatives ("definitely not person A") — Implementation Handoff

A self-contained spec for adding **negative face labels** — a way for the user to
mark a specific detected face as *"this is not person A"* so the recognizer stops
suggesting A for that face. This is the false-positive-suppression feature.

> **Heads-up on paths.** Every Python module lives under `src/geotagger/` and the
> web assets under `src/geotagger/web/`. All references below use real, verified
> locations — but **anchor on function/symbol names, not line numbers** (they
> drift).

---

## 1. What we're building — and what we are *not*

**The problem.** InsightFace (the `buffalo_l` pack in `faces.py`) does detection +
512-d ArcFace embeddings only. It has **no concept of identity** — all "who is
this" logic is ours: cosine nearest-neighbour matching against a gallery of
user-confirmed faces (`faces.match_embedding` / `suggest_persons_batch` /
`suggest_for_person`). So there is no library feature for "not person A"; it's an
application-level relation we store and honor in *our* ranking.

**The feature.** A per-(face, person) **exclusion**. When the user rejects a
suggestion ("that's not Alice"), we record `(face_id → excludes Alice)`. From then
on, Alice is removed from that face's candidate ranking, so:

- Alice is never re-suggested for that face, and
- the face's *next-best* person (Bob) surfaces instead of the face bouncing back
  to Alice on every rescan.

**Why this is the right shape.** The highest-value case is the **look-alike family
member** — which the code already anticipates via the `alternatives` /
`FACE_AMBIGUITY_MARGIN` machinery in `suggest_for_person` (`faces.py`). A negative
is the natural "resolve this near-tie permanently" action.

**Explicitly out of scope for v1** (note them, don't build them):

- **No model retraining.** ArcFace is frozen; we can't move the embedding. We only
  edit the *ranking*, not the underlying cosine similarity.
- **No "hard negative" threshold learning.** A negative only *suppresses* a
  candidate; it does not raise/adjust `FACE_MATCH_THRESHOLD` or feed a
  discriminative margin. (Possible future work — §10.)
- **No sidecar/XMP export.** Face data is DB-only by design (see the
  `face-tagging-storage` memory note). Negatives are DB-only too.

### 1.1 How this differs from `ignored` (important — don't conflate)

The `faces` table already has a three-state model (`index.py`, `faces` table
comment): **labeled** (`person_id` set) / **ignored** (`ignored=1`) / **unlabeled**
(`person_id NULL AND ignored=0`). `ignored` means *"this box is junk — a
background stranger or a false detection — hide it from every queue."* It is a
property **of the face alone**.

A negative is **orthogonal**: the face is a real, valid face that *is* someone —
just **not this particular person**. It stays in the unlabeled queue and can still
be matched to everyone else. So a negative is **not a fourth state**; it's a
separate many-to-many relation `(face_id, person_id)` layered on top of the
existing three states. Do **not** try to encode it as an `ignored` variant.

---

## 2. Conventions this codebase uses (follow them)

Read these three patterns before writing code; the feature is "do what
`assign`/`ignore` already do, plus a `(face, person)` relation and a mask step in
the matcher."

### 2.1 DB schema + additive migration (`src/geotagger/index.py`)

- Tables are `CREATE TABLE IF NOT EXISTS` inside `init_db()`. The `faces` table
  block and its `PRAGMA table_info(...)` + `ALTER TABLE ADD COLUMN` migration
  guards are the model to copy.
- Indexes via `CREATE INDEX IF NOT EXISTS`.
- **FKs are NOT enforced** — `init_db` never sets `PRAGMA foreign_keys=ON`. So
  `ON DELETE CASCADE` will **not** fire. Clean up related rows explicitly (§3.2).
- The connection is a module global (`get_db()`), `row_factory = sqlite3.Row`,
  every mutating helper ends in `db.commit()`, parameterized queries only.

### 2.2 The generation counter is how caches stay correct

`faces.py` caches expensive structures keyed on `index.faces_generation()`:
`build_gallery` (labeled gallery), `get_unlabeled_matrix` (candidate embeddings),
`get_suggested_scores` (per-face scores). **Any** face/person mutation calls
`index.bump_faces_generation()` (see `assign_faces`, `set_faces_ignored`), which
forces the next read to rebuild.

**Rule for this feature:** adding or removing a negative **must call
`bump_faces_generation()`**. That's what makes the mask take effect — the next
suggestion fetch rebuilds the scores with the negative applied. Do **not** try to
be clever and prune caches in place (that's what `drop_from_unlabeled_cache` does
for *removals from the queue*; a negated face stays in the queue, so a plain
generation bump is the correct, simplest tool).

### 2.3 Never block the event loop; keep matching in the executor

Routes are thin and `await loop.run_in_executor(get_executor(), ...)` the blocking
matching work (see `api_list_faces` scope=`suggested`). New negative-write
endpoints are pure SQLite (fast) and can stay inline like `/api/faces/ignore`.

### 2.4 Tests exist (unlike older plans)

This repo **does** have a suite: `uv run pytest` over `tests/`. Relevant:
`tests/test_faces_math.py` (pure matcher math, with `tests/face_fixtures.py`
helpers to synthesize gallery/unknown embeddings), and `tests/api/` endpoint
smoke tests using the `client` fixture in `tests/conftest.py`. Add coverage in
both (see §8).

---

## 3. Data model (`src/geotagger/index.py`)

### 3.1 New table

Add inside `init_db()`, right after the `faces` table + its migration guards:

```sql
-- Negative labels: "face F is definitely NOT person P". Orthogonal to the
-- labeled/ignored/unlabeled state — the face stays in the queue and can still
-- match every OTHER person; P is just removed from F's candidate ranking.
CREATE TABLE IF NOT EXISTS face_negatives (
    face_id    INTEGER NOT NULL REFERENCES faces(id)   ON DELETE CASCADE,
    person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    PRIMARY KEY (face_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_face_negatives_person ON face_negatives(person_id);
```

The `PRIMARY KEY (face_id, person_id)` gives idempotent inserts (`INSERT OR
IGNORE`) and a fast lookup by face. `idx_face_negatives_person` supports the
person-delete cleanup and any "faces excluded from person P" query.

> **FK reminder:** cascade won't fire (§2.1). Clean up explicitly in §3.2.

### 3.2 Helpers to add (new `# ── Face negatives ──` section near the face helpers)

Mirror the shape of `assign_faces` / `set_faces_ignored` (bulk, `executemany`,
`commit()`, then `bump_faces_generation()`):

```python
def add_face_negatives(face_ids: list[int], person_id: int):
    """Record 'these faces are NOT person_id'. Idempotent. Also clears any
    existing (face, person_id) assignment-conflict is impossible here because a
    labeled face isn't in the review queue, but if the same face was somehow
    assigned to person_id, drop that assignment so state stays coherent."""
    if not face_ids:
        return
    db = get_db()
    now = time.time()
    db.executemany(
        "INSERT OR IGNORE INTO face_negatives (face_id, person_id, created_at) "
        "VALUES (?, ?, ?)",
        [(fid, person_id, now) for fid in face_ids],
    )
    db.commit()
    bump_faces_generation()   # invalidate gallery/score caches so the mask applies

def remove_face_negatives(face_ids: list[int], person_id: int):
    """Undo: allow person_id to be suggested for these faces again."""
    if not face_ids:
        return
    db = get_db()
    db.executemany(
        "DELETE FROM face_negatives WHERE face_id=? AND person_id=?",
        [(fid, person_id) for fid in face_ids],
    )
    db.commit()
    bump_faces_generation()

def get_all_face_negatives() -> dict[int, set[int]]:
    """face_id -> {excluded person_id, ...} for the WHOLE table.

    The table is tiny (only faces the user explicitly rejected), so one read is
    cheap and lets the matcher mask by column with a dict lookup. Cached in
    faces.py keyed on faces_generation() (see §4.1)."""
    out: dict[int, set[int]] = {}
    for r in get_db().execute("SELECT face_id, person_id FROM face_negatives"):
        out.setdefault(r["face_id"], set()).add(r["person_id"])
    return out

def get_negatives_for_face(face_id: int) -> list[int]:
    """Excluded person_ids for one face (for the per-photo endpoint / detail pane)."""
    return [r["person_id"] for r in get_db().execute(
        "SELECT person_id FROM face_negatives WHERE face_id=?", (face_id,))]
```

**Explicit cleanup (because FK cascade is off):**

- In `delete_person(person_id)` — add
  `db.execute("DELETE FROM face_negatives WHERE person_id=?", (person_id,))`
  before/after the existing delete (same transaction).
- In `replace_faces(...)` — this DELETEs and re-INSERTs `source='detected'` faces,
  minting **new** face ids, which would orphan negatives keyed on the old ids.
  Add `db.execute("DELETE FROM face_negatives WHERE face_id IN (...)")` for the
  captured `old_ids`, right where it already computes `old_ids` for the cache
  prune. **This is a known, accepted limitation, consistent with assignments:**
  `replace_faces`'s own docstring notes assignments "live by face id and are
  reapplied by the caller if it chooses to" — i.e. a rescan already discards
  per-face-id state. Rescan of already-scanned photos is rare (low-res RAW
  re-runs), so losing a negative on rescan is acceptable; just don't leave
  dangling rows. (A belt-and-suspenders `DELETE FROM face_negatives WHERE face_id
  NOT IN (SELECT id FROM faces)` sweep at startup in `init_db` is optional.)

- **Assignment coherence (optional, recommended):** in `assign_face` /
  `assign_faces`, when assigning a face to person P, also
  `DELETE FROM face_negatives WHERE face_id=? AND person_id=?` for P — so a face
  can't be simultaneously "assigned to Alice" and "not Alice" if the user changes
  their mind. Cheap; keeps the data honest. Leave *other* persons' negatives on
  that face intact (harmless once labeled; relevant only if later unassigned).

---

## 4. The matcher integration — the core of the feature (`src/geotagger/faces.py`)

Negatives are per-face; the matcher scores a `(P persons × u faces)` matrix per
chunk. Excluding person P for face F means **setting that one cell to `-inf`
before the per-person argmax/argsort**. Because negatives are sparse, we iterate
only over the few faces that actually have negatives — O(number of rejected
pairs), negligible.

### 4.1 Cache the negatives map (mirror `build_gallery`)

Add next to `_gallery_cache`:

```python
_negatives_cache: tuple[int, dict[int, set[int]]] | None = None

def get_negatives_map() -> dict[int, set[int]]:
    """Cached face_id -> {excluded person_id}, keyed on faces_generation()."""
    global _negatives_cache
    gen = index.faces_generation()
    if _negatives_cache is not None and _negatives_cache[0] == gen:
        return _negatives_cache[1]
    m = index.get_all_face_negatives()
    _negatives_cache = (gen, m)
    return m
```

Since every add/remove bumps the generation (§3.2), this stays correct with zero
extra invalidation plumbing.

### 4.2 A tiny masking helper

Add one helper that both batch paths call. It maps excluded `person_id` → the
gallery's group row via the existing `gallery._pid_to_group` dict and writes
`-inf` into `per_person[group_row, col]`:

```python
def _apply_negatives(per_person: np.ndarray, rows, c0: int,
                     gallery: "Gallery", neg_map: dict[int, set[int]]) -> None:
    """In-place: -inf out (person, face) cells the user marked as negatives.

    per_person is (P, chunk) for rows[c0 : c0+chunk]. Sparse: only faces present
    in neg_map do any work. Persons not in this gallery (no confirmed examples)
    simply have no group and are skipped."""
    if not neg_map:
        return
    for j in range(per_person.shape[1]):
        excl = neg_map.get(rows[c0 + j]["id"])
        if not excl:
            continue
        for pid in excl:
            g = gallery._pid_to_group.get(pid)
            if g is not None:
                per_person[g, j] = np.float32(-np.inf)
```

### 4.3 Wire it into the three ranking seams

All three already produce a `per_person` matrix (or a per-person score array)
right before choosing the best — insert the mask there. **Thread a `neg_map`
argument through** (default `None` → fetch via `get_negatives_map()` so existing
callers/tests keep working):

1. **`suggest_persons_batch(...)`** — in the chunk loop, after
   `per_person = _best_per_person_f32(...)` and **before** `per_person.argmax(...)`,
   call `_apply_negatives(per_person, rows, c0, gallery, neg_map)`. This covers the
   general unlabeled-scan suggestions and `get_suggested_scores` (the "approve all
   of one person's guesses" review) and the per-photo suggestion list.

2. **`_rank_from_matrix(...)`** — same insertion after `_best_per_person_f32`,
   before the `np.argsort(...)`. This covers the full per-face ranking, which is
   what surfaces `alternatives`. Masking here means once Alice is excluded, Bob
   correctly becomes the top rank and the face re-suggests Bob.
   ⚠️ **Caller note:** `_rank_from_matrix` receives `unknowns[cand]` / `times[cand]`
   (a *filtered* subset) in `suggest_for_person`. It must be given the matching
   subset of rows so `rows[c0+j]["id"]` lines up — pass `cand_rows` (see below),
   not the full `rows`.

3. **`suggest_for_person(rows, gallery, person_id, ...)`** — two touch-points:
   - The cheap **single-person gate** computes `best` (best score vs person_id's
     own examples) then `cand = best >= threshold`. **Before** thresholding, zero
     out faces that are negative *for this person_id*: for each `j` with
     `person_id in neg_map.get(rows[j]["id"], ())`, set `best[j] = -inf`. Those
     faces can never be a suggestion for this person, so drop them at the gate
     (cheapest possible place — they never reach the rank pass).
   - It then calls `_rank_from_matrix(unknowns[cand], times[cand], gallery, ...)`.
     Pass the negatives through and give it `cand_rows` so alternatives are also
     masked (a rejected alternative shouldn't reappear as an alternative).

4. **`match_embedding(vec, photo_datetime, gallery)`** (single face; used by
   `suggest_person` → `api_photo_faces`). It builds a `per_person` array for one
   face. Add an optional `exclude: set[int] | None = None` param; after computing
   `per_person`, set `per_person[gallery._pid_to_group[pid]] = -inf` for each
   `pid in exclude`. The per-photo route (`api_photo_faces`) passes
   `index.get_negatives_for_face(face_id)` as `exclude`.

**Do not** mask inside `_best_per_person_f32` itself — keep that function purely
about cosine+age math (it's the hottest loop and is unit-tested in isolation).
Masking belongs one layer up, at the ranking seams.

### 4.4 Caching interaction — the one subtlety

`get_suggested_scores` caches the full `(gen, scan_cap, scores)`. After an
accept/ignore, `drop_from_unlabeled_cache` prunes rows *and* re-tags the scores to
the current generation so the accept loop doesn't force a full matmul. **A
negative does not go through `drop_from_unlabeled_cache`** (the face stays in the
queue). Instead it bumps the generation, so the *next* `get_suggested_scores`
sees a stale gen and does a full rebuild — masked this time. That's correct and
matches how `assign`/`ignore` already invalidate. Just make sure the negative
write path calls `bump_faces_generation()` and does **not** call
`drop_from_unlabeled_cache`.

---

## 5. Backend API (`src/geotagger/api/faces.py`)

Add near `api_ignore_faces` (`/api/faces/ignore`), which is the closest template.
Request model beside the other inline models (`IgnoreFacesRequest` etc.):

```python
class NegativeFacesRequest(BaseModel):
    face_ids: list[int]
    person_id: int          # the person these faces are NOT
    negative: bool = True   # False removes the exclusion (undo)
```

```python
@router.post("/api/faces/negatives")
async def api_face_negatives(req: NegativeFacesRequest):
    """Mark faces as 'definitely not person_id' (negative=true), or lift that
    (negative=false). Removes person_id from these faces' recognition ranking so
    they stop being suggested as this person and fall through to their next-best
    match. Distinct from /ignore, which hides a face from every queue."""
    if not index.get_person(req.person_id):   # add get_person if not present
        raise HTTPException(404, "person not found")
    if req.negative:
        index.add_face_negatives(req.face_ids, req.person_id)
    else:
        index.remove_face_negatives(req.face_ids, req.person_id)
    return {"updated": len(req.face_ids), "person_id": req.person_id,
            "negative": req.negative}
```

Pure SQLite → fine to run inline (no executor), like `/api/faces/ignore`.

**Surface existing negatives so the UI can show/undo them:** in `api_photo_faces`
(the per-photo face list) include `"negatives": index.get_negatives_for_face(r["id"])`
per face, and pass that set as `exclude` into the `suggest_person` call
(§4.3.4) so the per-photo suggestion already respects it.

*(`index.get_person` may not exist yet — there are ad-hoc `SELECT name FROM persons
WHERE id=?` reads in this router. Add a small `get_person(person_id) -> Row | None`
helper mirroring `get_face`, or reuse an existing person lookup.)*

---

## 6. Frontend (`src/geotagger/web/people.js` + `people.css`)

The reject action should live everywhere a suggestion is shown. Three seams, in
priority order:

### 6.1 The right-click quick-action menu (primary, lowest effort)

`openFaceActions(anchor, face)` in `people.js` wraps `openQuickActions(...)`,
which lives in **`src/geotagger/web/face-grid.js`** (a shared page script, not
`people.js`). Its `opts` contract is documented in a JSDoc block above the
function: `onAssign` (required), `onAssignNew`, `onIgnore`, `onOpenPhoto`,
`showConfirm`. Buttons are plain `<button class="expand-btn">` (add
`danger` for destructive ones); a confirm button is rendered when
`face.suggestion && !face.person_name`. **Copy the `if (opts.onIgnore) {…}` block
as your template** — add a parallel `if (opts.onNotPerson && face.suggestion) {…}`
that renders a `⛔ Not <name>` button and extend the JSDoc contract. In
`people.js`'s `openFaceActions`, pass an `onNotPerson` callback that POSTs to
`/api/faces/negatives`:

```js
onNotPerson: async (personId, personName) => {
  try {
    const res = await fetch("/api/faces/negatives", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: [face.id], person_id: personId, negative: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Marked as not ${personName}.`);
    await loadFaces();     // refetch → generation bumped → next-best surfaces
  } catch (err) { setStatus("Failed: " + err.message, true); }
},
```

The `⛔ Not <name>` button in `openQuickActions` (`face-grid.js`, per above)
calls `opts.onNotPerson(face.suggestion.person_id, face.suggestion.person_name)`
whenever `face.suggestion` exists.

### 6.2 The suggestion chips (grid view — `makeSuggestChip` / `makeAltChip`)

These render the green "✓ Alice?" confirm chip and amber "→ Bob?" alt chips.
Add a small "✕" affordance on each that calls the same negatives POST for that
chip's person, instead of confirming. Rejecting the **primary** suggestion is the
common case ("no, not Alice"); rejecting an **alt** says "not Bob either." After
the POST, `loadFaces()` refetch re-ranks (Alice gone → Bob promoted).

### 6.3 The detail pane suggestion area (`showFaceDetail`, `#face-suggestion`)

Next to the **Confirm** button in the `sug-primary` block, add a **"Not
<name>"** button → negatives POST for `face.suggestion.person_id`. Do the same
for each alt button in `sug-alts`. Also render current negatives (from the new
`negatives` field / `get_negatives_for_face`) with an "undo" affordance
(`negative:false`) so a mistaken rejection is reversible.

### 6.4 The one-person bulk review (`scope=suggested`) — highest user value

`api_list_faces` scope=`suggested` powers "approve all of Alice's guesses." Here a
per-face **reject** ("not Alice") is the sharpest tool: it removes just the wrong
faces from Alice's suggestion set permanently, while Accept-all handles the rest.
Wire the same negatives POST (with the reviewed `person_id`) onto each face's
reject control in that view.

> In every case the pattern is: POST `/api/faces/negatives` → `await loadFaces()`.
> No optimistic DOM surgery needed — the generation bump + refetch reflows the
> suggestions (this is the established loop for confirm/ignore in `people.js`).

*(No new page/nav — this rides on the existing People UI. No `nav.js` change.)*

---

## 7. Build order

1. **Data + helpers** (`index.py`): `face_negatives` table + index;
   `add_face_negatives` / `remove_face_negatives` / `get_all_face_negatives` /
   `get_negatives_for_face`; explicit cleanup in `delete_person`, `replace_faces`,
   and (optional) `assign_face(s)`; `get_person` helper if missing.
2. **Matcher** (`faces.py`): `get_negatives_map` cache + `_apply_negatives`; thread
   `neg_map`/`exclude` through `suggest_persons_batch`, `_rank_from_matrix`,
   `suggest_for_person` (gate + rank), and `match_embedding`. **This is the
   feature** — verify with a unit test before touching the UI.
3. **API** (`api/faces.py`): `POST /api/faces/negatives`; add `negatives` to
   `api_photo_faces` and pass `exclude` into its suggestion call.
4. **Frontend** (`people.js`): the quick-action item (§6.1) first — smallest,
   covers everything — then the chips (§6.2), detail pane (§6.3), and the
   `scope=suggested` reject (§6.4).

Steps 1–2 are independently testable and deliver the core. 3–4 are the surface.

---

## 8. Tests

- **`tests/test_faces_math.py`** (extend, using `tests/face_fixtures.py`): build a
  small gallery with persons A and B whose examples are near-ties for a synthetic
  unknown. Assert `suggest_persons_batch` / `suggest_for_person` return A, then add
  `A` to the passed `neg_map` for that face and assert the result flips to B (or
  `None` if B is below threshold). Cover: gate-drop in `suggest_for_person`, alt
  masking in `_rank_from_matrix`, and the single-face `match_embedding(exclude=…)`.
  Keep it pure (no DB) by passing `neg_map` explicitly — that's why §4.3 makes it a
  parameter, not a hard `get_negatives_map()` call.
- **`tests/api/test_faces.py`** (exists — extend it, via the `client` fixture in
  `tests/conftest.py`): POST `/api/faces/negatives`
  `{negative:true}`, then GET the photo's faces and assert the previously-suggested
  person is gone from that face's `suggestion` and appears in its `negatives`; POST
  `{negative:false}` and assert it comes back. Assert `delete_person` removes the
  person's negative rows (no orphans).
- Run `uv run pytest`. For the UI, boot the app on a **non-8000** port
  (`uv run geotagger` binds `127.0.0.1:8000` by default) and exercise reject →
  confirm the next-best suggestion appears and survives a refetch.

---

## 9. Acceptance / manual verification checklist

- [ ] Rejecting a suggested face ("not Alice") makes Alice stop being suggested for
      that face — permanently, across refetch and across a **server restart** (it's
      in the DB), and across a **face rescan of a different photo** (generation-safe).
- [ ] After rejecting Alice on a near-tie face, the **next-best** person (Bob) now
      shows as the suggestion / top alternative instead of the face reverting to
      Alice.
- [ ] A negative is **face-scoped**: Alice is still suggested normally for *other*
      faces; and the rejected face is still matchable to *everyone except Alice*.
- [ ] Reject is **reversible** (undo → Alice can be suggested again).
- [ ] Rejecting is **not** ignoring: the face stays in the unlabeled queue and in
      counts; it is not hidden like an ignored face.
- [ ] `scope=suggested` bulk review: rejecting individual wrong faces removes just
      those from that person's guesses; Accept-all still works on the rest.
- [ ] Deleting a person removes their `face_negatives` rows (no orphan exclusions);
      rescanning a photo doesn't leave dangling negatives.
- [ ] `uv run pytest` green.

---

## 10. Future work (note, don't build)

- **Hard negatives → discrimination.** Today a negative only deletes a candidate.
  A stronger version would treat rejected examples as a per-person *negative
  gallery* and require the positive margin over the nearest negative to exceed a
  threshold — genuinely reducing look-alike false positives rather than just
  hiding one face. Bigger change to the scoring core; revisit if look-alikes stay
  noisy after v1.
- **Sidecar export.** Deferred with the rest of face data (`face-tagging-storage`
  memory note) — don't add XMP writes for negatives without checking that note.

---

## 11. Gotchas summary

- **InsightFace gives you nothing here** — negatives are pure app logic layered on
  our cosine matcher.
- **A negative is orthogonal to `ignored`** — a separate `(face, person)` relation,
  **not** a fourth face state. Don't overload `ignored`.
- **Bump the generation** on every add/remove (`bump_faces_generation()`); that's
  what makes the mask take effect. Do **not** call `drop_from_unlabeled_cache` —
  the face stays in the queue.
- **Mask at the ranking seams, not in `_best_per_person_f32`** — keep the hot math
  loop pure and separately testable.
- **Row/column alignment in `_rank_from_matrix`** — when `suggest_for_person`
  passes the *filtered* `unknowns[cand]`, pass `cand_rows` too so
  `rows[c0+j]["id"]` matches the right column.
- **FKs aren't enforced** — clean up `face_negatives` explicitly in
  `delete_person` and `replace_faces` (cascade won't fire).
- **Rescan mints new face ids** (`replace_faces` DELETE+INSERT) → negatives keyed
  on old ids are dropped, consistent with how assignments already behave. Accepted.
- **Config-live settings** (`FACE_MATCH_THRESHOLD`, `FACE_AMBIGUITY_MARGIN`) must be
  read as `config.KEY` (module attribute), never `from geotagger.config import KEY`
  — the `_cfg(value, "KEY")` idiom in `faces.py` already handles this; keep using it
  if you add any knob.
