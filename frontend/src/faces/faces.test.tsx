import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "../test/utils";
import { fuzzyPickerRows, matchRank } from "../photos/PersonPickerDialog";
import {
  bboxStyle, dirLabel, formatDateRange, locationKey, locationLabel, minMaxOf, primaryDirKey, primaryLocationKey, sortGroups,
} from "./faceGrid";
import { FaceQuickActions } from "./FaceQuickActions";
import { quickActionItems } from "./quickActions";

const DAY = 86400;
const ts = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const loc = (city: string) => ({ city, sublocation: null, state: "CA", country: "USA" });

describe("faceGrid helpers", () => {
  it("maps a normalized bbox to percentages", () => {
    expect(bboxStyle([0.1, 0.2, 0.4, 0.8])).toEqual({ left: "10%", top: "20%", width: "30.000000000000004%", height: "60.00000000000001%" });
  });
  it("labels date ranges in wall-clock UTC", () => {
    expect(formatDateRange(null)).toBe("Undated");
    expect(formatDateRange(ts(2021, 3, 5), ts(2021, 3, 5) + 3600)).toMatch(/2021/);
    const range = formatDateRange(ts(2021, 3, 5), ts(2021, 3, 8));
    expect(range).toContain("–");
  });
  it("builds location keys and labels", () => {
    expect(locationKey({ location: loc("Paris") })).toBe("Paris, CA, USA");
    expect(locationKey({ location: null })).toBeNull();
    const items = [{ location: loc("A") }, { location: loc("A") }, { location: loc("B") }, { location: null }];
    expect(locationLabel(items)).toBe("A, CA, USA (and 1 other)");
    expect(primaryLocationKey(items)).toBe("A, CA, USA");
    expect(locationLabel([{ location: null }])).toBe("");
  });
  it("labels folders by their last segment", () => {
    expect(dirLabel({ dir: "C:\\Photos\\1985 Box\\" })).toBe("1985 Box");
    expect(dirLabel({ dir: null })).toBe("Unknown folder");
    expect(primaryDirKey([{ dir: "/a" }, { dir: "/b" }, { dir: "/b" }])).toBe("/b");
  });
  it("finds min/max without spreading", () => {
    expect(minMaxOf([3, 1, 2])).toEqual([1, 3]);
    expect(minMaxOf([])).toEqual([Infinity, -Infinity]);
  });
  it("sorts groups by date, count, place and folder with keyless groups last", () => {
    const g = [
      { n: "undated", date: null, count: 9, place: null, dir: null },
      { n: "late", date: 3 * DAY, count: 1, place: "B", dir: "/z" },
      { n: "early", date: DAY, count: 5, place: "A", dir: null },
    ];
    const by = (mode: "date" | "count" | "location" | "dir") => sortGroups(g, mode, (x) => x).map((x) => x.n);
    expect(by("date")).toEqual(["early", "late", "undated"]);
    expect(by("count")).toEqual(["undated", "early", "late"]);
    expect(by("location")).toEqual(["early", "late", "undated"]);
    expect(by("dir")).toEqual(["late", "early", "undated"]);
  });
});

describe("quickActionItems", () => {
  const h = { onAssign: vi.fn(), onPickPerson: vi.fn() };
  it("offers confirm for a suggestion on an unassigned face", () => {
    const items = quickActionItems({ id: 1, suggestion: { person_id: 3, person_name: "Ann" } }, { ...h, onNotPerson: vi.fn(), onIgnore: vi.fn() });
    expect(items.map((i) => i.label)).toEqual(["✓ Ann", "⛔ Not Ann", "Assign to…", "🚫 Ignore"]);
    items[0]!.onSelect();
    expect(h.onAssign).toHaveBeenCalledWith(3);
  });
  it("offers unassign / restore / delete box by state", () => {
    expect(quickActionItems({ id: 1, person_name: "Bob" }, h).map((i) => i.label)).toEqual(["× Unassign", "Assign to…"]);
    expect(quickActionItems({ id: 1, ignored: true }, { ...h, onIgnore: vi.fn(), onComeBack: vi.fn() }).map((i) => i.label))
      .toEqual(["Assign to…", "↩ Restore", "🕒 Come back later"]);
    expect(quickActionItems({ id: 1, source: "manual" }, { ...h, onDelete: vi.fn() }).map((i) => i.label)).toContain("🗑 Delete box");
    expect(quickActionItems({ id: 1, source: "detected" }, { ...h, onDelete: vi.fn() }).map((i) => i.label)).not.toContain("🗑 Delete box");
  });
});

describe("fuzzy person picker", () => {
  const people = [{ id: 1, name: "John Smith" }, { id: 2, name: "Joanne" }, { id: 3, name: "José" }];
  it("ranks exact, prefix, word-prefix, substring and typo matches", () => {
    expect(matchRank("john smith", "john smith")).toBe(0);
    expect(matchRank("john smith", "jo")).toBe(1);
    expect(matchRank("john smith", "jo sm")).toBe(2);
    expect(matchRank("joanne", "ann")).toBe(3);
    expect(matchRank("john smith", "jhon")).toBe(4);
    expect(matchRank("john smith", "xyz")).toBeNull();
  });
  it("defaults Enter to Create when only similar names match", () => {
    const r = fuzzyPickerRows(people, "Jhon", true);
    expect(r.rows.map((x) => (x.kind === "person" ? `${x.name}${x.similar ? "~" : ""}` : `+${x.name}`))).toEqual(["John Smith~", "+Jhon"]);
    expect(r.defaultIndex).toBe(1);
    // "jose" *is* José once folded: no Create row (John is only a look-alike).
    expect(fuzzyPickerRows(people, "jose", true).rows.map((x) => x.kind)).not.toContain("create");
  });
});

describe("FaceQuickActions", () => {
  it("opens the person picker from Assign to… and assigns the pick", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onAssign = vi.fn(), onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<FaceQuickActions target={{ anchor, face: { id: 5 } }} persons={[{ id: 7, name: "Ann" }]} sheet={false}
      handlers={{ onAssign }} onDone={onDone} />);
    await user.click(screen.getByRole("menuitem", { name: "Assign to…" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Ann" }));
    expect(onAssign).toHaveBeenCalledWith(7);
    expect(onDone).toHaveBeenCalled();
    anchor.remove();
  });
});
