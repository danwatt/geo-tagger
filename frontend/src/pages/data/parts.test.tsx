import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useJob } from "../../lib/useJob";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import { JobControls } from "./parts";

const idle = { running: false, queued: false, done: false, error: null, message: "" };
const STATUS = "/api/test/download/status";

function Harness(props: { start: (force: boolean) => Promise<void>; validate?: () => string | null; forceWarning?: () => string }) {
  const job = useJob(STATUS, { intervalMs: 10 });
  return <JobControls id="t" job={job} startLabel="Download" {...props} />;
}

describe("JobControls", () => {
  it("starts, then shows the job's progress until it finishes", async () => {
    let polls = 0;
    mockApi({
      [`GET ${STATUS}`]: () => {
        polls++;
        if (polls === 1) return idle; // the on-load check
        if (polls < 4) return { ...idle, running: true, message: `Downloading… ${polls}` };
        return { ...idle, done: true, message: "Download complete." };
      },
    });
    const start = vi.fn(async () => {});
    const user = userEvent.setup();
    renderWithQuery(<Harness start={start} />);

    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(start).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Download complete.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("doesn't replay a finished job's message on load", async () => {
    mockApi({ [`GET ${STATUS}`]: () => ({ ...idle, done: true, message: "Old news." }) });
    renderWithQuery(<Harness start={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    expect(screen.queryByText("Old news.")).not.toBeInTheDocument();
  });

  it("resumes a job already running on load", async () => {
    mockApi({ [`GET ${STATUS}`]: () => ({ ...idle, running: true, message: "Merging Texas…" }) });
    renderWithQuery(<Harness start={vi.fn()} />);
    expect(await screen.findByText("Merging Texas…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  });

  it("shows a validation problem instead of starting", async () => {
    mockApi({ [`GET ${STATUS}`]: () => idle });
    const start = vi.fn(async () => {});
    const user = userEvent.setup();
    renderWithQuery(<Harness start={start} validate={() => "Select at least one region."} />);
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Select at least one region.");
    expect(start).not.toHaveBeenCalled();
  });

  it("asks before a forced re-download, and Cancel backs out", async () => {
    mockApi({ [`GET ${STATUS}`]: () => idle });
    const start = vi.fn(async () => {});
    const user = userEvent.setup();
    renderWithQuery(<Harness start={start} forceWarning={() => "This discards the cached Texas download."} />);

    await user.click(screen.getByLabelText(/Force re-download/));
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("discards the cached Texas download");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(start).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.click(screen.getByRole("button", { name: "Re-download" }));
    expect(start).toHaveBeenCalledWith(true);
  });

  it("reports a job that vanished from the server", async () => {
    let polls = 0;
    mockApi({
      [`GET ${STATUS}`]: () => (++polls === 1 ? idle : jsonResponse(404, { detail: "Not Found" })),
    });
    const user = userEvent.setup();
    renderWithQuery(<Harness start={async () => {}} />);
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The job is no longer on the server.");
  });
});
