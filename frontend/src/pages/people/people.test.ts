import { describe, expect, it } from "vitest";
import type { Face } from "../../faces/faceGrid";
import { focusFromValue, focusQuery, initialFocus } from "./focus";
import { buildGridModel } from "./gridModel";
import {
  computeBatches, computeMonthLocationGroups, computeTimeGroups, computeUnlabeledDirGroups, computeUnlabeledPersonGroups,
  formatRelativeTime, personRuns, shortDirPath, sortBucketBySuggestion,
} from "./grouping";
import { peopleKeyAction, type PeopleKeyCtx } from "./keyboard";
import { applyPreselection, cellClick, extendFocus, freshPreselectMemory, moveFocus } from "./selection";
import {
  classifyRestore, groupPendingEntries, pendingRecord, pendingRequest, recordsToSave, stagedAlreadyApplied, type PendingEntry,
} from "./staging";

const ts = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;
const loc = (city: string) => ({ city, sublocation: null, state: null, country: "X" });

function face(id: number, over: Partial<Face> = {}): Face {
  return {
    id, photo_id: id, filename: `p${id}.jpg`, bbox: [0, 0, 0.5, 0.5], det_score: 0.9, person_id: null, person_name: null,
    ignored: false, come_back: false, photo_datetime: null, assigned_at: null, ignored_at: null, come_back_at: null,
    dir: null, location: null, suggestion: null, alternatives: [], negatives: [], ...over,
  };
}
const sug = (person_id: number, score = 0.7) => ({ person_id, person_name: `P${person_id}`, score });

describe("grouping", () => {
  it("buckets a month by place, splitting undated no-location faces by folder", () => {
    const list = [
      face(1, { photo_datetime: null, dir: "/scans/A" }),
      face(2, { photo_datetime: null, dir: "/scans/B" }),
      face(3, { photo_datetime: ts(2021, 3, 1), location: loc("Paris") }),
      face(4, { photo_datetime: ts(2021, 3, 2) }),
      face(5, { photo_datetime: ts(2021, 3, 3), location: loc("Paris") }),
    ];
    const g = computeMonthLocationGroups(list);
    expect(g.map((b) => [b.year, b.place ?? b.dir ?? "-", b.faces.map((f) => f.id)])).toEqual([
      [null, "A", [1]], [null, "B", [2]], [2021, "Paris, X", [3, 5]], [2021, "-", [4]],
    ]);
  });

  it("clusters suggested people in first-appearance order, unsuggested last, and freezes the order", () => {
    const list = [face(1, { photo_datetime: 30, suggestion: sug(2) }), face(2, { photo_datetime: 10 }),
      face(3, { photo_datetime: 20, suggestion: sug(9) }), face(4, { photo_datetime: 40, suggestion: sug(9) })];
    const rank = new Map<string, number>();
    expect(sortBucketBySuggestion(list, "k", rank).map((f) => f.id)).toEqual([3, 4, 1, 2]);
    // Face 3 staged away: person 9's earliest would move to 40, after person 2 —
    // but the frozen rank keeps their run first.
    expect(sortBucketBySuggestion(list.filter((f) => f.id !== 3), "k", rank).map((f) => f.id)).toEqual([4, 1, 2]);
    expect(personRuns(sortBucketBySuggestion(list)).map((r) => r.map((f) => f.id))).toEqual([[3, 4], [1], [2]]);
  });

  it("groups events by gap, undated trailing", () => {
    const g = computeTimeGroups([face(1, { photo_datetime: 100 }), face(2, { photo_datetime: 200 }), face(3, { photo_datetime: 100000 }), face(4)], 3600);
    expect(g.map((x) => x.faces.map((f) => f.id))).toEqual([[1, 2], [3], [4]]);
    expect(g[2]!.undated).toBe(true);
  });

  it("orders the person-first hierarchy by name with no-suggestion last", () => {
    const g = computeUnlabeledPersonGroups([face(1), face(2, { suggestion: { person_id: 1, person_name: "Zed", score: 1 } }),
      face(3, { suggestion: { person_id: 2, person_name: "Amy", score: 1 } })]);
    expect(g.map((b) => b.name)).toEqual(["Amy", "Zed", null]);
  });

  it("groups folders on the full path and shortens it", () => {
    const g = computeUnlabeledDirGroups([face(1, { dir: "/x/1990/Scans" }), face(2, { dir: "/x/1985/Scans" }), face(3, { dir: "/x/1985/Scans" })]);
    expect(g.map((b) => [b.dir, b.faces.length])).toEqual([["/x/1985/Scans", 2], ["/x/1990/Scans", 1]]);
    expect(shortDirPath("/a/b/c/d")).toBe("…/c/d");
    expect(shortDirPath(null)).toBe("Unknown folder");
  });

  it("batches by stamp and words relative times", () => {
    expect(computeBatches([face(1, { ignored_at: 5 }), face(2, { ignored_at: 5 }), face(3)], (f) => f.ignored_at).map((b) => b.faces.length)).toEqual([2, 1]);
    const now = 1_000_000_000;
    expect(formatRelativeTime(now / 1000 - 10, now)).toBe("just now");
    expect(formatRelativeTime(now / 1000 - 600, now)).toBe("10 min ago");
    expect(formatRelativeTime(null, now)).toBe("unknown time");
  });
});

describe("buildGridModel", () => {
  it("draws year/month dividers only in the Date sort, and walks cells in render order", () => {
    const list = [face(1, { photo_datetime: ts(2020, 1, 5) }), face(2, { photo_datetime: ts(2021, 2, 5), suggestion: sug(1) })];
    const m = buildGridModel({ scope: "unlabeled", list, hierarchy: "date", sort: "date", gapSeconds: 86400 });
    expect(m.items.filter((i) => i.type === "divider").map((i) => i.type === "divider" && i.text)).toEqual(["2020", "January", "2021", "February"]);
    expect(m.order.map((f) => f.id)).toEqual([1, 2]);
    const byCount = buildGridModel({ scope: "unlabeled", list, hierarchy: "date", sort: "count", gapSeconds: 86400 });
    expect(byCount.items.some((i) => i.type === "divider")).toBe(false);
  });
  it("puts a person scope's header first and dividers between loose cells", () => {
    const list = [face(1, { photo_datetime: ts(2020, 1, 5) }), face(2, { photo_datetime: ts(2020, 3, 5) })];
    const m = buildGridModel({ scope: "person", list, hierarchy: "date", sort: "date", gapSeconds: 86400 });
    expect(m.items.map((i) => i.type)).toEqual(["person-header", "divider", "cells", "divider", "cells"]);
  });
  it("names tag batches by their people", () => {
    const list = [face(1, { assigned_at: 9, person_name: "Ann" }), face(2, { assigned_at: 9, person_name: "Bob" })];
    const m = buildGridModel({ scope: "recent", list, hierarchy: "date", sort: "date", gapSeconds: 86400 });
    const g = m.items[0]!;
    expect(g.type === "group" && g.header.title).toBe("Ann & Bob");
  });
});

describe("selection", () => {
  const order = [face(1), face(2), face(3), face(4)];
  const s0 = { selected: new Set<number>(), focusedId: null, anchorIdx: -1 };
  it("selects, shift-extends and toggles like the legacy grid", () => {
    const a = cellClick(s0, order, 1, { shift: false, toggle: false }, false);
    expect([...a.selected]).toEqual([2]);
    const b = cellClick(a, order, 3, { shift: true, toggle: false }, false);
    expect([...b.selected].sort()).toEqual([2, 3, 4]);
    const c = cellClick(b, order, 2, { shift: false, toggle: true }, false);
    expect([...c.selected].sort()).toEqual([2, 4]);
  });
  it("toggles on a plain click in the guesses view", () => {
    const s = { selected: new Set([1, 2]), focusedId: null, anchorIdx: -1 };
    expect([...cellClick(s, order, 0, { shift: false, toggle: false }, true).selected]).toEqual([2]);
  });
  it("moves and extends focus with the keyboard", () => {
    const m = moveFocus(s0, order, 1);
    expect([m.focusedId, [...m.selected]]).toEqual([1, [1]]);
    const e = extendFocus(m, order, 2);
    expect([e.focusedId, [...e.selected].sort()]).toEqual([3, [1, 2, 3]]);
  });
  it("keeps deselections across reloads (W15)", () => {
    const vis = [face(1), face(2), face(3)];
    const first = applyPreselection(new Set(), freshPreselectMemory(), "unlabeled:", vis, () => true, () => false);
    expect([...first.selected].sort()).toEqual([1, 2, 3]);
    // The user deselects 2, then the queue reloads with a new face 4.
    const user = new Set([1, 3]);
    const again = applyPreselection(user, first.memory, "unlabeled:", [...vis, face(4)], () => true, () => false);
    expect([...again.selected].sort()).toEqual([1, 3, 4]);
    // A new visit starts over.
    const fresh = applyPreselection(user, again.memory, "suggested:7", vis, () => true, () => false);
    expect([...fresh.selected].sort()).toEqual([1, 2, 3]);
  });
});

describe("keyboard", () => {
  const ctx: PeopleKeyCtx = { typing: false, onButton: false, onResizer: false, helpOpen: false, layerAbove: false, flatGrid: true, busy: false, scope: "unlabeled" };
  it("maps the shortcut table", () => {
    expect(peopleKeyAction({ key: "j" }, ctx)).toEqual({ type: "move", delta: 1 });
    expect(peopleKeyAction({ key: "ArrowUp", shiftKey: true }, ctx)).toEqual({ type: "extend", delta: -1 });
    expect(peopleKeyAction({ key: "a", ctrlKey: true }, ctx)).toEqual({ type: "select-all" });
    expect(peopleKeyAction({ key: "x" }, ctx)).toEqual({ type: "ignore", ignored: true });
    expect(peopleKeyAction({ key: "x" }, { ...ctx, scope: "ignored" })).toEqual({ type: "ignore", ignored: false });
    expect(peopleKeyAction({ key: "b" }, { ...ctx, scope: "come_back" })).toEqual({ type: "come-back", comeBack: false });
    expect(peopleKeyAction({ key: "N", shiftKey: true }, ctx)).toEqual({ type: "nuke" });
    expect(peopleKeyAction({ key: "?" }, ctx)).toEqual({ type: "help-open" });
  });
  it("ignores keys while typing, in dialogs, on buttons and outside the flat grids", () => {
    expect(peopleKeyAction({ key: "j" }, { ...ctx, typing: true })).toBeNull();
    expect(peopleKeyAction({ key: "?" }, { ...ctx, typing: true })).toBeNull();
    expect(peopleKeyAction({ key: "j" }, { ...ctx, layerAbove: true })).toBeNull();
    expect(peopleKeyAction({ key: " " }, { ...ctx, onButton: true })).toBeNull();
    expect(peopleKeyAction({ key: "j" }, { ...ctx, flatGrid: false })).toBeNull();
    expect(peopleKeyAction({ key: "?" }, { ...ctx, flatGrid: false })).toEqual({ type: "help-open" });
    expect(peopleKeyAction({ key: "j" }, { ...ctx, busy: true })).toEqual({ type: "swallow" });
    expect(peopleKeyAction({ key: "?" }, { ...ctx, helpOpen: true })).toEqual({ type: "help-close" });
  });
});

describe("staging", () => {
  const persons = [{ id: 1, name: "Ann" }, { id: 2, name: "Bob" }];
  const e = (id: number, over: Partial<PendingEntry>): PendingEntry => ({ face: face(id), kind: "assign", ...over });
  it("groups by destination, assigns first and people A→Z", () => {
    const g = groupPendingEntries([e(1, { kind: "ignore" }), e(2, { personId: 2 }), e(3, { personId: 1 }), e(4, { personId: null, name: "Cy" }), e(5, { personId: 1 })], persons);
    expect(g.map((x) => [x.label, x.entries.length])).toEqual([["Ann", 2], ["Bob", 1], ["Cy (new person)", 1], ["Ignore", 1]]);
  });
  it("builds one request per group", () => {
    expect(pendingRequest({ kind: "assign", personId: 1, name: null }, [3])).toEqual(["/api/faces/assign", { face_ids: [3], person_id: 1 }]);
    expect(pendingRequest({ kind: "assign", personId: null, name: "Cy" }, [3])).toEqual(["/api/faces/assign", { face_ids: [3], name: "Cy" }]);
    expect(pendingRequest({ kind: "uncome_back", personId: null, name: null }, [3])).toEqual(["/api/faces/come-back", { face_ids: [3], come_back: false }]);
  });
  it("records keep the legacy shape and carry unvalidated records", () => {
    const rec = pendingRecord(e(7, { personId: 2 }));
    expect(rec).toEqual({ id: 7, kind: "assign", personId: 2, name: null, was: { p: null, i: false, c: false } });
    const carried = { ...rec, id: 9 };
    expect(recordsToSave(new Map([[7, e(7, { personId: 2 })]]), [rec, carried]).map((r) => r.id)).toEqual([7, 9]);
  });
  it("classifies a restore: gone, already applied, orphaned, changed", () => {
    const records = [
      { id: 1, kind: "assign" as const, personId: 1, name: null, was: { p: null, i: false, c: false } },
      { id: 2, kind: "ignore" as const, personId: null, name: null, was: { p: null, i: false, c: false } },
      { id: 3, kind: "assign" as const, personId: 99, name: null, was: { p: null, i: false, c: false } },
      { id: 4, kind: "come_back" as const, personId: null, name: null, was: { p: null, i: false, c: false } },
    ];
    const current = new Map([[2, face(2, { ignored: true })], [3, face(3)], [4, face(4, { person_id: 2, person_name: "Bob" })]]);
    const o = classifyRestore(records, current, new Set([1, 2]), new Map(), () => false);
    expect([o.gone, o.applied, o.orphaned, o.changed, o.entries.map((x) => x.face.id)]).toEqual([1, 1, 1, 1, [4]]);
    expect(stagedAlreadyApplied({ kind: "assign", personId: null, name: "Bob" }, face(4, { person_id: 2, person_name: "Bob" }))).toBe(true);
  });
});

describe("focus", () => {
  it("turns option values into UTC windows", () => {
    const y = focusFromValue("y:2020");
    expect([y.start, y.end, y.label]).toEqual([ts(2020, 1, 1), ts(2021, 1, 1), "2020"]);
    expect(focusFromValue("m:2020-12").end).toBe(ts(2021, 1, 1));
    expect(focusQuery(y)).toBe(`start_ts=${y.start}&end_ts=${y.end}`);
    expect(focusQuery(focusFromValue(""))).toBe("");
  });
  it("starts from the URL month, else the saved year; undated skips the saved one", () => {
    expect(initialFocus("?month=2021-07", [2021], "y:2021").value).toBe("m:2021-07");
    expect(initialFocus("", [2021, 2020], "y:2020").value).toBe("y:2020");
    expect(initialFocus("", [2021], "y:1999").value).toBe("");
    const u = initialFocus("?month=undated", [2021], "y:2021");
    expect([u.value, u.jumpToUndated]).toEqual(["", true]);
  });
});
