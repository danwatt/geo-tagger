import type { Schemas } from "../api/client";
import { formatWallClockDate } from "../lib/wallClock";

/* Shared face-grid primitives for the People, Photo Faces and Quick Tag pages.
 * Port of web/face-grid.js's pure parts: bbox overlay geometry, the date-range
 * and location labels for a group of faces, and group sorting. The DOM parts
 * live next door (FaceTile, BboxBox, FaceQuickActions) and in photos/
 * (FaceCrop, GroupHeader, FaceActionsMenu, PersonPickerDialog). */

export type Face = Schemas["FaceItem"];
export type FaceLocation = Schemas["FaceLocation"];
export type FaceSuggestion = Schemas["FaceSuggestion"];
export type Bbox = readonly number[];

/* ── Bbox overlay geometry ──
 * Normalized bbox [x1, y1, x2, y2] → CSS percentage box, for every overlay of a
 * face box on a full photo. */
export function bboxStyle(bbox: Bbox): { left: string; top: string; width: string; height: string } {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = bbox;
  return {
    left: `${x1 * 100}%`,
    top: `${y1 * 100}%`,
    width: `${(x2 - x1) * 100}%`,
    height: `${(y2 - y1) * 100}%`,
  };
}

/* ── Large-array min/max ──
 * Math.min(...arr) passes every element as an argument, and engines cap the
 * argument count, so a library-sized timestamp list breaks it. Empty input gives
 * [Infinity, -Infinity], like the spread form. Port of common.js minMaxOf. */
export function minMaxOf(values: Iterable<number>): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

export function minOf(values: Iterable<number>): number {
  return minMaxOf(values)[0];
}

/* ── Date-range label for a group of faces ──
 * Both timestamps are wall-clock epoch seconds (see lib/wallClock.ts), so they
 * are formatted in UTC. "Undated" with no start. */
export function formatDateRange(startTs: number | null | undefined, endTs?: number | null): string {
  if (!startTs) return "Undated";
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
  const sStr = formatWallClockDate(startTs, opts);
  const eStr = formatWallClockDate(endTs || startTs, opts);
  if (sStr === eStr) return sStr;
  return `${formatWallClockDate(startTs, { month: "short", day: "numeric" })} – ${eStr}`;
}

/* ── Location labels ──
 * A face (or crowd photo) may carry a `location` resolved by the reverse
 * geocoder, or null when its photo isn't geocoded. */
type Located = { location?: FaceLocation | null; dir?: string | null };

/** "City, Sublocation, State, Country" for one item (missing parts dropped), or null. */
export function locationKey(item: Located): string | null {
  const loc = item.location;
  if (!loc) return null;
  return [loc.city, loc.sublocation, loc.state, loc.country].filter(Boolean).join(", ") || null;
}

/** Last path segment of an item's folder — the fallback grouping key when
 *  there's no location (undated scans with no GPS). */
export function dirLabel(item: Located): string {
  const d = item.dir;
  if (!d) return "Unknown folder";
  const parts = d.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || d;
}

function mostCommon(keys: Iterable<string | null>): string[] {
  const counts = new Map<string, number>();
  for (const k of keys) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
}

/** The group's most common place, plus " (and N other)" when it spans more
 *  than one; "" when nothing in it is geocoded. */
export function locationLabel(items: readonly Located[]): string {
  const sorted = mostCommon(items.map(locationKey));
  if (!sorted.length) return "";
  if (sorted.length === 1) return sorted[0]!;
  const n = sorted.length - 1;
  return `${sorted[0]} (and ${n} other${n > 1 ? "s" : ""})`;
}

/** The single most common place among the items (a raw key for sorting), or null. */
export function primaryLocationKey(items: readonly Located[]): string | null {
  return mostCommon(items.map(locationKey))[0] ?? null;
}

/** The folder the items share (the most common one when they straddle folders),
 *  or null when none has a dir. */
export function primaryDirKey(items: readonly Located[]): string | null {
  return mostCommon(items.map((it) => it.dir ?? null))[0] ?? null;
}

/* ── Group sorting ──
 * Shared by every grid that renders groups of faces/photos (Discover clusters,
 * Crowd groups, the Unlabeled buckets, the guesses event groups). keyFn gives
 *   date  — epoch seconds, or null/0 when undated
 *   count — number of photos in the group
 *   place — location string, or null when the group has no geocoded photo
 *   dir   — full directory path, or null when the group has no folder
 * Modes: "date" chronological, undated last; "count" most photos first, ties
 * chronological; "location" / "dir" A→Z with keyless groups last, ties
 * chronological. Folders sort on the full path, so sibling folders of a scanned
 * batch stay adjacent. Returns a new array. */
export const GROUP_SORT_MODES = ["date", "count", "location", "dir"] as const;
export type GroupSort = (typeof GROUP_SORT_MODES)[number];

export type GroupSortKey = { date: number | null; count: number; place: string | null; dir: string | null };

export function sortGroups<G>(groups: readonly G[], mode: GroupSort, keyFn: (g: G) => GroupSortKey): G[] {
  const keys = new Map(groups.map((g) => [g, keyFn(g)]));
  const k = (g: G) => keys.get(g)!;
  // Undated sorts after everything dated, in every mode.
  const byDate = (a: G, b: G) => (k(a).date || Infinity) - (k(b).date || Infinity) || 0;
  const byText = (pa: string | null, pb: string | null, a: G, b: G) => {
    if (pa && pb && pa !== pb) return pa.localeCompare(pb);
    if (pa !== pb) return pa ? -1 : 1;
    return byDate(a, b);
  };
  const cmp: Record<GroupSort, (a: G, b: G) => number> = {
    date: byDate,
    count: (a, b) => (k(b).count - k(a).count) || byDate(a, b),
    location: (a, b) => byText(k(a).place, k(b).place, a, b),
    dir: (a, b) => byText(k(a).dir, k(b).dir, a, b),
  };
  return [...groups].sort(cmp[mode] ?? byDate);
}

export function isGroupSort(v: unknown): v is GroupSort {
  return typeof v === "string" && (GROUP_SORT_MODES as readonly string[]).includes(v);
}

/** "3 faces" / "1 face". */
export const faceWord = (n: number) => `${n} face${n === 1 ? "" : "s"}`;
