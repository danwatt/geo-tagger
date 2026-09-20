# Product review — September 2026

A product-manager pass over every screen, taken against the live library. The question
asked: what to add, tweak, or remove so the app is as good as possible at its two jobs —
tagging **where** a photo was taken and **who** is in it.

Screenshots were captured from the running app at 1400×900 (headless Chrome, so map tiles
are sometimes half-loaded). They show real library data.

## 1. Where the library stands

Numbers from the Home dashboard, because they decide what the app should be optimised for:

| Metric | Value |
|---|---|
| Photos | 107,785 (107,561 images, 224 videos) |
| Geotagged | 73,985 (69%) · 691 ignored · **33,109 remaining** |
| Undated | **9,266** |
| Photos with a nearby-in-time guess available | 1,972 |
| Faces | 173,728 detected · 59,981 labeled · 106,051 ignored · **0 unlabeled** |
| People | 444 people · 18 families |

![Home dashboard](img/home.png)

Two conclusions follow:

1. **The face-labeling backlog is finished.** The People page's bulk-triage tooling
   (Unlabeled queue, Discover clusters, Crowds, Quick Tag) has done its job. Quick Tag
   already opens on "All caught up". The face workflow now shifts to *intake* (new photos)
   and *trust* (auditing what was labeled).
2. **Geotagging is the remaining backlog**, and it is the hard third: photos with no GPS,
   often no time neighbours (scans), and 9K with no date at all. The tools that got the
   library to 69% (drag-to-map, propose bar, month picker) are not the tools that will get
   it to 95%.

The app is, in short, tuned for a phase that is over. The recommendations below re-aim it.

## 2. Screen-by-screen notes

### Geocode (main tool)

![Geocode, October 2024](img/geocode-oct2024.png)

The best screen in the app. Staging + commit, the propose bar (`POST /api/geotag/propose`),
the two-level month picker with coverage bars, the `l` shortcut into the named-places
picker, imprecise drops with an accuracy radius, per-day pins — all good decisions.

Gaps:

- **Tagged and untagged photos mix in the grid.** When the goal is tagging, tagged photos
  are noise. The "Not tagged" filter exists but is not remembered outside of batch mode.
- **Detail pane** has no prev/next, and faces are hidden behind a button to another page.
  Who is in the photo is a location hint ("Grandma → Grandma's house").
- **Street search lives on the Data page**, not here. Typing "Elm St" into "Jump to map
  location" is a core tagging move, not data management.
- Selecting a photo zooms the map to it. Right for tagged photos; for untagged ones the
  more useful view is its time-neighbours (which `showDayOnMap` does, but only on demand).

### Search

![Search](img/search.png)

Good multi-facet search (saved places, date range, geotag status, people incl. "together",
camera, folder, GPS accuracy, has-faces), a sort control, and handoff buttons into Geocode
(an explicit id selection) and People (single-person scope).

### Named Places

![Named Places](img/named-places.png)

153 saved places with radius, representative thumbnail, count and last-used date. Solid.

### Time Sync

Does one thing (apply a fixed offset to a camera's clock) and does it clearly. But 9,266
undated photos need a *date assignment* tool, not an *offset* tool — see
[Undated photos](#32-undated-photos-need-a-date-tool).

### People

![People](img/people.png)

The largest subsystem and it shows: scopes, focus year, group-by, sort, staging, keyboard
shortcuts, a resizable detail pane, negative examples with undo. With the Unlabeled queue
at zero, what is missing is the *post-labeling* toolset:

- **Least-confident labels.** Faces were bulk-accepted at the 0.5 pre-select score.
  There is no view of "labels that least resemble this person's representatives". That
  is where the mislabels are.
- **Merge people.** The list contains near-duplicate names (Colin/Collin, Sue/Susan,
  a person and "X's Mom"). No merge action, no fuzzy duplicate detector.
- **Un-ignore sweep.** 106K faces are ignored, many from early in labeling when the
  gallery was thin. A one-shot "restore ignored faces that now match a known person
  above 0.6" would recover labels for free.
- "New since last scan" scope — the steady-state intake view.

### Representatives

Diagnostic: lets you inspect the medoid dedup that feeds matching. Useful for tuning,
not for tagging.

### Geo Data (Places DB map)

Diagnostic overlay of OSM/Census/ZCTA polygons plus the click-to-probe popup. Excellent
for debugging *why* a photo got a city name; not a tagging tool.

### Data

Dataset downloads plus street search. Clear copy. Two additions: a **Backup database**
button (the `.geotagger` DB holds every face label, which has no sidecar export) and a
**Re-resolve place names for a region** action with a dry-run diff — today that is only
`scripts/regeocode.py`.

### Settings

![Settings](img/settings.png)

Twenty tunables, nineteen of them cosine thresholds and caps. Only *Write GPS to XMP
sidecar immediately* matters to normal use. Collapse the rest under "Advanced".

### Hidden pages (Quick Tag, Photo Faces, People Manager)

Quick Tag is done ("All caught up"). Photo Faces is good and should be reachable inline
from the Geocode detail pane. People Manager needs a thumbnail column and the merge
action above.

## 3. Recommendations

Ordered by impact on the actual remaining work.

### 3.1 Batch guess review

`GET /api/guess/{photo_id}` is one photo at a time from the detail pane. 1,972 photos
already have a guess. Give them the same treatment faces got:

```mermaid
flowchart LR
    A[All photos with a\ntime-neighbour guess] --> B[Review list:\nphoto · guessed spot · neighbour · Δ minutes]
    B --> C{Per row}
    C -->|Accept| S[Stage]
    C -->|Reject| N[Never suggest again]
    B --> D[Accept all above Δ ≤ 5 min] --> S
    S --> K[Commit]
```

Same accept / accept-all / reject shape the user already knows from the face suggestion
queue.

### 3.2 Undated photos need a date tool

Time Sync applies an offset; 9,266 photos have nothing to offset. Scans arrive by folder
with no EXIF date. Add **Assign approximate date** to a folder or selection: year or
month precision, stored with a precision flag so the histogram and age-aware face
matching can treat it honestly.

### 3.3 Export state tracking

Today `POST /api/geocode/export-sidecars` rewrites every geocoded photo's sidecar (74K)
because nothing records what changed since the last export. The DB stores
`sidecar_mtime` but no dirty flag.

```mermaid
flowchart LR
    T[Geotag / place-name change] --> D[photos.geo_dirty = 1]
    D --> H[Home card:\nN photos with unexported changes]
    H -->|Export| X[Write sidecars for dirty rows only]
    X --> Z[geo_dirty = 0,\nexported_at = now]
```

Two migration-safe columns, one filtered export, one Home card.

**Person names in sidecars.** Face tags are DB-only by an earlier decision (export
deferred). That decision was right while labels were churning. They are not churning any
more: 0 unlabeled, 60K labels. Writing `Iptc4xmpExt:PersonInImage` plus MWG face regions
is now the single biggest step in getting value *out* of the app — it is what Lightroom,
digiKam and Immich read. Worth re-deciding.

### 3.4 Trust and audit views

Nothing checks work already done. Two cheap views on existing indexes:

- **Geotag outliers** — same camera, same day, one photo more than N km from its
  siblings. Uses the same time-window join the propose bar uses.
- **Least-confident face labels** — per person, labels with the lowest cosine similarity
  to that person's representatives. Sort ascending, review the top hundred.

Plus **Merge people** with a fuzzy duplicate-name check in People Manager.

### 3.5 Undo history

Staging protects against mistakes *before* commit. After commit there is nothing: one
"Stage all at X" on a thousand photos, committed, has no way back. Add a `geotag_history`
table (photo, old lat/lng, new lat/lng, source, timestamp) and a **Recent changes** view
with revert. Faces already carry `assigned_at`; surface it the same way.

### 3.6 Steady-state intake

Scanning runs only at startup. The recurring workflow after import is:
import → geotag the photos without GPS → confirm face suggestions. Today that is three
pages and a restart.

```mermaid
flowchart LR
    I[Scan for new photos\nbutton on Home] --> N[New since last scan]
    N --> G[Geocode:\nscope = new, untagged]
    N --> P[People:\nscope = new, suggested]
    G & P --> E[Export dirty sidecars]
```

A "new since last scan" scope on both Geocode and People, and a scan button that does not
need a restart.

## 4. Remove or de-emphasise

| Item | Action | Why |
|---|---|---|
| Settings: 19 threshold knobs | Collapse under Advanced | One toggle matters day to day |
| Road Trip | Keep off nav (already disabled) | Right idea for pre-GPS trips; ship when propose-along-route works |
| Quick Tag | Keep hidden | Done its job; still useful for intake on a phone |

## 5. Suggested order

1. Batch guess review (3.1) — 1,972 photos, mostly one-click.
2. Approximate-date tool (3.2) — unlocks the undated scans.
3. Dirty-flag export (3.3) — then re-decide person-name export.
4. Audit views and undo history (3.4, 3.5).
5. Intake scope and scan button (3.6).

## Appendix: remaining screenshots

| | |
|---|---|
| ![Geocode, nothing selected](img/geocode-empty.png) | ![Time Sync](img/timesync.png) |
| ![Representatives](img/representatives.png) | ![Geo Data](img/geo-data.png) |
| ![Data](img/data.png) | ![People Manager](img/people-manage.png) |
