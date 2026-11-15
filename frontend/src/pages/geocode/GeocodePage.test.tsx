import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import type { GeocodeMap } from "./GeocodeMap";
import { GeocodePage } from "./GeocodePage";

// Leaflet doesn't need to render in jsdom: the map pane is stubbed and its props
// captured, so a test can play the map's part (a drop on it).
type MapProps = Parameters<typeof GeocodeMap>[0];
const mapProps: { current: MapProps | null } = { current: null };
vi.mock("./GeocodeMap", () => ({
  DRAG_MIME: "application/json",
  IMPRECISE_RADII: [],
  GeocodeMap: (props: MapProps) => {
    mapProps.current = props;
    return <div data-testid="map" />;
  },
}));

const ts = (d: number, h: number, m = 0) => Date.UTC(2021, 5, d, h, m) / 1000;   // June 2021, wall clock
const photo = (id: number, extra: Record<string, unknown> = {}) => ({
  id, filename: `p${id}.jpg`, lat: null, lng: null, camera: "Canon", geocode_ignored: false, geotag_source: "none", ...extra,
});
const PHOTOS = [
  photo(1, { photo_datetime: ts(1, 10) }),
  photo(2, { photo_datetime: ts(1, 11, 30) }),
  photo(3, { photo_datetime: ts(2, 9), lat: 30, lng: -97, geotag_source: "sidecar" }),
  photo(4, { photo_datetime: ts(3, 9), geocode_ignored: true }),
];
const detail = (id: number) => ({ id, path: `/x/p${id}.jpg`, filename: `p${id}.jpg`, media_type: "image", lat: null, lng: null, datetime: "2021-06-01 10:00:00", geocode_ignored: false });
const snap = (id: number) => ({ id, geocode_ignored: false, expect: { geocode_ignored: true } });

const BASE = {
  "GET /api/status": () => ({ exiftool: { available: true, reason: null }, db_total: 4, geocoder: { available: true } }),
  "GET /api/stats/bounds": () => ({ has_data: false }),
  "GET /api/places": () => [],
  "GET /api/photos/dirs": () => [{ dir: "/pics/scans", total: 2, untagged: 2 }],
  "GET /api/photos/1": () => detail(1),
  "GET /api/photos/2": () => detail(2),
  "GET /api/photos/3": () => ({ ...detail(3), lat: 30, lng: -97 }),
  "GET /api/photos/4": () => detail(4),
  "POST /api/geotag/propose": () => ({ candidates: [], selected: 0, voted: 0, window_sec: 3600 }),
};

const status = () => document.getElementById("status-bar")!.textContent;
const cell = (name: string) => screen.getByRole("button", { name });

function open(url: string) {
  window.history.replaceState({}, "", url);
}

afterEach(() => {
  open("/");
  localStorage.clear();
  sessionStorage.clear();
  mapProps.current = null;
});

describe("GeocodePage", () => {
  it("opens ?month=, filters with the Show toggles, bands rows and moves with j/k", async () => {
    open("/geocode.html?month=2021-06");
    const { calls } = mockApi({ ...BASE, "GET /api/photos": () => PHOTOS });
    const user = userEvent.setup();
    renderWithQuery(<GeocodePage />);

    expect(await screen.findByRole("button", { name: "p1.jpg" })).toBeInTheDocument();
    const load = calls.find((c) => c.url === "/api/photos")!;
    expect(load.query.toString()).toBe("geotagged=all&date_from=2021-06-01&date_to=2021-06-30");
    // Ignored starts hidden.
    expect(screen.queryByRole("button", { name: "p4.jpg" })).not.toBeInTheDocument();
    expect(status()).toBe("Showing 3 of 4 photos");
    expect(screen.getByText(/June 2021 · All dates/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "🚫 Ignored" }));
    expect(cell("p4.jpg")).toBeInTheDocument();
    expect(status()).toBe("Showing 4 of 4 photos");
    expect(JSON.parse(localStorage.getItem("geotagger.geocode.showToggles.v1")!)).toMatchObject({ ignored: true });

    // Two hours on 1 June → two bands under its header; a whole-day row has none.
    expect(document.querySelectorAll(".grid-band-divider")).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText("Rows"), "0");
    expect(document.querySelectorAll(".grid-band-divider")).toHaveLength(0);
    expect(localStorage.getItem("geotagger.gridBandSecs")).toBe("0");

    // j / k move focus and collapse the selection; Shift+j extends it. (Not from
    // the Rows select, which keeps its keys.)
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await user.keyboard("j");
    expect(cell("p1.jpg")).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("j");
    expect(cell("p2.jpg")).toHaveAttribute("aria-pressed", "true");
    expect(cell("p1.jpg")).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("{Shift>}J{/Shift}");
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    // Hiding the selected photos' camera deselects them.
    await user.click(screen.getByRole("button", { name: "Canon" }));
    expect(status()).toBe("Showing 0 of 4 photos · deselected 2 now hidden");

    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("stages with I, commits after confirming, and undoes the last commit", async () => {
    open("/geocode.html?month=2021-06");
    const { calls } = mockApi({
      ...BASE,
      "GET /api/photos": () => PHOTOS,
      "POST /api/geotag/ignore": ({ body }) => ({ ids: (body as { ids: number[] }).ids, geocode_ignored: true, results: [{ id: 1, previous: snap(1) }] }),
      "POST /api/geotag/undo": () => ({ results: [{ id: 1, lat: null, lng: null, geotag_source: "none", geocode_ignored: false }], written: [1], failed: [], not_found: [] }),
    });
    const user = userEvent.setup();
    renderWithQuery(<GeocodePage />);
    await user.click(await screen.findByRole("button", { name: "p1.jpg" }));
    await user.keyboard("i");

    const staging = screen.getByRole("region", { name: "Staged changes" });
    expect(within(staging).getByText("🚫 No location needed")).toBeInTheDocument();
    expect(status()).toMatch(/^Staged 1 photo\(s\) as needing no location\. Nothing saved yet/);
    expect(screen.queryByRole("button", { name: "p1.jpg" })).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem("geotagger.staged.geocode.v1")!).entries)
      .toEqual([{ id: 1, ignore: true, was: { lat: null, lng: null, gi: false } }]));

    await user.click(within(staging).getByRole("button", { name: "✔ Commit all" }));
    const dialog = screen.getByRole("dialog", { name: "Commit staged changes" });
    expect(dialog).toHaveTextContent("Commit 1 staged change(s)? This writes them to the photos.");
    await user.click(within(dialog).getByRole("button", { name: "✔ Commit" }));
    await waitFor(() => expect(status()).toBe("Committed 1 change(s)."));
    expect(calls.find((c) => c.url === "/api/geotag/ignore")!.body).toEqual({ ids: [1], ignored: true });
    expect(screen.queryByRole("region", { name: "Staged changes" })).not.toBeInTheDocument();
    expect(screen.getByText(/^Last commit: 1 photo at/)).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("geotagger.undo.geocode.v1")!).previous).toEqual([snap(1)]);
    await waitFor(() => expect(sessionStorage.getItem("geotagger.staged.geocode.v1")).toBeNull());

    // Press u, confirm, and the snapshot goes back verbatim.
    await user.keyboard("u");
    await user.click(within(screen.getByRole("dialog", { name: "Undo last commit" })).getByRole("button", { name: "↶ Undo" }));
    await waitFor(() => expect(status()).toBe("Undid the last commit: 1 photo(s) restored."));
    expect(calls.find((c) => c.url === "/api/geotag/undo")!.body).toEqual({ previous: [snap(1)] });
    expect(screen.queryByText(/^Last commit:/)).not.toBeInTheDocument();
  });

  it("stages a drop on the map under its reverse-geocoded place and commits that group", async () => {
    open("/geocode.html?month=2021-06");
    const { calls } = mockApi({
      ...BASE,
      "GET /api/photos": () => PHOTOS,
      "GET /api/geocode/lookup": () => ({ lat: 30.1, lng: -97.2, location: { city: "Austin", state: "Texas", country: "United States" }, sources: {} }),
      "POST /api/geotag": ({ body }) => {
        const b = body as { ids: number[]; lat: number; lng: number };
        return { results: b.ids.map((id) => ({ id, lat: b.lat, lng: b.lng, geotag_source: "sidecar", previous: { id, expect: {} } })), written: b.ids, failed: [], not_found: [] };
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<GeocodePage />);
    await screen.findByRole("button", { name: "p2.jpg" });
    await act(async () => { mapProps.current!.onStageAt([2], 30.1, -97.2); });

    const staging = await screen.findByRole("region", { name: "Staged changes" });
    expect(within(staging).getByText("Austin, Texas, United States")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/geocode/lookup")!.query.toString()).toBe("lat=30.1&lng=-97.2");

    await user.click(within(staging).getByRole("button", { name: "✔ Commit (1)" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Commit 1 staged change(s) — Austin, Texas, United States?");
    await user.click(screen.getByRole("button", { name: "✔ Commit" }));
    await waitFor(() => expect(status()).toBe("Committed 1 change(s)."));
    expect(calls.find((c) => c.url === "/api/geotag")!.body).toEqual({ ids: [2], lat: 30.1, lng: -97.2, gps_accuracy: null });
    // The committed point heads the Tag as… Recent list from now on.
    expect(JSON.parse(localStorage.getItem("geotagger.recentLocations")!)[0]).toMatchObject({ lat: 30.1, lng: -97.2, label: "Austin, Texas, United States" });
    // p2 is geotagged now, back in the grid.
    expect(cell("p2.jpg")).toBeInTheDocument();
  });

  it("loads a Search hand-off with a POST", async () => {
    open("/geocode.html?ids=3,1");
    const { calls } = mockApi({ ...BASE, "POST /api/photos/by-ids": () => [PHOTOS[0], PHOTOS[2]] });
    renderWithQuery(<GeocodePage />);
    expect(await screen.findByRole("button", { name: "p3.jpg" })).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/photos/by-ids")!.body).toEqual({ ids: [3, 1] });
    expect(screen.getByText(/2 photo\(s\) from Search/)).toBeInTheDocument();
  });

  it("works a ?batch=: selects its members, skips, passes over and runs out", async () => {
    open("/geocode.html?batch=s%3ACanon%3A100");
    const batch1 = {
      id: "s:Canon:100", kind: "session", title: "Jun 1 · Canon", count: 2, start_ts: ts(1, 10), end_ts: ts(1, 11, 30),
      sample_photo_ids: [1], confidence: 0, proposal: null, photo_ids: [1, 2], position: 0, total_batches: 3,
    };
    const batch2 = { ...batch1, id: "f:/pics/scans", kind: "folder", dir: "/pics/scans", title: "📁 …/pics/scans", start_ts: null, end_ts: null, position: 1, photo_ids: [5] };
    let nextCalls = 0;
    const { calls } = mockApi({
      ...BASE,
      "GET /api/work-queue/batch/s%3ACanon%3A100": () => batch1,
      "GET /api/work-queue/next": () => (++nextCalls === 1 ? batch2 : jsonResponse(404, { detail: "No batches left" })),
      "GET /api/photos": ({ query }) => (query.get("dir") ? [photo(5, { dir: "/pics/scans" })] : PHOTOS.slice(0, 2)),
    });
    const user = userEvent.setup();
    renderWithQuery(<GeocodePage />);

    const banner = await screen.findByRole("region", { name: "Work queue batch" });
    expect(banner).toHaveTextContent("⚡ Batch 1 of 3");
    await waitFor(() => expect(banner).toHaveTextContent("2 selected"));
    expect(calls.find((c) => c.url === "/api/photos")!.query.toString()).toBe("geotagged=all&date_from=2021-06-01&date_to=2021-06-01");
    // The propose bar is asked about the batch's members.
    await waitFor(() => expect(calls.find((c) => c.url === "/api/geotag/propose")?.body).toEqual({ ids: [1, 2] }));

    await user.click(within(banner).getByRole("button", { name: /Skip/ }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Work queue batch" })).toHaveTextContent("Batch 2 of 3"));
    expect(JSON.parse(localStorage.getItem("geotagger.workqueue.skipped")!)).toEqual(["s:Canon:100"]);
    expect(calls.filter((c) => c.url === "/api/work-queue/next")[0]!.query.get("skip")).toBe("s:Canon:100");
    expect(calls.filter((c) => c.url === "/api/photos").at(-1)!.query.toString()).toBe("geotagged=all&dir=%2Fpics%2Fscans");
    expect(window.location.search).toBe("?batch=f%3A%2Fpics%2Fscans");

    // n passes over this one; nothing else is left, so the queue wraps and then ends.
    await user.keyboard("n");
    await waitFor(() => expect(status()).toBe("No batches left — everything is either tagged or too small to batch."));
    const skips = calls.filter((c) => c.url === "/api/work-queue/next").map((c) => c.query.get("skip"));
    expect(skips).toEqual(["s:Canon:100", "s:Canon:100,f:/pics/scans", "s:Canon:100"]);
    expect(screen.queryByRole("region", { name: "Work queue batch" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("offers staged work from before a reload back, and asks before leaving with it", async () => {
    open("/geocode.html");
    sessionStorage.setItem("geotagger.staged.geocode.v1", JSON.stringify({
      v: 1, savedAt: 1, entries: [
        { id: 1, lat: 30, lng: -97, accuracy: null, loc: null, label: "Austin", was: { lat: null, lng: null, gi: false } },
        { id: 99, ignore: true, was: { lat: null, lng: null, gi: false } },
      ],
    }));
    const { calls } = mockApi({ ...BASE, "GET /api/photos": () => [PHOTOS[0]] });
    const user = userEvent.setup();
    renderWithQuery(<GeocodePage />);

    expect(await screen.findByText("You have 1 uncommitted change from your last visit.")).toBeInTheDocument();
    expect(screen.getByText("Dropped: 1 photo(s) no longer exist.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/photos")!.query.get("ids")).toBe("1,99");
    expect(within(screen.getByRole("region", { name: "Staged changes" })).getByText("Austin")).toBeInTheDocument();
    expect(status()).toMatch(/^Restored 1 staged change\(s\) from your last visit/);
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem("geotagger.staged.geocode.v1")!).entries.map((r: { id: number }) => r.id)).toEqual([1]));

    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText(/uncommitted change/)).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem("geotagger.staged.geocode.v1")).toBeNull());
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("tags the selection from Tag as… and stages at the picked place", async () => {
    open("/geocode.html?month=2021-06");
    localStorage.setItem("geotagger.recentLocations", JSON.stringify([{ lat: 40, lng: -100, accuracy: 500, label: "Grandma's", ts: Date.now() }]));
    mockApi({
      ...BASE,
      "GET /api/photos": () => PHOTOS,
      "GET /api/geotag/hotspots": () => ({ hotspots: [], total: 0, offset: 0, merge_meters: 150 }),
      "GET /api/geocode/lookup": () => ({ lat: 40, lng: -100, location: null, sources: {} }),
    });
    const user = userEvent.setup();
    renderWithQuery(<GeocodePage />);
    await user.click(await screen.findByRole("button", { name: "p1.jpg" }));
    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: "Tag 1 photo(s) as…" });
    await user.keyboard("gran{Enter}");
    expect(dialog).not.toBeInTheDocument();
    const staging = await screen.findByRole("region", { name: "Staged changes" });
    // No geocode data: staged under the raw coordinate, keeping the recent's accuracy.
    expect(within(staging).getByText("📌 40.00000, -100.00000")).toBeInTheDocument();
    expect(within(staging).getByText("40.0000, -100.0000 ±500m")).toBeInTheDocument();
  });
});
