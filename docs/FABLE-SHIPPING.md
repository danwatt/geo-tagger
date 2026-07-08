# Shipping Readiness Review

Findings from a pass over the repo with the question: *what stands between this codebase
and a smooth open-source release an average user can clone and run?* Ordered roughly by
severity. Test suite state at time of review: **377 passed**.

Items resolved since the original review (LICENSE, pyproject metadata, README overhaul,
repo hygiene) have been removed from this doc — see git history for what changed.

---

## 1. Blockers (cannot ship without these)

### 1.1 First run with no arguments is still a functional dead end
README now documents `--scan-dir` prominently and warns that a flag-less first run is a dead
end — but the underlying behavior is unchanged: `uv run geotagger` with no flags and no prior
run still starts a server where every API call fails, because `index.get_db()` is never
initialized and there's still no way to pick a photo folder from the UI. Docs mitigate the
surprise; they don't fix it. Remaining options, in increasing effort:
1. Make the CLI require/prompt for a scan directory when no saved root exists, with a clear
   error message instead of a silently-broken server.
2. Best UX: a first-run onboarding page — server detects "no library configured" and the
   home page shows a "set your photo folder" form that triggers a scan.

---

## 2. Major friction (ship-degrading, fix before or shortly after release)

### 2.1 Project only works from a source checkout
`config.py`, `index.py`, and both download scripts anchor paths at
`Path(__file__).parent.parent.parent` (`_PROJECT_ROOT`). That resolves to the repo root in
a `src/` checkout, but to `site-packages/` if anyone installs the wheel (`pip install
geo-tagger`, `uvx geotagger`) — tools, GeoNames data, the OSM DB, and the legacy
`.geotagger_last_root` sentinel would all try to live inside site-packages. Either:
- commit to "clone-and-run only" and remove the wheel-publishing implication (don't
  publish to PyPI) — README now states this explicitly, so just needs the code path
  decision, or
- move defaults to a per-user data dir (e.g. `platformdirs`: `%LOCALAPPDATA%/geotagger`,
  `~/.local/share/geotagger`) with env overrides kept as-is.

Also note `save_last_scan_roots()` **writes state into the project root** when no cache
dir is set — a program writing files into its own install directory is a packaging smell
and fails on read-only installs.

### 2.2 Heavy mandatory dependency set
`insightface` + `onnxruntime` + `rawpy` + `av` + `osmium` are unconditional dependencies.
A user who only wants map-based geotagging still downloads hundreds of MB and needs a
working compiler-toolchain-free wheel for every one of them on their platform. Consider
extras: `geo-tagger[faces]`, `[video]`, `[osm]`, with graceful feature-off behavior when
missing (the lazy-import pattern already used in `faces.py` makes this cheap).

### 2.3 `--network` warning is documentation-only
README now carries an explicit LAN-exposure warning, but the review's other suggestion — the
`--network` flag itself printing a warning at startup — isn't implemented. `__main__.py`
currently only prints bind-address info, not a no-auth warning, when `--network` is passed.

---

## 3. Repo hygiene (visible to every visitor on day one)

- **Internal working docs committed at root**: `PLAN.md`, `FACE_TESTING_PLAN.MD`,
  `LIFE_CONTEXTS_PLAN.md`, `IDEAS.md`, `PERFORMANCE.md`, `CLAUDE.md`, `network_test.py`.
  These are fine to keep, but at root they crowd out README for a first-time visitor —
  consider a `docs/` folder, and decide deliberately whether agent-handoff docs are part
  of the public repo's story.
- **No CHANGELOG**, no tagged releases, version frozen at `0.1.0`.
- Minor: project name is `geo-tagger` but the package and command are `geotagger` — pick
  one spelling for the public name and use it consistently.
- **No CI.** A single GitHub Actions workflow running `uv sync && uv run pytest` on
  push (Windows + Ubuntu matrix would also answer the cross-platform question for free) is
  cheap and signals the project is alive and tested. 377 passing tests is a genuine asset —
  advertise it.
- **No CONTRIBUTING.md / issue templates** — optional for launch, but a 10-line "PRs
  welcome, run `uv run pytest`, code style notes live in CLAUDE.md" goes a long way.

---

## 4. Inconsistencies and rough edges noticed along the way

- **Legacy vs. new persistence paths.** `index.get_last_scan_roots()` supports two
  regimes (global cache dir with `.last_scan_roots` vs. legacy project-root
  `.geotagger_last_root` + per-root `.geotagger/`), and `lifespan.py` has two divergent
  startup branches (multi-dir scan vs. "legacy" single-root auto-load) with different
  behavior (`init_db()` vs `init_db(root)`). Confirmed while writing the README: a
  flag-less restart only ever reloads the *first* of multiple `--scan-dir` values, because
  the legacy branch calls `get_last_scan_root()` (singular). Works, but it's the kind of
  dual-path code that generates confusing bug reports; worth consolidating before strangers
  run it.
- **Startup failures are swallowed.** `lifespan.py` wraps both startup branches in
  `except Exception as e: print(f"Auto-scan failed: {e}")` and the server keeps running
  in a broken state. For end users, a hard failure with a clear message beats a
  half-alive server.
- **Non-nav pages** (`tag.html`, `crowd-review.html`, `people-manage.html`) are reachable
  only via in-page links; now documented in the README, but still worth confirming each is
  actually linked from somewhere (or pruning if not).
- **`scripts/` is a mixed bag**: user-facing setup (`get_exiftool.py`, `get_geonames.py`,
  `build_osm_places.py`, `regeocode.py`) sits beside one-off maintenance/backfill scripts
  (`backfill_checksums.py`, `rescan_raw_faces.py`, `reembed_faces.py`,
  `backfill_orientation.py`, `prime_previews.py`). Separate or document which are part of
  the product vs. developer archaeology.
- **ExifTool version pinned to 13.59** in `get_exiftool.py` with no checksum verification
  of the download (`hashlib` is imported but unused). Pin + verify, or fetch latest.

---

## 5. Suggested launch checklist (condensed)

1. ~~Add `LICENSE` + pyproject metadata.~~ Done.
2. Fix bare-first-run for real: error clearly when no library is configured, or add
   first-run folder setup UI (§1.1) — README documentation of `--scan-dir` is done, the
   functional fix isn't.
3. ~~README overhaul.~~ Done.
4. ~~Untrack `.idea/`, resolve `.python-version`, delete `nul`.~~ Done. Still open: move
   plan docs to `docs/` (§3).
5. Add CI (Windows + Ubuntu pytest) and cut a `v0.1.0` tag/release (§3).
6. Decide install story: clone-only (already stated in README) vs. installable (then fix
   `_PROJECT_ROOT`-relative data paths, §2.1) — and consider dependency extras (§2.2).
7. Add a startup-time warning when `--network` is passed, not just a README note (§2.3).
