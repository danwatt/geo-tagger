import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM, EMPTY_PAGING, appendUnique, buildQuery, nextLimit, pagingCounts, pagingText, reloadWant, scopeText,
  selectionCountText, summaryText, untaggedOffset, withSimilar, withText, type Candidate, type SearchForm,
} from "./query";

const form = (p: Partial<SearchForm> = {}): SearchForm => ({ ...EMPTY_FORM, ...p });
const q = (p: Partial<SearchForm> = {}) => buildQuery(form(p)).toString();

describe("buildQuery", () => {
  it("sends nothing for an empty form (the API's date_asc default)", () => {
    expect(q()).toBe("");
  });

  it("puts parameters in the legacy order", () => {
    expect(q({
      text: "  beach  ", sort: "relevance", dateRange: { from: "2020-01-01", to: "2020-12-31" }, locationText: "Paris",
      geotagged: "no", camera: "Canon", folder: "/a/b", gpsAccuracy: "precise", hasFaces: "yes",
      persons: [{ id: 3, name: "A" }, { id: 9, name: "B" }], personMode: "any",
    })).toBe(
      "text=beach&date_from=2020-01-01&date_to=2020-12-31&location=Paris&geotagged=no&camera=Canon&dir=%2Fa%2Fb" +
      "&gps_accuracy=precise&has_faces=yes&sort=relevance&person_ids=3%2C9&person_mode=any",
    );
  });

  it("lets typed text win over a pending More like this", () => {
    expect(q({ text: "dog", similarTo: { id: 5, filename: "x.jpg" }, sort: "relevance" })).toBe("text=dog&sort=relevance");
    expect(q({ similarTo: { id: 5, filename: "x.jpg" }, sort: "relevance" })).toBe("similar_to=5&sort=relevance");
  });

  it("replaces the date range with undated=true", () => {
    expect(q({ undatedOnly: true, dateRange: { from: "2020-01-01", to: null } })).toBe("undated=true");
  });

  it("rejects an inverted range", () => {
    expect(() => q({ dateRange: { from: "2021-01-01", to: "2020-01-01" } })).toThrow(/From date/);
  });

  it("sends a saved place with its widening in metres, and metadata fields as JSON", () => {
    expect(q({ location: { kind: "place", id: 7, label: "Home" }, locationText: "Home", nearby: "1" }))
      .toBe("place_id=7&nearby_m=1609.34");
    expect(q({ location: { kind: "metadata", label: "Austin, Texas", fields: { loc_city: "Austin", loc_state: "Texas" } }, locationText: "Austin, Texas" }))
      .toBe("location_fields=" + encodeURIComponent(JSON.stringify({ loc_city: "Austin", loc_state: "Texas" })).replace(/%20/g, "+"));
  });

  describe("sort rules", () => {
    it("only sends relevance with a ranking query", () => {
      expect(q({ sort: "relevance" })).toBe("");
      expect(q({ sort: "relevance", text: "x" })).toBe("text=x&sort=relevance");
    });
    it("omits date_asc, the default, unless ranking (where it overrides relevance)", () => {
      expect(q({ sort: "date_asc" })).toBe("");
      expect(q({ sort: "date_asc", text: "x" })).toBe("text=x&sort=date_asc");
      expect(q({ sort: "camera" })).toBe("sort=camera");
    });
  });

  it("sends person_mode only with people", () => {
    expect(q({ personMode: "any" })).toBe("");
  });
});

describe("withText / withSimilar", () => {
  it("switches date order to Best match while typing, and back when cleared", () => {
    const typed = withText(form(), "sunset");
    expect(typed.sort).toBe("relevance");
    expect(withText(typed, "").sort).toBe("date_asc");
  });
  it("drops a pending similar_to and keeps an explicit sort", () => {
    const f = withText(form({ similarTo: { id: 1, filename: "a" }, sort: "camera" }), "x");
    expect(f.similarTo).toBeNull();
    expect(f.sort).toBe("camera");
  });
  it("keeps Best match on clear while More like this is pending", () => {
    expect(withText(form({ similarTo: { id: 1, filename: "a" }, sort: "relevance", text: "x" }), "").sort).toBe("relevance");
  });
  it("More like this clears the text and ranks", () => {
    expect(withSimilar(form({ text: "x", sort: "date_desc" }), { id: 4, filename: "b.jpg" }))
      .toMatchObject({ text: "", sort: "relevance", similarTo: { id: 4 } });
  });
});

describe("paging", () => {
  const paging = (p: Partial<typeof EMPTY_PAGING>) => ({ ...EMPTY_PAGING, ...p });

  it("keeps a reload of the same search at its loaded size", () => {
    const prev = paging({ key: "a=1", loaded: 4000, pageSize: 2000 });
    expect(reloadWant("a=1", prev)).toBe(4000);
    expect(reloadWant("a=2", prev)).toBeNull();
    expect(reloadWant("a=1", paging({ key: "a=1", loaded: 2000, pageSize: 2000 }))).toBeNull();
  });

  it("caps each request at the endpoint's max", () => {
    expect(nextLimit(null, 0, 20000)).toBeNull();
    expect(nextLimit(50000, 0, 20000)).toBe(20000);
    expect(nextLimit(50000, 40000, 20000)).toBe(10000);
  });

  it("drops repeats when appending a page", () => {
    const { merged, added } = appendUnique([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }], (x) => x.id);
    expect(merged.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(added.map((x) => x.id)).toEqual([3]);
  });

  it("starts the next untagged page earlier by the candidates emptied locally", () => {
    const c = (proposed: number): Candidate => ({ photo: { id: proposed, filename: "x", geocode_ignored: false }, tagged: [], proposed: Array.from({ length: proposed }, (_, i) => ({ person_id: 1, face_id: i, score: 0.5 })) });
    expect(untaggedOffset([c(1), c(0), c(2), c(0)], 500)).toEqual({ offset: 498, dropped: 2 });
  });

  it("says what part of the result set is on screen", () => {
    const p = paging({ key: "k", total: 12345, loaded: 2000, nextOffset: 2000, pageSize: 2000 });
    expect(summaryText(p, 2000, false)).toBe("Showing first 2,000 of 12,345 photos found");
    expect(summaryText(p, 2000, true)).toBe("Showing top 2,000 of 12,345 photos found");
    expect(summaryText(paging({ key: "k", total: 1, what: " similar to a.jpg" }), 1, false)).toBe("1 photo found similar to a.jpg");
    expect(pagingText(p, 2000, false, false)).toMatch(/^Showing 2,000 of 12,345 photos\. Select all and the timeline range/);
    expect(pagingCounts(p)).toEqual({ remaining: 10345, nextN: 2000, showAll: true });
    expect(pagingCounts(paging({ total: 3000, loaded: 2000, pageSize: 2000 }))).toEqual({ remaining: 1000, nextN: 1000, showAll: false });
  });

  it("counts a selection against the loaded and unloaded photos", () => {
    const loaded = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const p = paging({ total: 10, nextOffset: 3 });
    expect(selectionCountText(new Set([1, 2]), EMPTY_PAGING, loaded)).toBe("2 selected");
    expect(selectionCountText(new Set([1, 2]), p, loaded)).toBe("2 selected (of 3 loaded)");
    expect(selectionCountText(new Set([1, 99]), p, loaded)).toBe("2 selected (1 not loaded)");
    expect(selectionCountText(new Set(Array.from({ length: 10 }, (_, i) => i)), p, loaded)).toBe("All 10 matches selected");
  });
});

describe("scopeText", () => {
  it("names location, search area and dates", () => {
    expect(scopeText(form())).toBe("All locations · All dates");
    expect(scopeText(form({ location: { kind: "place", id: 1, label: "Home" }, locationText: "Home", nearby: "0.5", dateRange: { from: "2020-01-01", to: null, label: "From Jan 1, 2020" } })))
      .toBe("Home · +0.5 miles · From Jan 1, 2020");
  });
});
