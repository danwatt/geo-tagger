import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { mockApi, renderWithQuery } from "../../test/utils";
import { PeoplePage, clampDetailWidth } from "./PeoplePage";

const T = Date.UTC(2021, 2, 5) / 1000;
const face = (id: number, over: Record<string, unknown> = {}) => ({
  id, photo_id: 100 + id, filename: `p${id}.jpg`, bbox: [0.1, 0.1, 0.4, 0.4], det_score: 0.9, person_id: null, person_name: null,
  ignored: false, come_back: false, photo_datetime: T + id, assigned_at: null, ignored_at: null, come_back_at: null, dir: "/x",
  location: null, suggestion: null, alternatives: [], negatives: [], ...over,
});
const FACES = [face(1, { suggestion: { person_id: 7, person_name: "Ann", score: 0.9 } }), face(2), face(3)];

function routes(extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}) {
  return mockApi({
    "GET /api/settings": () => ({ settings: [{ key: "FACE_PRESELECT_MIN_SCORE", value: 0.5 }, { key: "FACE_QUERY_LIMIT", value: 5000 }] }),
    "GET /api/stats/years": () => ({ years: [2021] }),
    "GET /api/persons": () => [{ id: 7, name: "Ann" }, { id: 8, name: "Bob", birth_date: "1980-01-01" }],
    "GET /api/faces/scan/status": () => ({ remaining_photos: 0, failed_photos: 0, total_faces: 3, unlabeled_faces: 3, ignored_faces: 0, come_back_faces: 0, tagged_faces: 0 }),
    "GET /api/faces": () => ({ faces: FACES, total: 3, returned: 3, offset: 0, next_offset: null }),
    "GET /api/photos/101/tagged-people": () => [],
    "GET /api/photos/102/tagged-people": () => [],
    ...extra,
  });
}
const status = () => document.getElementById("status-bar")!.textContent;

describe("PeoplePage", () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it("loads the Unlabeled queue and pre-selects only confident guesses", async () => {
    routes();
    renderWithQuery(<PeoplePage />);
    await screen.findByRole("button", { name: "Face in p1.jpg, looks like Ann" });
    await waitFor(() => expect(status()).toBe("3 of 3 unlabeled face(s), grouped by month then place. 1 confident guess(es) pre-selected."));
    expect(screen.getByRole("button", { name: "Face in p1.jpg, looks like Ann" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Face in p2.jpg, unassigned" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Unlabeled/ })).toHaveAttribute("aria-current", "true");
  });

  it("stages a selection to a person, backs it up, then commits it", async () => {
    const { calls } = routes({ "POST /api/faces/assign": () => ({ assigned: 1, not_found: 0, person_id: 8, undo: null }) });
    const user = userEvent.setup();
    renderWithQuery(<PeoplePage />);
    await user.click(await screen.findByRole("button", { name: "Face in p2.jpg, unassigned" }));
    await user.keyboard("a");
    const dlg = await screen.findByRole("dialog", { name: "Assign 1 face(s) to…" });
    await user.type(within(dlg).getByRole("combobox"), "bo{Enter}");
    await waitFor(() => expect(status()).toMatch(/^Staged 1 face\(s\) → Bob/));
    const staged = screen.getByRole("region", { name: "Staged changes" });
    expect(within(staged).getByText(/1 staged change\(s\) in 1 group\(s\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Face in p2.jpg, unassigned" })).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem("geotagger.staged.people.v1")!).entries[0]).toMatchObject({ id: 2, kind: "assign", personId: 8 }));

    await user.click(screen.getByRole("button", { name: "✔ Commit all" }));
    await user.click(await screen.findByRole("button", { name: "Commit" }));
    await waitFor(() => expect(status()).toBe("Committed 1 change(s)."));
    expect(calls.find((c) => c.url === "/api/faces/assign")!.body).toEqual({ face_ids: [2], person_id: 8 });
    expect(sessionStorage.getItem("geotagger.staged.people.v1")).toBeNull();
  });

  it("shows the shortcuts help on ? and ignores keys typed into fields", async () => {
    routes();
    const user = userEvent.setup();
    renderWithQuery(<PeoplePage />);
    await screen.findByRole("button", { name: "Face in p2.jpg, unassigned" });
    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.selectOptions(screen.getByLabelText(/Focus/), "");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("restores staged work from a previous visit, dropping what's gone", async () => {
    sessionStorage.setItem("geotagger.staged.people.v1", JSON.stringify({ v: 1, entries: [
      { id: 3, kind: "ignore", personId: null, name: null, was: { p: null, i: false, c: false } },
      { id: 99, kind: "ignore", personId: null, name: null, was: { p: null, i: false, c: false } },
    ] }));
    routes({ "POST /api/faces/by-ids": () => ({ faces: [face(3)], missing: [99] }) });
    renderWithQuery(<PeoplePage />);
    expect(await screen.findByText(/You have 1 uncommitted change from your last visit/)).toBeInTheDocument();
    expect(screen.getByText(/Dropped: 1 face\(s\) no longer exist/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Staged changes" })).toBeInTheDocument();
  });
});

describe("clampDetailWidth", () => {
  it("keeps the preview between its floor and what leaves the grid two columns", () => {
    expect(clampDetailWidth(100, 1600)).toBe(240);
    expect(clampDetailWidth(5000, 1600)).toBe(1600 - 220 - 6 - 320);
    expect(clampDetailWidth(400, 600)).toBe(240);
  });
});
