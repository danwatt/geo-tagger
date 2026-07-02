# Home Dashboard + Shared Nav — Implementation Plan

> Handoff document. A fresh Claude session should be able to execute this end-to-end
> without other context. Working dir: `C:\Users\danwa\PycharmProjects\geo-tagger`.
> Windows 11, `uv` available. Run the app with `uv run geotagger` (add `--no-scan` to
> skip the startup scan when iterating).

## Goal

Geo-tagger has grown into five workflows (Geocode, Quick Geocode, Time Sync, People,
Contexts) reachable through per-page copies of a toolbar button row that have drifted
out of sync. There is no overview of library state — the stats live in scattered API
endpoints. Build:

1. **A home dashboard at `/`** showing library health (photo counts, geotagging
   progress, face-labeling progress, pending queues) with action links into the right
   tool, plus "run until done" buttons for the two batch endpoints (reverse-geocode
   backfill, face detection).
2. **A shared nav component** (`nav.js`) used by every main page, replacing the
   hand-copied button rows.

The current geocode view moves from `/` to `/geocode.html` to make room.

## Constraints / conventions (do not deviate)

- **Vanilla JS, no build step, no frameworks.** Static files in `src/geotagger/web/`
  are served directly by FastAPI (`StaticFiles(html=True)` mounted at `/`, last line
  of `main.py`). CDN `<script>` tags only where already used (Leaflet, vis-timeline).
- **Dark theme.** Reuse `style.css` conventions: `#toolbar`, `.toolbar-group`,
  `button` / `a.button` (styled identically, `style.css:46`), `button.active`
  (`style.css:59`), `button.primary`, `button.danger`. Background/panel colors match
  the existing pages (see `style.css` top).
- **Backend routes live in `main.py`**, defined with decorators. The static mount is
  the **last** statement — new API routes must be added **above** it. Follow the
  existing pattern: `try/except` → `raise HTTPException(500, str(e))`, DB access via
  `index.get_db()` (returns sqlite3 connection with `Row` factory).
- **Originals are immutable** — not touched by this feature at all; it's read-only
  plus two existing batch endpoints.
- Photo library DB may be large (tens of thousands of rows). Keep the summary
  endpoint to a handful of indexed queries; verify it returns in well under a second.

## Existing pieces you will touch or reuse

### Pages (all in `src/geotagger/web/`)

| Page | Role | Nav today |
|---|---|---|
| `index.html` + `app.js` + `style.css` | Geocode view (map + grid + detail) | Buttons in first `.toolbar-group`; wired in `app.js:263-271` |
| `quick-geocode.html` + `quick-geocode.js` | Phone-friendly geotag wizard | Back link `<a id="back" href="/">` only |
| `timesync.html` + `timesync.js` | Clock-offset fixing | Buttons; wired in `timesync.js:163-171` |
| `people.html` + `people.js` | Face tagging workbench | Buttons; wired in `people.js:42-55` (note: `quicktag-view-btn` and `manage-view-btn` are people-specific — they stay) |
| `contexts.html` + `contexts.js` | Life Contexts editor | Buttons; wired in `contexts.js:87-95` |
| `tag.html` + `tag.js` | Mobile Quick Tag | Back link to `/people.html` — leave as-is |
| `people-manage.html` | People Manager | Back link to `/people.html` — leave as-is |
| `crowd-review.html` | Crowd photo review (query-param driven sub-flow) | Back button to `/people.html` — leave as-is |

`face-grid.js` / `face-grid.css` are shared grid helpers loaded by several pages —
untouched here, but follow that precedent for how a shared JS file is included.

### API endpoints already available (reuse, don't duplicate)

- `GET /api/status` → `{ exiftool..., db_total, geocoder }`
- `GET /api/stats/months` → `{ months: [{year, month, total, geotagged, not_geotagged}] }`
  (a photo counts as geotagged if `lat IS NOT NULL OR geocode_ignored = 1`)
- `GET /api/geocode/status` → `{ available, ..., geocoded, pending }`
- `POST /api/geocode/backfill` body `{"limit": N}` → `{ processed, matched, remaining }`;
  returns **503** when GeoNames data isn't installed — handle that in the UI
- `GET /api/faces/scan/status` → `{ remaining_photos, total_faces, unlabeled_faces, ignored_faces, tagged_faces }`
- `POST /api/faces/scan` body `{"limit": N}` → `{ processed, faces_found, errors, remaining }`
  (CPU-heavy: ~seconds per batch of 50)
- `GET /api/persons`, `GET /api/families`, `GET /api/contexts` → arrays (length = count)

### Relevant DB columns (`photos` table, see `index.py`)

`media_type` (`image`|`video`), `lat`/`lng` (NULL = untagged), `geocode_ignored`
(0/1 — screenshots etc., count as "done" for progress), `photo_datetime` (epoch
seconds, 0/NULL = unknown), `loc_city`/`loc_state`/`loc_country` (reverse-geocode
results).

---

## Task 1 — Move the geocode view to `/geocode.html`

1. `git mv src/geotagger/web/index.html src/geotagger/web/geocode.html` (content
   otherwise unchanged for now; Task 3 swaps its nav row). It still loads `app.js`,
   `style.css`, `face-grid.*` via relative paths — those keep working.
2. Update every reference that pointed at the geocode view as `/`:
   - `contexts.js:87-88`, `people.js:42-43`, `timesync.js:163-164` — the
     `geocode-view-btn` handlers (these get deleted anyway in Task 3; just make sure
     nothing still navigates to `/` expecting the geocode view).
   - `quick-geocode.html` back link `<a id="back" href="/">` → `href="/geocode.html"`.
   - Search the whole `web/` dir for `href="/"` and `location.href = "/"` to catch
     stragglers.
3. `README.md` Usage section still describes the v1 scan-box flow; update it to:
   dashboard at `/`, geocode view at `/geocode.html`.

## Task 2 — `GET /api/stats/summary` (backend)

One endpoint, one round trip for the whole dashboard. Add to `main.py` near the other
stats routes (`api_stats_months` is at ~line 343). Response shape:

```json
{
  "photos":   { "total": 0, "images": 0, "videos": 0 },
  "geotag":   { "tagged": 0, "ignored": 0, "untagged": 0 },
  "guessable": { "count": 0, "window_sec": 900 },
  "geocode":  { "available": true, "geocoded": 0, "pending": 0 },
  "faces":    { "unscanned_photos": 0, "total": 0, "labeled": 0, "unlabeled": 0, "ignored": 0 },
  "people":   { "persons": 0, "families": 0 },
  "contexts": { "count": 0 }
}
```

- `photos` / `geotag`: single `SELECT` with conditional `SUM`s over `photos`
  (pattern: `api_stats_months`, `main.py:349`). `tagged` = `lat IS NOT NULL`,
  `ignored` = `lat IS NULL AND geocode_ignored = 1`, `untagged` = the rest.
- `geocode`: reuse `geocode.status()` + `index.count_geocoded_photos()` +
  `index.count_photos_needing_geocode()` (see `api_geocode_status`, `main.py:950`).
- `faces`: reuse `index.count_faces(scope)` with scopes `all` / `unlabeled` /
  `ignored` / `recent` (recent = assigned; see `api_faces_scan_status`,
  `main.py:1618`) and `len(index.get_unscanned_photo_ids())`.
- `people` / `contexts`: `SELECT COUNT(*)` on `persons`, `families`, `contexts`.
- `guessable.count` — untagged, non-ignored, timestamped photos that have at least
  one geotagged photo within ±900 s (i.e. `/api/guess` would succeed via
  time-neighbors). **Do not** run a correlated `EXISTS` per row blindly — with tens
  of thousands of rows it can be slow. Preferred: fetch the sorted timestamp list of
  tagged photos and of untagged photos (two indexed queries), then count matches with
  a two-pointer / `bisect` sweep in Python — O(n log n), a few ms. (Same `bisect`
  trick as `api_photos_by_area`, `main.py:612`.)
- Wrap the whole thing in the standard `try/except → HTTPException(500)`.

## Task 3 — Shared nav (`nav.js`)

New file `src/geotagger/web/nav.js`. It finds `<div id="app-nav" data-active="...">`
and renders the nav links into it:

| key | label | href |
|---|---|---|
| `home` | 🏠 Home | `/` |
| `geocode` | 📍 Geocode | `/geocode.html` |
| `quick-geocode` | ⚡ Quick Geocode | `/quick-geocode.html` |
| `timesync` | 🕐 Time Sync | `/timesync.html` |
| `people` | 🙂 People | `/people.html` |
| `contexts` | 🗺️ Contexts | `/contexts.html` |

- Render as `<a class="button">` (already styled like buttons, `style.css:46`); add
  class `active` to the entry matching `data-active`. Add an
  `a.button.active { ... }` rule to `style.css` mirroring the existing
  `button.active` rule at `style.css:59` (that selector only matches `<button>`).
- Plain links, no JS navigation handlers needed — this *removes* code.
- Retrofit each main page:
  - **geocode.html**: replace the first `.toolbar-group` (the 5 nav buttons/link,
    lines 13-19 of the old index.html) with `<div class="toolbar-group" id="app-nav"
    data-active="geocode"></div>`; add `<script src="nav.js"></script>` before
    `app.js`. Delete the dead handlers `app.js:263-271`. **Careful:** `app.js` also
    references `geocode-view-btn` nowhere else, but verify with a grep before
    deleting; a removed element with a surviving `getElementById(...).addEventListener`
    throws and kills page init.
  - **timesync.html** / `timesync.js:163-171`, **people.html** / `people.js:42-49`,
    **contexts.html** / `contexts.js:87-95`: same treatment. On people.html keep the
    page-specific `quicktag-view-btn` and `manage-view-btn` buttons (and their
    handlers `people.js:51-55`) in a second `.toolbar-group` after the nav div.
  - **quick-geocode.html**: keep its minimal phone header (back arrow →
    `/geocode.html` per Task 1). Do not embed the full nav — it's a focused flow.
  - **tag.html, people-manage.html, crowd-review.html**: leave as-is (sub-flows with
    back links).

## Task 4 — Dashboard page (new `index.html` + `home.css` + `home.js`)

New `src/geotagger/web/index.html` (the old one is now `geocode.html`). Loads
`style.css`, `home.css`, `nav.js` (`data-active="home"`), `home.js`. No Leaflet, no
`app.js`.

Layout: `#toolbar` with the shared nav, then a scrollable card grid
(`display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))`).
On load, `home.js` fetches `/api/stats/summary` and `/api/stats/months` in parallel
and renders:

**Card: Library**
- Big number: total photos; sub-line "N images · N videos".

**Card: Geotagging**
- Progress bar: `(tagged + ignored) / total` with percentage label. (Simple CSS
  div-in-div bar; no chart libs.)
- Lines: "N tagged · N ignored · **N remaining**".
- "N photos have a nearby-in-time guess available" (from `guessable`) — this is the
  headline motivator.
- Action links: `⚡ Quick Geocode` → `/quick-geocode.html`;
  `📍 Open Geocode view` → `/geocode.html`.

**Card: Reverse geocoding (place names)**
- "N geocoded · N pending".
- Button **Run backfill**: loop `POST /api/geocode/backfill {"limit": 1000}` until
  `remaining === 0`, updating the button label with progress ("Backfilling… 3,200
  left"); disable while running; re-fetch summary when done. On **503**, show the
  install hint ("GeoNames data not installed — run `scripts/get_geonames.py`") and
  disable the button. Hide/disable the whole card gracefully when
  `geocode.available` is false.

**Card: Faces**
- Progress bar: `labeled / (total - ignored)` ("N of N faces labeled").
- "N photos not yet scanned for faces" + button **Detect faces**: loop
  `POST /api/faces/scan {"limit": 50}` until `remaining === 0` with progress text and
  a **Stop** affordance (a flag the loop checks between batches — each batch takes
  seconds of CPU, so the user must be able to bail out).
- Action links: `🙂 People` → `/people.html`; `📱 Quick Tag` → `/tag.html`.

**Card: People & Contexts**
- "N people · N families" → link `⚙ Manage` → `/people-manage.html`.
- "N life contexts" → link `🗺️ Contexts` → `/contexts.html`.

**Card (full-width): Coverage by month**
- From `/api/stats/months`: one thin stacked bar per month (CSS divs in a flex row;
  green = geotagged, gray/red = not), oldest → newest, with sparse year labels.
  Hover title: "March 2014 — 210 of 340 tagged". Data is already sorted DESC;
  reverse it. Keep it render-only (no click-through) — month deep-linking into the
  geocode view is a stretch goal, below.

General behavior: fetch errors render an inline error line in the affected card, not
a blank page. While a loop button runs, keep the rest of the page usable. Numbers
are `toLocaleString()`-formatted.

## Stretch goals (only if everything above is done and verified)

- Deep links: `geocode.html?filter=no` pre-sets the Show filter; app.js would parse
  `URLSearchParams` during init (precedent: `crowd-review.js:12`). Then wire the
  dashboard's "N remaining" line and the month bars to it
  (`?filter=no&year=2014&month=3` matching the month-picker state in app.js).
- Show the configured scan roots on the Library card (`scans` table via a small
  `index.py` getter).

## Verification

Run: `uv run geotagger --no-scan` (uses the existing DB; if none exists locally,
create a temp dir with a couple of JPEGs and run
`uv run geotagger --scan-dir <dir> --cache-dir <tmp>`).

1. `GET http://127.0.0.1:8000/api/stats/summary` returns the documented shape;
   spot-check `photos.total` against `/api/status.db_total`; response < 1 s.
2. `/` serves the dashboard; all cards populate; numbers are plausible and
   internally consistent (tagged + ignored + untagged = total).
3. Nav: every main page (`/`, `/geocode.html`, `/timesync.html`, `/people.html`,
   `/contexts.html`) shows the same nav with the correct item highlighted; every
   link works from every page; `/quick-geocode.html` back arrow → `/geocode.html`.
4. Geocode view at `/geocode.html` is functionally unchanged: map loads, grid
   loads, month picker / area select / drag-to-map still work, **no console errors**
   (the killer regression here is a deleted nav button with a surviving
   `addEventListener` — check the console on every retrofitted page).
5. Backfill button: with GeoNames installed it loops to `remaining: 0` and the
   pending count updates; without GeoNames it shows the install hint (test by
   temporarily setting `GEOTAGGER_GEONAMES_DIR` to a bogus path).
6. Detect-faces button: runs a batch, progress text updates, Stop halts between
   batches, counts refresh afterward.
7. Grep checks: no remaining `location.href = "/"` meaning "geocode view"; no
   references to deleted button ids in JS.
