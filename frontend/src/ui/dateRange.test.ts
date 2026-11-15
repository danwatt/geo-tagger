import { describe, expect, it } from "vitest";
import {
  addMonths, axisTicks, buildPresets, buildVolume, checkFields, dateAt, matchPreset, parseYmd, posOf, rangeLabel,
  rangeTotal, shiftDays,
} from "./dateRange";

describe("parseYmd", () => {
  it("accepts real calendar days only", () => {
    expect(parseYmd("2024-02-29")).toEqual({ y: 2024, m: 2, d: 29 });
    expect(parseYmd(" 2021-12-31 ")).toEqual({ y: 2021, m: 12, d: 31 });
    expect(parseYmd("2023-02-29")).toBeNull();
    expect(parseYmd("2023-13-01")).toBeNull();
    expect(parseYmd("2023-1-01")).toBeNull();
    expect(parseYmd("")).toBeNull();
  });
});

describe("day arithmetic", () => {
  it("shifts across month and year ends in UTC", () => {
    expect(shiftDays("2020-12-31", 1)).toBe("2021-01-01");
    expect(shiftDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addMonths({ y: 2020, m: 12 }, 1)).toEqual({ y: 2021, m: 1 });
    expect(addMonths({ y: 2020, m: 1 }, -1)).toEqual({ y: 2019, m: 12 });
  });
});

const rows = [
  { date: "2021-06-01", count: 5 },
  { date: "2019-03-10", count: 2 },
  { date: "2021-06-15", count: 1 },
  { date: "2023-01-02", count: 4 },
  { date: "not a date", count: 99 },
];

describe("volume", () => {
  const v = buildVolume(rows);
  it("sorts, drops junk and totals ranges by binary search", () => {
    expect(v.days.map((d) => d.date)).toEqual(["2019-03-10", "2021-06-01", "2021-06-15", "2023-01-02"]);
    expect(rangeTotal(v, null, null)).toBe(12);
    expect(rangeTotal(v, "2021-01-01", "2021-12-31")).toBe(6);
    expect(rangeTotal(v, "2021-06-02", null)).toBe(5);
    expect(rangeTotal(v, null, "2019-03-10")).toBe(2);
  });

  it("buckets a long span by month and a short one by day", () => {
    expect(v.buckets[0]).toMatchObject({ start: "2019-03-01", end: "2019-03-31", count: 2, days: 31 });
    expect(v.buckets.at(-1)).toMatchObject({ start: "2023-01-01", count: 4 });
    const short = buildVolume([{ date: "2021-06-01", count: 1 }, { date: "2021-06-03", count: 2 }]);
    expect(short.buckets.map((b) => b.count)).toEqual([1, 0, 2]);
    expect(axisTicks(short.buckets).map((t) => t.n)).toEqual([3]);
  });

  it("maps dates to histogram positions and back", () => {
    const short = buildVolume([{ date: "2021-06-01", count: 1 }, { date: "2021-06-10", count: 2 }]);
    expect(posOf(short, "2021-06-01")).toBe(0);
    expect(dateAt(short, 0)).toBe("2021-06-01");
    expect(dateAt(short, 1)).toBe("2021-06-10");
    expect(dateAt(short, 0.5)).toBe("2021-06-06");
  });
});

describe("presets", () => {
  const v = buildVolume(rows);
  it("drops empty relative presets and adds the three latest years", () => {
    const presets = buildPresets(v, "2023-01-20");
    expect(presets.map((p) => p.key)).toEqual(["any", "30d", "12m", "year", "sep", "y2023", "y2021", "y2019"]);
    expect(matchPreset(presets, "2021-01-01", "2021-12-31")).toBe("y2021");
    expect(matchPreset(presets, "2021-01-02", "2021-12-31")).toBe("custom");
    expect(matchPreset(presets, null, null)).toBe("any");
  });
  it("skips the year presets for a single-year set", () => {
    expect(buildPresets(buildVolume([{ date: "2021-06-01", count: 1 }]), "2030-01-01").map((p) => p.key)).toEqual(["any"]);
  });
});

describe("checkFields", () => {
  it("validates typed bounds and never swaps an inverted range", () => {
    expect(checkFields("", "")).toMatchObject({ ok: true, hint: "" });
    expect(checkFields("2021-01-01", "2021-01-31")).toMatchObject({ ok: true, hint: "31 days" });
    expect(checkFields("2021-1-1", "")).toMatchObject({ ok: false, fromBad: true, hint: "Use YYYY-MM-DD" });
    expect(checkFields("2021-02-01", "2021-01-01")).toMatchObject({ ok: false, inverted: true, hint: "End is before start" });
  });
});

describe("rangeLabel", () => {
  it("formats the trigger text", () => {
    expect(rangeLabel(null, null)).toBeNull();
    expect(rangeLabel("2021-03-05", "2021-04-01")).toBe("Mar 5 – Apr 1, 2021");
    expect(rangeLabel("2020-12-30", "2021-01-02")).toBe("Dec 30, 2020 – Jan 2, 2021");
    expect(rangeLabel("2021-03-05", null)).toBe("From Mar 5, 2021");
    expect(rangeLabel(null, "2021-03-05")).toBe("Until Mar 5, 2021");
    expect(rangeLabel("2021-01-01", "2021-12-31", "2021")).toBe("2021");
  });
});
