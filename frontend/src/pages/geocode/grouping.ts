import { MONTH_NAMES } from "../../lib/format";
import type { DateRange } from "../../ui/DateRangePicker";
import type { DayRow } from "../../ui/dateRange";
import { parseWallClockDay, wallClockDay } from "./scope";
import type { Photo } from "./staging";

/* The grid's view of the loaded scope: the Show toggles, the camera and date
 * filters, and the day → time-band layout. Every scope loads whole
 * (geotagged=all) and is filtered here, so the date picker describes the whole
 * scope while the grid shows a subset, and flipping a toggle is instant instead
 * of a round trip. Port of app.js applyFilters / renderGrid / timeBands.
 *
 * Photo timestamps are wall clock, not instants: photo_datetime is the EXIF
 * datetime read as if it were UTC (sidecar.py → calendar.timegm), so every
 * calendar field here is taken with the UTC getters, which hand back exactly the
 * wall clock the camera wrote. Local getters would shift every photo by the
 * viewer's own offset — in US Central a 20:07 photo lands in the 3 PM band, and
 * photos near midnight on the wrong day. */

// ── Show toggles ──

export type FilterKey = "geotagged" | "untagged" | "screenshots" | "ignored";
export type Toggles = Record<FilterKey, boolean>;

// Ignored starts off: those photos are done, and the point of this screen is
// the ones that aren't.
export const DEFAULT_TOGGLES: Toggles = { geotagged: true, untagged: true, screenshots: true, ignored: false };
export const TOGGLES_KEY = "geotagger.geocode.showToggles.v1";

export const FILTER_BUTTONS: { key: FilterKey; label: string; title: string }[] = [
  { key: "geotagged", label: "📍 Geotagged", title: "Show photos that already have a location" },
  { key: "untagged", label: "❓ Not tagged", title: "Show photos still waiting for a location" },
  { key: "screenshots", label: "🖼 Screenshots", title: "Show screenshots (.png)" },
  { key: "ignored", label: "🚫 Ignored", title: "Show photos marked as needing no location" },
];

/** What the viewer last clicked the toggles to, remembered per browser. Only
 *  known keys with boolean values are taken from storage, so a stale or garbled
 *  entry can't add a filter or hide everything with a non-boolean. */
export function loadToggles(): Toggles {
  const out = { ...DEFAULT_TOGGLES };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(TOGGLES_KEY) ?? "null");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      (Object.keys(out) as FilterKey[]).forEach((k) => {
        const v = (saved as Record<string, unknown>)[k];
        if (typeof v === "boolean") out[k] = v;
      });
    }
  } catch { /* not remembered */ }
  return out;
}

export function saveToggles(t: Toggles): void {
  try { localStorage.setItem(TOGGLES_KEY, JSON.stringify(t)); } catch { /* not remembered */ }
}

// ── Row bands ──

export const BAND_KEY = "geotagger.gridBandSecs";
export const BAND_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Rows: whole day" },
  { value: 300, label: "Rows: 5 min" },
  { value: 600, label: "Rows: 10 min" },
  { value: 900, label: "Rows: 15 min" },
  { value: 1200, label: "Rows: 20 min" },
  { value: 1800, label: "Rows: 30 min" },
  { value: 3600, label: "Rows: 1 hour" },
];

/** The remembered Rows choice (a plain string, as the legacy page stored it). */
export function loadBand(): number {
  try {
    const saved = localStorage.getItem(BAND_KEY);
    if (saved !== null && BAND_OPTIONS.some((o) => String(o.value) === saved)) return Number(saved);
  } catch { /* storage blocked */ }
  return 3600;
}

export function saveBand(secs: number): void {
  try { localStorage.setItem(BAND_KEY, String(secs)); } catch { /* not remembered */ }
}

// ── Filtering ──

/** Which of the three mutually exclusive buckets a photo is in. Ignored wins
 *  over having a coordinate: a photo marked "no location needed" belongs under
 *  🚫 even if it carries one from a previous pass. */
export function photoBucket(p: Photo): "ignored" | "geotagged" | "untagged" {
  if (p.geocode_ignored) return "ignored";
  return p.lat != null ? "geotagged" : "untagged";
}

export function cameraKey(p: Pick<Photo, "camera">): string {
  return p.camera || "Unknown";
}

/** Inclusive wall-clock bounds of a date range (null = open on that side). The
 *  end day runs to its last second. */
export type DateBounds = { lo: number | null; hi: number | null };
export function dateBounds(range: DateRange): DateBounds {
  return {
    lo: range.from ? parseWallClockDay(range.from) : null,
    hi: range.to ? parseWallClockDay(range.to) + 86399 : null,
  };
}

export function filterPhotos(photos: readonly Photo[], toggles: Toggles, hiddenCameras: ReadonlySet<string>, dates: DateBounds): Photo[] {
  return photos.filter((p) => {
    if (hiddenCameras.has(cameraKey(p))) return false;
    // Screenshots cuts across the buckets rather than being one of them — a
    // screenshot is usually also untagged, and hiding the noise shouldn't cost
    // you the rest of the untagged photos.
    if (!toggles.screenshots && /\.png$/i.test(p.filename)) return false;
    if (!toggles[photoBucket(p)]) return false;
    // Undated (0/null) stays visible; negative = pre-1970, still range-filtered.
    const ts = p.photo_datetime || 0;
    if (ts && ((dates.lo !== null && ts < dates.lo) || (dates.hi !== null && ts > dates.hi))) return false;
    return true;
  });
}

/** The loaded scope's own daily counts, for the date picker. Bucketed by UTC day,
 *  matching how the rest of the page reads photo_datetime. */
export function dayCounts(photos: readonly Photo[]): DayRow[] {
  const byDay = new Map<string, number>();
  for (const p of photos) {
    const ts = p.photo_datetime;
    if (!ts) continue;   // undated; negative (pre-1970) is a real date
    const key = wallClockDay(ts);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  return [...byDay].map(([date, count]) => ({ date, count }));
}

/** The date picker only makes sense with at least two dated photos. */
export function hasTimeline(photos: readonly Photo[]): boolean {
  let n = 0;
  for (const p of photos) if (p.photo_datetime && ++n >= 2) return true;
  return false;
}

export function dayKey(p: Pick<Photo, "photo_datetime">): string | null {
  return p.photo_datetime ? wallClockDay(p.photo_datetime) : null;
}

/** Photos the map should pin: everything the filters kept, plus — with "Show
 *  nearby on map" active — that day's photos even when a toggle excludes them
 *  (the day's *geotagged* photos are usually exactly what the toggles hide). An
 *  isolated day ("Show only this day on map") narrows it to that day. */
export function pinnedPhotos(filtered: readonly Photo[], photos: readonly Photo[], dayOverride: string | null, isolation: string | null): Photo[] {
  let out: Photo[] = filtered as Photo[];
  if (dayOverride) {
    const shown = new Set(filtered.map((p) => p.id));
    out = out.concat(photos.filter((p) => !shown.has(p.id) && dayKey(p) === dayOverride));
  }
  if (isolation) out = out.filter((p) => dayKey(p) === isolation);
  return out.filter((p) => p.lat != null && p.lng != null);
}

// ── Grid layout ──

export type GridEntry = { photo: Photo; idx: number };
export type Band = { start: number | null; entries: GridEntry[] };
export type DaySection = {
  kind: "day";
  key: string;
  /** The calendar day, or null for the Undated bucket. */
  day: string | null;
  title: string;
  entries: GridEntry[];
  bands: Band[];
  tint: number;
};
export type GridItem = { kind: "year"; key: string; year: number } | { kind: "month"; key: string; month: number } | DaySection;

const DAY_ABBRS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Consecutive runs of photos that share a band. The grid is in time order, so a
 *  run *is* a band. Every width on offer divides an hour evenly, so bucketing on
 *  the raw epoch second puts boundaries on clock times (:00, :05, …) — that works
 *  because photo_datetime is wall-clock-as-UTC, so epoch zero is midnight on the
 *  same clock the photos were taken by. 0 = don't split the day. */
export function timeBands(entries: GridEntry[], bandSecs: number): Band[] {
  if (!bandSecs) return [{ start: null, entries }];
  const bands: Band[] = [];
  entries.forEach((entry) => {
    const ts = entry.photo.photo_datetime;
    const start = ts ? Math.floor(ts / bandSecs) * bandSecs : null;
    const last = bands[bands.length - 1];
    if (!last || last.start !== start) bands.push({ start, entries: [entry] });
    else last.entries.push(entry);
  });
  return bands;
}

/** UTC on purpose (wall clock). Hour bands leave off the ":00" every label would carry. */
export function bandLabel(startTs: number, bandSecs: number): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", timeZone: "UTC" };
  if (bandSecs < 3600) opts.minute = "2-digit";
  return new Date(startTs * 1000).toLocaleTimeString(undefined, opts);
}

/** "City, Sublocation, State, Country" (missing parts dropped), or null. */
export function locationKey(loc: Photo["location"] | undefined): string | null {
  if (!loc) return null;
  return [loc.city, loc.sublocation, loc.state, loc.country].filter(Boolean).join(", ") || null;
}

/** Last segment of a photo's containing directory, the fallback grouping key. */
export function dirLabel(dir: string | null | undefined): string {
  if (!dir) return "Unknown folder";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

/** The Undated bucket would be one giant unsorted pile, so it is split further:
 *  by resolved location for the few geotagged despite a missing timestamp, else
 *  by containing directory. */
export function undatedSubGroups(entries: GridEntry[]): { place: string | null; dir: string | null; entries: GridEntry[] }[] {
  const buckets = new Map<string, { place: string | null; dir: string | null; entries: GridEntry[] }>();
  entries.forEach((entry) => {
    const loc = locationKey(entry.photo.location);
    const dir = loc ? null : dirLabel(entry.photo.dir);
    const key = loc ? `loc:${loc}` : `dir:${dir}`;
    let b = buckets.get(key);
    if (!b) { b = { place: loc, dir, entries: [] }; buckets.set(key, b); }
    b.entries.push(entry);
  });
  return [...buckets.values()];
}

/** The grid: year and month dividers, then one section per calendar day (the
 *  Undated bucket split by place/folder), each banded by time. Staged photos have
 *  moved to the staging area, so they're skipped here — but `idx` still indexes
 *  `filtered`, which shift-range select and j/k need. */
export function gridItems(filtered: readonly Photo[], isStaged: (id: number) => boolean, bandSecs: number): GridItem[] {
  type Day = { key: string | null; parts: ReturnType<typeof wallClockParts>; entries: GridEntry[] };
  const days: Day[] = [];
  let cur: Day | null = null;
  filtered.forEach((photo, idx) => {
    if (isStaged(photo.id)) return;
    const key = dayKey(photo);
    if (!cur || cur.key !== key) {
      cur = { key, parts: wallClockParts(photo.photo_datetime), entries: [] };
      days.push(cur);
    }
    cur.entries.push({ photo, idx });
  });

  const items: GridItem[] = [];
  // Keys stay stable when staging removes cells elsewhere (no positional part),
  // so sections — and their decoded thumbnails — aren't remounted; a key seen
  // twice (an out-of-order scope) gets a counter.
  const seen = new Map<string, number>();
  const uniq = (k: string) => { const n = seen.get(k) ?? 0; seen.set(k, n + 1); return n ? `${k}#${n}` : k; };
  let curYear: number | null | undefined, curMonth: number | null | undefined, tint = 0;
  days.forEach((d) => {
    const year = d.parts?.year ?? null, month = d.parts?.month ?? null;
    if (year !== curYear) {
      curYear = year;
      curMonth = undefined;
      if (year !== null) items.push({ kind: "year", key: uniq(`y${year}`), year });
    }
    if (month !== curMonth) {
      curMonth = month;
      if (month !== null) items.push({ kind: "month", key: uniq(`m${year}-${month}`), month });
    }
    const subs = d.parts
      ? [{ title: `${DAY_ABBRS[d.parts.weekday]} ${d.parts.day}`, entries: d.entries }]
      : undatedSubGroups(d.entries).map((s) => ({ title: s.place ? `📍 ${s.place}` : s.dir ? `📁 ${s.dir}` : "Undated", entries: s.entries }));
    subs.forEach((s, i) => {
      items.push({
        kind: "day", key: uniq(`d${d.key ?? "undated"}-${i}`), day: d.key, title: s.title, entries: s.entries,
        // Undated sub-groups have no clock to band by.
        bands: d.parts ? timeBands(s.entries, bandSecs) : [{ start: null, entries: s.entries }],
        tint: tint++ % 6,
      });
    });
  });
  return items;
}

function wallClockParts(ts: number | null | undefined): { year: number; month: number; day: number; weekday: number } | null {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay() };
}

export function monthName(m: number): string {
  return MONTH_NAMES[m] ?? "";
}

/** Index `delta` grid cells away from `from` in `filtered`, counting only photos
 *  still in the grid — staged ones have moved to the staging area, so j/k must
 *  step over them rather than focus an invisible photo. Clamps at the first/last
 *  visible photo; -1 when none is visible. `from` -1 means "before the first". */
export function stepGridIndex(ids: readonly number[], from: number, delta: number, isStaged: (id: number) => boolean): number {
  const step = delta > 0 ? 1 : -1;
  let idx = from, last = -1;
  for (let left = Math.abs(delta); left > 0;) {
    idx += step;
    if (idx < 0 || idx >= ids.length) break;
    if (isStaged(ids[idx]!)) continue;
    last = idx;
    left--;
  }
  if (last !== -1) return last;
  // Nothing visible that way (already at the edge): stay put if `from` is
  // visible, else take the nearest visible photo the other way.
  if (from >= 0 && from < ids.length && !isStaged(ids[from]!)) return from;
  for (let i = from - step; i >= 0 && i < ids.length; i -= step) {
    if (!isStaged(ids[i]!)) return i;
  }
  return -1;
}
