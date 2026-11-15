import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import { RepresentativesPage, groupsStatus, recomputeStatus } from "./RepresentativesPage";

const face = (id: number, filename = `f${id}.jpg`) => ({ id, photo_id: id, filename, person_id: 1, person_name: "Ann" });
const PERSONS = [
  { person_id: 1, name: "Ann", total: 12, representative: 2 },
  { person_id: 2, name: "Bob", total: 4, representative: 1 },
];
const ANN_GROUPS = {
  groups: [
    { representative: face(1), others: [face(2), face(3)], size: 9 },
    { representative: face(4), others: [face(5)], size: 2 },
  ],
  total: 12,
};
const BOB_GROUPS = { groups: [{ representative: face(20, "bob.jpg"), others: [], size: 1 }], total: 4 };

const status = () => document.getElementById("status-bar")!.textContent;

describe("status lines", () => {
  it("counts the faces shown against the person's total", () => {
    expect(groupsStatus(ANN_GROUPS.groups, 12)).toBe("2 group(s), 5 of 12 face(s) shown.");
    expect(groupsStatus([], 0)).toBe("No representative groups for this person yet — try Recompute.");
  });
  it("sums a recompute", () => {
    expect(recomputeStatus([{ person_id: 1, total: 1200, representative: 30 }]))
      .toBe("1 people processed: 1,200 labeled faces -> 30 representatives.");
    expect(recomputeStatus([])).toBe("No one has enough labeled faces yet (see Settings for the threshold).");
  });
});

describe("RepresentativesPage", () => {
  it("shows a person's groups with the representative marked", async () => {
    const { calls } = mockApi({
      "GET /api/faces/dedup/persons": () => PERSONS,
      "GET /api/faces/dedup/groups": () => ANN_GROUPS,
    });
    const user = userEvent.setup();
    renderWithQuery(<RepresentativesPage />);
    expect(screen.getByText("Pick a person on the left to review their representative groups.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Ann/ }));
    const first = await screen.findByRole("region", { name: /^Group of 9\s*· showing 3$/ });
    expect(within(first).getByRole("img", { name: "Representative: f1.jpg" })).toHaveAttribute("src", "/api/faces/1/crop");
    expect(within(first).getAllByRole("img")).toHaveLength(3);
    expect(within(first).getByText("+6 more")).toBeInTheDocument();
    // All shown: no "showing" note, no "more".
    const second = screen.getByRole("region", { name: /^Group of 2$/ });
    expect(within(second).queryByText(/more/)).not.toBeInTheDocument();
    await waitFor(() => expect(status()).toBe("2 group(s), 5 of 12 face(s) shown."));
    expect(screen.getByRole("button", { name: /Ann/ })).toHaveAttribute("aria-pressed", "true");
    expect(calls.find((c) => c.url === "/api/faces/dedup/groups")?.query.get("person_id")).toBe("1");
  });

  it("only draws the latest person's groups when replies arrive out of order", async () => {
    let releaseAnn: () => void = () => {};
    mockApi({
      "GET /api/faces/dedup/persons": () => PERSONS,
      "GET /api/faces/dedup/groups": ({ query }) => query.get("person_id") === "1"
        ? new Promise((resolve) => { releaseAnn = () => resolve(ANN_GROUPS); })
        : BOB_GROUPS,
    });
    const user = userEvent.setup();
    renderWithQuery(<RepresentativesPage />);
    await user.click(await screen.findByRole("button", { name: /Ann/ }));
    await user.click(screen.getByRole("button", { name: /Bob/ }));
    await screen.findByRole("region", { name: "Group of 1" });
    releaseAnn();   // Ann's slower reply lands last
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: /Group of 9/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("region")).toHaveLength(1);
    await waitFor(() => expect(status()).toBe("1 group(s), 1 of 4 face(s) shown."));
  });

  it("recomputes, then refreshes the list and the open person", async () => {
    let groupLoads = 0;
    mockApi({
      "GET /api/faces/dedup/persons": () => PERSONS,
      "GET /api/faces/dedup/groups": () => { groupLoads++; return BOB_GROUPS; },
      "POST /api/faces/dedup/recompute": () => ({ persons: [{ person_id: 2, total: 4, representative: 1 }] }),
    });
    const user = userEvent.setup();
    renderWithQuery(<RepresentativesPage />);
    await user.click(await screen.findByRole("button", { name: /Bob/ }));
    await screen.findByRole("region", { name: "Group of 1" });
    await user.click(screen.getByRole("button", { name: "Recompute representatives" }));
    await waitFor(() => expect(groupLoads).toBe(2));
    await waitFor(() => expect(status()).toBe("1 group(s), 1 of 4 face(s) shown."));
  });

  it("explains an empty list and reports failures", async () => {
    mockApi({
      "GET /api/faces/dedup/persons": () => [],
      "POST /api/faces/dedup/recompute": () => jsonResponse(500, { detail: "boom" }),
    });
    const user = userEvent.setup();
    renderWithQuery(<RepresentativesPage />);
    expect(await screen.findByText(/No one has representative faces yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Recompute representatives" }));
    await waitFor(() => expect(status()).toBe("Recompute failed: boom"));
  });
});
