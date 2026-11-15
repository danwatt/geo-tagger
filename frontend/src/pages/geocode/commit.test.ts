import { describe, expect, it, vi } from "vitest";
import { commitPlan, commitSummary, patchPhotos, runCommit, undoOutcome, undoPatches, type BatchReply, type CommitApi } from "./commit";
import { dropEntry, groupStaged, ignoreEntry, removeEntry, type Photo } from "./staging";

const photo = (id: number, extra: Partial<Photo> = {}): Photo => ({ id, filename: `p${id}.jpg`, lat: null, lng: null, geocode_ignored: false, ...extra });
const reply = (written: number[], extra: Partial<BatchReply> = {}): BatchReply => ({
  results: written.map((id) => ({ id, previous: { id, expect: {} } })), written, failed: [], not_found: [], ...extra,
});

const groups = () => groupStaged([
  dropEntry(photo(1), 10, 20, null, null, "Austin"),
  dropEntry(photo(2), 10, 20, null, null, "Austin"),
  dropEntry(photo(3), 11, 21, 500, null, "Austin"),
  removeEntry(photo(4, { lat: 1, lng: 1 })),
  ignoreEntry(photo(5)),
]);

describe("commitPlan", () => {
  it("makes one geotag call per distinct point, one removal and one ignore call per group", () => {
    expect(commitPlan(groups())).toEqual([
      { kind: "geotag", label: "Austin", ids: [1, 2], lat: 10, lng: 20, accuracy: null },
      { kind: "geotag", label: "Austin", ids: [3], lat: 11, lng: 21, accuracy: 500 },
      { kind: "remove", label: "❌ Remove saved location", ids: [4] },
      { kind: "ignore", label: "🚫 No location needed", ids: [5] },
    ]);
  });
});

describe("runCommit", () => {
  it("sends each call, keeps every snapshot, and reports partial failures", async () => {
    const api: CommitApi = {
      geotag: vi.fn(async (ids: number[]) => (ids[0] === 3
        ? reply([], { failed: [{ id: 3, error: "disk full" }] })
        : reply(ids))),
      remove: vi.fn(async (ids: number[]) => reply(ids)),
      ignore: vi.fn(async (ids: number[]) => ({ ids, geocode_ignored: true, results: ids.map((id) => ({ id, previous: { id, expect: {} } })) })),
    };
    const out = await runCommit(groups(), api);
    expect(api.geotag).toHaveBeenCalledWith([1, 2], 10, 20, null);
    expect(api.geotag).toHaveBeenCalledWith([3], 11, 21, 500);
    expect(api.remove).toHaveBeenCalledWith([4]);
    expect(api.ignore).toHaveBeenCalledWith([5], true);
    expect(out.landed.sort()).toEqual([1, 2, 4, 5]);
    expect(out.snapshots.map((s) => s.id).sort()).toEqual([1, 2, 4, 5]);
    expect(out.failures).toEqual(["Austin (11.0000, 21.0000) — 1 failed: disk full"]);
    expect(out.recents).toEqual([{ lat: 10, lng: 20, accuracy: null, label: "Austin" }]);
    expect(out.patches.get(4)).toMatchObject({ lat: null, geotag_source: "none" });
    expect(out.patches.get(5)).toEqual({ geocode_ignored: true });
    expect(commitSummary(out)).toEqual({ message: expect.stringContaining("Committed 4 of 5 change(s)"), isError: true });
  });

  it("keeps a group staged when its request fails outright", async () => {
    const api: CommitApi = {
      geotag: async () => { throw new Error("HTTP 500"); },
      remove: async (ids) => reply(ids),
      ignore: async () => { throw new Error("offline"); },
    };
    const out = await runCommit(groupStaged([dropEntry(photo(1), 1, 2, null, null, "X"), ignoreEntry(photo(2))]), api);
    expect(out.landed).toEqual([]);
    expect(out.failures).toEqual(["X (1.0000, 2.0000) — HTTP 500", "🚫 No location needed (1 photo(s)) — offline"]);
  });
});

describe("undo", () => {
  it("patches restored photos, only setting location when the undo restored a geotag", () => {
    const p = undoPatches([
      { id: 1, lat: 5, lng: 6, geotag_source: "sidecar", gps_accuracy: null, geocode_ignored: false, location: { city: "Austin", country: "US" } },
      { id: 2, lat: null, lng: null, geotag_source: "none", geocode_ignored: false },
    ]);
    expect(p.get(1)!.location).toEqual({ city: "Austin", sublocation: null, state: null, country: "US" });
    expect("location" in p.get(2)!).toBe(false);
    const photos = [photo(1), photo(3)];
    const next = patchPhotos(photos, p);
    expect(next[0]).toMatchObject({ lat: 5, geotag_source: "sidecar" });
    expect(next[1]).toBe(photos[1]);
  });

  it("keeps only retryable failures and names each one", () => {
    const snaps = [1, 2, 3, 4].map((id) => ({ id, expect: {} }));
    const out = undoOutcome(snaps, {
      results: [], written: [1],
      failed: [{ id: 2, error: "changed since the commit", conflict: true }, { id: 3, error: "locked" }],
      not_found: [4],
    }, (id) => (id === 2 ? "two.jpg" : undefined));
    expect(out.retry.map((s) => s.id)).toEqual([3]);
    expect(out.isError).toBe(true);
    expect(out.message).toBe("Undid 1 of 4 photo(s); not restored: two.jpg (changed since the commit), photo #3 (locked), " +
      "photo #4 (no longer in the library). Undo again to retry the failed ones.");
    expect(undoOutcome(snaps, { results: [], written: [1, 2, 3, 4], failed: [], not_found: [] }, () => "").message)
      .toBe("Undid the last commit: 4 photo(s) restored.");
  });
});
