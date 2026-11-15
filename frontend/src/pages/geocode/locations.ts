import type { Schemas } from "../../api/client";
import type { Place } from "./scope";
import type { Photo } from "./staging";

/* ── Tag as… (the location picker) ──
 * Most tagging is repeat business: the same house, the same park, the same
 * relatives' addresses. Hunting each of them down on the map again is the slow
 * part, so this is the map-free path — select photos, press "l", type a few
 * letters, Enter. It picks from the locations that already exist, in the order
 * they're likely to be wanted:
 *   Recent   — what this browser committed lately (localStorage, this machine).
 *   Places   — saved places from the Named Places page, at their centre.
 *   Hotspots — /api/geotag/hotspots, the recurring drop points mined from the
 *              coordinates already on the photos: places you use but never named.
 * A pick stages, exactly as a map drop does. Port of app.js buildLocationItems. */

export type Hotspot = Schemas["Hotspot"];

export const RECENT_LOCATIONS_KEY = "geotagger.recentLocations";
const RECENT_LOCATIONS_MAX = 12;
// Hotspots are ranked over the span of photos on screen, widened by a month
// either side — see the sort="time" note in services/hotspots_service.py.
const PICKER_SPAN_PAD = 30 * 86400;

export type Recent = { lat: number; lng: number; accuracy: number | null; label: string; ts: number };

export type LocationChoice = {
  group: "Recent" | "Saved places" | "Hotspots";
  name: string;
  meta: string;
  count?: number;
  thumb: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
};

/** 4 decimals ≈ 11 m: close enough that two drops the user thinks of as "the
 *  same spot" collapse into one entry. */
export function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

export function loadRecent(): Recent[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_LOCATIONS_KEY) || "[]");
    return Array.isArray(list)
      ? (list as Recent[]).filter((r) => r && typeof r.lat === "number" && typeof r.lng === "number")
      : [];
  } catch {
    return [];   // unreadable or from an older shape — start the history over
  }
}

export function rememberLocation(lat: number, lng: number, accuracy: number | null, label: string, now = Date.now()): void {
  const key = coordKey(lat, lng);
  const list = loadRecent().filter((r) => coordKey(r.lat, r.lng) !== key);
  list.unshift({ lat, lng, accuracy: accuracy ?? null, label: label || "", ts: now });
  try {
    localStorage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify(list.slice(0, RECENT_LOCATIONS_MAX)));
  } catch {
    // Quota or private browsing — the picker just loses its history.
  }
}

/** The single point a saved place stands for. Rectangles collapse to their
 *  centre, which is what "tag these as being at this place" has to mean. */
export function placeCenter(place: Pick<Place, "type" | "bounds">): { lat: number; lng: number } | null {
  try {
    const b = JSON.parse(place.bounds) as Record<string, number>;
    if (place.type === "circle") return { lat: b.lat!, lng: b.lng! };
    return { lat: (b.south! + b.north!) / 2, lng: (b.west! + b.east!) / 2 };
  } catch {
    return null;
  }
}

/** Time span the hotspot ranking should answer for: the selection if there is
 *  one, else everything loaded. A loop, not Math.min(...arr) — a month of
 *  thousands of photos overflows the argument list. */
export function pickerTimeSpan(photos: readonly Photo[], selected: ReadonlySet<number>): { from: number; to: number } | null {
  let lo = Infinity, hi = -Infinity;
  photos.forEach((p) => {
    // Truthiness, not `> 0`: pre-1970 dates are negative; undated is 0/null.
    if (!p.photo_datetime) return;
    if (selected.size && !selected.has(p.id)) return;
    if (p.photo_datetime < lo) lo = p.photo_datetime;
    if (p.photo_datetime > hi) hi = p.photo_datetime;
  });
  if (lo === Infinity) return null;
  return { from: Math.round(lo - PICKER_SPAN_PAD), to: Math.round(hi + PICKER_SPAN_PAD) };
}

export function relativeDay(ts: number | null | undefined, nowMs = Date.now()): string {
  if (!ts) return "";
  const days = Math.floor((nowMs / 1000 - ts) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** One de-duplicated, group-ordered list. Earlier sources win: a coordinate used
 *  this morning shouldn't also appear as a hotspot. Saved places are indexed
 *  first but listed after Recent: committing at a saved place also writes a
 *  Recent entry labelled with the *reverse-geocoded* name, so plain "earlier
 *  wins" dedup swallowed the place and its name became unsearchable. A recent
 *  that lands on a saved place borrows that place's name and thumbnail instead. */
export function buildLocationChoices(recents: readonly Recent[], places: readonly Place[], hotspots: readonly Hotspot[], nowMs = Date.now()): LocationChoice[] {
  const items: LocationChoice[] = [];
  const seen = new Set<string>();
  const add = (item: LocationChoice) => {
    const k = coordKey(item.lat, item.lng);
    if (seen.has(k)) return;
    seen.add(k);
    items.push(item);
  };
  const thumb = (id: number | null | undefined) => (id ? `/api/thumbnail/${id}` : null);

  const placeByKey = new Map<string, { place: Place; center: { lat: number; lng: number } }>();
  places.forEach((p) => {
    if (p.bounds_valid === false) return;
    const c = placeCenter(p);
    if (!c) return;
    const k = coordKey(c.lat, c.lng);
    if (!placeByKey.has(k)) placeByKey.set(k, { place: p, center: c });
  });

  recents.forEach((r) => {
    const p = placeByKey.get(coordKey(r.lat, r.lng))?.place;
    add({
      group: "Recent",
      name: p ? p.name : (r.label || `📌 ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`),
      meta: relativeDay(Math.round(r.ts / 1000), nowMs),
      thumb: thumb(p?.representative_photo_id),
      lat: r.lat, lng: r.lng, accuracy: r.accuracy ?? null,
    });
  });
  placeByKey.forEach(({ place: p, center: c }) => {
    add({
      group: "Saved places", name: p.name, meta: `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`,
      thumb: thumb(p.representative_photo_id), lat: c.lat, lng: c.lng, accuracy: null,
    });
  });
  hotspots.forEach((h) => {
    const windowCount = (h as { window_count?: unknown }).window_count;
    add({
      group: "Hotspots", name: h.label, meta: relativeDay(h.last_ts, nowMs),
      count: typeof windowCount === "number" ? windowCount : h.count,
      thumb: thumb(h.sample_photo_id), lat: h.lat, lng: h.lng, accuracy: null,
    });
  });
  return items;
}

/** Case- and accent-insensitive form for matching. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The choices matching `query`, in the caller's (group-ranked) order — grouped
 *  lists keep the order they were built in. Matches the name by prefix, by word
 *  prefixes ("ho we" → "Home - Weston Ln") or as a substring of name or meta. */
export function matchChoices(items: readonly LocationChoice[], query: string): LocationChoice[] {
  const q = fold(query.trim());
  if (!q) return items.slice();
  const words = q.split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    const name = fold(it.name);
    if (name.startsWith(q)) return true;
    const nameWords = name.split(/[\s\-'.,]+/).filter(Boolean);
    if (words.every((w) => nameWords.some((nw) => nw.startsWith(w)))) return true;
    return name.includes(q) || fold(it.meta).includes(q);
  });
}
