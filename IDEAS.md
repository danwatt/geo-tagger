# Ideas / Backlog

Parked ideas for geo-tagger, to revisit later.

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
  center. *(Top brainstorm pick alongside clustering, 2026-06-28.)*

## Geo / locating photos

- **Bulk "geotag by time" queue** — the geo analog of the face Accept-all flow:
  surface every untagged photo that has a confident time-based location guess
  (`/api/guess` already computes these one at a time) and accept per trip/day.

- **Reverse-geocode coordinates → city/country** — turn raw lat/lng into place
  names so photos are searchable/labelable by text ("Paris") instead of only
  drawn boxes; enables grouping by location name.
