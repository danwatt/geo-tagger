import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MonthBars, UndatedLink, barLayout, type Segment } from "./MonthBars";

const SEGS: Segment<"a" | "b">[] = [
  { key: "a", cls: "bar-untagged", label: "untagged" },
  { key: "b", cls: "bar-tagged", label: "tagged" },
];
const months = [
  { year: 2023, month: 12, a: 1, b: 3 },
  { year: 2024, month: 1, a: 0, b: 0 },
  { year: 2024, month: 2, a: 4, b: 4 },
];

describe("barLayout", () => {
  it("splits each bar by segment share and labels each new year once", () => {
    const bars = barLayout(months, SEGS, "pct");
    expect(bars.map((b) => b.key)).toEqual(["2023-12", "2024-01", "2024-02"]);
    expect(bars[0]!.segments.map((s) => s.pct)).toEqual([25, 75]);
    expect(bars[1]!.segments.map((s) => s.pct)).toEqual([0, 0]); // empty month, no NaN
    expect(bars.map((b) => b.yearLabel)).toEqual([2023, 2024, null]);
    expect(bars.every((b) => b.heightPct === 100)).toBe(true);
  });

  it("sizes bars against the tallest month in count mode", () => {
    expect(barLayout(months, SEGS, "abs").map((b) => b.heightPct)).toEqual([50, 0, 100]);
  });
});

describe("MonthBars", () => {
  it("renders each month as a link into the given page", () => {
    render(<MonthBars months={months} segments={SEGS} mode="pct" linkPage="geocode.html" />);
    const link = screen.getByRole("link", { name: /February 2024 — 4 untagged, 4 tagged/ });
    expect(link).toHaveAttribute("href", "geocode.html?month=2024-02");
  });

  it("shows the undated link only when there are undated photos", () => {
    const { rerender } = render(<UndatedLink total={0} linkPage="people.html" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    rerender(<UndatedLink total={1} linkPage="people.html" />);
    expect(screen.getByRole("link", { name: /1 undated photo →/ })).toHaveAttribute("href", "people.html?month=undated");
  });
});
