# Lightroom Classic export — feasibility notes

Idea: select a set of photos in geo-tagger, group them into a "project", and export
something Lightroom Classic can open as a collection. Assumes LR runs on the same
machine with the same absolute file paths as the geo-tagger DB.

Status: **not implemented** — exploratory notes only.

## What a `.lrcat` actually is

A SQLite database. ~100 tables, Adobe-proprietary, **no public schema spec**, and the
schema changes between Lightroom releases. LR "upgrades" foreign catalogs when opening
them; a wrong schema version means refusal or corruption. Nothing technically prevents
writing one, but doing so means owning the reverse-engineering indefinitely.

## Option A — write a real `.lrcat` (heaviest)

Minimum tables involved:

- `AgLibraryRootFolder` — drive root, absolute path
- `AgLibraryFolder` — path relative to the root folder
- `AgLibraryFile` — basename, extension, folder FK
- `Adobe_images` — the photo record: fileFormat, captureTime, rating, orientation
- `Adobe_AdditionalMetadata` — XMP blob, `externalXmpIsDirty`
- `AgHarvestedExifMetadata` — `gpsLatitude` / `gpsLongitude`; this is what makes the LR
  Map module show pins without re-reading the files
- `AgLibraryCollection` + `AgLibraryCollectionImage` — the "project" grouping

Every row needs an `id_local` (int) and an `id_global` (UUID), and cross-table FK
ordering matters.

Do **not** hand-write the `CREATE TABLE` schema. Instead ship a template: the user
creates one empty catalog in *their* LR version, we `shutil.copy2()` it and INSERT rows.
That sidesteps most version drift, but adds a user-specific setup step and still breaks
on LR upgrades.

Photos themselves are fine — LR builds previews on open — as long as the files exist at
the exact recorded paths.

## Option B — smart collection file (`.lrsmcol`)

A plain-text Lua table, importable via Collections panel → right-click → *Import Smart
Collection Settings*. We emit rules; LR resolves them against whatever is already in the
user's catalog. No schema risk, tiny file.

Limitation: rules are criteria-based (filename, keyword, folder), not an explicit list of
photo IDs. Large literal filename OR-lists get unwieldy fast.

## Option C — keyword in sidecar + collection by keyword (recommended)

We already write XMP sidecars (`src/geotagger/sidecar.py`, `SIDECAR_MODE`). Add
`-XMP-dc:Subject+=Project/<name>` (or `lr:hierarchicalSubject`) to the selected set.
Then:

1. User imports / synchronizes the folder in LR (or, if already imported,
   Metadata → *Read Metadata from File*).
2. The keyword appears in the LR keyword list.
3. Pair it with a generated `.lrsmcol` whose single rule is
   `keyword contains "Project/<name>"` — one-click collection, exact membership, no
   fragile ID mapping.

Zero Adobe schema dependency, reuses the existing ExifTool write path, and GPS already
flows through the same sidecars.

**Caveat:** sidecar keywords only reach LR if the user reads metadata from file. LR does
this automatically on import, but *not* for photos already in the catalog.

## Recommendation

Ship **Option C**. Scope is small: an export endpoint, a keyword write, and an `.lrsmcol`
emitter.

Pursue **Option A** only if geo-tagger should become the catalog source of truth for a
fresh Lightroom install — a much larger project with permanent maintenance cost.

**Option B** alone is weaker than C; it is really the delivery mechanism *for* C.
