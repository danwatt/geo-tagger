# Life Contexts — Implementation Handoff

> **Status: removed (2026-07-30).** Life Contexts shipped, went unused, and
> was removed from the code and the database — the contexts /
> context_persons tables are dropped on DB open (index.init_db). This
> plan is kept as the spec to rebuild from if the feature ever comes back.

A self-contained spec for implementing the **Life Contexts** feature. You should
not need to read `IDEAS.md` to do this work, but it is the origin of the idea if
you want the original framing (see `IDEAS.md` → "Life Contexts").

> **Heads-up on paths.** `IDEAS.md` refers to `index.py`, `main.py`, `faces.py`,
> `config.py`, `app.js` as if they were top-level. They are **not** — every
> Python module lives under `src/geotagger/` and the web assets under
> `src/geotagger/web/`. All references below use the real, verified locations and
> line numbers (as of this writing — line numbers drift, so anchor on
> function/symbol names).

---

## 1. What we're building

A **Life Context** is a named **(polygon, optional date range)** pair describing
the *where* and *when* of a chapter of life (e.g. "City A, childhood
1985–1998", "City C, college 2003–2007"). Contexts narrow the search space for:

- **Geo-tagging** (phase 1, the high-value win): give an untagged photo a coarse
  location from *when* it was taken, even when no time-neighbor has GPS.
- **Face recognition** (phase 2, optional): softly boost people who were around
  during that chapter.

**The key asymmetry that drives the design:** an untagged photo has no GPS, so
**only its timestamp (`photos.photo_datetime`) can assign it to a context**. The
polygon is the spatial *answer* the context hands back, not a filter on the
input. For photos that already have GPS, both time and polygon can confirm
membership.

Contexts may overlap in space and time; a photo can match several at once — take
the **union**. "City A childhood" and "City A adulthood" are two separate rows,
each with its own polygon and range (self-contained is the simplest model).

---

## 2. Conventions this codebase uses (follow them)

Before writing code, internalize these three existing patterns. The whole
feature is "do what `places` + `persons` already do, plus a polygon and a date
range."

### 2.1 DB schema + additive migration (`src/geotagger/index.py`)

- All tables are created with `CREATE TABLE IF NOT EXISTS` inside `init_db()`
  (`src/geotagger/index.py:25`). The `places` table is the closest model
  (`index.py:85-93`); the `persons` table shows the FK + migration style
  (`index.py:106-118`).
- New columns on existing tables are added via the "check `PRAGMA table_info`,
  then `ALTER TABLE ADD COLUMN`" idiom (see `index.py:64-77` and `:114-118`).
  You are adding **new** tables, so you mostly just need the `CREATE TABLE IF NOT
  EXISTS` blocks — but if you later add a column to `contexts`, use that idiom.
- Indexes via `CREATE INDEX IF NOT EXISTS` (`index.py:147-155`).
- The connection is a module global (`get_db()`), `row_factory = sqlite3.Row`,
  and every mutating helper calls `db.commit()`. Mirror the existing
  `create_place` / `delete_place` / `update_place` helpers (`index.py:408-437`).
- **Date string → epoch conversion**: match `get_photos` exactly
  (`index.py:270-290`) so context ranges behave like the date filters users
  already know:
  - start: `int(datetime.strptime(d, "%Y-%m-%d").timestamp())`
  - end: `int(datetime.strptime(d, "%Y-%m-%d").timestamp()) + 86400` (inclusive
    of the whole end day)
  - ⚠️ Known nuance: `get_photos` uses local-time `.timestamp()` while
    `faces.py:_birth_ts` uses UTC `calendar.timegm`. They're inconsistent in the
    existing code. **Match `get_photos` (local `.timestamp()`)** here, because
    context ranges compare against `photos.photo_datetime` through the same UI
    the user uses for the month/date filters. Don't "fix" the inconsistency as
    part of this task.

### 2.2 API routes (`src/geotagger/main.py`)

- FastAPI app, routes grouped by feature with `# ── section ──` comment banners.
- The `/api/places` CRUD block (`main.py:716-754`) is the template for
  `/api/contexts`. The `/api/persons` block (`:833-911`) shows list-with-counts
  and the **partial-update via `model_fields_set`** pattern (`api_update_person`,
  `:843-864`) — use that for `PATCH /api/contexts/{id}` so callers can send only
  the fields they want to change.
- Pydantic request models are declared near the top (`:270-282`) or just above
  the routes that use them (`:746-748`, `:804-831`). Keep that style.
- **Important ordering constraint:** `app.mount("/", StaticFiles(...))` is the
  **last** statement in `main.py` (`:1213`) and serves `src/geotagger/web/` as
  the web root with `html=True`. All `/api/...` routes must be declared *before*
  that mount (they already are; just add yours in the API section). A new
  `contexts.html` placed in `web/` is automatically served at `/contexts.html`
  — no route needed.

### 2.3 Frontend = multi-page, one html/js/css trio per screen

There is no SPA framework and no build step. Each screen is a plain
`<name>.html` + `<name>.js` + `<name>.css`, all under `src/geotagger/web/`,
sharing `style.css`. Leaflet is loaded from a CDN, pinned to **1.9.4**
(`index.html:7,114`).

- The map screen (`app.js`) is the reference for: map/tile setup (`initMap`
  `app.js:116`, `BASEMAPS` `:35-61`, `setBasemap` `:155`, `addBasemapControl`
  `:173`), loading/rendering shapes from the API (`loadPlaces` `:334`,
  `renderPlaces` `:356`), creating a shape via POST (`app.js:594`), and the
  guess UI (`doGuess` `:1183`).
- Cross-screen nav is just `window.location.href = "/..."` wired in a
  `bindToolbar`-style function. See `app.js:192-199` and `people.js:39-49`. Each
  toolbar has the same button group; the current page's button gets
  `class="active"`. The back-to-map button id is `geocode-view-btn` and points
  to `/` (`people.js:39-41`).
- Person dropdowns are filled from `GET /api/persons` (`people.js:104`,
  options built like `loadPlaces` does for places `app.js:340-347`).

### 2.4 Testing reality

There is **no test suite** in this repo (no `tests/` dir, no pytest config).
Verification is manual via the running app:

```
uv run python -m geotagger --no-scan       # reuse existing index, skip re-scan
# then open http://127.0.0.1:8000/
```

Pure functions you add (`point_in_polygon`, the bbox/centroid helpers, the
date→ts conversion) are the easy things to sanity-check with a throwaway
`uv run python -c "..."`. Consider adding a tiny `tests/test_contexts.py` for
`point_in_polygon` and `contexts_for_time` if you want regression safety — it
would be the first test in the repo, so keep it dependency-light (`pytest` is
not currently a dependency; a plain `assert` script under `scripts/` is also
fine and matches existing precedent).

---

## 3. Data model (`src/geotagger/index.py`)

Add these inside `init_db()`, right after the `places` table block
(`index.py:85-93`). Polygon stored as a JSON array of `[lat, lng]` vertices;
range stored as epoch ints so it compares directly against
`photos.photo_datetime`; bbox cached so a lookup can prefilter cheaply before
the exact point-in-polygon test.

```sql
CREATE TABLE IF NOT EXISTS contexts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    polygon TEXT NOT NULL,          -- JSON array of [lat, lng] vertices
    start_ts INTEGER,               -- epoch secs, NULL = open start
    end_ts INTEGER,                 -- epoch secs, NULL = open end
    min_lat REAL, max_lat REAL,     -- cached polygon bbox for cheap prefilter
    min_lng REAL, max_lng REAL,
    created_at REAL NOT NULL
);

-- Phase 2 only (faces). Optional manual "cast" of people present in this chapter.
CREATE TABLE IF NOT EXISTS context_persons (
    context_id INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
    person_id  INTEGER NOT NULL REFERENCES persons(id)  ON DELETE CASCADE,
    PRIMARY KEY (context_id, person_id)
);
```

> **FK enforcement note:** SQLite does not enforce foreign keys unless
> `PRAGMA foreign_keys=ON` is set per-connection, and this codebase currently
> does **not** set it (check `init_db` — only `journal_mode` and `cache_size`
> pragmas are set, `index.py:41-44`). So `ON DELETE CASCADE` on
> `context_persons` will **not** fire automatically. Two options:
> 1. Add `_db.execute("PRAGMA foreign_keys=ON")` in `init_db` (cleanest, but
>    audit whether any existing code relies on FKs *not* cascading — the
>    `persons`/`families`/`faces` tables use `ON DELETE SET NULL`/`CASCADE` and
>    currently rely on app-level deletes, so turning this on is a behavior
>    change — verify before flipping it), **or**
> 2. Explicitly `DELETE FROM context_persons WHERE context_id=?` inside
>    `delete_context()` and skip relying on cascade. **Recommended** for a
>    contained change.

### 3.1 Helpers to add (same file, in a new `# ── Contexts ──` section near the
`# ── Places ──` section at `index.py:408`)

Mirror the `places` helpers' shape (`get_*`, `create_*`, `delete_*`,
`update_*`, each `commit()`-ing):

- `get_contexts() -> list[Row]` — all contexts, ordered by name. For the list
  endpoint you'll also want a photo count per context; doing point-in-polygon
  for a count on every list call is expensive, so compute counts lazily/only
  when asked, or approximate with the bbox + time range (a SQL `COUNT` over the
  spatial+time prefilter) and label it "approx". Decide based on UI need; a
  bbox-based approximate count is fine for v1 and is pure SQL.
- `create_context(name, polygon_json, start_ts, end_ts, bbox) -> int`
- `update_context(id, **fields)` — only update provided fields (parallels
  `set_person_*` granularity).
- `delete_context(id)` — also delete `context_persons` rows (see FK note).
- `get_context(id) -> Row | None`
- Cast (phase 2): `get_context_persons(context_id)`,
  `set_context_persons(context_id, person_ids)` (delete-then-insert).

### 3.2 Pure geometry/lookup helpers

Put these in `index.py` (they're DB-adjacent and used by both API and `faces`),
or a small new `src/geotagger/contexts.py` if you prefer to keep `index.py`
focused — either is acceptable; `index.py` already mixes SQL and small
computation. **Recommendation:** a new `src/geotagger/contexts.py` for the pure
math (`point_in_polygon`, `polygon_bbox`, `polygon_centroid`) and keep the
SQL CRUD in `index.py`, importing the math where needed.

```python
def point_in_polygon(lat: float, lng: float, verts: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon. verts is [[lat, lng], ...]. SQLite has no
    native PIP; at this scale (a handful of contexts, tens of thousands of
    photos) a Python test behind the bbox prefilter is plenty fast."""
    inside = False
    n = len(verts)
    j = n - 1
    for i in range(n):
        yi, xi = verts[i][0], verts[i][1]   # lat=y, lng=x
        yj, xj = verts[j][0], verts[j][1]
        if ((yi > lat) != (yj > lat)) and \
           (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def polygon_bbox(verts) -> tuple[float, float, float, float]:
    """-> (min_lat, max_lat, min_lng, max_lng)."""
    lats = [v[0] for v in verts]; lngs = [v[1] for v in verts]
    return min(lats), max(lats), min(lngs), max(lngs)


def polygon_centroid(verts) -> tuple[float, float]:
    """Area-weighted centroid (-> (lat, lng)). For the geotag-fallback pin.
    Falls back to the vertex mean for degenerate (zero-area) polygons."""
    # standard shoelace centroid; treat lng as x, lat as y
    ...
```

And two lookup helpers (in `index.py`, since they query the `contexts` table):

```python
def contexts_for_time(ts: int) -> list[Row]:
    """Contexts whose date range contains ts (NULL bound = open). Used for
    untagged photos — time is the only thing that can place them."""
    return get_db().execute(
        "SELECT * FROM contexts "
        "WHERE (start_ts IS NULL OR start_ts <= ?) "
        "  AND (end_ts   IS NULL OR end_ts   >= ?)",
        (ts, ts),
    ).fetchall()

def contexts_for_point_time(lat, lng, ts) -> list[Row]:
    """Contexts matching BOTH the time range AND containing the point (bbox
    prefilter, then exact point_in_polygon). Used for already-geotagged photos
    to confirm membership."""
    rows = contexts_for_time(ts)
    out = []
    for r in rows:
        if r["min_lat"] is not None and not (
            r["min_lat"] <= lat <= r["max_lat"] and r["min_lng"] <= lng <= r["max_lng"]
        ):
            continue
        if point_in_polygon(lat, lng, json.loads(r["polygon"])):
            out.append(r)
    return out
```

---

## 4. Backend CRUD API (`src/geotagger/main.py`)

Add a `# ── Contexts ──` section. Model it on `/api/places`
(`main.py:716-754`) and the `model_fields_set` update from `api_update_person`
(`:843-864`).

Request models (place near the other models or just above the routes):

```python
class CreateContextRequest(BaseModel):
    name: str
    polygon: list[list[float]]      # [[lat, lng], ...]
    start_date: str | None = None   # ISO YYYY-MM-DD, optional
    end_date: str | None = None
    person_ids: list[int] | None = None   # phase 2 manual cast

class UpdateContextRequest(BaseModel):
    name: str | None = None
    polygon: list[list[float]] | None = None
    start_date: str | None = None
    end_date: str | None = None
    person_ids: list[int] | None = None
```

Routes:

- `GET  /api/contexts` — list with `id, name, polygon (parsed), start_date,
  end_date, photo_count (or approx), persons (phase 2)`. Convert stored
  `start_ts/end_ts` back to `YYYY-MM-DD` for the UI (or also return the raw ts).
- `POST /api/contexts` — validate polygon has ≥3 vertices; convert
  `start_date/end_date` → ts (the `get_photos` way, §2.1); compute bbox via
  `polygon_bbox`; insert.
- `PATCH /api/contexts/{id}` — use `req.model_fields_set` so only sent fields
  change; recompute bbox if `polygon` changed; recompute `*_ts` if dates
  changed; replace cast if `person_ids` sent.
- `DELETE /api/contexts/{id}`.

Validation to enforce (return `HTTPException(400, ...)` like the persons routes):
polygon present and ≥3 points; each point a `[lat, lng]` with sane ranges
(`-90..90`, `-180..180`); date strings parse as `YYYY-MM-DD` (reuse the
`strptime` guard from `api_update_person` `:856-860`); `start_ts <= end_ts` when
both present.

---

## 5. Geo-tagging integration — the phase-1 win (`/api/guess`)

This is the highest-value piece. Today `/api/guess/{photo_id}`
(`main.py:659-698`) averages geotagged photos within ±`window` seconds and
**returns 404 when there are no time-neighbors** (`:682-683`). Fold contexts in
so that *every timestamped photo gets at least a coarse guess*.

**New algorithm (extend the existing endpoint, keep its response shape and add
fields):**

1. After loading the photo and its `ts` (existing code `:667-669`), look up
   `contexts = index.contexts_for_time(ts)`.
2. Run the existing time-neighbor query (`:672-680`).
3. **Constrain** (when both neighbors *and* contexts exist): if any neighbors
   fall inside the matched context polygon(s), average **only those** in-polygon
   neighbors (drops cross-trip contamination from a clock-skewed neighbor in a
   different city). Keep `source: "time-neighbors"`. If contexts exist but *no*
   neighbor is in-polygon, fall through to step 4 rather than averaging
   out-of-context neighbors.
4. **Fallback** (no neighbors, or none in-polygon, but a context matched):
   return the matched polygon's **centroid** (union of polygons → pick the
   smallest-area context's centroid, or the centroid of the union bbox; smallest
   polygon is the more specific answer) with `source: "context-centroid"` and a
   low/explicit confidence. **This is the coverage gain** — photos that get a
   404 today get a "somewhere in City A" the user can accept or refine.
5. Only return 404 if there are neither neighbors nor matching contexts.
6. Add to the response: `source` ("time-neighbors" | "context-centroid"),
   and `contexts: [{id, name, polygon}]` for the matched context(s) so the UI
   can show "in your *City C, college* context" and draw the polygon.

Response shape stays backward-compatible (existing keys `lat`, `lng`,
`source_count`, `window_sec`, `sources` remain; `source_count`/`sources` are
empty for a centroid result). Update the frontend `doGuess` (`app.js:1183`) to:
draw the matched polygon (a faint `L.polygon`, cleaned up in `dismissGuess`
`:1264`), and word the summary differently for a centroid guess ("No time
neighbors — center of your *City A* context"). The existing apply/dismiss flow
(`applyGuess` `:1257`, `dismissGuess` `:1264`) works unchanged since it just
uses `guessPending.{lat,lng}`.

> This also super-charges the backlog's **"bulk geotag by time"** queue (a
> separate idea): once every timestamped photo has at least a context-centroid
> guess, that queue can offer a guess for nearly everything.

---

## 6. Face soft-prior — phase 2 (optional, do after phase 1 ships)

Contexts narrow *people*, not embeddings, so make it a **soft additive score
bonus, never a hard filter** (preserve recall when someone appears in a new
chapter). The natural seam is the same per-person adjustment already done for
age in `match_embedding` (`faces.py:356-397`, the `scores` array) and
`_best_per_person_f32` (`faces.py:421-462`). Add a small additive bonus to the
cosine for persons in the photo's context cast, *before* the per-person max
reduction.

**Getting the cast — pick one (derived is recommended):**

- **Derived (zero data entry, recommended):** cast = persons who already have
  labeled faces in photos whose `photo_datetime` falls in the same context(s).
  Purely time-derived, self-reinforcing as you tag. Risk: broad if a range spans
  years → keep the bonus small. A query: persons with ≥1 labeled face whose
  photo time ∈ the matched context ranges.
- **Manual:** the `context_persons` table (§3), edited on the contexts screen.
  More precise, more upkeep. Can layer on top of the derived set.

**Config:** add `CONTEXT_PERSON_BONUS` to `src/geotagger/config.py` (cosine
units, default e.g. `0.03`), env-overridable exactly like the other face knobs
(see `FACE_AMBIGUITY_MARGIN` at `config.py:68` for the precise pattern:
`float(os.environ.get("GEOTAGGER_CONTEXT_PERSON_BONUS", "0.03"))`).

**Caching caveat:** `faces.py` caches the gallery and unlabeled matrices keyed on
`index.faces_generation()` (`faces.py:241-247`, `build_gallery` `:250`). A
context's cast affects suggestion *scores*, so either (a) thread the
photo-context cast into the suggestion call per-photo (cheap for the per-photo
endpoint `api_photo_faces` `main.py:1070`), or (b) if you bake the bonus into a
cached structure, call `index.bump_faces_generation()` when contexts/cast change
so the cache rebuilds. **(a) is simpler and lower-risk** — apply the bonus only
where a photo's context is known (the per-photo face list), not in the
library-wide unlabeled scan.

---

## 7. Contexts screen (`web/contexts.html` + `contexts.js` + `contexts.css`)

Follow the multi-page pattern (§2.3). A Leaflet map + a sidebar list of contexts.

- **Polygon drawing:** `app.js` hand-rolls only rectangle/circle drag
  (`startDrawing` near `app.js:594`). Vertex-by-vertex polygon editing is fiddly
  to hand-roll — pull in **Leaflet-Geoman** (free edition) or **Leaflet.draw**
  from a CDN for draw/edit/delete of polygons. Ensure the CDN version is
  compatible with **Leaflet 1.9.4** (the pinned version, `index.html:7`).
  Reuse the basemap/tile setup by copying the `BASEMAPS` object and
  `setBasemap`/`addBasemapControl` from `app.js:35-189` (or factor them into a
  shared `web/map-common.js` if you want to avoid duplication — optional, but
  there's currently no shared JS module, so copying matches existing precedent).
- **Sidebar list:** each context shows name, date range, vertex count, photo
  count (or approx), and edit/delete actions. Load via `GET /api/contexts`
  (mirror `loadPlaces` `app.js:334`).
- **Form:** name; start date; end date (both optional `<input type="date">`);
  draw/edit polygon; (phase 2) a people multi-select filled from
  `GET /api/persons` (mirror the person dropdown in `people.js:104` /
  `app.js:340-347`). Save via `POST`/`PATCH /api/contexts`.
- **Nav:** add a `🗺️ Contexts` button to the toolbar group on **every** page
  (`index.html:11-16`, `timesync.html:12-17`, `people.html:11-18`,
  `people-manage.html`, `tag.html`) and wire it like the others:
  `window.location.href = "/contexts.html"` (wiring lives in each page's
  toolbar-binding fn: `app.js:192`, `people.js:39`, and the equivalents in
  `timesync.js`, `people-manage.js`, `tag.js`). On `contexts.html` itself, give
  that button `class="active"` and include a `geocode-view-btn` back-link to `/`
  (same as `people.js:39-41`).

---

## 8. Optional: pre-build contexts from existing photos (script)

A convenience script (mirror `scripts/scan_faces.py`'s argparse + `--cache-dir`
bootstrapping, `scripts/scan_faces.py:1-40`) that infers candidate contexts from
already-geotagged photos: cluster geotagged photos over time, detect sudden
sustained shifts in location centroid (e.g. 2000–2010 mostly City A with
vacation outliers, then 2010–2020 mostly City B), and emit candidate contexts
(polygon ≈ convex hull or bbox of the cluster; range = the time span) for the
user to name/adjust in the UI. Handle gradual moves by splitting into distinct
regions. This is a *nice-to-have* — defer until the manual flow works. Pairs
naturally with the backlog's reverse-geocoding idea (auto-name a context "Paris"
from its centroid).

---

## 9. Build order

1. **Data + helpers:** `contexts` table, `point_in_polygon` / `polygon_bbox` /
   `polygon_centroid` / `contexts_for_time` / `contexts_for_point_time`, CRUD
   helpers in `index.py`. (Decide FK approach per §3.)
2. **CRUD API:** `/api/contexts` GET/POST/PATCH/DELETE.
3. **Contexts screen:** draw/list/edit/delete polygons with optional date range
   (Leaflet-Geoman). Wire the `🗺️ Contexts` nav button into every page.
4. **Geo-tagging integration** in `/api/guess` (constrain + centroid fallback)
   — **the highest-value step**; ship this before phase 2.
5. **Face soft-prior** (derived cast first; manual `context_persons` cast
   optional later) + `CONTEXT_PERSON_BONUS` config.

Phases 1–4 are independently shippable and deliver the main value. Phase 5
(faces) is additive and lower priority.

---

## 10. Acceptance / manual verification checklist

Run `uv run python -m geotagger --no-scan` and open `http://127.0.0.1:8000/`.

- [ ] Can create a context by drawing a polygon + entering a name and optional
      dates; it appears in the sidebar and persists across a server restart
      (it's in the DB).
- [ ] Edit (rename, redraw polygon, change dates) and delete work; deleting a
      context with a cast removes its `context_persons` rows (no orphans).
- [ ] `point_in_polygon` is correct for a known polygon (spot-check a point
      clearly inside and one clearly outside, incl. a concave shape).
- [ ] `GET /api/guess/{id}` for an untagged photo **with no time-neighbors** but
      a matching context now returns a `context-centroid` guess instead of 404;
      the UI draws the polygon and the centroid pin; Apply geotags the photo.
- [ ] For an untagged photo **with** time-neighbors, an out-of-context
      (clock-skewed, different-city) neighbor no longer drags the average when a
      context constrains it (`source: "time-neighbors"`, in-polygon only).
- [ ] A photo with neither neighbors nor a matching context still returns 404
      (no regression).
- [ ] The `🗺️ Contexts` button appears and navigates correctly from every page,
      and the contexts page links back to the map.
- [ ] (Phase 2) A person in a photo's context cast gets a small suggestion bump
      but is never the *only* candidate considered (recall preserved); changing
      a cast / context bumps `faces_generation` if you cached the bonus.

---

## 11. Config additions (`src/geotagger/config.py`)

```python
# ── Life contexts ──
# Phase 2 (faces): additive cosine bonus for a person in the photo's context
# cast. Soft prior only — never a hard filter. Env-overridable like the other
# face knobs (cf. FACE_AMBIGUITY_MARGIN, config.py:68).
CONTEXT_PERSON_BONUS = float(os.environ.get("GEOTAGGER_CONTEXT_PERSON_BONUS", "0.03"))
```

---

## 12. Gotchas summary

- **Real paths are under `src/geotagger/`**, not the repo root. Web assets under
  `src/geotagger/web/`.
- **`StaticFiles` mount must stay last** in `main.py` (`:1213`); add API routes
  above it. New `web/*.html` files are auto-served at `/<name>.html`.
- **FKs aren't enforced** (no `PRAGMA foreign_keys=ON`) — don't rely on cascade;
  delete `context_persons` explicitly (§3).
- **Date→ts conversion**: copy `get_photos` (local `.timestamp()`, end+86400)
  for UI consistency; don't introduce a third timezone convention.
- **Leaflet is pinned to 1.9.4** — pick a compatible Geoman/Leaflet.draw build.
- **Face caches are generation-keyed** — if a context/cast change must affect
  cached suggestion scores, call `index.bump_faces_generation()`; otherwise
  apply the bonus per-photo where the context is known (preferred).
- **No existing tests** — verify manually via the running app; add a tiny test
  for the pure geometry helpers if you want a safety net (it'd be the repo's
  first test).
