import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockApi, renderWithQuery } from "../test/utils";
import { LATEST_ONLY_STALE, latestOnly } from "../lib/latestOnly";
import { DateRangePicker, type DateRange } from "./DateRangePicker";
import { Dialog } from "./Dialog";
import { adjustWeights, gridColumns, parseSavedLayout } from "./ResizablePanes";
import { inTimelineRange, sliderToTs, timelineNarrowed } from "./TimelineHistogram";

describe("latestOnly", () => {
  it("aborts the previous call and resolves it to STALE", async () => {
    const resolvers: ((v: string) => void)[] = [];
    const signals: AbortSignal[] = [];
    const load = latestOnly((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>((res) => resolvers.push(res));
    });
    const first = load();
    const second = load();
    expect(signals[0]!.aborted).toBe(true);
    resolvers[1]!("new");
    resolvers[0]!("old");
    expect(await second).toBe("new");
    expect(await first).toBe(LATEST_ONLY_STALE);
  });

  it("swallows a superseded call's error and cancel() aborts without a new call", async () => {
    let reject: (e: Error) => void = () => {};
    const load = latestOnly((signal: AbortSignal) => new Promise<void>((_, rej) => { reject = rej; void signal; }));
    const first = load();
    const rejectFirst = reject;
    void load();
    rejectFirst(new Error("boom"));
    expect(await first).toBe(LATEST_ONLY_STALE);
    load.cancel();
  });
});

describe("ResizablePanes helpers", () => {
  it("restores a valid saved layout and rejects junk", () => {
    expect(parseSavedLayout(JSON.stringify({ weights: [60, 40], previewVisible: false }), [70, 30]))
      .toEqual({ weights: [60, 40], previewVisible: false });
    expect(parseSavedLayout(JSON.stringify({ weights: [95, 5] }), [70, 30]).weights).toEqual([70, 30]);
    expect(parseSavedLayout("{not json", [70, 30])).toEqual({ weights: [70, 30], previewVisible: true });
  });
  it("keeps both panes above the floor", () => {
    expect(adjustWeights([70, 30], 0, 20)).toEqual([85, 15]);
    expect(adjustWeights([70, 30], 0, -2)).toEqual([68, 32]);
    expect(gridColumns([70, 30], 2)).toBe("minmax(0, 70fr) 6px minmax(0, 30fr)");
    expect(gridColumns([70, 30], 1)).toBe("minmax(0, 70fr)");
  });
});

describe("timeline helpers", () => {
  const h = { min: 1000, max: 2000, bucket_secs: 100, counts: [1, 2] };
  it("narrows dated photos only", () => {
    const photos = [{ photo_datetime: 1100 }, { photo_datetime: 1900 }, { photo_datetime: null }];
    expect(timelineNarrowed(h, { lo: 1000, hi: 2000 })).toBe(false);
    expect(inTimelineRange(photos, h, { lo: 1000, hi: 2000 })).toHaveLength(3);
    expect(inTimelineRange(photos, h, { lo: 1500, hi: 2000 })).toEqual([{ photo_datetime: 1900 }, { photo_datetime: null }]);
    expect(sliderToTs(500, h)).toBe(1500);
  });
});

function DialogHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      {open && (
        <Dialog title="Pick a thing" onClose={() => { onClose?.(); setOpen(false); }}>
          <input aria-label="First field" />
          <button type="button">Last button</button>
        </Dialog>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("labels itself, traps focus, closes on Escape and restores focus", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Pick a thing" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("First field")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Last button" })).toHaveFocus();
    await user.tab(); // wraps to the first focusable: the close button
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last button" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes from its close button", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

function PickerHarness({ onChange }: { onChange: (r: DateRange) => void }) {
  const [value, setValue] = useState<DateRange>({ from: null, to: null });
  return <DateRangePicker value={value} onChange={(r) => { onChange(r); setValue(r); }} />;
}

describe("DateRangePicker", () => {
  const dates = { dates: [{ date: "2019-05-01", count: 3 }, { date: "2021-06-01", count: 5 }, { date: "2021-07-04", count: 2 }] };

  it("stages typed bounds and commits only on Apply", async () => {
    mockApi({ "GET /api/stats/dates": () => dates });
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PickerHarness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Any date/ }));
    const from = await screen.findByLabelText("From");
    await user.type(from, "2021-06-01");
    await user.type(screen.getByLabelText("To"), "2021-07-31");
    expect(screen.getByText("61 days")).toBeInTheDocument();
    expect(screen.getByText("7", { selector: "b" })).toBeInTheDocument(); // photos in range
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ from: "2021-06-01", to: "2021-07-31", label: "Jun 1 – Jul 31, 2021" }));
    expect(screen.getByRole("button", { name: "Jun 1 – Jul 31, 2021" })).toHaveFocus();
  });

  it("disables Apply for an inverted range and commits a preset by name", async () => {
    mockApi({ "GET /api/stats/dates": () => dates });
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PickerHarness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Any date/ }));
    await user.type(await screen.findByLabelText("From"), "2021-08-01");
    await user.type(screen.getByLabelText("To"), "2021-07-01");
    expect(screen.getByText("End is before start")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^2021/ }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2021-01-01", to: "2021-12-31", preset: "y2021", label: "2021" }));
    expect(screen.getByRole("button", { name: "2021" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear date range" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ from: null, to: null }));
  });

  it("builds a range from two calendar clicks and closes on Escape", async () => {
    mockApi({ "GET /api/stats/dates": () => dates });
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PickerHarness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Any date/ }));
    // A long library opens on its latest months (July + August 2021); step back.
    expect(await screen.findByText("July 2021")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Previous month" })[0]!);
    await user.click(screen.getByRole("button", { name: "Jun 1, 2021, 5 photos" }));
    await user.click(screen.getByRole("button", { name: /^Jun 3, 2021/ }));
    expect(screen.getByLabelText("From")).toHaveValue("2021-06-01");
    expect(screen.getByLabelText("To")).toHaveValue("2021-06-03");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose a date range" })).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });
});
