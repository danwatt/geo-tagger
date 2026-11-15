import { describe, expect, it } from "vitest";
import type { Schemas } from "../api/client";
import { bannerView } from "./ScanBanner";

const idle: Schemas["ScanStatusResponse"] = {
  running: false, root: null, phase: null, processed: 0, total: 0, indexed: 0, skipped: 0,
  known_failed: 0, warnings: 0, errors: 0, error: null, summary: null, started_at: null, finished_at: null,
};
const none = { sawRunning: false, dismissedError: null, dismissedCount: 0 };

describe("bannerView", () => {
  it("is hidden when idle with nothing to report", () => {
    expect(bannerView(idle, none)).toEqual({ kind: "hidden" });
  });

  it("shows progress while scanning, then a post-scan phase name", () => {
    expect(bannerView({ ...idle, running: true, processed: 1200, total: 5000 }, none)).toMatchObject({
      kind: "running", text: "Scanning library… 1,200 / 5,000 files", closable: false,
    });
    expect(bannerView({ ...idle, running: true, phase: "geocoding" }, none).kind).toBe("running");
    expect(bannerView({ ...idle, running: true, phase: "geocoding" }, none)).toMatchObject({
      text: "Scanning library… reverse geocoding",
    });
  });

  it("asks for a reload after a scan this page watched", () => {
    expect(bannerView(idle, { ...none, sawRunning: true })).toMatchObject({ kind: "finished", closable: true });
  });

  it("shows a scan error until that error is dismissed", () => {
    const failed = { ...idle, error: "disk gone" };
    expect(bannerView(failed, none)).toMatchObject({ kind: "error", text: "Library scan failed: disk gone" });
    expect(bannerView(failed, { ...none, dismissedError: "disk gone" })).toEqual({ kind: "hidden" });
  });

  it("reminds about unindexed files until that count is dismissed", () => {
    const withErrors = { ...idle, errors: 3 };
    expect(bannerView(withErrors, none).kind).toBe("issues");
    expect(bannerView(withErrors, { ...none, dismissedCount: 3 })).toEqual({ kind: "hidden" });
    expect(bannerView({ ...idle, errors: 4 }, { ...none, dismissedCount: 3 }).kind).toBe("issues");
  });
});
