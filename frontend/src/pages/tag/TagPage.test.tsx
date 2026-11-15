import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Face } from "../../faces/faceGrid";
import { mockApi, renderWithQuery } from "../../test/utils";
import { dropGroup, removeFace, restoreToQueue, splitGroups, type TagGroup } from "./quickTag";
import { TagPage } from "./TagPage";

const DAY = 86400;
const f = (id: number, ts: number | null, city: string | null = null): Face => ({
  id, photo_id: id, filename: `p${id}.jpg`, bbox: [0, 0, 1, 1], det_score: 0.9, person_id: null, person_name: null,
  ignored: false, come_back: false, photo_datetime: ts, assigned_at: null, ignored_at: null, come_back_at: null, dir: null,
  location: city ? { city, sublocation: null, state: null, country: "X" } : null, suggestion: null, alternatives: [], negatives: [],
});

describe("quickTag queue", () => {
  it("splits a cluster on the date window and on a changed known place", () => {
    let n = 1;
    const groups = splitGroups({ sample: [f(1, DAY, "A"), f(2, 2 * DAY, null), f(3, 3 * DAY, "B"), f(4, 60 * DAY, "B"), f(5, null)] }, 30 * DAY, () => n++);
    // Undated sorts first as ts 0 and opens the chunk the next faces join (legacy behaviour).
    expect(groups.map((g) => g.faces.map((x) => x.id))).toEqual([[5, 1, 2], [3], [4]]);
  });
  it("drops, splits and restores groups by id", () => {
    const g = (id: number, ids: number[]): TagGroup => ({ id, suggestion: null, faces: ids.map((i) => f(i, i)), start: 0, place: null });
    const q = { groups: [g(1, [1]), g(2, [2, 3]), g(3, [4])], pos: 2 };
    expect(dropGroup(q, 1)).toMatchObject({ pos: 1 });
    expect(removeFace(q, 2, 3).groups[1]!.faces.map((x) => x.id)).toEqual([2]);
    expect(removeFace(q, 1, 1).groups.map((x) => x.id)).toEqual([2, 3]);
    const gone = dropGroup(q, 2);
    const back = restoreToQueue(gone, g(2, [2, 3]), [f(3, 3), f(2, 2)]);
    expect([back.pos, back.groups[back.pos]!.faces.map((x) => x.id)]).toEqual([1, [2, 3]]);
  });
});

describe("TagPage", () => {
  beforeEach(() => localStorage.clear());
  it("accepts a group as its suggested person and remembers them for next time", async () => {
    const { calls } = mockApi({
      "GET /api/persons": () => [{ id: 4, name: "Ann" }],
      "GET /api/faces/clusters": () => ({ scanned: 3, grouped: 3, clusters: [
        { size: 2, face_ids: [1, 2], sample: [f(1, DAY), f(2, DAY)], suggestion: { person_id: 4, person_name: "Ann", score: 0.9 } },
        { size: 1, face_ids: [3], sample: [f(3, DAY)], suggestion: null },
      ] }),
      "POST /api/faces/assign": () => ({ assigned: 2, not_found: 0, person_id: 4, undo: null }),
    });
    const user = userEvent.setup();
    renderWithQuery(<TagPage />);
    expect(await screen.findByRole("button", { name: "Looks like Ann" })).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "✓ Accept as Ann" }));
    expect(await screen.findByRole("button", { name: "New person?" })).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/faces/assign")!.body).toEqual({ face_ids: [1, 2], person_id: 4, clear: false });
    expect(JSON.parse(localStorage.getItem("quicktag_prev_person")!)).toEqual({ id: 4, name: "Ann" });
    expect(screen.getByRole("button", { name: /Use previous/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip ›" }));
    await waitFor(() => expect(screen.getByText(/Done for now — 1 group\(s\) skipped/)).toBeInTheDocument());
  });
});
