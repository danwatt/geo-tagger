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

## Fix these first

| # | Finding | Why it is first |
|---|---------|-----------------|
| 1 | [D1](#d1) Time Sync writes local time into the sidecar | Silently corrupts the one artefact the app treats as source of truth |
| 2 | [D2](#d2) Pre-1970 dates crash on Windows and count as undated | Breaks "Assign approximate date" for scanned prints, the feature's main use |
| 3 | [C1](#c1) One shared SQLite connection, no lock, no rollback | Root cause behind several intermittent 500s and half-written states |
| 4 | [C2](#c2) `create_function` on every place search | Intermittent 500 on place search; one-line fix |
| 5 | [F1](#f1) A model failure marks the whole library as scanned | One bad model download permanently empties face and semantic results |
| 6 | [F2](#f2) Newly detected faces never reach suggestions in-session | Face scan appears to do nothing until restart |
| 7 | [S1](#s1) Unparseable dates make a file permanently stale | Multi-GB videos re-hashed on every startup |
| 8 | [W1](#w1) Stale date filter hides every photo in folder scopes | "Showing 0 of N" on a core Geocode workflow |
| 9 | [W2](#w2) `setGeocodeIgnored` ignores HTTP errors | Staged work discarded while the UI reports success |
| 10 | [X1](#x1) No Host/Origin validation | Any web page can drive the local API via DNS rebinding or form posts |

---

## Data integrity (backend)

<a id="d1"></a>
**D1 — High — Time Sync shifts sidecar times by the local UTC offset** [seen] — ✅ **DONE** (`sidecar.epoch_to_wallclock`; sidecars already written by Time Sync on a non-UTC machine stay shifted — DB value is still correct, no repair action yet)
`sidecar.py:311`, `services/photos_service.py:26-62`.
`photo_datetime` is wall-clock stored as UTC (`calendar.timegm`), but `write_datetime` formats with
`datetime.fromtimestamp(timestamp)`, which converts through local time. The DB gets the intended value and the
XMP gets a value off by the machine's UTC offset. Any later re-read of that sidecar shifts every corrected photo.
`tests/test_sidecar.py:153-163` asserts the asymmetric behaviour, and CI runs in UTC, so nothing catches it.
*Fix:* format with `datetime(1970,1,1,tzinfo=utc) + timedelta(seconds=ts)`; rewrite the test as a true round trip.

<a id="d2"></a>
**D2 — High — Pre-1970 dates raise `OSError` on Windows and are treated as undated** [run] — ✅ **DONE** (`timeutil.py` conversions; one predicate `index.HAS_DATE_SQL` = `photo_datetime != 0` / `timeutil.has_date`; undated-aware ordering; exactly 1970-01-01 00:00:00 still reads as undated)
`serializers.py:89,101`, `sidecar.py:311,317`, `services/work_queue_service.py:81`.
`datetime.fromtimestamp(negative)` raises `OSError [Errno 22]` on Windows, with or without `tz`.
`_validate_year_month` accepts years back to 1826, so assigning 1955 to a scan makes `/api/photo/{id}`,
`/api/photos/guess-dates` and `/api/crowds` return 500. Separately, about 18 `photo_datetime > 0` filters
(`api/stats.py:26,37`, `index.py:701`, `api/geotag.py:124`, `work_queue_service.py:121,130,170`,
`roadtrip_service.py:169`) class these photos as undated, so they never leave the Undated grid, never form
sessions, and never anchor a route.
*Fix:* same timedelta arithmetic as D1; use `IS NOT NULL AND != 0` as the "has a date" predicate, behind one helper.

**D3 — Medium — `update_geotag` leaves sub-location and postal code behind** [seen] — ✅ **DONE** (`index.DERIVED_LOCATION_COLUMNS` is the single list; `update_geotag` clears all eight)
`index.py:636-641`. The UPDATE clears city, state, county and country, but not `loc_sublocation` or
`loc_postal_code`. After a geotag removal or move, the photo still shows and searches under the old values.
*Fix:* clear both columns.

**D4 — Medium — Removing a geotag can be undone by the next scan** [traced] — ✅ **DONE** (`sidecar.sidecar_tracking` for every writer; removal recorded as `photos.geotag_removed` plus `GPSStatus=V` in the sidecar when one exists; DB-only removals without a sidecar are lost on a DB rebuild)
`services/geotag_service.py:75`, `index.py:1066`, `scanning.py:37`.
`remove_geotag` stores `str(sc)` (full path, even when no sidecar exists) where the scanner compares
`sc.name` or `None`. `is_fresh` therefore fails, the file is re-read, and a photo with GPS embedded in the
original gets its coordinates back. Behaviour differs depending on whether a sidecar exists.
*Fix:* store `sc.name if sc.exists() else None`, and persist an explicit "removed" marker that `upsert_photo` honours.

**D5 — Medium — `upsert_photo` changes coordinates without invalidating derived data** [traced] — ✅ **DONE** (moved coordinates clear `loc_*`/`geocoded_at`; changed checksum drops the semantic embedding. Faces deliberately NOT re-queued: a face rescan would delete manual person tags)
`index.py:608-622`. When a sidecar is edited externally, `lat`/`lng` update but `loc_*` and `geocoded_at`
stay, so place names are stale forever. A changed file likewise keeps its old faces, `faces_scanned_at` and embedding.
*Fix:* null `geocoded_at` and `loc_*` in the upsert when coordinates differ; reset scan markers when `checksum` changes.

**D6 — Medium — The `path`-column table rebuild is not atomic** [run, for the DDL behaviour] — ✅ **DONE** (create-copy-drop-rename in one explicit transaction; startup recovers a leftover `photos_old`; a `faces` FK left pointing at `photos_old` by the old migration is repaired by a checked one-time rebuild of `faces`)
`index.py:158-202`. Python's `sqlite3` does not open a transaction for DDL, so `ALTER TABLE … RENAME` and
`CREATE TABLE` commit immediately. A crash during the copy leaves an empty `photos` plus an orphaned
`photos_old`, and the next start does not recover it; a rescan then assigns new ids while `faces.photo_id`
holds the old ones. The RENAME also rewrites the `faces` foreign key to point at `photos_old`.
Only affects databases old enough to need this migration.
*Fix:* explicit `BEGIN IMMEDIATE`/`COMMIT`, create-copy-drop-rename order, and detect a leftover `photos_old` at startup.

**D7 — Medium — Batch geotag writes are non-atomic and report nothing on partial failure** [traced] — ✅ **DONE** (coordinates range-checked at API, service and sidecar; per-photo isolation; response is `{results, written, failed, not_found}`; 502/404 when nothing was written; invalidation in `finally`)
`services/geotag_service.py:27-80`, `api/geotag.py:35-44`. One ExifTool error mid-batch returns 500 after
earlier photos were written; cache invalidation after the loop is skipped; unknown ids are silently dropped;
`lat`/`lng` have no range validation, so `lat=999` reaches XMP.
*Fix:* `Field(ge=-90, le=90)` and `ge=-180, le=180`; per-photo try/except returning `{written, failed}`; invalidate in `finally`.

**D8 — Medium — `/api/photos/update-times` double-applies offsets on retry** [traced]
`services/photos_service.py:26-62`. Relative offsets are applied with a commit per photo. A failure mid-batch
returns 500, and a client retry shifts the already-done photos again.
*Fix:* send absolute target timestamps, or return per-id results.

**D9 — Low — `representative` flag survives reassignment** [traced]
`index.py:1855,1886,1917,2024,2052`. Reassigning, unassigning or ignoring a face leaves `representative=1`,
so the new person inherits a stale representative. Only `delete_person` resets it.

**D10 — Low — Bulk assign unassigns by omission** [seen]
`api/faces.py:317-324`. A request with no `person_id`, a blank `name` and `clear=false` falls through to
`assign_faces(ids, None)` and wipes existing labels. `"assigned"` echoes the input length, not rows changed.
*Fix:* 400 unless exactly one of `person_id`, `name`, `clear` is supplied; return the rowcount.

**D11 — Low — Backup has no restore path and omits DB-only data** [traced]
`services/backup_service.py:42-53`. Only `build_backup` exists, so the format is never exercised. It omits
`geocode_ignored` and `gps_accuracy`, and anchors on absolute directories, so a moved library cannot be matched.
*Fix:* add the fields, store directories relative to the scan root, implement restore with a round-trip test.

## Concurrency

<a id="c1"></a>
**C1 — High — One shared SQLite connection, no lock, no rollback** [seen] — ✅ **Done** (`22ad220`: `index.transaction()`; unlocked readers can still see uncommitted writes)
`index.py:40`. `check_same_thread=False`, used by the event loop, the executor threads and the scan workers.
There are zero `rollback()` calls in `src/`. Consequences:

- A commit from one thread commits another thread's half-finished multi-statement write
  (`replace_faces` at `index.py:1423-1451`, `delete_person`, `delete_photo_faces`, `set_person_representatives`).
- An exception mid-function leaves its statements pending, and the next unrelated commit persists them.
- Readers on the same connection see uncommitted state.
- `cur.lastrowid` in `replace_faces` may read another thread's insert [unverified].

*Fix:* either a module-level `RLock` plus a `with index.transaction():` context manager that commits or rolls
back, or one locked writer connection with per-thread readers (WAL already supports this). This is the
largest single change in the audit, and it unblocks P1.

<a id="c2"></a>
**C2 — High — `create_function` is called on every place search** [run] — ✅ **Done** (`1d9723a`)
`index.py:854,1145`. SQLite refuses to redefine a function while any statement on the connection is active;
this raises `OperationalError: Error creating function`. `/api/search` only catches `ValueError`, so the result
is an intermittent 500 on `/api/search?place_id=`, `/api/search/untagged-faces` and `/api/places?stats=true`
whenever another request is mid-query.
*Fix:* register once in `init_db()`.

**C3 — Medium — Thumbnail cache files are written non-atomically** [traced] — ✅ **Done** (`9af6528`)
`thumbnails.py:352-356,382,406-411,429-434,491-508`. `if cached.exists(): return cached.read_bytes()` then
`cached.write_bytes(data)`. A concurrent request can read a partial file; a crash mid-write leaves a truncated
file served forever.
*Fix:* write to a temp name and `os.replace`; treat zero-length as a miss.

**C4 — Medium — ExifTool lock held across up to three calls, no timeout on the server path** [traced] — ✅ **Done** (`8ee5ae6`: watchdog + one-call preview; session pool not done)
`thumbnails.py:167-174`, `exiftool_session.py:13`. Videos without an embedded preview pay three failed
round-trips under the global lock. A file that hangs ExifTool wedges every executor thread;
`run_with_timeout` is only used by scripts.
*Fix:* order tags per extension, add a watchdog timeout with restart, consider a small session pool.

**C5 — Low — Census `_has_zctas()` races with `reset()`** [traced] — ✅ **Done** (`597c423`)
`census_places.py:75-85,188-191`. Runs outside `_lock` on every `postal_lookup`; `_conn` can become `None`
between the check and the lock.

## Scanning and indexing

<a id="s1"></a>
**S1 — High — Unparseable dates make a file permanently stale** [seen]
`sidecar.py:123-127`, `index.py:1075`. `_parse_exif_datetime` returns `None` for any truthy but unparseable
value, and `is_fresh` treats `None` as "never read". Triggers include `QuickTime:CreateDate` of
`0000:00:00 00:00:00` (common in videos), sub-seconds, and timezone suffixes. Those files get two ExifTool
calls and a full SHA-256 on every startup. The `or` chain also stops at the first truthy garbage value
instead of trying the next candidate.
*Fix:* parse each candidate in turn, store 0 when none parse, and tolerate `.ss` and `±hh:mm`/`Z` suffixes.

**S2 — Medium — The scan never prunes vanished files** [traced]
`scanning.py:31-38`. There is no `DELETE FROM photos` in `src/`. Deleted or moved files stay as rows that 500
on thumbnail; a moved file becomes a new row and loses its faces and DB-only geotag.
*Fix:* after a successful scan, diff the rows under the root against the seen set, re-link by `checksum`, and
delete or flag the rest (cleaning faces and embeddings explicitly, since foreign keys are off).

**S3 — Medium — The whole scan runs inside the lifespan before the server accepts requests** [traced]
`lifespan.py:82-88`. On first run the port does not answer for minutes to hours. Only the first five warnings
print, and a file whose metadata read fails is silently absent and retried every boot.
*Fix:* run the scan as a background task with a status endpoint; persist per-file scan errors.

**S4 — Medium — Scan-time thumbnails ignore orientation** [traced]
`scanning.py:121-127`, `api/photos.py:210-214`. The scan writes `{key}_thumb.webp`; the API looks for
`{key}_thumb_o6.webp`. For every rotated photo the scan's thumbnail is never served. The scan also keys on
`stat.st_mtime` while the API keys on the DB `mtime`.

**S5 — Low — Sidecar collision check skips videos** [traced]
`scanner.py:38`. In `basename` mode an iPhone Live Photo pair (`IMG_1.HEIC` + `IMG_1.MOV`) shares
`IMG_1.xmp`, so geotagging one silently applies to the other, with no warning.

**S6 — Low — `QuickTime:CreateDate` is UTC, EXIF dates are local wall-clock** [traced]
`sidecar.py:103,126`. Both go through the same `timegm`, so phone videos sit offset from photos by the UTC
offset, which skews time-neighbour inference and session grouping.

**S7 — Low — GPS fallback loses the hemisphere and accepts 0,0** [traced]
`sidecar.py:112-113`. `Composite:GPSLatitude or GPS:GPSLatitude` treats 0.0 as missing and falls back to the
unsigned raw tag.

## Faces and semantic search

<a id="f1"></a>
**F1 — High — A systemic failure marks the whole library as processed** [seen, faces path]
`services/faces_service.py:27-34`, `services/semantic_service.py:46-49`. Any exception, including the model
failing to load, runs `index.replace_faces(pid, [])` or stores a null embedding. The client loop then walks
every photo, and neither queue ever retries those rows.
*Fix:* load the model once before the loop and abort the batch on model errors; tombstone only per-file
decode errors; add a "retry failed" action.

<a id="f2"></a>
**F2 — High — Newly detected faces never reach suggestions during a session** [seen]
`faces.py:573-605`, `index.py:1414-1455`. A first-time `replace_faces` does not bump the generation, relying
on the next label action to rebuild. But `drop_from_unlabeled_cache` unconditionally re-tags the old cache
with the current generation (`faces.py:605`), so the rebuild never happens until an unassign or a restart.
*Fix:* re-tag only when `old_gen == faces_generation() - 1`; have `replace_faces` invalidate the unlabeled
cache when it inserts faces.

**F3 — Medium — Face settings changes do not invalidate face caches** [traced]
`api/status.py:52-58`, `faces.py:407-418`. `_invalidate_for` only handles `WORKQUEUE_*`. `FACE_MATCH_THRESHOLD`
and related knobs are baked into three caches, and with F2 they survive indefinitely.

**F4 — Medium — Per-person gate drops matches for people with more than 200 examples** [traced]
`faces.py:899-911,950-958`. The comment says the rank pass recovers false negatives, but the rank pass only
runs on candidates that already passed the threshold.

**F5 — Low — `replace_faces` deletes labelled faces without bumping the generation** [traced]
`index.py:1434`. A rescan of a photo with tagged faces leaves the gallery cache holding deleted embeddings.

**F6 — Low — Batch and gate paths ignore `date_precision`** [traced]
`faces.py:716-741,920-933` versus `:636-649`. Single and batch lookups can disagree for year-precision photos.

## Geocoding and datasets

**G1 — High — Downloads write straight to the final filename** [seen, for the OSM path]
`services/data_service.py:255-264`, `semantic.py:96-102`. A timeout leaves a partial `.pbf` that the next run
accepts as cached. No `Content-Length` or checksum check anywhere. A truncated model file feeds F1.
*Fix:* `.part` plus `os.replace`, compare bytes to `Content-Length`, verify GeoFabrik's `.md5`.

**G2 — High — `geocode_cache` is never invalidated** [traced]
`osm_builder.py:312-337`, `geocode.py:806-821`, `index.py:1225-1252`. The OSM merge commits into the live DB
while lookups run, so a point whose polygon is not inserted yet caches `city=None`. Nothing ever deletes from
the cache, so pre-install answers are served forever for that cell.
*Fix:* build to a temp file and swap (as the census builder does); clear or version the cache after every dataset job.

**G3 — High — A first-time OSM or GeoNames install has no effect until restart** [seen, for the missing `reset()`]
`osm_places.py:72-79`, `geocode.py:71-78`. `_state` latches to `"unavailable"`, and only `census_places` has a
`reset()`.

**G4 — High — Census rebuild can fail at the final swap on Windows** [traced]
`services/data_service.py:384-386`, `census_builder.py:462-464`. `reset()` runs before the multi-minute build;
any lookup in between reopens the old file, and `unlink`/`replace` then raises `PermissionError`.
*Fix:* reset and swap together under the lock; drop the `unlink` before `replace`.

**G5 — Medium — Hotspot grid misses neighbours within the merge radius** [run]
`services/hotspots_service.py:94-99`. Longitude bucket width depends on each point's own latitude, so indices
are not comparable across rows. A cell 90 m from a seed with a 100 m radius failed to merge in 22 of 72
directions at Seattle's latitude. Result: duplicate hotspots and duplicate work-queue proposals.

**G6 — Medium — City and state can disagree near borders** [traced]
`geocode.py:782-790`. City comes from polygon containment, but state and country always come from the nearest
GeoNames point. `census.lookup()` already returns `state` and it is discarded.

**G7 — Medium — `geocode_pending` gates on GeoNames only** [traced]
`services/geocode_service.py:13,41-43`. An OSM- or Census-only install never geocodes, and
`export_to_sidecars` skips cities when `loc_country_code` is null.

**G8 — Medium — OSM re-merge never refreshes existing places** [traced]
`osm_builder.py:270-271,331-336`. `INSERT OR IGNORE` keeps old geometry and names; deleted features persist.

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

**A2 — Medium — Duplicate names return 500; PATCH applies partially** [traced] — ✅ **Done** (409 on duplicates, 404 on unknown ids, PATCH atomic; `POST /api/persons` is now strict create)
`api/faces.py:106-125,136-151`. `persons.name` and `families.name` are `UNIQUE`, so a rename collision raises
an uncaught `IntegrityError`. `api_update_person` commits the rename before validating `birth_date`, so a 400
response has already changed the name. Unknown ids return 200.
*Fix:* validate first, apply in one transaction, map to 409, 404 on `rowcount == 0`.

**A3 — Medium — Search results silently capped at 2000** [seen]
`api/search.py:71,127`, `web/search.js:271,285`. `total` is `len(photos)`, so the page reads
"2,000 photos found" and "Select all" acts on a partial set.
*Fix:* return the true total and a `truncated` flag; show "first 2,000 of N".

**A4 — Medium — Unbounded and unvalidated parameters** [traced] — ✅ **Done** (bad bbox/date = 400, id lists via `json_each`, limits bounded; `/api/photos` deliberately still unpaged — map loads full set)
- `/api/photos` has no paging; an unparseable `bbox` or date is silently dropped (`index.py:712,727,739`), so a typo returns the whole library.
- `/api/photos/by-location` passes `limit=10_000_000` (`api/photos.py:166`).
- Id lists are expanded into `IN (?,…)` (`index.py:685,1469,2015`); more than 32,766 ids gives a 500.
- `api/geocode.py:47,59,77,103,125` limits lack `ge=1`; a negative value becomes SQLite's unlimited `LIMIT -1`.

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

<a id="x1"></a>
**X1 — High — No Host or Origin validation** [traced; not exploited]
`main.py:24-30`. The API is unauthenticated on loopback.
- **DNS rebinding:** a page that rebinds its hostname to `127.0.0.1:8000` becomes same-origin and can read
  absolute paths, download originals and call every write endpoint.
- **Cross-site POST:** JSON-body endpoints are protected only by FastAPI's strict content-type default, and
  `fastapi` is unpinned. Body-less POSTs are forgeable today with a plain form:
  `/api/geocode/export-sidecars`, `/api/faces/dedup/recompute`, `/api/data/*/download`, `/api/semantic/scan`.
- `--network` binds `0.0.0.0` with no authentication.

*Fix:* `TrustedHostMiddleware` (localhost, 127.0.0.1, plus the LAN IP under `--network`); a small middleware
rejecting non-GET requests whose `Origin`/`Sec-Fetch-Site` is cross-site; pin `fastapi>=0.132`.

**X2 — Medium — Undeclared runtime network dependencies** [seen]
CLAUDE.md sanctions only Leaflet and OSM tiles and forbids online geocoders. The code also uses:
- Nominatim place search, sending typed queries to a third party (`web/app.js:2159-2160`; no `res.ok` check).
- Esri satellite tiles (`web/app.js:76-92`, `web/map.js:96-106`, `web/custom-places.js:31-41`).
- `leaflet.markercluster` and `vis-timeline` from unpkg (`web/map.html:8-29`, `web/timesync.html:7,78`).

No CDN tag carries a Subresource Integrity hash. *Decide:* sanction these in CLAUDE.md, or replace place
search with the offline `/api/search/locations` and vendor the rest. Add `integrity` attributes either way.

**X3 — Medium — `?back=` is navigated to unvalidated** [traced]
`web/photo-faces.js:25,75`. `photo-faces.html?photo_id=1&back=javascript:…` runs script in the app origin when
Back is clicked. *Fix:* accept only same-origin paths.

**X4 — Medium — Two unescaped filenames in HTML sinks** [traced] — ✅ **Done** (both escaped; sweep of other HTML sinks found none)
`web/timesync.js:107-110` (`title="${item.filename}"`) and `web/roadtrip.js:626` (dormant). Missed by the
recent XSS sweep.

No SQL injection was found: every f-string interpolates fixed fragments, `int()` casts or whitelisted field
names. No archive is extracted to disk. Download URLs are fixed HTTPS constants.

## Performance

**P1 — Medium — Scan does one query and one fsync per file** [traced] — ✅ **Done** (`synchronous=NORMAL`, `fresh_flags` preload, 200-row / 1 s batches; 3000-file synthetic scan 7.5 s → 1.6 s)
`index.py:626`, `scanning.py:88`. `upsert_photo` commits per row at the default `synchronous=FULL`.
*Fix:* `PRAGMA synchronous=NORMAL`, preload existing rows in one query, batch commits.

**P2 — Medium — Two full tree walks that descend into the thumbnail cache** [traced] — ✅ **Done** (`scanner.walk_media`: one pruned `os.scandir` walk; 2k files + 50k cache files: ~500 ms → ~6 ms)
`scanning.py:18,31`, `scanner.py:20-22`. `rglob("*")` runs twice and filters `.geotagger` only after enumeration.
*Fix:* one `os.walk` that prunes the cache directory.

**P3 — Medium — `photos_spatial_update` fires on every UPDATE of `photos`** [seen] — ✅ **Done** (`AFTER UPDATE OF lat, lng`, old trigger dropped and recreated in `init_db`)
`index.py:448`. No column list, so every face-scan, checksum or date write does an R*Tree delete and insert.
*Fix:* recreate as `AFTER UPDATE OF lat, lng`.

**P4 — Medium — `download-zip` builds the archive of originals in RAM, twice** [seen] — ✅ **Done** (temp-file zip, `GEOTAGGER_ZIP_MAX_BYTES` cap = 413, all-missing = 404, form-POST navigation download)
`api/photos.py:459-498`, `web/search.js:1113-1127`. `BytesIO` on the server and `res.blob()` in the tab. A few
hundred RAW files is several GB in each. An all-missing selection returns 200 with an empty zip.
*Fix:* cap by total bytes, stream from a temp file, and use a plain navigation download.

**P5 — Medium — Full-resolution JPEG decode before downscale** [traced] — ✅ **Done** (`thumbnail()` now runs before `convert()` for JPEG/MPO so Pillow's own draft engages; 24 MP → 256 px: ~110 ms → ~40 ms)
`thumbnails.py:255-259`. `convert("RGB")` runs before `thumbnail()`, forfeiting Pillow's DCT draft mode.
*Fix:* `img.draft("RGB", (max, max))` first.

**P6 — Medium — Semantic `rank()` copies the whole matrix per query** [seen] — ✅ **DONE** (unfiltered path scores `mat @ q` in place; 100k × 768 synthetic: peak 308 MB → 0.4 MB, 96 ms → 8 ms per query)
`semantic.py:264,275`. `mat[np.arange(len(ids))] @ q` — about 300 MB at 100k photos. Use `mat @ q`.

**P7 — Medium — Geocode grid and map do not scale** [traced] — ✅ **DONE** (rAF-throttled scrubber, one render per commit, reused cells + `content-visibility`, saved pins clustered; 400-photo scratch run: scrubber drag 61 → 2 rebuilds, 20-point commit 21 → 1 renders)
`web/app.js:1656-1792,1958-2015`. Every filter or stage rebuilds every cell; every geotagged photo is its own
DOM marker with no clustering; the date scrubber triggers a full rebuild per `pointermove`; committing N
points causes N full re-renders.
*Fix:* rAF-throttle, `markerClusterGroup` (already used in `map.js`), `content-visibility: auto`, batch the commit.

**P8 — Medium — People grid: no virtualisation, and a cache that misses 100% above 3000 faces** [traced] — ✅ **DONE** (cache sized from `FACE_LIMIT`, LRU refresh on hit, one rebuild per accept-suggestions, `content-visibility`; 3940-face scratch run: 2,400–3,940 → 0 images recreated per rebuild. Still no virtual scroller)
`web/people.js:962-964,2942-2956`, `web/face-grid.js:18-27,42-50`. `CROP_IMG_CACHE_MAX = 3000` but
`FACE_LIMIT = 5000`, with no LRU refresh on hit, so every rebuild recreates every image. "Accept suggestions"
does one full rebuild per suggested person.

**P9 — Low** [traced] — ✅ **DONE** (all six: chunked geocode writes, memoised bounds parse, cache drops embedding blobs, 256-row cluster slab, ids-only search, narrow `get_photos` columns) — `geocode_pending` commits twice per photo (`services/geocode_service.py:18-21`);
`covered_by_place` re-parses bounds JSON per cluster × place (`hotspots_service.py:299-301`);
`_unlabeled_cache` holds embeddings twice (`faces.py:513-515`); `cluster_unlabeled` allocates (1024, N)
(`faces.py:1012`); `find_untagged_face_photos` loads every row to build an id set (`faces_service.py:220-225`);
`get_photos` is `SELECT *` with no limit (`index.py:742`).

## Frontend bugs

<a id="w1"></a>
**W1 — High — A stale date filter hides every photo in folder scopes** [traced]
`web/app.js:1323-1327,1454-1457,2423-2428`. Folder scopes skip `buildHistogram()`, and
`setTimelineAvailable(false)` never fires `onChange`, so the previous scope's date range stays active.
Open June 2019, then a folder dated 2021: "Showing 0 of N".
*Fix:* zero the four date variables when the timeline is unavailable.

<a id="w2"></a>
**W2 — High — `setGeocodeIgnored` never checks `res.ok`** [seen]
`web/app.js:2082-2096`. On a 4xx/5xx, local state is mutated, staged entries are deleted, and the UI reports
"Committed N".

**W3 — High — Stale async responses overwrite newer state, in several places** [traced]
No request token or abort in: `people.js:696-714,1967-1978,2109-2124` (click "Discover groups" then
"Unlabeled" and the cluster response replaces the grid); `photo-faces.js:151-196` (fast Prev/Next shows one
photo's faces on another, and "Ignore unlabeled" then posts for the wrong photo); `app.js:1258-1335,2189-2336`
(month A then month B; j/k held; "Guess location" applies an old photo's guess to the new focus);
`custom-places.js:999-1048,762-785`; `map.js:267-408`; `home.js:430-471`; `representatives.js:51-62`.
*Fix:* one shared sequence-token helper used by every loader.

**W4 — High — Document-level Enter handler on Search** [traced]
`web/search.js:1371-1376`. Enter in the text input fires two concurrent searches. Enter in the Assign-date
year field runs a search behind the modal, clearing the selection, so Apply posts an empty `photo_ids`.

**W5 — High — Manage page delete confirm never warns about tagged faces** [traced]
`web/people-manage.js:310,326-329`, `api/faces.py:84-90`. `/api/persons` returns no `face_count`, so the
warning branch never runs while the server unassigns every face. The Faces column always shows "—".

**W6 — Medium — Scope state is not reset consistently** [traced]
`web/app.js:344-357,658-682,2885`. `batchScope` is never nulled, so changing a filter after visiting a folder
reloads the old folder. `selectedIds` is never pruned, so `L`/`I` act on photos no longer visible.

**W7 — Medium — `?` shortcut fires inside text inputs** [seen]
`web/app.js:3095`. The check runs before the input guard at line 3098, so typing "?" in a search box opens
the help modal. `people.js:1906` has the same order [seen; whether its guard precedes was not checked].

**W8 — Medium — Time Sync shows saved photos double-shifted** [seen]
`web/timesync.js:656-657`. `await loadPhotos(); appliedOffsets = {};` is in the wrong order.

**W9 — Medium — Local-time getters on wall-clock-as-UTC values** [traced]
`web/search.js:488-490,807-809,1206-1215`, `web/timesync.js:399,559-561`, `web/people.js:1101-1103,1156-1158,2391`,
`web/face-grid.js:72-87`. West of UTC, a photo taken 1 Jan 00:30 lands under the previous December.
*Fix:* one shared UTC date helper.

**W10 — Medium — `loadFaces` and `loadPersons` never check `res.ok`** [traced]
`web/people.js:507-508,712-714`. A 422 leaves `faces` undefined and every later handler throws.

**W11 — Medium — Shift-click after a filter change reads past the array** [traced]
`web/app.js:1844-1850`. `lastClickedIndex` is not reset by `applyFilters`.

**W12 — Medium — Search "untagged faces" mode leaves old results actionable** [traced]
`web/search.js:343-368,924-928`. "Select all" and "Open in Geocode" act on the previous, invisible result set.

**W13 — Medium — Tag page double-submit drops a group** [traced]
`web/tag.js:99-118,274-280,354-373`. Only three buttons are disabled in flight; a second tap splices twice.

**W14 — Medium — Data page poll loops have no `catch`** [traced]
`web/data.js:166-195,218-248,293-322,345-374,654-678,767-781`. A failed status fetch freezes progress with no
error. One generic `pollJob()` would also remove about 200 duplicated lines.

**W15 — Medium — Reloads re-select faces the user deselected** [traced]
`web/people.js:719-723,834-839,2814-2818`. In "Review guesses" every reload re-selects everything, so the
next Assign stages the wrong faces.

**W16 — Low** [traced]
- `Math.min(...tsList)` throws `RangeError` above roughly 100k photos (`app.js:2471-2472`, `search.js:1244-1245`) [seen].
- Batch loops spin forever if `remaining` stops decreasing (`home.js:279-330`) [unverified whether the backend guarantees progress].
- Crowds per-photo ignore mutates a throwaway copy; button stuck on "Ignoring…" (`people.js:2145,2225-2272`).
- `commitPending` has no in-flight guard (`people.js:3118-3147`).
- "Ignore unlabeled" receives the click event as `silent`, so its status never shows (`photo-faces.js:89,746`).
- j/k step into staged photos that have left the grid (`app.js:1876-1884`).
- "Open in Geocode" puts up to 2000 ids in the query string (`search.js:346`) [unverified against uvicorn's limit].
- Date inputs on Manage may save on each intermediate value (`people-manage.js:222-273`) [unverified].

## UX

**U1 — No way to merge two people** [traced] — `web/people-manage.js:198-211`. Renaming one person to
another's name fails with "Internal Server Error" (see A2). Add `POST /api/persons/{id}/merge` and a
"Merge into…" action; offer it on rename collision.

**U2 — No way to remove or undo a committed geotag** [traced] — `web/geocode.html:74-80`. The only caller of
`/api/geotag/remove` sits in a `display:none` block. Add "Remove location" to the context menu and an
"Undo last commit".

**U3 — One-click destructive actions without undo** [traced] — the "×" on a tagged card and "Ignore all N"
(`photo-faces.js:448-450,507,588-590`); group Ignore/Accept on Tag (1.8 s toast only); the hover-only "×"
beside "✎" in the People list (`people.js:597-615`). An Undo toast pattern would cover all of them.

**U4 — Missing loading states** [traced] — `loadFaces` and `loadPhotoScope` leave the old grid interactive
with no indication (`people.js:696-714`, `app.js:1315-1319`). The first-load status on People is overwritten
(`people.js:118-120`).

**U5 — `FACE_LIMIT` truncation is nearly invisible** [traced] — `people.js:702,746,783-784`. A person with
more than 5000 faces silently lacks the lowest-scoring ones, with no way to reach them. Add a persistent
banner with "Load more".

**U6 — Discover: any single-face action re-clusters the whole library** [traced] — `people.js:699,2561-2562`.
Patch the cluster locally, as `clusterAssign` already does.

**U7 — Staged tagging work is lost on crash or accidental close** [traced] — persist `pending` to
`sessionStorage`.

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

## Refactors

✅ **R1–R5 done** in `750e1b9`. Exceptions: `doRemoveGeotag` kept (wanted by U2); the `search.js` histogram
named in R3 turned out to be live UI and was left alone.

**R1 — Split `people.js` (3224 lines)** along its existing seams, as plain `<script>` files: state (with an
id `Map`), API (one `postJson` with `res.ok` and `detail` parsing, replacing about 12 near-identical fetch
blocks), pure grouping functions, grid, selection, detail, discover, crowds, staging, focus.

**R2 — Extract shared frontend code.** `BASEMAPS`/`setBasemap`/`addBasemapControl` are verbatim in `app.js`,
`map.js` and `custom-places.js`. `camColor`, `renderLegend`, the thumb-cell builder and `showDetail` repeat
across `app.js`, `search.js` and `timesync.js`. `MONTH_NAMES` appears four times. `setStatus`, `loadPersons`
and `openFaceActions` are duplicated between `people.js` and `photo-faces.js`.

**R3 — Delete dead code.** The non-staged halves of five functions in `people.js` (`2519-2533`, `2705-2719`,
`2866-2913`); `doApplyLatLng`, `doCopyLocation`, `doRemoveGeotag` in `app.js`; the legacy canvas histogram
in `search.js:1170-1343`; `record_scan_root` and the `scans` table (`index.py:1004`); A11.

**R4 — Move the worker count into `config.py`.** `__main__.py:57` overwrites a user-set `GEOTAGGER_WORKERS`
with the argparse default; `--workers 0` crashes; `SIDECAR_MODE` is unvalidated, so a typo means `basename`.

**R5 — Smaller items.** The two init branches in `lifespan.py:63-113` duplicate five calls. Date parsing is
duplicated in `index.py:714-740` and `815-836`. `lifespan.py` never shuts down the executor or closes the DB.
A failed `VACUUM` leaves the session out of WAL mode (`index.py:562-566`). `count_geotagged_photos` is a weak
change-stamp (`index.py:1293-1298`); use a generation counter.

## Tests, CI and repository hygiene

**T1 — A test pins a bug.** `tests/test_sidecar.py:153-163` asserts the D1 asymmetry.

**T2 — Untested routes.** `/api/photos/update-times`, `/api/photos/guess-dates`,
`/api/geocode/export-sidecars`, `/api/faces/nuke`, `/api/faces/dedup/*`, `/api/stats/faces-months`, and the
download routes. Nothing covers pre-1970 dates, duplicate names, malformed place bounds, partial batch
failure, or any concurrent request.

**T3 — CI runs `pytest` only.** No lint or type check. `ruff` with F401/F821 would have caught A11.
CI also runs in UTC, hiding D1; add a job with `TZ` set to a non-UTC zone.

**T4 — Write-path tests skip silently when ExifTool is missing.** `tests/api/test_geotag.py:60`,
`tests/api/test_photos.py:284`. Fail instead when `CI=true`.

**T5 — The `client` fixture leaks four threads per API test.** Nothing calls `shutdown` on the executor.

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

1. **One-line and small fixes with outsized effect:** C2, D3, P3, W2, W7, W8, A11, T6.
2. **Date handling as one change:** D1, D2, S1, W9, T1, plus a non-UTC CI job. One shared helper on each side.
3. **Concurrency foundation:** C1, then A1 and P1 on top of it.
4. **Face pipeline trust:** F1, F2, F3, G1.
5. **Dataset lifecycle:** G2, G3, G4, A7.
6. **Frontend stale-response helper:** W3, then W1, W4, W6.
7. **Security middleware:** X1, X3, X4, and a decision on X2.
8. **UX features:** U1 (merge people), U2 (remove geotag), U3 (undo toast).
9. **Structure:** R1, R2, T3.
