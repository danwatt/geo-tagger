import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import { NO_GEOCODE_DATA_HINT, ReverseGeocodeCard } from "./ReverseGeocodeCard";
import { WorkQueue, confClass } from "./WorkQueue";

function batch(i: number, extra: Record<string, unknown> = {}) {
  return {
    id: `s:cam:${i}`, kind: "session", title: `June ${i} · iPhone`, count: 10 + i,
    start_ts: 1_700_000_000 + i, end_ts: 1_700_000_100 + i, sample_photo_ids: [i],
    confidence: 0.9, proposal: { lat: 1, lng: 2, label: "Yosemite Valley" }, ...extra,
  };
}

function queue(batches: ReturnType<typeof batch>[], total: number, extra: Record<string, unknown> = {}) {
  return { batches, total_batches: total, batched_photos: 300, total_photos: 400, tail_photos: 12, ...extra };
}

describe("confClass", () => {
  it("grades the guess share", () => {
    expect(confClass(0.85)).toBe("wq-conf good");
    expect(confClass(0.5)).toBe("wq-conf fair");
    expect(confClass(0.1)).toBe("wq-conf weak");
  });
});

describe("WorkQueue", () => {
  it("lists batches with totals and pages in more", async () => {
    mockApi({
      "GET /api/work-queue": ({ query }) => {
        return Number(query.get("offset")) === 0
          ? queue(Array.from({ length: 20 }, (_, i) => batch(i)), 25)
          : queue([20, 21, 22, 23, 24].map((i) => batch(i)), 25);
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<WorkQueue />);

    expect(await screen.findByText("June 0 · iPhone")).toBeInTheDocument();
    expect(screen.getByText(/25 batches · 300 photos\s+\(12 more not worth batching\)/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Open in Geocode" })[0]).toHaveAttribute("href", "/geocode.html?batch=s%3Acam%3A0");

    await user.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(await screen.findByText("June 24 · iPhone")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more/ })).not.toBeInTheDocument();
  });

  it("refetches for another kind and says when nothing is batchable", async () => {
    const { calls } = mockApi({
      "GET /api/work-queue": () => queue([], 0, { total_photos: 3, tail_photos: 3, batched_photos: 0 }),
    });
    const user = userEvent.setup();
    renderWithQuery(<WorkQueue />);
    expect(await screen.findByText("Nothing big enough to batch — use the month bars below.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Folders" }));
    await waitFor(() => expect(calls.some((c) => c.query.get("kind") === "folder")).toBe(true));
    expect(screen.getByRole("button", { name: "Folders" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers to clear the skipped list kept in this browser", async () => {
    localStorage.setItem("geotagger.workqueue.skipped", JSON.stringify(["a", "b"]));
    mockApi({ "GET /api/work-queue": () => queue([batch(1)], 1) });
    const user = userEvent.setup();
    renderWithQuery(<WorkQueue />);
    await user.click(await screen.findByRole("button", { name: "Clear skipped (2)" }));
    expect(localStorage.getItem("geotagger.workqueue.skipped")).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear skipped/ })).not.toBeInTheDocument();
  });
});

const geocode = { any_available: true, geocoded: 30, pending: 0, export_pending: 450 };

describe("ReverseGeocodeCard", () => {
  it("exports sidecars in cursor-chained batches and reports the result", async () => {
    let cursor = 0;
    const { calls } = mockApi({
      "POST /api/geocode/export-sidecars": ({ body }) => {
        const after = (body as { after_id: number }).after_id;
        expect(after).toBe(cursor);
        cursor += 200;
        const remaining = Math.max(0, 450 - cursor);
        return { processed: 200, written: after === 0 ? 199 : 200, failed: after === 0 ? 1 : 0,
          errors_sample: after === 0 ? ["IMG_1.jpg: locked"] : [], cursor, remaining };
      },
    });
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<ReverseGeocodeCard geocode={geocode} error={null} onDone={onDone} />);

    await user.click(screen.getByRole("button", { name: "Export to sidecars" }));
    expect(await screen.findByText("Wrote 599 sidecars · 1 failed (IMG_1.jpg: locked)")).toBeInTheDocument();
    expect(calls.map((c) => (c.body as { after_id: number }).after_id)).toEqual([0, 200, 400]);
    expect(onDone).toHaveBeenCalled();
  });

  it("shows the no-data hint when the backfill finds no dataset", async () => {
    mockApi({ "POST /api/geocode/backfill": () => jsonResponse(503, { detail: "No geocoding dataset" }) });
    const user = userEvent.setup();
    renderWithQuery(<ReverseGeocodeCard geocode={{ ...geocode, pending: 5 }} error={null} onDone={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Run backfill" }));
    expect(await screen.findByText(NO_GEOCODE_DATA_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run backfill" })).toBeDisabled();
  });
});
