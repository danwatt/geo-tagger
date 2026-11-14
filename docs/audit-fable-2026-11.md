# Codebase audit — November 2026

Audit of the working tree on `master` (including uncommitted changes) as of 2026-11-12.
Scope: all of `src/geotagger/` (Python and `web/`), `tests/`, `scripts/`, packaging and CI.
Existing audit documents were deliberately not read.

## How to read this

Every finding has an ID, a location, and a confidence tag:

- **[run]** — reproduced by executing a snippet against the project's Python 3.13.6 / SQLite 3.49.1 on Windows.
- **[seen]** — the decisive lines were re-read and confirmed during the final verification pass.
- **[traced]** — followed through the code by reading; not executed and not re-checked afterwards.
- **[unverified]** — plausible from the code, but depends on runtime or browser behaviour nobody tested.

Nothing was run in a browser, and the test suite was not run as part of this audit. No code was changed.

Severity is **High** (data loss, wrong data written to disk, or a crash on a normal workflow),
**Medium** (wrong behaviour in a reachable scenario, or a serious performance cliff),
**Low** (edge cases, polish).

Findings that have since been fixed were removed on 2026-11-14, along with the "Fix these first" table
and the Data integrity, Concurrency, Scanning, Faces, Performance, Frontend bugs and Refactors sections,
which no longer had open items. The full original text is in git history (`git log -p -- docs/audit-fable-2026-11.md`).

## Geocoding and datasets

**G9 — Low — Roadtrip extrapolation goes the wrong way on a reversed route** [traced]
`services/roadtrip_service.py:199,262-264`. `speed` uses `abs(...)`. (The Roadtrip page script is currently commented out.)

**G10 — Low — Street viewport test is vertex-only** [traced]
`osm_streets.py:154-157`. A long straight road crossing a zoomed-in view with no vertex inside is missed.
The module also imports `services.data_service`, inverting the layering.

## API

**A1 — Medium — Heavy synchronous work directly in `async def` routes** [traced]
`api/faces.py:219,226,263-267,442,477-513`, `api/photos.py:45,137-148,166`, `api/stats.py:18-56,109-154,188-242`,
`api/geocode.py:54`. Each stalls every other request, including thumbnails, against the project's own
"never block event loop" rule. *Fix:* move bodies into `services/` and `run_in_executor` them (after C1).

**A3 — Medium — Search results silently capped at 2000** [seen]
`api/search.py:71,127`, `web/search.js:271,285`. `total` is `len(photos)`, so the page reads
"2,000 photos found" and "Select all" acts on a partial set.
*Fix:* return the true total and a `truncated` flag; show "first 2,000 of N".

**A5 — Medium — Places CRUD has no validation and no 404s** [traced]
`api/places.py:50-86`. `bounds` is a free string; malformed JSON makes `place_distance` raise inside SQLite,
so place search returns 500. DELETE and PATCH on a missing id return success.

**A6 — Medium — Media routes turn every failure into 500 with the exception text** [seen, for `api/faces.py:305-306`]
`api/photos.py:205-222,233-247,266-278`. A file deleted since the scan should be 404; the detail typically
leaks an absolute path. The ETag `"{id}-{mtime}"` omits orientation, so browsers keep a sideways image for a
day after orientation changes.

**A7 — Medium — Dataset downloads run on the shared 4-worker request executor** [traced]
`services/data_service.py:215,326,416,481`, `services/semantic_service.py:134`. Starting four jobs from the
Data page occupies every worker and freezes the UI. `/api/geocode/export-sidecars` pins a worker for the whole
library instead of using the `limit`/`remaining` client-loop convention.
*Fix:* a dedicated one- or two-thread jobs executor.

**A8 — Low — Settings PATCH and reset apply partially** [traced] — `api/status.py:61-98`.

**A9 — Low — `add_manual_face` creates the person before validating** [traced] — `api/faces.py:358-380`.

**A10 — Low — `api_dedup_groups` can `KeyError`** [traced] — `api/faces.py:442-449`.

**A11 — Low — Dead code referencing an undefined name** [seen]
`api/geocode.py:199-203`. Unreachable `return` after the route's `return`, using undefined `groups`.
A linter would catch it (see T3).

**A12 — Low — Inconsistent response shapes** [traced]
Mutations return `{"success"}`, `{"id"}`, `{"updated"}`, or bare lists. `/api/status` and `/api/debug` return
200 with `"error"` strings, which defeats `res.ok`. `/api/photo/{id}` and `/api/photos/{id}/…` mix singular and plural.

## Security

No SQL injection was found: every f-string interpolates fixed fragments, `int()` casts or whitelisted field
names. No archive is extracted to disk. Download URLs are fixed HTTPS constants.

## UX

**U2 — No way to remove or undo a committed geotag** [traced] — `web/geocode.html:74-80`. The only caller of
`/api/geotag/remove` sits in a `display:none` block. Add "Remove location" to the context menu and an
"Undo last commit".

**U3 — One-click destructive actions without undo** [traced] — the "×" on a tagged card and "Ignore all N"
(`photo-faces.js:448-450,507,588-590`); group Ignore/Accept on Tag (1.8 s toast only); the hover-only "×"
beside "✎" in the People list (`people.js:597-615`). An Undo toast pattern would cover all of them.

**U4 — Missing loading states** [traced] — `loadFaces` and `loadPhotoScope` leave the old grid interactive
with no indication (`people.js:696-714`, `app.js:1315-1319`). The first-load status on People is overwritten
(`people.js:118-120`).

**U8 — Dialog and drawing papercuts** [traced] — Enter on a focused Cancel button saves
(`custom-places.js:1307-1309`); releasing the mouse outside the map leaves draw mode armed with dragging
disabled; Escape does not cancel drawing here or in `app.js:1171-1185`.

**U9 — Error toasts show raw JSON for 2.2 s** [traced] — `people-manage.js:15,24-26`.

**U10 — Smaller items** [traced] — `prompt()` for naming people hides near-duplicates (`people.js:2022,3166`);
no arrow keys for Prev/Next in Crowd Review; Crowd Review ignores the Focus window (`people.js:2243-2244`);
pane widths and Show toggles are not persisted; Custom Places rectangles can be resized but not moved.

## Accessibility

**Y1** [traced] — Thumbnails, month cards, nav items, face cells and edit/delete glyphs are click-only
`div`/`span` elements with no `tabindex`, role or key handling. Per-face actions are right-click only.

**Y2** [traced] — Global shortcuts hijack Enter and Space on focused buttons (`people.js:1895-1936`), so
keyboard users cannot operate the toolbar on flat scopes.

**Y3** [traced] — Modals lack `role="dialog"`, focus trap and focus restore; several do not close on Escape.
`.modal-close` is a `<span>`.

**Y4** [traced] — `outline: none` on text inputs (`theme.css:151`, `people-manage.css:68,81,117`);
`#status-bar` is not `aria-live`; nav dropdowns lack `aria-expanded`.

A shared modal helper and a `<button>` sweep would address most of this.

## Tests, CI and repository hygiene

**T1 — A test pins a bug.** `tests/test_sidecar.py:153-163` asserts the D1 asymmetry.

**T6 — Stray files tracked in git.** [seen] `tempgeotagger-test/`, `tempgeotagger-test2/` and
`tempgeotagger-test3/` (`index.db`, `-wal`, `-shm`, and `.last_scan_roots` containing an absolute local path),
added in `e682bc7`. Also `.mcp.json` (an ephemeral local port) and `.claude/settings.local.json`.
`git rm --cached` and ignore them.

**T7 — Undeclared direct dependencies.** `numpy`, `scipy`, `cv2` and `pydantic` are imported but arrive only
transitively. `fastapi`, `uvicorn`, `pillow`, `pyexiftool` and `av` have no lower bounds.

**T8 — Two scripts reset the library with no confirmation.** `scripts/backfill_checksums.py:51-54` and
`scripts/scan_faces.py:53-56` run `UPDATE photos SET …=NULL` immediately under `--rescan`. The other scripts
already have `--dry-run`; match them and require `--yes`.

## Suggested order of work

1. **Small fixes:** A11, T1, T6.
2. **Request handling:** A1, A7.
3. **UX features:** U2 (remove geotag), U3 (undo toast).
