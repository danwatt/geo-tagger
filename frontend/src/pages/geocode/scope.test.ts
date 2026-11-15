import { describe, expect, it } from "vitest";
import { parseScopeUrl, placeBboxWithBuffer, scopeLabels, scopeRequest, shortDir, workspaceScopeText, type Place } from "./scope";

const place = (extra: Partial<Place> = {}): Place => ({
  id: 3, name: "Home", type: "rectangle", bounds: JSON.stringify({ south: 1, north: 2, west: 3, east: 4 }), bounds_valid: true, ...extra,
});

describe("parseScopeUrl", () => {
  it("reads ?month=YYYY-MM and ?month=undated", () => {
    expect(parseScopeUrl("?month=2021-06")).toEqual({ kind: "month", year: 2021, month: 6 });
    expect(parseScopeUrl("?month=undated")).toEqual({ kind: "undated" });
    expect(parseScopeUrl("?month=junk")).toEqual({ kind: "none" });
    expect(parseScopeUrl("")).toEqual({ kind: "none" });
  });

  it("reads ?batch= first, then ?ids=, then ?month=", () => {
    expect(parseScopeUrl("?batch=s%3ACam%3A100&ids=1,2&month=2021-06")).toEqual({ kind: "batch", id: "s:Cam:100" });
    expect(parseScopeUrl("?ids=1,2,x,3&month=2021-06")).toEqual({ kind: "ids", ids: [1, 2, 3] });
  });

  it("reads a Search hand-off from sessionStorage, or says it's gone", () => {
    expect(parseScopeUrl("?handoff=tok", (t) => (t === "tok" ? [5, 6] : null))).toEqual({ kind: "ids", ids: [5, 6] });
    expect(parseScopeUrl("?handoff=gone", () => null)).toEqual({ kind: "handoff-missing" });
    sessionStorage.setItem("geotagger.searchHandoff.abc", JSON.stringify([9]));
    expect(parseScopeUrl("?handoff=abc")).toEqual({ kind: "ids", ids: [9] });
  });
});

describe("scopeRequest", () => {
  it("builds the legacy URLs, always for the whole scope", () => {
    expect(scopeRequest({ kind: "month", year: 2020, month: 2 }, 900).url).toBe("/api/photos?geotagged=all&date_from=2020-02-01&date_to=2020-02-29");
    expect(scopeRequest({ kind: "month", year: 2020, month: null }, 900).url).toBe("/api/photos?geotagged=all&date_from=2020-01-01&date_to=2020-12-31");
    expect(scopeRequest({ kind: "undated" }, 900)).toEqual({ url: "/api/photos?geotagged=all&undated=true", timeline: false });
    expect(scopeRequest({ kind: "dir", dir: "C:\\Scans\\1985 Box", label: "x" }, 900).url).toBe("/api/photos?geotagged=all&dir=C%3A%5CScans%5C1985%20Box");
    expect(scopeRequest({ kind: "range", from: "2021-01-01", to: "2021-01-03", label: "x" }, 900).url).toBe("/api/photos?geotagged=all&date_from=2021-01-01&date_to=2021-01-03");
    expect(scopeRequest({ kind: "area", lat: 1, lng: 2, radius: 300 }, "3600").url).toBe("/api/photos/by-area?lat=1&lng=2&radius=300&geotagged=all&window=3600");
  });

  it("POSTs an id set rather than putting it in the URL", () => {
    const r = scopeRequest({ kind: "ids", ids: [1, 2], label: "x" }, 900);
    expect(r.url).toBe("/api/photos/by-ids");
    expect(r.init?.method).toBe("POST");
    expect(JSON.parse(String(r.init?.body))).toEqual({ ids: [1, 2] });
  });

  it("grows a place's bounds by the buffer", () => {
    const box = placeBboxWithBuffer(place(), 1);
    expect(box.min_lat).toBeCloseTo(1 - 1609.34 / 111000, 6);
    expect(box.max_lat).toBeCloseTo(2 + 1609.34 / 111000, 6);
    expect(scopeRequest({ kind: "place", place: place(), buffer: 0 }, 900).url)
      .toBe("/api/photos/by-bounds?min_lat=1&max_lat=2&min_lng=3&max_lng=4&geotagged=all&window=900");
    const loc = scopeRequest({ kind: "location", item: { kind: "metadata", label: "Austin", fields: { city: "Austin" } } }, 900).url;
    expect(new URL(loc, "http://x").searchParams.get("location_fields")).toBe(JSON.stringify({ city: "Austin" }));
  });
});

describe("labels", () => {
  it("labels each scope the way the toolbar did", () => {
    expect(scopeLabels({ kind: "month", year: 2021, month: 6 }).month).toBe("June 2021");
    expect(scopeLabels({ kind: "month", year: 2021, month: null }).month).toBe("2021 (all months)");
    expect(scopeLabels({ kind: "area", lat: 0, lng: 0, radius: 1500 }).area).toBe("Area: 1.50km radius");
    expect(scopeLabels({ kind: "place", place: place(), buffer: 0.5 }).area).toBe("Home (+0.5 mi)");
    expect(workspaceScopeText(null, null)).toBe("Choose a location or month · All dates");
    expect(workspaceScopeText({ kind: "place", place: place(), buffer: 0 }, "Jun 2021")).toBe("Home · Within bounds · Jun 2021");
  });

  it("shortens folder paths to their last two parts", () => {
    expect(shortDir("C:\\Photos\\Scans\\1985")).toBe("…\\Scans\\1985");
    expect(shortDir("/a/b")).toBe("/a/b");
  });
});
