import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import { nav } from "../../lib/handoff";
import { SearchPage } from "./SearchPage";

const MAR5 = Date.UTC(2021, 2, 5) / 1000;
const MAR20 = Date.UTC(2021, 2, 20) / 1000;
const APR1 = Date.UTC(2021, 3, 1) / 1000;

const photo = (id: number, ts: number | null, extra: Record<string, unknown> = {}) => ({ id, filename: `p${id}.jpg`, photo_datetime: ts, ...extra });

function page(photos: ReturnType<typeof photo>[], total = photos.length, extra: Record<string, unknown> = {}) {
  return { photos, total, offset: 0, limit: 2000, next_offset: null, truncated: photos.length < total, histogram: null, ...extra };
}

const BASE = {
  "GET /api/persons": () => [{ id: 7, name: "Ann" }, { id: 8, name: "Bob" }],
  "GET /api/search/cameras": () => ({ cameras: ["Canon EOS"] }),
  "GET /api/photos/dirs": () => [{ dir: "/pics/2021", total: 3, untagged: 1 }],
  "GET /api/stats/dates": () => ({ dates: [] }),
  "GET /api/semantic/status": () => ({ model: "m", available: true, total: 3, embedded: 3, failed: 0, remaining: 0 }),
};

function detail(id: number) {
  return { id, path: `/x/p${id}.jpg`, filename: `p${id}.jpg`, media_type: "image", camera: "Canon EOS", datetime: "2021-03-05 10:00", lat: null, lng: null, location: null };
}

beforeEach(() => {
  // jsdom has no canvas; the timeline just draws nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  window.history.replaceState({}, "", "/");
  localStorage.clear();
});

describe("SearchPage", () => {
  it("searches, groups by month, shift-selects a range and previews the focused photo", async () => {
    const { calls } = mockApi({
      ...BASE,
      "GET /api/search": () => page([photo(1, MAR5), photo(2, MAR20), photo(3, APR1)]),
      "GET /api/photos/1": () => detail(1),
      "GET /api/photos/3": () => detail(3),
    });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.selectOptions(await screen.findByLabelText("Geotagged"), "no");
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));

    expect(await screen.findByText("3 photos found")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/search")!.query.toString()).toBe("geotagged=no&offset=0");
    expect(screen.getByRole("region", { name: /March 2021/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /April 2021/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "p1.jpg" }));
    expect(await screen.findByText("Canon EOS", { selector: "td" })).toBeInTheDocument();
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "p3.jpg" }));
    await user.keyboard("{/Shift}");
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/photos/3")).toBe(true));

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it("runs the search on Enter in a filter field", async () => {
    const { calls } = mockApi({ ...BASE, "GET /api/search": () => page([]) });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.type(screen.getByLabelText("Describe"), "sunset{Enter}");
    expect(await screen.findByText("No photos match these filters.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/search")[0]!.query.get("text")).toBe("sunset");
    expect(calls.filter((c) => c.url === "/api/search")[0]!.query.get("sort")).toBe("relevance");
  });

  it("lets a newer search supersede one still in flight", async () => {
    let releaseOld: () => void = () => {};
    mockApi({
      ...BASE,
      "GET /api/search": ({ query }) => (query.get("camera")
        ? page([photo(20, MAR5)])
        : new Promise((res) => { releaseOld = () => res(page([photo(10, MAR5)])); })),
    });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Searching…"));
    await user.selectOptions(screen.getByLabelText("Camera"), "Canon EOS");
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    expect(await screen.findByRole("button", { name: "p20.jpg" })).toBeInTheDocument();

    releaseOld();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "p10.jpg" })).not.toBeInTheDocument();
    expect(screen.getByText("1 photo found")).toBeInTheDocument();
  });

  it("loads more into the same grid, dropping repeats, and selects every match", async () => {
    const { calls } = mockApi({
      ...BASE,
      "GET /api/search": ({ query }) => {
        if (query.get("ids_only")) return { ids: [1, 2, 3, 4], datetimes: [MAR5, MAR5, MAR20, APR1], total: 4 };
        return Number(query.get("offset")) === 0
          ? page([photo(1, MAR5), photo(2, MAR5)], 4, { limit: 2, next_offset: 2 })
          // Photo 2 moved between requests and comes back again.
          : page([photo(2, MAR5), photo(3, MAR20)], 4, { offset: 2, limit: 2, next_offset: 3 });
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    expect(await screen.findByText("Showing first 2 of 4 photos found")).toBeInTheDocument();
    const banner = screen.getByRole("region", { name: "More results" });
    expect(within(banner).getByText(/^Showing 2 of 4 photos\./)).toBeInTheDocument();

    await user.click(within(banner).getByRole("button", { name: "Load 2 more" }));
    expect(await screen.findByRole("button", { name: "p3.jpg" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "p2.jpg" })).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/search").map((c) => c.query.get("offset"))).toEqual(["0", "2"]);
    expect(calls.at(-1)!.query.get("limit")).toBe("2");
    expect(screen.getByText("Loaded 1 more — 3 of 4 now shown.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select all 4" }));
    expect(await screen.findByText("All 4 matches selected")).toBeInTheDocument();
    expect(screen.getByText(/Selected all 4 matches — 1 of them aren't loaded/)).toBeInTheDocument();
  });

  it("switches to untagged-face mode and back, dropping the other mode's results", async () => {
    const { calls } = mockApi({
      ...BASE,
      "GET /api/search": () => page([photo(1, MAR5)]),
      "GET /api/search/untagged-faces": () => ({
        mode: "single", threshold: 0.5, total: 1, offset: 0, limit: 500, next_offset: null, truncated: false, warnings: [],
        candidates: [{ photo: photo(5, MAR5), tagged: [], proposed: [{ person_id: 7, person_name: "Ann", face_id: 50, score: 0.61 }] }],
      }),
      "POST /api/faces/50/assign": () => ({ face_id: 50, person_id: 7, undo: null }),
    });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    const people = screen.getByRole("combobox", { name: "People" });
    await user.click(people);
    await user.click(await screen.findByRole("option", { name: "Ann" }));
    expect(screen.getByRole("button", { name: "Remove Ann" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    expect(await screen.findByRole("button", { name: "📍 Open in Geocode" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "🔎 Find untagged faces of Ann" }));
    expect(await screen.findByRole("button", { name: "Preview p5.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "p1.jpg" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "📍 Open in Geocode" })).not.toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/search/untagged-faces")!.query.get("person_ids")).toBe("7");

    // Confirming the suggestion moves the face to tagged, locally.
    await user.click(screen.getByRole("button", { name: /Ann\?/ }));
    expect(await screen.findByText("Ann", { selector: ".face-label" })).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/faces/50/assign")!.body).toEqual({ person_id: 7, clear: false });

    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    expect(await screen.findByRole("button", { name: "p1.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview p5.jpg" })).not.toBeInTheDocument();
  });

  it("assigns a date to the ids captured at open, after an inline confirm", async () => {
    let searches = 0;
    const { calls } = mockApi({
      ...BASE,
      "GET /api/search": () => { searches++; return page([photo(1, null), photo(2, null)]); },
      "GET /api/photos/1": () => detail(1),
      "GET /api/photos/2": () => detail(2),
      "POST /api/photos/assign-date": () => ({ updated: 2 }),
    });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    await user.click(await screen.findByRole("button", { name: "☑ Select all" }));
    const opener = screen.getByRole("button", { name: "📅 Assign date…" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Assign approximate date" });
    expect(within(dialog).getByText("Assigning an approximate date to 2 selected photos.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Year")).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Please enter a year.");

    await user.type(within(dialog).getByLabelText("Year"), "1999");
    await user.selectOptions(within(dialog).getByLabelText(/Month/), "3");
    await user.keyboard("{Enter}");
    expect(within(dialog).getByText(/Assign approximate date “March 1999” to 2 photo\(s\)\?/)).toBeInTheDocument();
    expect(searches).toBe(1); // Enter in the dialog never searches behind it
    await user.click(within(dialog).getByRole("button", { name: "Yes, assign" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.find((c) => c.url === "/api/photos/assign-date")!.body).toEqual({ photo_ids: [1, 2], year: 1999, month: 3 });
    await waitFor(() => expect(searches).toBe(2));
  });

  it("closes Guess dates on Escape and returns focus to its button", async () => {
    mockApi({
      ...BASE,
      "GET /api/search": () => page([photo(1, null)]),
      "GET /api/photos/1": () => detail(1),
      "POST /api/photos/guess-dates": () => ({ guesses: [{ photo_id: 1, filename: "p1.jpg", guess: { year: 2004, month: 3, day: 5, precision: null, source: "filename" } }] }),
    });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    await user.click(await screen.findByRole("button", { name: "p1.jpg" }));
    const opener = screen.getByRole("button", { name: "🔍 Guess dates…" });
    await user.click(opener);
    expect(await screen.findByText("March 5, 2004")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Commit the guess for p1.jpg" })).toBeChecked();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("narrows the grid with the timeline and keeps undated photos", async () => {
    mockApi({
      ...BASE,
      "GET /api/search": () => page([photo(1, MAR5), photo(2, APR1), photo(3, null)], 3,
        { histogram: { min: MAR5, max: APR1, bucket_secs: 86400, counts: [1, 0, 1] } }),
    });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    expect(await screen.findByRole("button", { name: "p1.jpg" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "Timeline start" }), { target: { value: "900" } });
    expect(screen.queryByRole("button", { name: "p1.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "p2.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "p3.jpg" })).toBeInTheDocument();
  });

  it("opens a ?place_id= deep link as a saved-place search", async () => {
    window.history.replaceState({}, "", "/search.html?place_id=3");
    const { calls } = mockApi({
      ...BASE,
      "GET /api/places": () => [{ id: 3, name: "Cabin", type: "circle", bounds: "{}", bounds_valid: true }],
      "GET /api/search": () => page([photo(1, MAR5)]),
    });
    renderWithQuery(<SearchPage />);
    expect(await screen.findByRole("button", { name: "p1.jpg" })).toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toHaveValue("Cabin");
    expect(screen.getByLabelText("Search area")).toHaveValue("0");
    expect(screen.getByText("Matches photo GPS coordinates within this saved area.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/search")!.query.toString()).toBe("place_id=3&nearby_m=0&offset=0");
  });

  it("hands a selection to Geocode in the URL", async () => {
    const go = vi.spyOn(nav, "go").mockImplementation(() => {});
    mockApi({ ...BASE, "GET /api/search": () => page([photo(1, MAR5), photo(2, MAR5)]), "GET /api/photos/2": () => detail(2) });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    await user.click(await screen.findByRole("button", { name: "📍 Open in Geocode" }));
    expect(go).toHaveBeenLastCalledWith("/geocode.html?ids=1,2");
    await user.click(screen.getByRole("button", { name: "p2.jpg" }));
    await user.click(screen.getByRole("button", { name: "📍 Open in Geocode" }));
    expect(go).toHaveBeenLastCalledWith("/geocode.html?ids=2");
  });

  it("shows a search failure in the status bar", async () => {
    mockApi({ ...BASE, "GET /api/search": () => jsonResponse(409, { detail: "Text search model not downloaded" }) });
    const user = userEvent.setup();
    renderWithQuery(<SearchPage />);
    await user.click(screen.getByRole("button", { name: "🔎 Search" }));
    expect(await screen.findByText("Search failed: Text search model not downloaded")).toBeInTheDocument();
  });
});
