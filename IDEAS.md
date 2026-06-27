# Ideas / Backlog

Parked ideas for geo-tagger, to revisit later.

## Faces

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
