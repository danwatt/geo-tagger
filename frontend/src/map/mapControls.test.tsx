import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BASEMAPS, basemapLayers, type BasemapKey } from "./basemaps";
import { BasemapButtons } from "./BasemapSwitcher";
import { OverlayPanel } from "./OverlayToggles";

describe("basemaps", () => {
  it("keeps the legacy tile sources: OSM street, Esri imagery, Esri reference overlay on hybrid", () => {
    expect(basemapLayers("street")).toEqual([{ url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", options: { attribution: "© OpenStreetMap contributors", maxZoom: 19 } }]);
    expect(basemapLayers("satellite")).toHaveLength(1);
    const hybrid = basemapLayers("hybrid");
    expect(hybrid).toHaveLength(2);
    expect(hybrid[0]!.url).toBe(BASEMAPS.satellite.url);
    expect(hybrid[1]!.url).toContain("server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places");
    for (const key of Object.keys(BASEMAPS) as BasemapKey[]) {
      for (const l of basemapLayers(key)) expect(l.url).toMatch(/^https:\/\/(\{s\}\.tile\.openstreetmap\.org|server\.arcgisonline\.com)\//);
    }
  });

  it("switches from the buttons and shows which one is on", async () => {
    function Harness() {
      const [key, setKey] = useState<BasemapKey>("street");
      return <BasemapButtons value={key} onChange={setKey} />;
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Street" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Hybrid" }));
    expect(screen.getByRole("button", { name: "Hybrid" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Street" })).toHaveAttribute("aria-pressed", "false");
    // The legacy switcher never remembered the choice, and neither does this.
    expect(localStorage.length).toBe(0);
  });
});

describe("OverlayPanel", () => {
  const options = [{ key: "a", label: "Place boundaries" }, { key: "b", label: "ZIP areas" }] as const;

  it("opens from the keyboard, toggles an overlay and closes on Escape", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<OverlayPanel options={options} enabled={new Set(["a"])} onToggle={onToggle} label="Boundary overlays" />);
    const toggle = screen.getByRole("button", { name: "Boundary overlays" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Place boundaries" })).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "Place boundaries" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "ZIP areas" }));
    expect(onToggle).toHaveBeenCalledWith("b", true);
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
});
