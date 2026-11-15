import { describe, expect, it } from "vitest";
import { countLabel, deleteMessage, emptyListHint, nameClash, placeMeta, sortPlaces, visiblePlaces, type Place } from "./places";
import { hotspotCountLabel, hotspotKey, pickSuggestion, viewBbox, type Hotspot } from "./hotspots";

const MAR5 = Date.UTC(2021, 2, 5) / 1000;

function place(id: number, name: string, extra: Partial<Place> = {}): Place {
  return {
    id, name, type: "circle", bounds: '{"lat":1,"lng":2,"radius":250}', bounds_valid: true,
    created_at: id, representative_photo_id: null, ...extra,
  };
}

const PLACES = [
  place(1, "beach", { photo_count: 5, last_ts: 300 }),
  place(2, "Attic", { photo_count: 12, last_ts: 100, representative_photo_id: 9 }),
  place(3, "Cabin", { photo_count: 5, last_ts: null }),
];

describe("sortPlaces", () => {
  it("orders by name case-insensitively, and by stats with name breaking ties", () => {
    expect(sortPlaces(PLACES, "name").map((p) => p.name)).toEqual(["Attic", "beach", "Cabin"]);
    expect(sortPlaces(PLACES, "count").map((p) => p.name)).toEqual(["Attic", "beach", "Cabin"]);
    expect(sortPlaces(PLACES, "recent").map((p) => p.name)).toEqual(["beach", "Attic", "Cabin"]);
    expect(sortPlaces(PLACES, "created").map((p) => p.id)).toEqual([3, 2, 1]);
  });

  it("sorts a copy, leaving the map's order alone", () => {
    const list = [...PLACES];
    sortPlaces(list, "name");
    expect(list.map((p) => p.id)).toEqual([1, 2, 3]);
  });
});

describe("visiblePlaces", () => {
  it("filters by representative photo and by name", () => {
    expect(visiblePlaces(PLACES, "with-photo", "", "name").map((p) => p.id)).toEqual([2]);
    expect(visiblePlaces(PLACES, "without-photo", "", "name").map((p) => p.id)).toEqual([1, 3]);
    expect(visiblePlaces(PLACES, "all", "  CAB ", "name").map((p) => p.id)).toEqual([3]);
    expect(visiblePlaces(PLACES, "with-photo", "cab", "name")).toEqual([]);
  });

  it("says why the list is empty", () => {
    expect(emptyListHint(0, "", "all")).toBe("No places yet — draw a rectangle or circle on the map.");
    expect(emptyListHint(3, "Zoo", "all")).toBe("No place name matches “zoo”.");
    expect(emptyListHint(3, "", "with-photo")).toBe("No places have a representative photo.");
    expect(emptyListHint(3, "", "without-photo")).toBe("No places are missing a representative photo.");
  });

  it("counts '8 of 63' only while narrowed", () => {
    expect(countLabel(3, 3)).toBe("3");
    expect(countLabel(1, 3)).toBe("1 of 3");
    expect(countLabel(0, 0)).toBe("");
  });
});

describe("placeMeta", () => {
  it("lists the facts a hotspot row carries", () => {
    expect(placeMeta(place(1, "x", { photo_count: 1, last_ts: MAR5, untagged_nearby_count: 4 })))
      .toBe(`1 photo · last ${new Date(MAR5 * 1000).toLocaleDateString(undefined, { timeZone: "UTC" })} · 250 m · ~4 untagged nearby`);
    expect(placeMeta(place(2, "y", { type: "rectangle", bounds: '{"north":1,"south":0,"east":1,"west":0}' }))).toBe("rectangle");
  });

  it("flags an unreadable shape", () => {
    expect(placeMeta(place(1, "x", { bounds_valid: false }))).toMatch(/^⚠ Unreadable shape/);
  });

  it("explains what a delete keeps", () => {
    expect(deleteMessage(place(1, "x", { photo_count: 2 }))).toBe("The 2 photos taken here keep their coordinates — only the name and the shape go.");
    expect(deleteMessage(place(1, "x"))).toBe("Only the name and the shape go; no photo is changed.");
  });

  it("warns about a clashing name, but not the place's own", () => {
    expect(nameClash(PLACES, " ATTIC ", null)).toBe(true);
    expect(nameClash(PLACES, "Attic", 2)).toBe(false);
    expect(nameClash(PLACES, "  ", null)).toBe(false);
  });
});

describe("hotspots", () => {
  const h = (lat: number, lng: number, count: number): Hotspot => ({ lat, lng, count, label: `${lat}`, last_ts: null, sample_photo_id: null, location: null });

  it("suggests the first big enough hotspot that wasn't dismissed", () => {
    const list = [h(1, 1, 50), h(2, 2, 20), h(3, 3, 5)];
    expect(pickSuggestion(list, new Set())).toBe(list[0]);
    expect(pickSuggestion(list, new Set([hotspotKey(list[0]!)]))).toBe(list[1]);
    expect(pickSuggestion(list, new Set([hotspotKey(list[0]!), hotspotKey(list[1]!)]))).toBeNull();
  });

  it("wraps a view past the antimeridian and drops a whole-world view", () => {
    expect(viewBbox({ south: -10, north: 10, west: 170, east: 190 })).toEqual({ min_lat: -10, max_lat: 10, min_lng: 170, max_lng: -170 });
    expect(viewBbox({ south: -95, north: 95, west: -458, east: -400 })).toEqual({ min_lat: -90, max_lat: 90, min_lng: -98, max_lng: -40 });
    expect(viewBbox({ south: -80, north: 80, west: -200, east: 200 })).toBeNull();
  });

  it("says when the server's limit cut the list short", () => {
    expect(hotspotCountLabel(40, 112, false)).toBe("40 of 112");
    expect(hotspotCountLabel(3, 3, true)).toBe("3 in view");
    expect(hotspotCountLabel(0, 0, true)).toBe("");
  });
});
