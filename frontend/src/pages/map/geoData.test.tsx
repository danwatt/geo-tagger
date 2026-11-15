import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/errors";
import { DEFAULT_OVERLAYS, bboxParam, cellColor, mapHint, mapStatus, overlayErrorMessage, probeView, type Probe } from "./geoData";
import { ProbeResult, placePopupElement } from "./ProbeResult";

const PROBE: Probe = {
  lat: 40, lng: -74,
  location: { city: "Census CDP", sublocation: "Central Park", postal_code: "10001", county: "Kings", state: "New York", country: "United States", country_code: "US" },
  sources: {
    osm: { city: null, sublocation: "Central Park" },
    census: { city: "Census CDP" },
    zcta: { postal_code: "10001", postal_city: "PostalCity" },
    geonames: { city: "Testville" },
  },
};

describe("probe readout", () => {
  it("shows what would be saved and which source won the city", () => {
    render(<ProbeResult data={PROBE} />);
    const popup = screen.getByRole("status");
    expect(within(popup).getByText("Census CDP", { selector: ".map-popup-name" })).toBeInTheDocument();
    expect(within(popup).getByText("Sub-location").nextSibling).toHaveTextContent("Central Park");
    expect(within(popup).getByText("ZIP").nextSibling).toHaveTextContent("10001");
    const won = popup.querySelector(".map-popup-source-win")!;
    expect(won).toHaveTextContent("Census place");
    expect(within(popup).getByText("ZIP city").nextSibling).toHaveTextContent("PostalCity");
    expect(within(popup).getByText("GeoNames").nextSibling).toHaveTextContent("Testville");
    expect(within(popup).queryByText("OSM")).not.toBeInTheDocument();   // OSM had no city
    expect(within(popup).getByText("40.00000, -74.00000")).toBeInTheDocument();
  });

  it("says when nothing resolves", () => {
    const v = probeView({ lat: 1, lng: 2, location: null, sources: {} });
    expect(v.name).toBe("(no place resolves here)");
    expect(v.fields).toEqual([]);
    expect(v.candidates).toEqual([]);
    render(<ProbeResult data={{ lat: 1, lng: 2, location: null, sources: {} }} />);
    expect(screen.getByText("(nothing — no location)")).toBeInTheDocument();
  });

  it("shows loading and errors, 503 as no data installed", () => {
    const { rerender } = render(<ProbeResult loading />);
    expect(screen.getByText("Geocoding…")).toBeInTheDocument();
    rerender(<ProbeResult error={new ApiError(503, { detail: "No geocode data installed — run …" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("No geocode data installed");
    rerender(<ProbeResult error={new ApiError(500, null)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Error: HTTP 500");
  });

  it("builds marker popups from text, not HTML", () => {
    const el = placePopupElement({ city: "<b>Town</b>", county: "Kings", state: "NY", country: null, country_code: "US", population: 12345, lat: 1, lng: 2 });
    expect(el.querySelector(".map-popup-name")!.textContent).toBe("<b>Town</b>");
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector(".map-popup-region")!.textContent).toBe("Kings, NY");
    expect(el.querySelector(".map-popup-country")!.textContent).toBe("US");
  });
});

describe("hint and status", () => {
  const markers = (n: number, total = n) => ({ places: Array.from({ length: n }, () => ({ lat: 0, lng: 0, population: 1 })), total, truncated: total > n });

  it("asks to zoom in until anything loads, then names overlays still waiting", () => {
    expect(mapHint(5, DEFAULT_OVERLAYS, null)).toBe("Zoom in to see reverse-geocode places");
    expect(mapHint(9, DEFAULT_OVERLAYS, null)).toBe("Zoom in further to see place boundaries, OSM places");
    expect(mapHint(10, new Set(["census", "zcta"]), null)).toBeNull();
    expect(mapHint(9, new Set(["zcta"]), null)).toBe("Zoom in further to see ZIP areas");
    expect(mapHint(12, DEFAULT_OVERLAYS, new ApiError(503, null))).toBe("GeoNames data not installed — run scripts/get_geonames.py");
  });

  it("reports counts, truncation, failures and missing datasets", () => {
    const base = { zoom: 12, markersLoading: false, markersError: null, markers: undefined, overlayErrors: [] as string[] };
    expect(mapStatus({ ...base, zoom: 4 })).toEqual({ message: "" });
    expect(mapStatus({ ...base, markersLoading: true }).message).toBe("Loading places…");
    expect(mapStatus({ ...base, markers: markers(1) }).message).toBe("1 place in view");
    expect(mapStatus({ ...base, markers: markers(3000, 4500) }).message)
      .toBe(`Showing ${(3000).toLocaleString()} largest of ${(4500).toLocaleString()} places in view — zoom in for the rest`);
    expect(mapStatus({ ...base, markersError: new ApiError(503, null) })).toEqual({ message: "" });
    expect(mapStatus({ ...base, markersError: new ApiError(500, null) })).toEqual({ message: "Error loading places: HTTP 500", isError: true });
    expect(mapStatus({ ...base, markers: markers(2), overlayErrors: ["x"] })).toEqual({ message: "x", isError: true });
  });

  it("explains overlay failures by dataset", () => {
    expect(overlayErrorMessage("osm", new ApiError(503, null))).toBe("OSM places DB not built — run scripts/build_osm_places.py <region>.osm.pbf");
    expect(overlayErrorMessage("census", new ApiError(500, null))).toBe("Error loading Census places: HTTP 500");
    expect(overlayErrorMessage("zcta", new ApiError(503, { detail: "Census DB has no ZIP areas — rebuild it" }))).toBe("Census DB has no ZIP areas — rebuild it");
    expect(overlayErrorMessage("zcta", new ApiError(503, null))).toBe("Census ZIP areas not built — run scripts/get_census_places.py");
  });

  it("formats the bbox and colours cells stably", () => {
    expect(bboxParam({ west: -1, south: -2, east: 3, north: 4 })).toBe("-1,-2,3,4");
    expect(cellColor("Springfield")).toBe(cellColor("Springfield"));
    expect(cellColor("Springfield")).toMatch(/^hsl\(\d+, 65%, 55%\)$/);
    expect(cellColor("Springfield")).not.toBe(cellColor("Shelbyville"));
  });
});
