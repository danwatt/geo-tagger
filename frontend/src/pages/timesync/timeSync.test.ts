import { afterEach, describe, expect, it } from "vitest";
import {
  applyOffset, batchProblems, classifyOffsetRestore, dayHistogram, filterPhotos, fitWindow, gridSelection, offsetRecords,
  offsetStore, resetOffsets, restoreDroppedNote, saveUpdates, settleSave, timelineSelection, totalOffset, validOffsetRecord,
  type Offset, type Photo,
} from "./timeSync";

const photo = (id: number, photo_datetime: number | null, camera: string | null = "Canon"): Photo =>
  ({ id, filename: `p${id}.jpg`, photo_datetime, camera, geocode_ignored: false });
const byId = (ps: Photo[]) => new Map(ps.map((p) => [p.id, p]));
const none = { shift: false, toggle: false };

afterEach(() => sessionStorage.clear());

describe("offset maths", () => {
  it("adds minutes and seconds, treating blanks and junk as 0", () => {
    expect(totalOffset("2", "30")).toBe(150);
    expect(totalOffset("-1", "15")).toBe(-45);
    expect(totalOffset("", "abc")).toBe(0);
    expect(totalOffset("1.9", "0")).toBe(60);   // parseInt, like the legacy page
  });

  it("applies relative to the original time, skips undated photos, keeps pre-1970 ones", () => {
    const ps = [photo(1, 1000), photo(2, null), photo(3, -5000), photo(4, 0)];
    const first = applyOffset(new Map(), byId(ps), [1, 2, 3, 4, 99], 60);
    expect(first.applied).toBe(2);
    expect(first.skipped).toBe(3);
    expect([...first.next]).toEqual([[1, { offset: 60, base: 1000 }], [3, { offset: 60, base: -5000 }]]);
    // Re-applying replaces, it doesn't add up.
    const again = applyOffset(first.next, byId(ps), [1], 30);
    expect(again.next.get(1)).toEqual({ offset: 30, base: 1000 });
    expect(resetOffsets(again.next, [1]).has(1)).toBe(false);
  });

  it("saves absolute expected/target pairs", () => {
    const offsets = new Map<number, Offset>([[1, { offset: 90, base: 1000 }], [2, { offset: -30, base: 500 }]]);
    expect(saveUpdates(offsets)).toEqual([
      { id: 1, expected: 1000, target: 1090 },
      { id: 2, expected: 500, target: 470 },
    ]);
  });

  it("clears what landed, conflicts and missing photos; keeps retryable failures", () => {
    const offsets = new Map<number, Offset>([1, 2, 3, 4].map((id) => [id, { offset: 10, base: 100 }]));
    const out = {
      results: [{ id: 1, photo_datetime: 110, unchanged: false }], written: [1], not_found: [2],
      failed: [{ id: 3, error: "date changed", conflict: true }, { id: 4, error: "ExifTool timed out" }],
    };
    const { next, retryable } = settleSave(offsets, out);
    expect([...next.keys()]).toEqual([4]);
    expect(retryable).toEqual([4]);
    expect(batchProblems(out)).toBe("3 failed: date changed");
    expect(batchProblems({ failed: [], not_found: [5] })).toBe("1 failed: photo not found");
    expect(batchProblems({ failed: [], not_found: [] })).toBe("");
  });

  it("fits the window to adjusted times", () => {
    const ps = [photo(1, 1000), photo(2, 2000), photo(3, null)];
    expect(fitWindow(ps, new Map([[2, { offset: 500, base: 2000 }]]))).toEqual({ start: 1_000_000, end: 2_500_000 });
    expect(fitWindow([photo(3, null)], new Map())).toBeNull();
  });
});

describe("selection", () => {
  const ps = [photo(1, 1, "A"), photo(2, 2, "B"), photo(3, 3, "A"), photo(4, 4, null), photo(5, 5, "A")];

  it("limits a grid shift-range to the anchor photo's camera", () => {
    expect([...gridSelection(new Set([1]), ps, 4, 0, { shift: true, toggle: false })]).toEqual([1, 3, 5]);
    expect([...gridSelection(new Set([1]), ps, 1, 0, { shift: false, toggle: true })]).toEqual([1, 2]);
    expect([...gridSelection(new Set([1, 2]), ps, 1, 0, { shift: false, toggle: true })]).toEqual([1]);
    expect([...gridSelection(new Set([1, 2]), ps, 3, 0, none)]).toEqual([4]);
    // No anchor yet: a shift-click is a plain click.
    expect([...gridSelection(new Set(), ps, 2, -1, { shift: true, toggle: false })]).toEqual([3]);
  });

  it("narrows a timeline shift-select to the selected camera", () => {
    expect(timelineSelection([1, 2, 3], true, new Set([3]), byId(ps))).toEqual([1, 3]);
    expect(timelineSelection([1, 2, 3], false, new Set([3]), byId(ps))).toEqual([1, 2, 3]);
    expect(timelineSelection([2, 4], true, new Set([4]), byId(ps))).toEqual([4]);   // null camera = "Unknown"
  });
});

describe("filters and histogram", () => {
  it("builds a dense day histogram ending a day past the last photo day", () => {
    const h = dayHistogram([{ date: "2021-06-01", count: 2 }, { date: "2021-06-04", count: 5 }])!;
    expect(h.min).toBe(Date.UTC(2021, 5, 1) / 1000);
    expect(h.max).toBe(Date.UTC(2021, 5, 5) / 1000);
    expect(h.counts).toEqual([2, 0, 0, 5]);
    expect(dayHistogram([])).toBeNull();
  });

  it("hides cameras and out-of-range photos, keeping undated ones", () => {
    const h = dayHistogram([{ date: "1970-01-01", count: 3 }, { date: "1970-01-03", count: 1 }])!;
    const ps = [photo(1, 100, "A"), photo(2, 100, "B"), photo(3, 200000, "A"), photo(4, null, "A")];
    expect(filterPhotos(ps, new Set(["B"]), h, { lo: h.min, hi: h.max }).map((p) => p.id)).toEqual([1, 3, 4]);
    expect(filterPhotos(ps, new Set(), h, { lo: h.min, hi: 1000 }).map((p) => p.id)).toEqual([1, 2, 4]);
  });
});

describe("staged offsets (U7)", () => {
  it("keeps the legacy page's key and record shape", () => {
    expect(offsetStore.key).toBe("geotagger.staged.timesync.v1");
    sessionStorage.setItem("geotagger.staged.timesync.v0", "old");
    sessionStorage.setItem(offsetStore.key, JSON.stringify({ v: 1, savedAt: 0, entries: [{ id: 7, offset: 60, base: 1000 }, { id: "x" }] }));
    expect(offsetStore.load()).toEqual([{ id: 7, offset: 60, base: 1000 }]);
    expect(sessionStorage.getItem("geotagger.staged.timesync.v0")).toBeNull();   // other versions swept
  });

  it("writes live offsets plus carried records, and removes the key when empty", () => {
    const carry = [{ id: 1, offset: 5, base: 10 }, { id: 2, offset: 5, base: 10 }];
    expect(offsetRecords(new Map([[1, { offset: 60, base: 10 }]]), carry)).toEqual([{ id: 1, offset: 60, base: 10 }, { id: 2, offset: 5, base: 10 }]);
    offsetStore.save([{ id: 1, offset: 60, base: 10 }]);
    expect(JSON.parse(sessionStorage.getItem(offsetStore.key)!)).toMatchObject({ v: 1, entries: [{ id: 1, offset: 60, base: 10 }] });
    offsetStore.save([]);
    expect(sessionStorage.getItem(offsetStore.key)).toBeNull();
  });

  it("drops gone, already-saved and moved photos on restore", () => {
    expect(validOffsetRecord({ id: 1, offset: 0, base: 5 })).toBe(false);
    expect(validOffsetRecord({ id: 1, offset: 3, base: Number.NaN })).toBe(false);
    const records = [
      { id: 1, offset: 60, base: 1000 },   // restorable
      { id: 2, offset: 60, base: 1000 },   // gone
      { id: 3, offset: 60, base: 1000 },   // already at base+offset
      { id: 4, offset: 60, base: 1000 },   // moved elsewhere
      { id: 5, offset: 60, base: 1000 },   // applied again meanwhile
    ];
    const current = byId([photo(1, 1000), photo(3, 1060), photo(4, 1234), photo(5, 1000)]);
    const r = classifyOffsetRestore(records, current, (id) => id === 5);
    expect(r.restored.map((x) => x.id)).toEqual([1]);
    expect(r).toMatchObject({ gone: 1, applied: 1, moved: 1 });
    expect(restoreDroppedNote(r)).toBe("Dropped: 1 photo(s) no longer exist, 1 already saved, 1 whose time was changed elsewhere since.");
  });
});
