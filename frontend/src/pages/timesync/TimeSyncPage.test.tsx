import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import type { VisTimelineProps } from "../../timeline/VisTimeline";
import { TimeSyncPage } from "./TimeSyncPage";

// vis-timeline doesn't render in jsdom: the wrapper is stubbed and its props
// captured, so a test can read what the timeline would draw and play its part.
const tl: { current: VisTimelineProps | null } = { current: null };
vi.mock("../../timeline/VisTimeline", () => ({
  VisTimeline: (props: VisTimelineProps) => {
    tl.current = props;
    return <div data-testid="timeline" />;
  },
}));

const ts = (d: number, h: number, m = 0) => Date.UTC(2021, 5, d, h, m) / 1000;   // June 2021, wall clock
const photo = (id: number, extra: Record<string, unknown> = {}) => ({
  id, filename: `p${id}.jpg`, lat: null, lng: null, camera: "Canon", geocode_ignored: false, ...extra,
});
const PHOTOS = [
  photo(1, { photo_datetime: ts(1, 10) }),
  photo(2, { photo_datetime: ts(1, 11), camera: "Nikon" }),
  photo(3, { photo_datetime: ts(2, 9) }),
  photo(4, { photo_datetime: null }),
];

const BASE = {
  "GET /api/status": () => ({ exiftool: { available: true, reason: null }, db_total: 4, geocoder: { available: true, cities: 0 } }),
  "GET /api/stats/months": () => ({
    months: [{ year: 2021, month: 6, total: 4, geotagged: 0, not_geotagged: 4 }],
    undated: { total: 0, geotagged: 0, not_geotagged: 0 },
  }),
  "GET /api/stats/dates": () => ({ dates: [{ date: "2021-06-01", count: 2 }, { date: "2021-06-02", count: 1 }] }),
};

const status = () => document.getElementById("status-bar")!.textContent;
const cell = (name: string) => screen.getByRole("button", { name });
const STORE = "geotagger.staged.timesync.v1";

afterEach(() => {
  sessionStorage.clear();
  tl.current = null;
});

async function openJune(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Select Month" }));
  await user.click(await screen.findByRole("button", { name: /^June 2021 — 4 photos/ }));
  await screen.findByRole("button", { name: "p1.jpg" });
}

describe("TimeSyncPage", () => {
  it("loads a month, applies an offset to one camera's photos and saves absolute times", async () => {
    let photos = PHOTOS;
    const { calls } = mockApi({
      ...BASE,
      "GET /api/photos": () => photos,
      "POST /api/photos/update-times": ({ body }) => {
        const updates = (body as { updates: { id: number; target: number }[] }).updates;
        photos = PHOTOS.map((p) => {
          const u = updates.find((x) => x.id === p.id);
          return u ? { ...p, photo_datetime: u.target } : p;
        });
        return {
          results: updates.map((u) => ({ id: u.id, photo_datetime: u.target, unchanged: false })),
          written: updates.map((u) => u.id), failed: [], not_found: [],
        };
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<TimeSyncPage />);
    await waitFor(() => expect(status()).toBe("Click 'Select Month' to begin"));
    await openJune(user);

    expect(calls.find((c) => c.url === "/api/stats/dates")!.query.toString()).toBe("year=2021&month=6");
    expect(calls.find((c) => c.url === "/api/photos")!.query.toString()).toBe("geotagged=all&date_from=2021-06-01&date_to=2021-06-30");
    expect(status()).toBe("Showing 4 of 4 photos");
    expect(screen.getByText("June 2021")).toBeInTheDocument();
    // The undated photo has no place on the timeline; the rows are the cameras.
    expect(tl.current!.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(tl.current!.groups.map((g) => g.id)).toEqual(["Canon", "Nikon"]);
    expect(tl.current!.fit).toMatchObject({ start: ts(1, 10) * 1000, end: ts(2, 9) * 1000 });

    // Validation: nothing selected, then a zero offset.
    await user.click(screen.getByRole("button", { name: "Apply to selection" }));
    expect(status()).toBe("No photos selected");

    // Shift-range from p1 to p3 skips the Nikon photo between them.
    await user.click(cell("p1.jpg"));
    expect(tl.current!.focus).toMatchObject({ id: 1 });
    fireEvent.click(cell("p3.jpg"), { shiftKey: true });
    expect([...tl.current!.selection]).toEqual([1, 3]);
    await user.click(screen.getByRole("button", { name: "Apply to selection" }));
    expect(status()).toBe("Please enter a non-zero offset");

    await user.clear(screen.getByLabelText("Offset minutes"));
    await user.type(screen.getByLabelText("Offset minutes"), "1");
    await user.clear(screen.getByLabelText("Offset seconds"));
    await user.type(screen.getByLabelText("Offset seconds"), "30");
    await user.click(screen.getByRole("button", { name: "Apply to selection" }));
    expect(status()).toBe("Applied +90s offset to 2 photos (relative to original time)");
    expect(tl.current!.items.find((i) => i.id === 1)).toMatchObject({ start: (ts(1, 10) + 90) * 1000, shifted: true });
    expect(JSON.parse(sessionStorage.getItem(STORE)!).entries).toEqual([
      { id: 1, offset: 90, base: ts(1, 10) },
      { id: 3, offset: 90, base: ts(2, 9) },
    ]);
    // The focused photo's adjusted time shows in the details.
    expect(within(screen.getByRole("complementary", { name: "Photo details" })).getByText("Adjusted time")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save times to sidecar (2)" }));
    const dialog = screen.getByRole("dialog", { name: "Save times" });
    expect(dialog).toHaveTextContent("Save time adjustments for 2 photos to sidecar files?");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(status()).toBe("Saved time adjustments for 2 photos"));
    expect(calls.find((c) => c.url === "/api/photos/update-times")!.body).toEqual({
      updates: [
        { id: 1, expected: ts(1, 10), target: ts(1, 10) + 90 },
        { id: 3, expected: ts(2, 9), target: ts(2, 9) + 90 },
      ],
    });
    // Offsets gone with the reload's new times: shown once, not double-shifted.
    expect(sessionStorage.getItem(STORE)).toBeNull();
    expect(tl.current!.items.find((i) => i.id === 1)).toMatchObject({ start: (ts(1, 10) + 90) * 1000, shifted: false });
  });

  it("keeps retryable failures after a partial save and drops conflicts", async () => {
    mockApi({
      ...BASE,
      "GET /api/photos": () => PHOTOS,
      "POST /api/photos/update-times": () => jsonResponse(502, {
        results: [], written: [], not_found: [],
        failed: [{ id: 1, error: "ExifTool timed out" }, { id: 3, error: "date changed", conflict: true }],
      }),
    });
    const user = userEvent.setup();
    renderWithQuery(<TimeSyncPage />);
    await openJune(user);
    await user.click(cell("p1.jpg"));
    fireEvent.click(cell("p3.jpg"), { shiftKey: true });
    await user.clear(screen.getByLabelText("Offset seconds"));
    await user.type(screen.getByLabelText("Offset seconds"), "-20");
    await user.click(screen.getByRole("button", { name: "Apply to selection" }));
    expect(status()).toBe("Applied -20s offset to 2 photos (relative to original time)");

    await user.click(screen.getByRole("button", { name: /^Save times to sidecar/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(status()).toBe("Updated 0 of 2; 2 failed: ExifTool timed out — press Save again to retry"));
    expect(JSON.parse(sessionStorage.getItem(STORE)!).entries).toEqual([{ id: 1, offset: -20, base: ts(1, 10) }]);
    expect([...tl.current!.selection]).toEqual([1]);
  });

  it("resets all offsets only after confirming", async () => {
    mockApi({ ...BASE, "GET /api/photos": () => PHOTOS });
    const user = userEvent.setup();
    renderWithQuery(<TimeSyncPage />);
    await openJune(user);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(status()).toBe("No offsets to reset");

    await user.click(cell("p2.jpg"));
    await user.type(screen.getByLabelText("Offset minutes"), "5");   // "05"
    await user.click(screen.getByRole("button", { name: "Apply to selection" }));
    // Deselect (ctrl-click), then Reset means "all".
    fireEvent.click(cell("p2.jpg"), { ctrlKey: true });
    await user.click(screen.getByRole("button", { name: "Reset" }));
    const dialog = screen.getByRole("dialog", { name: "Reset time offsets" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(sessionStorage.getItem(STORE)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset all" }));
    expect(status()).toBe("Time offsets reset");
    expect(sessionStorage.getItem(STORE)).toBeNull();
  });

  it("narrows a timeline shift-select to the selected photo's camera", async () => {
    mockApi({ ...BASE, "GET /api/photos": () => PHOTOS });
    const user = userEvent.setup();
    renderWithQuery(<TimeSyncPage />);
    await openJune(user);
    tl.current!.onSelect([3], false);
    await waitFor(() => expect([...tl.current!.selection]).toEqual([3]));
    tl.current!.onSelect([1, 2, 3], true);
    await waitFor(() => expect([...tl.current!.selection]).toEqual([1, 3]));
  });

  it("restores offsets kept from the last visit, drops stale ones, and reviews their month", async () => {
    sessionStorage.setItem(STORE, JSON.stringify({ v: 1, savedAt: 0, entries: [
      { id: 1, offset: 60, base: ts(1, 10) },        // still valid
      { id: 3, offset: 60, base: ts(2, 9) - 60 },    // already saved (now at base + offset)
      { id: 9, offset: 60, base: ts(1, 10) },        // deleted since
    ] }));
    const { calls } = mockApi({
      ...BASE,
      "GET /api/photos": ({ query }) => (query.get("ids") ? PHOTOS.filter((p) => query.get("ids")!.split(",").includes(String(p.id))) : PHOTOS),
    });
    const user = userEvent.setup();
    renderWithQuery(<TimeSyncPage />);

    await waitFor(() => expect(document.getElementById("staged-restore-banner")).toHaveTextContent("You have 1 uncommitted time offset from your last visit."));
    expect(calls.find((c) => c.query.get("ids"))!.query.get("ids")).toBe("1,3,9");
    expect(status()).toBe("Restored 1 unsaved time offset(s) from your last visit. Nothing is written until you Save.");
    expect(document.getElementById("staged-restore-banner")).toHaveTextContent("Dropped: 1 photo(s) no longer exist, 1 already saved.");
    expect(JSON.parse(sessionStorage.getItem(STORE)!).entries).toEqual([{ id: 1, offset: 60, base: ts(1, 10) }]);

    // Review opens the month of the earliest restored photo.
    const bar = document.getElementById("staged-restore-banner")!;
    await user.click(within(bar).getByRole("button", { name: "Review" }));
    await screen.findByRole("button", { name: "p1.jpg" });
    expect(calls.find((c) => c.url === "/api/stats/dates")!.query.toString()).toBe("year=2021&month=6");
    expect(tl.current!.items.find((i) => i.id === 1)).toMatchObject({ start: (ts(1, 10) + 60) * 1000, shifted: true });

    await user.click(within(bar).getByRole("button", { name: "Discard" }));
    expect(status()).toBe("Discarded 1 restored time offset(s).");
    expect(document.getElementById("staged-restore-banner")).toBeNull();
    expect(sessionStorage.getItem(STORE)).toBeNull();
  });

  it("keeps the saved offsets for the next reload when the restore check fails", async () => {
    const saved = { v: 1, savedAt: 0, entries: [{ id: 1, offset: 60, base: ts(1, 10) }] };
    sessionStorage.setItem(STORE, JSON.stringify(saved));
    mockApi({ ...BASE, "GET /api/photos": () => jsonResponse(500, { detail: "boom" }) });
    renderWithQuery(<TimeSyncPage />);
    await waitFor(() => expect(status()).toBe("Couldn't check the 1 time offset(s) kept from your last visit (boom). They're kept for the next reload."));
    expect(JSON.parse(sessionStorage.getItem(STORE)!).entries).toEqual(saved.entries);
  });
});
