import { describe, expect, it } from "vitest";
import { fmtBytes, plural } from "./format";
import { stallGuard } from "./stallGuard";
import { groupStreets, unionBounds } from "../pages/data/streets";

describe("fmtBytes", () => {
  it("formats 1024-based sizes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512.0 B");
    expect(fmtBytes(38.7 * 1024 * 1024)).toBe("38.7 MB");
    expect(fmtBytes(5 * 1024 ** 4)).toBe("5120.0 GB");
  });
});

describe("plural", () => {
  it("adds an s except for one", () => {
    expect(plural(1, "segment")).toBe("1 segment");
    expect(plural(1200, "segment")).toBe("1,200 segments");
  });
});

describe("stallGuard", () => {
  it("throws after three batches without progress", () => {
    const check = stallGuard("Indexing");
    check(100);
    check(100);
    check(100);
    expect(() => check(100)).toThrow(/Indexing stopped: 3 batches/);
  });

  it("resets when remaining drops, and tolerates a jump up", () => {
    const check = stallGuard("Indexing");
    check(100);
    check(100);
    check(90);
    check(95); // a scan added photos
    check(80);
    check(80);
    expect(() => check(70)).not.toThrow();
  });
});

describe("groupStreets", () => {
  const seg = (name: string, ref: string | null = null) => ({ name, ref, highway: "residential", coords: [] as [number, number][] });

  it("groups segments by name and ref, most segments first", () => {
    const groups = groupStreets([seg("Main St"), seg("Oak Ave"), seg("Main St"), seg("US 36", "US 36"), seg("Colfax", "US 40")]);
    expect(groups.map((g) => [g.key, g.ways.length])).toEqual([
      ["Main St", 2], ["Colfax (US 40)", 1], ["Oak Ave", 1], ["US 36", 1],
    ]);
  });
});

describe("unionBounds", () => {
  it("covers every box", () => {
    expect(unionBounds([
      { min_lat: 37, max_lat: 41, min_lng: -109, max_lng: -102 },
      { min_lat: 36, max_lat: 40, min_lng: -103, max_lng: -94 },
    ])).toEqual([[36, -109], [41, -94]]);
    expect(unionBounds([])).toBeNull();
  });
});
