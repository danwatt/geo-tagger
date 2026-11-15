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

## Suggested order of work

1. **Small fixes:** A11, T1.
2. **Request handling:** A1, A7.