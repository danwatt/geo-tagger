import { describe, expect, it, beforeEach } from "vitest";
import {
  IGNORE_LABEL, REMOVE_LABEL, STAGED_KEY, UNDO_COMMIT_KEY, classifyRestore, dropEntry, groupStaged, ignoreEntry,
  loadLastCommit, loadStagedRecords, pointKey, recordsToSave, removeEntry, saveLastCommit, saveStagedRecords,
  stagedPins, stagingReducer, toRecord, validRecord, type Photo, type Staged, type StagedEntry,
} from "./staging";

const photo = (id: number, extra: Partial<Photo> = {}): Photo => ({ id, filename: `p${id}.jpg`, lat: null, lng: null, geocode_ignored: false, ...extra });

describe("stagingReducer", () => {
  it("stages, overwrites a re-staged photo, and unstages", () => {
    let s: Staged = new Map();
    s = stagingReducer(s, { type: "stage", entries: [dropEntry(photo(1), 10, 20, null, null, "Paris")] });
    s = stagingReducer(s, { type: "stage", entries: [ignoreEntry(photo(1)), ignoreEntry(photo(2))] });
    expect(s.get(1)?.kind).toBe("ignore");
    expect(s.size).toBe(2);
    s = stagingReducer(s, { type: "unstage", ids: [1] });
    expect([...s.keys()]).toEqual([2]);
  });

  it("returns the same map when nothing changes", () => {
    const s: Staged = new Map([[1, ignoreEntry(photo(1))]]);
    expect(stagingReducer(s, { type: "unstage", ids: [9] })).toBe(s);
    expect(stagingReducer(s, { type: "stage", entries: [] })).toBe(s);
  });
});

describe("groupStaged", () => {
  it("orders places A→Z, raw coordinates after, then removals, then no-location marks", () => {
    const groups = groupStaged([
      ignoreEntry(photo(1)),
      dropEntry(photo(2), 1, 1, null, null, "📌 1.00000, 1.00000"),
      removeEntry(photo(3, { lat: 5, lng: 5 })),
      dropEntry(photo(4), 2, 2, null, null, "Zurich"),
      dropEntry(photo(5), 3, 3, null, null, "Austin"),
      dropEntry(photo(6), 3.5, 3, null, null, "Austin"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Austin", "Zurich", "📌 1.00000, 1.00000", REMOVE_LABEL, IGNORE_LABEL]);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual([5, 6]);
  });

  it("pins one marker per distinct point", () => {
    const s: Staged = new Map<number, StagedEntry>([
      [1, dropEntry(photo(1), 1, 1, null, null, "A")],
      [2, dropEntry(photo(2), 1, 1, null, null, "A")],
      [3, dropEntry(photo(3), 1, 1, 500, null, "A")],
      [4, ignoreEntry(photo(4))],
    ]);
    const pins = stagedPins(s);
    expect(pins.map((p) => p.count)).toEqual([2, 1]);
    expect(pointKey({ lat: 1, lng: 2, accuracy: null })).toBe("1.000000,2.000000,");
  });
});

describe("U7 records", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps the legacy record shape", () => {
    const p = photo(7, { lat: 1, lng: 2, geocode_ignored: true });
    expect(toRecord(dropEntry(p, 10, 20, 50, null, "Here"))).toEqual({
      id: 7, lat: 10, lng: 20, accuracy: 50, loc: null, label: "Here", was: { lat: 1, lng: 2, gi: true },
    });
    expect(toRecord(ignoreEntry(p))).toEqual({ id: 7, ignore: true, was: { lat: 1, lng: 2, gi: true } });
    expect(toRecord(removeEntry(p))).toEqual({ id: 7, remove: true, was: { lat: 1, lng: 2, gi: true } });
  });

  it("round-trips through sessionStorage under the legacy key and sweeps other versions", () => {
    sessionStorage.setItem("geotagger.staged.geocode.v0", "old");
    expect(saveStagedRecords([{ id: 1, ignore: true }])).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(STAGED_KEY)!)).toMatchObject({ v: 1, entries: [{ id: 1, ignore: true }] });
    expect(loadStagedRecords()).toEqual([{ id: 1, ignore: true }]);
    expect(sessionStorage.getItem("geotagger.staged.geocode.v0")).toBeNull();
    saveStagedRecords([]);
    expect(sessionStorage.getItem(STAGED_KEY)).toBeNull();
  });

  it("validates records and merges the carry", () => {
    expect(validRecord({ id: 1, lat: 95, lng: 0, label: "x" })).toBe(false);
    expect(validRecord({ id: 1, lat: 5, lng: 0 })).toBe(false);
    expect(validRecord({ id: 1, remove: true })).toBe(true);
    const staged: Staged = new Map([[2, ignoreEntry(photo(2))]]);
    expect(recordsToSave(staged, [{ id: 2, remove: true }, { id: 3, ignore: true }]).map((r) => r.id)).toEqual([2, 3]);
  });

  it("drops gone and already-applied records, and counts photos changed elsewhere", () => {
    const current = new Map<number, Photo>([
      [2, photo(2, { lat: 10, lng: 20 })],          // already at its staged point
      [3, photo(3, { geocode_ignored: true })],      // already ignored
      [4, photo(4, { lat: 1, lng: 1 })],            // tagged elsewhere since
      [5, photo(5)],
    ]);
    const r = classifyRestore([
      { id: 1, ignore: true },
      { id: 2, lat: 10, lng: 20, accuracy: null, label: "A" },
      { id: 3, ignore: true },
      { id: 4, lat: 30, lng: 40, label: "B", was: { lat: null, lng: null, gi: false } },
      { id: 5, remove: true },   // no location: nothing to remove
      { id: 6, ignore: true },
    ], current, (id) => id === 6);
    expect(r).toMatchObject({ gone: 1, applied: 3, changed: 1 });
    expect(r.entries.map((e) => [e.id, e.kind, e.label])).toEqual([[4, "drop", "B"]]);
  });
});

describe("last commit (U2)", () => {
  beforeEach(() => sessionStorage.clear());
  it("stores, reloads and clears the snapshots", () => {
    saveLastCommit({ previous: [{ id: 1, expect: {} }], at: 5 });
    expect(loadLastCommit()).toEqual({ previous: [{ id: 1, expect: {} }], at: 5 });
    sessionStorage.setItem(UNDO_COMMIT_KEY, JSON.stringify({ previous: [{ id: "x" }] }));
    expect(loadLastCommit()).toBeNull();
    saveLastCommit(null);
    expect(sessionStorage.getItem(UNDO_COMMIT_KEY)).toBeNull();
  });
});
