import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import { isIncompleteDate } from "./fields";
import { PeopleManagePage, filterPersons, mergeSummary, type Person } from "./PeopleManagePage";

const ANN: Person = { id: 1, name: "Ann", birth_date: "1990-01-02", not_before: null, not_after: null, family_id: 10, family_name: "Smith", face_count: 3 };
const BOB: Person = { id: 2, name: "Bob", birth_date: null, not_before: null, not_after: null, family_id: null, family_name: null, face_count: 0 };
const FAMILIES = [{ id: 10, name: "Smith", person_count: 1 }, { id: 11, name: "Jones", person_count: 0 }];

function routes(extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}) {
  return mockApi({
    "GET /api/persons": () => [ANN, BOB],
    "GET /api/families": () => FAMILIES,
    "PATCH /api/persons/1": () => ({ ok: true, id: 1 }),
    "PATCH /api/persons/2": () => ({ ok: true, id: 2 }),
    ...extra,
  });
}

async function renderPage() {
  const user = userEvent.setup();
  renderWithQuery(<PeopleManagePage />);
  await screen.findByRole("textbox", { name: "Name of Ann" });
  return user;
}

describe("pure helpers", () => {
  it("holds back half-typed dates", () => {
    expect(isIncompleteDate("", true)).toBe(true);            // some segments empty
    expect(isIncompleteDate("0201-05-04", false)).toBe(true);  // year still being typed
    expect(isIncompleteDate("2019-05-04", false)).toBe(false);
    expect(isIncompleteDate("", false)).toBe(false);           // deliberately cleared
  });

  it("filters by name and family", () => {
    expect(filterPersons([ANN, BOB], "an", "").map((p) => p.name)).toEqual(["Ann"]);
    expect(filterPersons([ANN, BOB], "", "__none__").map((p) => p.name)).toEqual(["Bob"]);
    expect(filterPersons([ANN, BOB], "", "10").map((p) => p.name)).toEqual(["Ann"]);
  });

  it("summarises a merge", () => {
    expect(mergeSummary("Al", "Ann", {
      id: 1, name: "Ann", merged_from: { id: 3, name: "Al" }, moved_faces: 1, moved_representatives: 0,
      merged_negatives: 0, duplicate_negatives: 0, dropped_negatives: 0,
      filled: ["birth_date"], widened: ["not_before"], conflicts: [{ field: "family_id", kept: 1, discarded: 2 }],
    })).toBe('Merged "Al" into "Ann" — 1 face moved (took birth date; widened not-before; kept Ann\'s family)');
  });
});

describe("PeopleManagePage", () => {
  it("lists people with counts and filters them", async () => {
    routes();
    const user = await renderPage();
    expect(screen.getByText("2 people · 2 families")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by family" }), "No family");
    expect(screen.queryByRole("textbox", { name: "Name of Ann" })).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Search people" }), "zz");
    expect(screen.getByText("No people match the filter.")).toBeInTheDocument();
  });

  it("renames on Enter and reverts a blank name", async () => {
    const { calls } = routes();
    const user = await renderPage();
    const name = screen.getByRole("textbox", { name: "Name of Ann" });
    await user.clear(name);
    await user.tab();
    expect(name).toHaveValue("Ann");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    await user.clear(name);
    await user.type(name, "Anne{Enter}");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Anne" }));
    expect(await screen.findByText('Renamed to "Anne"')).toBeInTheDocument();
  });

  it("offers a merge when the new name is taken", async () => {
    const { calls } = routes({
      "PATCH /api/persons/2": () => jsonResponse(409, { detail: { message: 'A person named "Ann" already exists', existing_person_id: 1 } }),
      "POST /api/persons/2/merge": () => ({
        id: 1, name: "Ann", merged_from: { id: 2, name: "Bob" }, moved_faces: 0, moved_representatives: 0,
        merged_negatives: 0, duplicate_negatives: 0, dropped_negatives: 0, filled: [], widened: [], conflicts: [],
      }),
    });
    const user = await renderPage();
    const name = screen.getByRole("textbox", { name: "Name of Bob" });
    await user.clear(name);
    await user.type(name, "Ann{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Merge person" });
    expect(dialog).toHaveTextContent('A person named "Ann" already exists — merge into them? Merge "Bob" (0 faces) into "Ann"?');
    expect(name).toHaveValue("Bob");
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/persons/2/merge")?.body).toEqual({ into: 1 }));
    expect(await screen.findByText('Merged "Bob" into "Ann" — 0 faces moved')).toBeInTheDocument();
  });

  it("saves a complete birth date, clears an emptied one and rejects a half-typed one", async () => {
    const { calls } = routes();
    await renderPage();
    const birth = screen.getByLabelText("Birth date of Bob") as HTMLInputElement;
    const patches = () => calls.filter((c) => c.method === "PATCH").map((c) => c.body);

    // A year still being typed: nothing saved, the field reverts on blur.
    fireEvent.change(birth, { target: { value: "0201-05-04" } });
    fireEvent.blur(birth);
    expect(await screen.findByText("Birth date not saved — enter a full date (YYYY-MM-DD).")).toBeInTheDocument();
    expect(birth.value).toBe("");
    expect(patches()).toEqual([]);

    // A full date saves once typing pauses, without a blur.
    fireEvent.change(birth, { target: { value: "2019-05-04" } });
    await waitFor(() => expect(patches()).toEqual([{ birth_date: "2019-05-04" }]), { timeout: 2500 });
    expect(await screen.findByText("Birth date set")).toBeInTheDocument();
    fireEvent.blur(birth);   // the same value again: no second save
    expect(patches()).toHaveLength(1);

    const ann = screen.getByLabelText("Birth date of Ann") as HTMLInputElement;
    fireEvent.change(ann, { target: { value: "" } });
    fireEvent.blur(ann);
    await waitFor(() => expect(patches()).toContainEqual({ birth_date: null }));
    expect(await screen.findByText("Birth date cleared")).toBeInTheDocument();
  });

  it("reverts a date the server rejects", async () => {
    routes({ "PATCH /api/persons/2": () => jsonResponse(400, { detail: "not_before must be in YYYY-MM-DD format" }) });
    await renderPage();
    const nb = screen.getByLabelText("Not-before date of Bob") as HTMLInputElement;
    fireEvent.change(nb, { target: { value: "2019-05-04" } });
    fireEvent.blur(nb);
    expect(await screen.findByText("Save failed: not_before must be in YYYY-MM-DD format")).toBeInTheDocument();
    expect(nb.value).toBe("");
  });

  it("moves a person to a family and refreshes the family counts", async () => {
    const { calls } = routes();
    const user = await renderPage();
    const before = calls.filter((c) => c.url === "/api/families").length;
    await user.selectOptions(screen.getByRole("combobox", { name: "Family of Bob" }), "Jones");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ family_id: 11 }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/families").length).toBeGreaterThan(before));
    expect(screen.getByRole("combobox", { name: "Family of Bob" })).toHaveValue("11");
  });

  it("puts the family back when the move fails", async () => {
    routes({ "PATCH /api/persons/1": () => jsonResponse(404, { detail: "Family not found" }) });
    const user = await renderPage();
    const sel = screen.getByRole("combobox", { name: "Family of Ann" });
    await user.selectOptions(sel, "— No family —");
    expect(await screen.findByText("Save failed: Family not found")).toBeInTheDocument();
    expect(sel).toHaveValue("10");
  });

  it("creates a family from the picker, or filters to an existing one", async () => {
    const { calls } = routes({ "POST /api/families": () => ({ ok: true, id: 12, name: "Lee", person_count: 0 }) });
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "+ Add Family" }));
    await user.type(screen.getByRole("combobox", { name: "Family" }), "Lee");
    await user.click(screen.getByRole("option", { name: '➕ Create family "Lee"' }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Lee" }));

    await user.click(screen.getByRole("button", { name: "+ Add Family" }));
    await user.type(screen.getByRole("combobox", { name: "Family" }), "Smi{Enter}");
    expect(screen.getByRole("combobox", { name: "Filter by family" })).toHaveValue("10");
    expect(await screen.findByText('Family "Smith" already exists — showing its members')).toBeInTheDocument();
  });

  it("renames and deletes a family", async () => {
    const { calls } = routes({
      "PATCH /api/families/10": () => ({ ok: true, id: 10, name: "Smyth" }),
      "DELETE /api/families/10": () => ({ ok: true, id: 10, success: true }),
    });
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Rename family Smith" }));
    const input = screen.getByRole("textbox", { name: "Rename family Smith" });
    await user.clear(input);
    await user.type(input, "Smyth{Enter}");
    await waitFor(() => expect(calls.find((c) => c.url === "/api/families/10")?.body).toEqual({ name: "Smyth" }));

    await user.click(screen.getByRole("button", { name: "Delete family Smith" }));
    const dialog = screen.getByRole("dialog", { name: "Delete family" });
    expect(dialog).toHaveTextContent('Delete family "Smith"? Its 1 member(s) will become unassigned.');
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/families/10")).toBe(true));
  });

  it("deletes a person after a confirm with a fresh face count, then offers Undo", async () => {
    let reads = 0;
    const { calls } = routes({
      // The confirm re-reads the count: 5 now, not the 3 the list was loaded with.
      "GET /api/persons": () => (++reads > 1 ? [{ ...ANN, face_count: 5 }, BOB] : [ANN, BOB]),
      "DELETE /api/persons/1": () => ({ ok: true, id: 1, success: true, undo: { faces: [{ face_id: 1 }], person: { id: 1, name: "Ann" } } }),
      "POST /api/faces/undo": () => ({ restored: [1], conflicts: [], not_found: [], person_id: 1, person_id_changed: false, family_dropped: false }),
    });
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Delete Ann" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete person" });
    expect(dialog).toHaveTextContent('Delete "Ann"? 5 tagged faces will become unlabeled.');
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted “Ann”.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored “Ann” with 1 face.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/faces/undo")?.body).toEqual({ faces: [{ face_id: 1 }], person: { id: 1, name: "Ann" } });
  });

  it("cancelling a delete writes nothing", async () => {
    const { calls } = routes();
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Delete Bob" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete person" });
    expect(dialog).toHaveTextContent('Delete "Bob"?');
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("adds a person, or shows the existing one", async () => {
    const { calls } = routes({ "POST /api/persons": () => ({ ok: true, id: 3, name: "Cy" }) });
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "+ Add Person" }));
    await user.type(screen.getByRole("combobox", { name: "Person" }), "Cy{Enter}");
    await waitFor(() => expect(calls.find((c) => c.url === "/api/persons" && c.method === "POST")?.body).toEqual({ name: "Cy" }));

    await user.click(screen.getByRole("button", { name: "+ Add Person" }));
    await user.type(screen.getByRole("combobox", { name: "Person" }), "Bo{Enter}");
    expect(screen.getByRole("textbox", { name: "Search people" })).toHaveValue("Bob");
    expect(screen.queryByRole("textbox", { name: "Name of Ann" })).not.toBeInTheDocument();
  });
});
