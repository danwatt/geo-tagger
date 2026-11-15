import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "../test/utils";
import { PhotoGrid, groupByMonth, groupTitle } from "./PhotoGrid";
import { fold, pickerRows } from "./PersonPickerDialog";
import { clickSelection } from "./selection";

const ids = [10, 11, 12, 13, 14];

describe("clickSelection", () => {
  it("selects only the clicked cell on a plain click", () => {
    expect([...clickSelection(new Set([10, 11]), ids, 3, 0, { shift: false, toggle: false })]).toEqual([13]);
  });
  it("adds the range from the last click on shift, in either direction", () => {
    expect([...clickSelection(new Set([10]), ids, 3, 1, { shift: true, toggle: false })].sort()).toEqual([10, 11, 12, 13]);
    expect([...clickSelection(new Set(), ids, 0, 2, { shift: true, toggle: false })].sort()).toEqual([10, 11, 12]);
  });
  it("treats shift without an anchor as a plain click", () => {
    expect([...clickSelection(new Set([10]), ids, 2, -1, { shift: true, toggle: false })]).toEqual([12]);
  });
  it("toggles one cell with ctrl/cmd", () => {
    expect([...clickSelection(new Set([10, 12]), ids, 2, 0, { shift: false, toggle: true })]).toEqual([10]);
    expect([...clickSelection(new Set([10]), ids, 4, 0, { shift: false, toggle: true })]).toEqual([10, 14]);
  });
});

// 2021-03-05 and 2021-03-31 23:30 (wall clock as UTC), then April, then undated.
const MAR5 = Date.UTC(2021, 2, 5) / 1000;
const MAR31 = Date.UTC(2021, 2, 31, 23, 30) / 1000;
const APR1 = Date.UTC(2021, 3, 1) / 1000;
const photos = [
  { id: 1, filename: "a.jpg", photo_datetime: MAR5 },
  { id: 2, filename: "b.jpg", photo_datetime: MAR31, lat: 1 },
  { id: 3, filename: "c.jpg", photo_datetime: APR1 },
  { id: 4, filename: "d.jpg", photo_datetime: null },
];

describe("groupByMonth", () => {
  it("groups consecutive runs by wall-clock month, undated on its own", () => {
    const groups = groupByMonth(photos, (p) => p.photo_datetime);
    expect(groups.map((g) => [groupTitle(g), g.items.map((x) => x.idx)])).toEqual([
      ["March 2021", [0, 1]], ["April 2021", [2]], ["Undated", [3]],
    ]);
  });
});

describe("PhotoGrid", () => {
  it("renders cells as buttons and reports modifiers and arrow-key moves", async () => {
    const onActivate = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PhotoGrid photos={photos} selectedIds={new Set([2])} focusedId={null} onActivate={onActivate} emptyMessage="none" />);
    expect(screen.getByRole("region", { name: /March 2021/ })).toBeInTheDocument();
    const b = screen.getByRole("button", { name: "b.jpg" });
    expect(b).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "a.jpg" }));
    expect(onActivate).toHaveBeenLastCalledWith(0, { shift: false, toggle: false });
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "c.jpg" }));
    await user.keyboard("{/Shift}");
    expect(onActivate).toHaveBeenLastCalledWith(2, { shift: true, toggle: false });

    screen.getByRole("button", { name: "c.jpg" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onActivate).toHaveBeenLastCalledWith(3, { shift: false, toggle: false });
    expect(screen.getByRole("button", { name: "d.jpg" })).toHaveFocus();
  });

  it("draws ranked results as one best-first section and shows scores", () => {
    renderWithQuery(<PhotoGrid photos={[{ id: 1, filename: "a.jpg", score: 0.1234 }]} selectedIds={new Set()} focusedId={null}
      onActivate={() => {}} ranked={{ title: "Best matches" }} emptyMessage="none" />);
    expect(screen.getByText("Best matches")).toBeInTheDocument();
    expect(screen.getByText("· 1 photo, best first")).toBeInTheDocument();
    expect(screen.getByText("0.123")).toBeInTheDocument();
  });

  it("says why it's empty", () => {
    renderWithQuery(<PhotoGrid photos={[]} selectedIds={new Set()} focusedId={null} onActivate={() => {}} emptyMessage="No photos match these filters." />);
    expect(screen.getByText("No photos match these filters.")).toBeInTheDocument();
  });
});

describe("pickerRows", () => {
  const people = [{ id: 1, name: "Joanne" }, { id: 2, name: "Ann" }, { id: 3, name: "José" }];
  it("ranks prefix matches first and offers Create last", () => {
    expect(pickerRows(people, "an", true).map((r) => r.name)).toEqual(["Ann", "Joanne", "an"]);
    expect(pickerRows(people, "an", true).at(-1)?.kind).toBe("create");
  });
  it("doesn't offer Create for an existing name once accents are folded", () => {
    expect(fold("José")).toBe("jose");
    expect(pickerRows(people, "jose", true).map((r) => r.kind)).toEqual(["person"]);
  });
});
