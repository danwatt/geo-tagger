import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import type { PlacesMapProps } from "./PlacesMap";
import { CustomPlacesPage } from "./CustomPlacesPage";

// Leaflet doesn't need to render in jsdom: the map is stubbed, and its props are
// captured so a test can play the map's part (a drawn shape, a dragged handle).
const mapProps: { current: PlacesMapProps | null } = { current: null };
vi.mock("./PlacesMap", () => ({
  PlacesMap: (props: PlacesMapProps) => {
    mapProps.current = props;
    return <div data-testid="map" />;
  },
}));

const CIRCLE = '{"lat":1,"lng":2,"radius":250}';
const RECT = '{"north":3,"south":1,"east":4,"west":2}';

function place(id: number, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, type: "circle", bounds: CIRCLE, bounds_valid: true, created_at: id, representative_photo_id: null, photo_count: 0, last_ts: null, untagged_nearby_count: 0, ...extra };
}

const NO_HOTSPOTS = { hotspots: [], total: 0, offset: 0, merge_meters: 150 };

afterEach(() => {
  localStorage.clear();
  mapProps.current = null;
});

describe("CustomPlacesPage", () => {
  it("lists places, filters by search, sorts, and selects from the keyboard", async () => {
    mockApi({
      "GET /api/places": () => [place(1, "Beach", { photo_count: 3 }), place(2, "Attic", { photo_count: 9, representative_photo_id: 5 })],
      "GET /api/geotag/hotspots": () => NO_HOTSPOTS,
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);

    const list = await screen.findByRole("list", { name: "Places" });
    expect(within(list).getAllByRole("listitem").map((li) => li.querySelector(".place-item-name")!.textContent)).toEqual(["Attic", "Beach"]);
    expect(screen.getByRole("link", { name: "Search the 9 photos taken at Attic" })).toHaveAttribute("href", "/search.html?place_id=2");

    await user.selectOptions(screen.getByLabelText("Sort places"), "count");
    await user.type(screen.getByLabelText("Search places"), "bea");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    const beach = screen.getByRole("button", { name: /^Beach/ });
    beach.focus();
    await user.keyboard("{Enter}");
    expect(beach).toHaveAttribute("aria-pressed", "true");
    expect(mapProps.current!.selectedId).toBe(1);

    // Selecting a place the filters hide (from the map) clears them.
    await user.selectOptions(screen.getByLabelText("Which places to list"), "with-photo");
    mapProps.current!.onSelect(1);
    await waitFor(() => expect(screen.getByLabelText("Which places to list")).toHaveValue("all"));
    expect(screen.getByLabelText("Search places")).toHaveValue("");
  });

  it("names a drawn rectangle and saves it", async () => {
    let created = false;
    const { calls } = mockApi({
      "GET /api/places": () => (created ? [place(7, "Yard", { type: "rectangle", bounds: RECT })] : []),
      "GET /api/geotag/hotspots": () => NO_HOTSPOTS,
      "POST /api/places": ({ body }) => { created = true; return { ok: true, id: 7, ...(body as object) }; },
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    expect(await screen.findByText("No places yet — draw a rectangle or circle on the map.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "📐 Rectangle" }));
    expect(mapProps.current!.drawMode).toBe("rectangle");
    expect(screen.getByText(/Drawing rectangle… click, hold and drag/)).toBeInTheDocument();
    mapProps.current!.onDrawn({ type: "rectangle", bounds: { north: 3, south: 1, east: 4, west: 2 } });

    const dialog = await screen.findByRole("dialog", { name: "Name this rectangle" });
    expect(within(dialog).queryByLabelText("Radius (metres)")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save place" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Name"), "Yard{Enter}");

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Yard", type: "rectangle", bounds: RECT });
    expect(await screen.findByText('Place "Yard" saved')).toBeInTheDocument();
    expect(await screen.findByText("Yard")).toBeInTheDocument();
    expect(mapProps.current!.drawMode).toBeNull();
  });

  it("uses the dialog's radius for a drawn circle, and warns about a clashing name", async () => {
    const { calls } = mockApi({
      "GET /api/places": () => [place(1, "Home")],
      "GET /api/geotag/hotspots": () => NO_HOTSPOTS,
      "POST /api/places": ({ body }) => ({ ok: true, id: 2, ...(body as object) }),
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await screen.findByText("Home");
    await user.click(screen.getByRole("button", { name: "⭕ Circle" }));
    mapProps.current!.onDrawn({ type: "circle", bounds: { lat: 5, lng: 6, radius: 87.4 } });

    const dialog = await screen.findByRole("dialog", { name: "Name this circle" });
    const radius = within(dialog).getByLabelText("Radius (metres)");
    expect(radius).toHaveValue(87);
    await user.type(within(dialog).getByLabelText("Name"), "home");
    expect(within(dialog).getByText("Another place is already called “home”.")).toBeInTheDocument();
    await user.clear(radius);
    await user.type(radius, "120");
    await user.click(within(dialog).getByRole("button", { name: "Save place" }));

    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "home", type: "circle", bounds: '{"lat":5,"lng":6,"radius":120}',
    }));
  });

  it("cancels drawing from the dialog and with Escape", async () => {
    mockApi({ "GET /api/places": () => [], "GET /api/geotag/hotspots": () => NO_HOTSPOTS });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await screen.findByText(/No places yet/);

    await user.click(screen.getByRole("button", { name: "⭕ Circle" }));
    await user.keyboard("{Escape}");
    expect(mapProps.current!.drawMode).toBeNull();
    expect(screen.getByText("Drawing cancelled")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "⭕ Circle" }));
    mapProps.current!.onDrawn({ type: "circle", bounds: { lat: 5, lng: 6, radius: 50 } });
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mapProps.current!.drawMode).toBeNull();
  });

  it("renames a place", async () => {
    const { calls } = mockApi({
      "GET /api/places": () => [place(1, "Beach")],
      "GET /api/geotag/hotspots": () => NO_HOTSPOTS,
      "PATCH /api/places/1": () => ({ ok: true, id: 1, success: true, bounds: CIRCLE }),
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await user.click(await screen.findByRole("button", { name: "Rename Beach" }));
    const dialog = screen.getByRole("dialog", { name: "Rename “Beach”" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Beach");
    await user.clear(name);
    await user.type(name, "  Shore ");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(await screen.findByText('Renamed to "Shore"')).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Shore" });
    expect(screen.getByRole("button", { name: /^Shore/ })).toBeInTheDocument();
  });

  it("saves a moved shape, and snaps back when the save fails", async () => {
    let fail = false;
    const { calls } = mockApi({
      "GET /api/places": () => [place(1, "Beach")],
      "GET /api/geotag/hotspots": () => NO_HOTSPOTS,
      "PATCH /api/places/1": ({ body }) => (fail
        ? jsonResponse(400, { detail: "radius must be positive" })
        : { ok: true, id: 1, success: true, bounds: (body as { bounds: string }).bounds }),
    });
    renderWithQuery(<CustomPlacesPage />);
    await screen.findByText("Beach");
    const p = mapProps.current!.places[0]!;

    mapProps.current!.onBoundsCommit(p, { type: "circle", bounds: { lat: 1, lng: 2, radius: 1500 } });
    expect(await screen.findByText('Updated "Beach" — radius 1.50 km')).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ bounds: '{"lat":1,"lng":2,"radius":1500}' });
    await waitFor(() => expect(mapProps.current!.places[0]!.bounds).toBe('{"lat":1,"lng":2,"radius":1500}'));

    fail = true;
    const rev = mapProps.current!.revision;
    mapProps.current!.onBoundsCommit(p, { type: "circle", bounds: { lat: 1, lng: 2, radius: 0 } });
    expect(await screen.findByText("Failed to update place: radius must be positive")).toBeInTheDocument();
    expect(mapProps.current!.revision).toBe(rev + 1);
  });

  it("deletes a place after confirming in the dialog", async () => {
    let deleted = false;
    const { calls } = mockApi({
      "GET /api/places": () => (deleted ? [] : [place(1, "Beach", { photo_count: 2 })]),
      "GET /api/geotag/hotspots": () => NO_HOTSPOTS,
      "DELETE /api/places/1": () => { deleted = true; return { ok: true, id: 1, success: true }; },
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await user.click(await screen.findByRole("button", { name: "Delete Beach" }));
    const dialog = screen.getByRole("dialog", { name: "Delete “Beach”?" });
    expect(within(dialog).getByText(/The 2 photos taken here keep their coordinates/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete place" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete Beach" }));
    await user.click(screen.getByRole("button", { name: "Delete place" }));
    expect(await screen.findByText('Place "Beach" deleted')).toBeInTheDocument();
    expect(await screen.findByText(/No places yet/)).toBeInTheDocument();
  });

  it("names the suggested hotspot as a circle at the merge radius", async () => {
    let named = false;
    const spot = { lat: 40.1, lng: -74.2, count: 25, last_ts: null, sample_photo_id: 3, location: null, label: "Elm St, Springfield" };
    const { calls } = mockApi({
      "GET /api/places": () => (named ? [place(4, "Mom's house")] : []),
      "GET /api/geotag/hotspots": () => ({ hotspots: named ? [] : [spot], total: named ? 0 : 1, offset: 0, merge_meters: 150 }),
      "POST /api/places": ({ body }) => { named = true; return { ok: true, id: 4, ...(body as object) }; },
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    const banner = await screen.findByRole("region", { name: "Suggested place" });
    expect(within(banner).getByText("25 photos here — no place named yet")).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: "✏️ Name it…" }));

    const dialog = screen.getByRole("dialog", { name: "Name this place" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Elm St, Springfield");
    expect(within(dialog).getByLabelText("Radius (metres)")).toHaveValue(150);
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Mom's house{Enter}");

    expect(await screen.findByText(`Saved "Mom's house" as a place (150 m radius).`)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "Mom's house", type: "circle", bounds: '{"lat":40.1,"lng":-74.2,"radius":150}',
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggested place" })).not.toBeInTheDocument());
  });

  it("remembers a dismissed suggestion", async () => {
    const spot = { lat: 1, lng: 2, count: 25, last_ts: null, sample_photo_id: null, location: null, label: "Spot" };
    mockApi({
      "GET /api/places": () => [],
      "GET /api/geotag/hotspots": () => ({ hotspots: [spot], total: 1, offset: 0, merge_meters: 100 }),
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await user.click(within(await screen.findByRole("region", { name: "Suggested place" })).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Suggested place" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("dismissedPlaceSuggestions")!)).toEqual(["1.00000,2.00000"]);
  });

  it("lists hotspots on request and pages in more", async () => {
    const spots = Array.from({ length: 62 }, (_, i) => ({ lat: i, lng: i, count: 100 - i, last_ts: null, sample_photo_id: null, location: null, label: `Spot ${i}` }));
    const { calls } = mockApi({
      "GET /api/places": () => [],
      "GET /api/geotag/hotspots": ({ query }) => {
        const offset = Number(query.get("offset") ?? 0), limit = Number(query.get("limit"));
        return { hotspots: spots.slice(offset, offset + limit), total: spots.length, offset, merge_meters: 100 };
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await user.click(await screen.findByLabelText("🔥 Hotspots"));
    const section = await screen.findByRole("region", { name: "Hotspots" });
    expect(await within(section).findByText("Spot 0")).toBeInTheDocument();
    expect(within(section).getByText("60 of 62")).toBeInTheDocument();
    expect(mapProps.current!.hotspots).toHaveLength(60);

    await user.click(within(section).getByRole("button", { name: "Load 2 more" }));
    expect(await within(section).findByText("Spot 61")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /more/ })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/geotag/hotspots").map((c) => c.query.get("offset"))).toContain("60");

    await user.selectOptions(screen.getByLabelText("Rank hotspots by"), "recent");
    await waitFor(() => expect(calls.some((c) => c.query.get("sort") === "recent" && c.query.get("limit") === "60")).toBe(true));
  });

  it("sets a representative photo from the photos inside the place", async () => {
    const { calls } = mockApi({
      "GET /api/places": () => [place(1, "Beach")],
      "GET /api/geotag/hotspots": () => NO_HOTSPOTS,
      // One inside the 250 m circle, one in the bbox corner outside it.
      "GET /api/photos/by-bounds": () => [
        { id: 10, filename: "in.jpg", lat: 1.0001, lng: 2.0001 },
        { id: 11, filename: "corner.jpg", lat: 1.0022, lng: 2.0022 },
      ],
      "PUT /api/places/1/representative": ({ body }) => ({ ok: true, id: 1, success: true, representative_photo_id: (body as { photo_id: number }).photo_id }),
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await user.click(await screen.findByRole("button", { name: "Choose a representative photo for Beach" }));
    const dialog = screen.getByRole("dialog", { name: "Representative photo — Beach" });
    await user.click(await within(dialog).findByRole("button", { name: "in.jpg" }));
    expect(within(dialog).queryByRole("button", { name: "corner.jpg" })).not.toBeInTheDocument();

    expect(await screen.findByText('Set the representative photo for "Beach"')).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/photos/by-bounds")!.query.get("geotagged")).toBe("yes");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ photo_id: 10 });
    expect(screen.getByRole("button", { name: "Remove the representative photo of Beach" })).toBeInTheDocument();
  });

  it("remembers the compact/gallery choice", async () => {
    mockApi({ "GET /api/places": () => [place(1, "Beach")], "GET /api/geotag/hotspots": () => NO_HOTSPOTS });
    const user = userEvent.setup();
    renderWithQuery(<CustomPlacesPage />);
    await screen.findByText("Beach");
    await user.click(screen.getByRole("button", { name: "Switch to gallery rows" }));
    expect(localStorage.getItem("placeDense")).toBe("gallery");
    expect(screen.getByRole("button", { name: "Switch to compact rows" })).toBeInTheDocument();
  });
});
