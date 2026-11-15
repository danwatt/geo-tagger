import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { jsonResponse, mockApi, renderWithQuery } from "../../test/utils";
import { SemanticCard } from "./SemanticCard";

const model = { available: true, name: "siglip2", size_bytes: 1.4 * 1024 ** 3 };
const idleJob = { running: false, queued: false, done: false, error: null, message: "" };

function status(remaining: number, failed = 0) {
  return { model: "siglip2", available: true, total: 100, embedded: 100 - remaining - failed, failed, remaining };
}

describe("SemanticCard indexing", () => {
  it("runs batches until nothing remains", async () => {
    let left = 64;
    const { calls } = mockApi({
      "GET /api/semantic/status": () => status(left),
      "GET /api/data/semantic-model/download/status": () => idleJob,
      "GET /api/data/status": () => ({}),
      "POST /api/semantic/scan": () => {
        left -= 32;
        return { processed: 32, errors: [], remaining: left, failed: 0 };
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<SemanticCard status={model} />);

    await user.click(await screen.findByRole("button", { name: "Index 64 photos" }));
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/semantic/scan")).toHaveLength(2);
    expect(calls.find((c) => c.url === "/api/semantic/scan")?.body).toEqual({ limit: 32, allow_failures: false });
  });

  it("asks before marking unreadable files, then retries with allow_failures for one batch", async () => {
    let attempt = 0;
    const { calls } = mockApi({
      "GET /api/semantic/status": () => status(10),
      "GET /api/data/semantic-model/download/status": () => idleJob,
      "GET /api/data/status": () => ({}),
      "POST /api/semantic/scan": () => {
        if (++attempt === 1) {
          return jsonResponse(503, { detail: { code: "too_many_failures", message: "8 photos in a row couldn't be read.", errors: ["a.jpg: truncated"] } });
        }
        return { processed: 10, errors: ["a.jpg: truncated"], remaining: 0, failed: 1 };
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<SemanticCard status={model} />);

    await user.click(await screen.findByRole("button", { name: "Index 10 photos" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("8 photos in a row couldn't be read.");
    expect(dialog).toHaveTextContent("a.jpg: truncated");

    await user.click(screen.getByRole("button", { name: "Mark unreadable and continue" }));
    expect(await screen.findByText("Done. 1 photo(s) couldn't be read.")).toBeInTheDocument();
    const scans = calls.filter((c) => c.url === "/api/semantic/scan");
    expect(scans.map((c) => (c.body as { allow_failures: boolean }).allow_failures)).toEqual([false, true]);
  });
});
