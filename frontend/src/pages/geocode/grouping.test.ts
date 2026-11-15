import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TOGGLES, TOGGLES_KEY, dateBounds, dayCounts, filterPhotos, gridItems, hasTimeline, loadBand, loadToggles,
  pinnedPhotos, stepGridIndex, timeBands, type DaySection, type GridEntry,
} from "./grouping";
import type { Photo } from "./staging";

// Wall clock stored as if UTC.
const ts = (y: number, m: number, d: number, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000;
const photo = (id: number, extra: Partial<Photo> = {}): Photo => ({ id, filename: `p${id}.jpg`, lat: null, lng: null, geocode_ignored: false, ...extra });

describe("filterPhotos", () => {
  const photos = [
    photo(1, { lat: 1, lng: 1, photo_datetime: ts(2021, 6, 1) }),
    photo(2, { photo_datetime: ts(2021, 6, 2) }),
    photo(3, { geocode_ignored: true, lat: 1, lng: 1, photo_datetime: ts(2021, 6, 3) }),
    photo(4, { filename: "shot.PNG", photo_datetime: ts(2021, 6, 4) }),
    photo(5, { camera: "Pixel" }),
  ];
  const none = { lo: null, hi: null };

  it("puts each photo in one bucket, ignored winning over a coordinate", () => {
    expect(filterPhotos(photos, DEFAULT_TOGGLES, new Set(), none).map((p) => p.id)).toEqual([1, 2, 4, 5]);
    expect(filterPhotos(photos, { ...DEFAULT_TOGGLES, geotagged: false, ignored: true }, new Set(), none).map((p) => p.id)).toEqual([2, 3, 4, 5]);
  });

  it("cuts screenshots across the buckets, and hides cameras", () => {
    expect(filterPhotos(photos, { ...DEFAULT_TOGGLES, screenshots: false }, new Set(), none).map((p) => p.id)).toEqual([1, 2, 5]);
    expect(filterPhotos(photos, DEFAULT_TOGGLES, new Set(["Unknown"]), none).map((p) => p.id)).toEqual([5]);
  });

  it("date-filters dated photos inclusively and keeps undated ones", () => {
    const b = dateBounds({ from: "2021-06-02", to: "2021-06-02" });
    expect(filterPhotos(photos, DEFAULT_TOGGLES, new Set(), b).map((p) => p.id)).toEqual([2, 5]);
  });

  it("counts days for the date picker, and needs two dated photos for it", () => {
    expect(dayCounts(photos.slice(0, 2))).toEqual([{ date: "2021-06-01", count: 1 }, { date: "2021-06-02", count: 1 }]);
    expect(hasTimeline(photos.slice(0, 1))).toBe(false);
    expect(hasTimeline(photos)).toBe(true);
  });
});

describe("toggles and rows", () => {
  beforeEach(() => localStorage.clear());
  it("takes only known boolean keys from storage", () => {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify({ ignored: true, geotagged: "no", bogus: true }));
    expect(loadToggles()).toEqual({ ...DEFAULT_TOGGLES, ignored: true });
    localStorage.setItem(TOGGLES_KEY, "[1]");
    expect(loadToggles()).toEqual(DEFAULT_TOGGLES);
    localStorage.setItem("geotagger.gridBandSecs", "900");
    expect(loadBand()).toBe(900);
    localStorage.setItem("geotagger.gridBandSecs", "7");
    expect(loadBand()).toBe(3600);
  });
});

describe("gridItems", () => {
  const photos = [
    photo(10, { dir: "C:\\Scans\\Box A" }),
    photo(11, { location: { city: "Austin", country: "US" } }),
    photo(1, { photo_datetime: ts(2021, 6, 1, 9, 5) }),
    photo(2, { photo_datetime: ts(2021, 6, 1, 9, 40) }),
    photo(3, { photo_datetime: ts(2021, 6, 1, 15, 0) }),
    photo(4, { photo_datetime: ts(2021, 7, 4, 10, 0) }),
  ];
  const days = (items: ReturnType<typeof gridItems>) => items.filter((i): i is DaySection => i.kind === "day");

  it("lays out year/month dividers and day sections, splitting the undated pile by place then folder", () => {
    const items = gridItems(photos, () => false, 3600);
    expect(items.map((i) => (i.kind === "day" ? `day:${i.title}` : `${i.kind}:${i.kind === "year" ? i.year : i.month}`))).toEqual([
      "day:📁 Box A", "day:📍 Austin, US", "year:2021", "month:5", "day:Tue 1", "month:6", "day:Sun 4",
    ]);
  });

  it("bands a day by time and skips staged photos, keeping their filtered index", () => {
    const tue = days(gridItems(photos, (id) => id === 2, 3600)).find((d) => d.title === "Tue 1")!;
    expect(tue.bands.map((b) => b.entries.map((e) => [e.photo.id, e.idx]))).toEqual([[[1, 2]], [[3, 4]]]);
    const whole = days(gridItems(photos, () => false, 0)).find((d) => d.title === "Tue 1")!;
    expect(whole.bands).toHaveLength(1);
  });

  it("bands consecutive runs by clock boundaries", () => {
    const e = (id: number, t: number): GridEntry => ({ photo: photo(id, { photo_datetime: t }), idx: id });
    const bands = timeBands([e(1, ts(2021, 1, 1, 9, 1)), e(2, ts(2021, 1, 1, 9, 14)), e(3, ts(2021, 1, 1, 9, 16))], 900);
    expect(bands.map((b) => b.entries.length)).toEqual([2, 1]);
  });
});

describe("stepGridIndex", () => {
  const ids = [1, 2, 3, 4, 5];
  const staged = (id: number) => id === 2 || id === 3;
  it("steps over staged photos and clamps at the ends", () => {
    expect(stepGridIndex(ids, 0, 1, staged)).toBe(3);
    expect(stepGridIndex(ids, 3, -1, staged)).toBe(0);
    expect(stepGridIndex(ids, 4, 1, staged)).toBe(4);
    expect(stepGridIndex(ids, -1, 1, staged)).toBe(0);
    expect(stepGridIndex(ids, -1, -1, staged)).toBe(0);
    expect(stepGridIndex([2, 3], -1, 1, staged)).toBe(-1);
  });
});

describe("pinnedPhotos", () => {
  it("adds the 'show nearby' day whatever the toggles say, and narrows to an isolated day", () => {
    const day1 = photo(1, { lat: 1, lng: 1, photo_datetime: ts(2021, 6, 1) });
    const day1hidden = photo(2, { lat: 2, lng: 2, photo_datetime: ts(2021, 6, 1, 14) });
    const day2 = photo(3, { lat: 3, lng: 3, photo_datetime: ts(2021, 6, 2) });
    const all = [day1, day1hidden, day2];
    expect(pinnedPhotos([day1, day2], all, null, null).map((p) => p.id)).toEqual([1, 3]);
    expect(pinnedPhotos([day1, day2], all, "2021-06-01", null).map((p) => p.id)).toEqual([1, 3, 2]);
    expect(pinnedPhotos([day1, day2], all, null, "2021-06-02").map((p) => p.id)).toEqual([3]);
  });
});
