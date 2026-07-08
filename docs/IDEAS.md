# Ideas / Backlog

Parked ideas for geo-tagger, to revisit later.

## Bug Fixes
* Image rotation issues. 20190724-IMG_1696.HEIC, 20190724-IMG_1706.HEIC, _20100508_170224__D301202.NEF
* Starting to get a lot of false positives

## Consistency
* Groups with date range and locations

## Narrow the face detection to time/space

Use contexts?
Use a date range picker?


## Life Contexts

Add the concept of a **Life Context** to the app. A context is the *where* and *when* of a
chapter of life: you start out in City A, move to City B for high school, go away to college in
City C, move back to City A for ten years, then move to City D. The goal is to narrow the search
space for both **geo-tagging** (where was this untagged photo taken?) and **face recognition**
(who is likely in it?).

### Refined definition

A **Life Context** is a named pair of **(polygon, optional date range)**:

- **Polygon** — the geographic area (the *where*). Required.
- **Date range** — `start_date` and/or `end_date`, both optional. Either bound can be open
  (`City D, 2020–present`). Photos with no timestamp match only the range-less part of the logic
  (see below).
- Contexts may **overlap** in space and in time. A photo can belong to several at once — that's
  fine; we take the **union** of the matched contexts.
- City A's childhood and City A's adulthood are **two separate context rows** (each with its own
  polygon drawn on the map). Keeping each context self-contained — its own polygon, range, and
  optional cast — is the simplest model and matches the mental picture. (A future normalization
  could let two contexts share one named polygon; not needed for v1.)

**The key asymmetry** that drives the implementation: a not-yet-located photo has no GPS, so
**time is the only thing that can assign it to a context** (its `photo_datetime` falls inside the
range). The polygon is then the spatial **answer/prior** the context hands back — not a filter on
the input. For photos that *are* already geotagged, both time and polygon can be used to confirm
membership.

### Data model (`index.py`, mirrors the `places` table at line 86)

```sql
CREATE TABLE contexts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    polygon TEXT NOT NULL,          -- JSON array of [lat, lng] vertices
    start_ts INTEGER,               -- epoch secs, NULL = open start
    end_ts INTEGER,                 -- epoch secs, NULL = open end
    min_lat REAL, max_lat REAL,     -- cached polygon bbox for cheap prefilter
    min_lng REAL, max_lng REAL,
    created_at REAL NOT NULL
);
-- Optional "cast" of people present during this context (phase 2, faces):
CREATE TABLE context_persons (
    context_id INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
    person_id  INTEGER NOT NULL REFERENCES persons(id)  ON DELETE CASCADE,
    PRIMARY KEY (context_id, person_id)
);
```

Store the date range as epoch ints (`start_ts`/`end_ts`) so it compares directly against
`photos.photo_datetime`; accept ISO `YYYY-MM-DD` from the UI and convert on write (the same
pattern `get_photos` already uses, `index.py:270`). Cache the polygon's bbox so a context lookup
can prefilter on min/max before running the exact point-in-polygon test.

Add a small ray-casting helper (`point_in_polygon(lat, lng, verts) -> bool`) — SQLite has no
native PIP, but at this scale (a handful of contexts, tens of thousands of photos) a Python test
behind the bbox prefilter is plenty fast. Helper to add: `contexts_for_time(ts)` and
`contexts_for_point_time(lat, lng, ts)`.

### Backend API (`main.py`, mirrors the `/api/places` routes at line 716)

- `GET /api/contexts` — list (with photo count and cast, like `/api/persons`).
- `POST /api/contexts` — `{name, polygon, start_date?, end_date?}`; computes bbox + `*_ts`.
- `PATCH /api/contexts/{id}` — update name/polygon/range/cast (model-fields-set pattern, like
  `api_update_person` at line 843).
- `DELETE /api/contexts/{id}`.

### Pre-building contexts

If possible, a script to build the contexts from the existing photos. This can be done by clustering photos,
and looking for sudden changes in locations. For example, if most photos for 2000-2010 are in city A (with
occasional photos outside the region due to vacation travel), and then suddenly most photos for 2010-2020 are in city B, we can
create two contexts: one for city A, and one for city B. The script should be able to handle cases where
the change in location is gradual, and create contexts for each distinct region.

### Geo-tagging use (the concrete phase-1 win — extend `/api/guess`, `main.py:659`)

Today `/api/guess` only averages geotagged photos within ±window and **returns 404 when there are
no time-neighbors**. Fold contexts in:

1. Look up the photo's contexts by `photo_datetime` (`contexts_for_time`).
2. **Constrain** the time-neighbor average: if any neighbors fall inside the matched context
   polygon(s), average only those (drops cross-trip contamination from a clock-skewed neighbor in
   a different city). Tag the result `source: "time-neighbors"`.
3. **Fallback** when there are *no* (in-polygon) neighbors: return the matched polygon's centroid
   with `source: "context-centroid"` and low confidence. This is the big coverage gain — photos
   that can't be guessed at all today get a coarse "somewhere in City A" the user can accept or
   refine.
4. Return which context(s) matched so the UI can show "in your *City C, college* context" and draw
   the polygon. A `bulk geotag-by-time` queue (already a backlog item below) becomes far stronger
   once every timestamped photo has at least a context-centroid guess.

### Face use (phase 2 — soft prior in `faces.py`)

Contexts narrow *people*, not embeddings, so make it a **soft score bonus**, never a hard filter
(preserve recall when someone genuinely appears in a new chapter). The natural seam is the same
per-person adjustment already done for age in `match_embedding` (`faces.py:356`) and
`_best_per_person_f32` (`faces.py:421`): add a small additive bonus to the cosine for persons in
the photo's context cast.

Two ways to get the cast, pick one:

- **Derived (recommended, zero data entry):** the cast = persons who already have labeled faces in
  photos whose `photo_datetime` falls in the same context(s). Purely time-derived, needs no GPS and
  no manual list; self-reinforcing as you tag. Risk: broad if a range spans years — keep the bonus
  small.
- **Manual:** the `context_persons` table above, edited on the contexts screen. More precise, more
  upkeep. Can layer on top of the derived set.

Config: `CONTEXT_PERSON_BONUS` (cosine units, e.g. `0.03`), env-overridable like the other face
knobs in `config.py`.

### Screen (`contexts.html` / `contexts.js` / `contexts.css`)

Follow the existing multi-page pattern (`people.html`, `timesync.html`): a Leaflet map plus a
sidebar list of contexts (name, date range, vertex/photo count, edit/delete).

- **Polygon drawing:** the current code hand-rolls rectangle/circle drag (`app.js` ~line 500).
  Vertex-by-vertex polygon editing is fiddly to hand-roll — pull in **Leaflet-Geoman**
  (or Leaflet.draw) from a CDN for draw/edit/delete of polygons. Reuse the basemap/tile setup
  from `app.js`.
- **Form:** name, start date, end date (both optional), draw/edit polygon; optional people
  multi-select for the manual cast.
- **Nav:** add a `🗺️ Contexts` toolbar button to each page's toolbar and wire
  `window.location.href = "/contexts.html"` (same as the other view buttons, e.g. `app.js:194`).
  Add a `geocode-view-btn` back-link on the new page.

### Build order

1. `contexts` table + `point_in_polygon` / `contexts_for_*` helpers + CRUD API.
2. Contexts screen (draw/list/edit/delete polygons with optional date range).
3. Geo-tagging integration in `/api/guess` (constrain + centroid fallback) — highest value.
4. Face soft-prior (derived cast first; manual cast optional later).

### Possible refinements later

- **Infer contexts** from already-geotagged photo density + time clustering, then let the user
  name/adjust them — instead of drawing every one by hand.
- Pairs naturally with **reverse-geocoding** (backlog below): name a context "Paris" by its
  centroid automatically.

## Faces

- **Discover / cluster unlabeled faces** — *Done 2026-06-28.* "Discover groups"
  view clusters the unlabeled queue (cosine-graph + union-find connected
  components over the stored embeddings; det-score floor; top `FACE_CLUSTER_CAP`
  by detection score) so a brand-new person can be named in one go without a seed
  example. Each group gets a majority-vote "looks like <existing person>" hint.
  Config `FACE_CLUSTER_THRESHOLD` (0.5), `FACE_CLUSTER_MIN_SIZE` (3),
  `FACE_CLUSTER_CAP` (10000). *Possible upgrades:* Chinese-Whispers to resist
  chaining; per-face deselect within a group before naming.

- **"Ignore similar" sweep** — from an ignored (or any) face, use its embedding to
  find other faces that match it and bulk-ignore (or bulk-suggest) them. Turns a
  single ignore of a recurring background stranger into a one-click sweep.

- **Ambiguity detection in suggestions** — when the top two candidate people score
  within a small margin of each other, flag it "A or B?" instead of confidently
  guessing. Cheap, independent of birth dates, and especially helps look-alike
  siblings.
  - *Done 2026-06-27 for the per-person review view (scope=suggested):* each guess
    now carries near-tie `alternatives`, shown as an amber ring + one-click
    "tag as the other person" chip (config `FACE_AMBIGUITY_MARGIN`, default 0.05).
  - *Still open:* surface the same ambiguity in the unlabeled queue and the
    per-photo face list (abstain / show "A or B?" rather than a lone suggestion).

- **Keyboard-driven rapid tagging** — shortcuts in the People grid to triage fast:
  e.g. number keys to assign to the top suggestion / a recent person, `x` to ignore,
  arrow keys to move the focus. Aimed at quickly working through a large unlabeled queue.

- **MWG Regions XMP sidecar export** — write confirmed face names + regions to `.xmp`
  sidecars using the standard `XMP-mwg-rs:RegionInfo` schema (optionally Microsoft
  `RegionInfoMP` too) so names are portable to Lightroom / digiKam / Apple Photos.
  Keep the DB as the source of truth; treat the sidecar as an on-demand export
  (corner→center bbox conversion needed; bboxes are stored normalized).
  Deferred 2026-06-26 — for now face/person data stays DB-only.

- **Person management** — avatars (a representative crop) beside names in the
  sidebar for instant visual ID; merge / rename / split people (cleans up
  duplicate person records and false-positive contamination).

## Cross-cutting (people × place × time)

- **People on the map** — filter the geo view to a person ("where does Alice
  appear?") and, inversely, "who's here?" within an area/place. Fuses the two
  halves of the app using data already stored (face tags + geotags). A combined
  search (person + date range + place → grid *and* map) would be the command
  center. *(Top brainstorm pick alongside clustering, 2026-06-28. Re-endorsed as
  the highest-value existing backlog item in the 2026-07-01 review — the hard
  parts are all indexed already: face tags, geotags, place names, contexts.)*

## Geo / locating photos

- **Bulk "geotag by time" queue** — the geo analog of the face Accept-all flow:
  surface every untagged photo that has a confident time-based location guess
  (`/api/guess` already computes these one at a time) and accept per trip/day.

- **Location-history import (GPX / Google Takeout)** — import phone GPS tracks
  (GPX files, or Google Location History JSON from Takeout) and auto-geotag every
  timestamped photo by track correlation: find the track point(s) nearest in time
  to each photo and interpolate. Typically resolves thousands of photos in one
  pass with real per-point accuracy instead of a context-centroid guess.
  Composes with what's already built: Time Sync fixes camera clock offsets first;
  the `gps_accuracy` field stores per-match confidence (based on time gap between
  photo and nearest track point); Quick Geocode becomes the review UI for
  low-confidence matches. Sketch: a `tracks` table (source file, point count,
  time span) + `track_points(ts, lat, lng)` with an index on `ts`; an import
  script/endpoint; a "correlate" pass that writes sidecars like `/api/geotag`
  does. *(Biggest single coverage win on the geo side — 2026-07-01 review.)*

## App-wide / UX (2026-07-01 review)

- **In-app rescan + background jobs with progress** — scanning only happens at
  server startup (the old `POST /api/scan` is gone), so new photos need a
  restart, and scan progress renders as ANSI text in the terminal — invisible
  from the browser. Face scan and geocode backfill are "call repeatedly until
  `remaining == 0`" endpoints with no UI driver. A small job runner (one
  background task per job kind, progress via SSE or polling) would give a Rescan
  button, a "Detect faces on N new photos" button, and progress bars in the web
  UI. `watchfiles` is already in the venv (via uvicorn) if filesystem watching
  is wanted later. *(The dashboard's loop-buttons are a stopgap for this.)*

- **Undo via sidecar history** — bulk operations (drop 50 photos on the wrong
  spot, accept a bad suggestion batch) commit immediately with no way back.
  Since sidecars are the only mutable artifact, an operations log plus a copy of
  the prior sidecar bytes per write buys full undo without touching the
  immutability guarantee — and makes aggressive bulk-accept workflows feel safe.


## Robustness & safety (2026-07-01 review)

- **LAN mode auth** — `--network` binds 0.0.0.0 with zero auth; anyone on the
  network can write sidecars and edit people. A simple shared token/PIN
  (query-param or cookie, set via env/CLI flag) would cover the phone-tagging
  use case without real user management.
