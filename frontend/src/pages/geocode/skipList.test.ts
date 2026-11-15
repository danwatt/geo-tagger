import { beforeEach, describe, expect, it } from "vitest";
import { SKIPPED_BATCHES_KEY, addSkipped, batchRemaining, loadSkipped, skipParam } from "./skipList";

describe("skip list", () => {
  beforeEach(() => localStorage.clear());

  it("lives under the key Home reads, keeping only strings", () => {
    localStorage.setItem(SKIPPED_BATCHES_KEY, JSON.stringify(["a", 3, "b"]));
    expect(loadSkipped()).toEqual(["a", "b"]);
    expect(addSkipped("c")).toEqual(["a", "b", "c"]);
    expect(addSkipped("c")).toEqual(["a", "b", "c"]);
    expect(JSON.parse(localStorage.getItem("geotagger.workqueue.skipped")!)).toEqual(["a", "b", "c"]);
    localStorage.setItem(SKIPPED_BATCHES_KEY, "{garbled");
    expect(loadSkipped()).toEqual([]);
  });

  it("joins skipped and passed-over batches once each", () => {
    expect(skipParam(["a", "b"], new Set(["b", "c"]))).toBe("a,b,c");
  });

  it("counts batch members still needing a decision", () => {
    const photos = [{ id: 1, lat: null }, { id: 2, lat: 5 }, { id: 3, lat: null, geocode_ignored: true }, { id: 4, lat: null }];
    expect(batchRemaining([1, 2, 3, 4, 5], photos, (id) => id === 4)).toBe(1);
    expect(batchRemaining([1], photos, (id) => id === 1)).toBe(0);
  });
});
