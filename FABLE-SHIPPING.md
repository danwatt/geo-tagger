# Shipping Readiness Review

Findings from a pass over the repo with the question: *what stands between this codebase
and a smooth open-source release an average user can clone and run?* Ordered roughly by
severity. Test suite state at time of review: **377 passed**.

---

## 1. Blockers (cannot ship without these)

### 1.1 No LICENSE file
There is no `LICENSE`, and `pyproject.toml` has no `license` field. Without one, the
project is legally "all rights reserved" — nobody can use or redistribute it, and GitHub
won't show a license badge. Pick one (MIT/Apache-2.0 are the usual choices), add the file,
and reference it in `pyproject.toml`.

Related: the project *redistributes instructions* for GeoNames (CC BY 4.0) and OSM (ODbL)
data. The README already attributes both — good — but a `NOTICE`/attribution section
should survive into whatever docs ship, and the chosen code license must not be confused
with the data licenses.

### 1.2 First run with no arguments is a dead end
`uv run geotagger` with no flags starts the server, but `lifespan.py` only initializes the
database if `--scan-dir` was passed **or** a previous-run sentinel exists. A brand-new user
who follows the README ("Run: `uv run geotagger`… opens at 127.0.0.1:8000") gets a UI where
every API call fails, because `index.get_db()` was never initialized and there is **no way
to pick a photo folder from the UI**. The only ways to point the app at photos are the
`--scan-dir` CLI flag and the `GEOTAGGER_SCAN_DIRS` env var — neither of which the README
documents (the README never mentions `--scan-dir` at all!).

This is the single biggest onboarding gap. Options, in increasing effort:
1. Make the CLI require/prompt for a scan directory when no saved root exists, with a
   clear error message instead of a silently-broken server.
2. Document `--scan-dir` prominently in the README ("Run: `uv run geotagger --scan-dir
   D:\Photos`").
3. Best UX: a first-run onboarding page — server detects "no library configured" and the
   home page shows a "set your photo folder" form that triggers a scan.

### 1.3 The README documents ~20% of the product
The nav has nine pages: Home, Geocode, Quick Geocode, Places DB, Time Sync, People,
Representatives, Contexts, Settings — plus non-nav pages (`tag.html`, `crowd-review.html`,
`people-manage.html`). The README covers only geocoding. Nothing about:
- **Face detection / people tagging** — the largest subsystem in the app (`people.js`
  alone is 92 KB; a dozen config knobs; multiple views).
- **Time Sync**, **Contexts**, **Quick Geocode**, **Crowd review**, **Representatives**.
- The **Settings page** and the concept of runtime-tunable settings.
- The fact that first use of face features downloads a **~275 MB InsightFace model**
  (buffalo_l) from the internet — a surprise for an app advertised as "fully local", and a
  hard failure for offline users. This needs a call-out and ideally a pre-download script
  like `get_exiftool.py` / `get_geonames.py`.

An average user judges the project by the README. Add a feature tour (screenshots or a
GIF of the drag-to-map flow would do more than any paragraph), and a "what happens on
first run" section (scan, thumbnail generation time expectations, where the cache lives).

---

## 2. Major friction (ship-degrading, fix before or shortly after release)

### 2.1 Windows-only setup path, unclear cross-platform story
- `scripts/get_exiftool.py` downloads the **Windows** ExifTool zip only; README setup
  instructions are Windows-only (`tools/exiftool.exe`, firewall notes).
- `config.get_exiftool_path()` does fall back to `exiftool` on PATH, so macOS/Linux users
  *can* `brew install exiftool` / `apt install libimage-exiftool-perl` — but nothing tells
  them that.
- The rest of the stack (pillow-heif, av, rawpy, onnxruntime, osmium) ships cross-platform
  wheels, so the app is *probably* portable — but if it has never been run on macOS/Linux,
  say so ("tested on Windows; Linux/macOS should work, reports welcome") or test it.
  Either is fine; silence is not.

### 2.2 Project only works from a source checkout
`config.py`, `index.py`, and both download scripts anchor paths at
`Path(__file__).parent.parent.parent` (`_PROJECT_ROOT`). That resolves to the repo root in
a `src/` checkout, but to `site-packages/` if anyone installs the wheel (`pip install
geo-tagger`, `uvx geotagger`) — tools, GeoNames data, the OSM DB, and the legacy
`.geotagger_last_root` sentinel would all try to live inside site-packages. Either:
- commit to "clone-and-run only" and remove the wheel-publishing implication (don't
  publish to PyPI), or
- move defaults to a per-user data dir (e.g. `platformdirs`: `%LOCALAPPDATA%/geotagger`,
  `~/.local/share/geotagger`) with env overrides kept as-is.

Also note `save_last_scan_roots()` **writes state into the project root** when no cache
dir is set — a program writing files into its own install directory is a packaging smell
and fails on read-only installs.

### 2.3 Heavy mandatory dependency set
`insightface` + `onnxruntime` + `rawpy` + `av` + `osmium` are unconditional dependencies.
A user who only wants map-based geotagging still downloads hundreds of MB and needs a
working compiler-toolchain-free wheel for every one of them on their platform. Consider
extras: `geo-tagger[faces]`, `[video]`, `[osm]`, with graceful feature-off behavior when
missing (the lazy-import pattern already used in `faces.py` makes this cheap).

### 2.4 Default cache location writes into the photo library
With no `--cache-dir`, the app creates `.geotagger/` (DB + thumbnails, potentially GBs)
**inside the scanned photo root**. Many users treat their photo tree as read-only/synced
(NAS, Dropbox, backup tools will churn on thumbnail writes). This is a defensible default
but must be documented loudly, with `--cache-dir` as the escape hatch. (The README
mentions neither `--cache-dir` nor the `.geotagger` folder.)

### 2.5 `--network` exposes an unauthenticated read/write API
`--network` binds 0.0.0.0. There is no authentication anywhere: anyone on the LAN can
browse every photo, rewrite geotags, edit sidecar files, and rename people. For a local
tool that's an acceptable design, but the README/`--help` text should carry an explicit
warning, and the flag should probably print one at startup.

### 2.6 Config/CLI documentation drift
- CLI flags `--scan-dir`, `--cache-dir`, `--workers`, `--no-scan`, `--network` are
  undocumented in the README.
- The README env-var table lists 8 variables; `config.py` defines ~35 (`GEOTAGGER_CACHE_DIR`,
  `GEOTAGGER_WORKERS`, `GEOTAGGER_NO_SCAN`, `GEOTAGGER_SCAN_DIRS`,
  `GEOTAGGER_WRITE_XMP_ON_GEOTAG`, `GEOTAGGER_RAW_FULL_DECODE`, all `GEOTAGGER_FACE_*`,
  auto-vacuum knobs…). Decide the documentation surface: either an exhaustive generated
  table, or "common" in README + full reference elsewhere.
- README says nothing about supported file types (`.jpg .jpeg .heic .heif .nef .dng .tif
  .tiff .png` + `.mp4 .mov .m4v .avi`) — the first question every user has.

### 2.7 No uv / prerequisites onboarding
Setup step 1 is `uv sync`, assuming the user has `uv`, git, and Python 3.13 already.
Average users don't. Add a prerequisites block (install uv one-liner; note that uv
installs Python 3.13 itself). Also `requires-python = ">=3.13"` is aggressive — fine, but
state it up front so users on system Python 3.11 aren't confused (uv makes this painless,
which is worth saying).

---

## 3. Repo hygiene (visible to every visitor on day one)

- **`.idea/` is committed** (8 tracked files, including `dataSources.xml` — check it for
  local DB paths). Untrack it; `.gitignore` already half-tries (`/.idea/geo-tagger@1.iml`).
- **`.python-version` is tracked but locally deleted** (git status `AD`) — resolve the
  inconsistency: either delete it from the repo or restore it.
- **Stray `nul` file** in the repo root (Windows redirection artifact). It's gitignored
  but sitting on disk; delete, since a file named `nul` breaks many Windows tools.
- **Internal working docs committed at root**: `PLAN.md`, `FACE_TESTING_PLAN.MD`,
  `LIFE_CONTEXTS_PLAN.md`, `IDEAS.md`, `PERFORMANCE.md`, `CLAUDE.md`, `network_test.py`.
  These are fine to keep, but at root they crowd out README for a first-time visitor —
  consider a `docs/` folder, and decide deliberately whether agent-handoff docs are part
  of the public repo's story.
- **No CHANGELOG**, no tagged releases, version frozen at `0.1.0`.
- **`pyproject.toml` metadata is bare**: no `description`, `readme`, `license`,
  `authors`, `keywords`, `classifiers`, or `[project.urls]`. Even for a non-PyPI project,
  GitHub and tooling read these. Minor: project name is `geo-tagger` but the package and
  command are `geotagger` — pick one spelling for the public name and use it consistently.
- **No CI.** A single GitHub Actions workflow running `uv sync && uv run pytest` on
  push (Windows + Ubuntu matrix would also answer §2.1 for free) is cheap and signals the
  project is alive and tested. 377 passing tests is a genuine asset — advertise it.
- **No CONTRIBUTING.md / issue templates** — optional for launch, but a 10-line "PRs
  welcome, run `uv run pytest`, code style notes live in CLAUDE.md" goes a long way.

---

## 4. Inconsistencies and rough edges noticed along the way

- **Legacy vs. new persistence paths.** `index.get_last_scan_roots()` supports two
  regimes (global cache dir with `.last_scan_roots` vs. legacy project-root
  `.geotagger_last_root` + per-root `.geotagger/`), and `lifespan.py` has two divergent
  startup branches (multi-dir scan vs. "legacy" single-root auto-load) with different
  behavior (`init_db()` vs `init_db(root)`). Works, but it's the kind of dual-path code
  that generates confusing bug reports; worth consolidating before strangers run it.
- **Startup failures are swallowed.** `lifespan.py` wraps both startup branches in
  `except Exception as e: print(f"Auto-scan failed: {e}")` and the server keeps running
  in a broken state. For end users, a hard failure with a clear message beats a
  half-alive server.
- **Non-nav pages** (`tag.html`, `crowd-review.html`, `people-manage.html`) are reachable
  only via in-page links; fine, but confirm each is linked from somewhere or prune.
- **`scripts/` is a mixed bag**: user-facing setup (`get_exiftool.py`, `get_geonames.py`,
  `build_osm_places.py`, `regeocode.py`) sits beside one-off maintenance/backfill scripts
  (`backfill_checksums.py`, `rescan_raw_faces.py`, `reembed_faces.py`,
  `backfill_orientation.py`, `prime_previews.py`). Separate or document which are part of
  the product vs. developer archaeology.
- **ExifTool version pinned to 13.59** in `get_exiftool.py` with no checksum verification
  of the download (`hashlib` is imported but unused). Pin + verify, or fetch latest.
- **First-scan expectations unset.** A large library means a long first scan + thumbnail
  generation with console-only progress. The README should set expectations (rough
  photos/minute) and mention `--workers` and `--no-scan`.
- **No "reset / start over" story.** Nothing documents where all state lives
  (`.geotagger/` per root, `GEOTAGGER_CACHE_DIR`, sentinel files, `~/.insightface`
  models) or how to wipe it. A short "uninstalling / resetting" README section closes the
  loop on trust for a tool that touches people's photo libraries.
- **XMP-off-by-default surprise.** As of `e101e16`, geotags go to the DB only and
  sidecars are written via an explicit export. That's a sane default, but it inverts the
  README's headline promise ("all geolocation metadata is written to XMP sidecar files").
  The README needs to describe the new model: DB is the working store, sidecar export is
  the durable output, and unexported edits live only in the cache DB (which sits in a
  dot-folder a user might casually delete).

---

## 5. Suggested launch checklist (condensed)

1. Add `LICENSE` + pyproject metadata (§1.1, §3).
2. Fix bare-first-run: document `--scan-dir` everywhere, error clearly when no library is
   configured, or add first-run folder setup UI (§1.2).
3. README overhaul: prerequisites (uv), full feature tour with screenshots, supported
   formats, all CLI flags, cache location, InsightFace model download note, sidecar-export
   model, LAN-exposure warning, reset instructions (§1.3, §2.4–2.7, §4).
4. Untrack `.idea/`, resolve `.python-version`, delete `nul`, move plan docs to `docs/`
   (§3).
5. Add CI (Windows + Ubuntu pytest) and cut a `v0.1.0` tag/release (§3).
6. Decide install story: clone-only (then say so) vs. installable (then fix
   `_PROJECT_ROOT`-relative data paths, §2.2) — and consider dependency extras (§2.3).
7. State the cross-platform position; extend `get_exiftool.py` or docs for macOS/Linux
   (§2.1).
