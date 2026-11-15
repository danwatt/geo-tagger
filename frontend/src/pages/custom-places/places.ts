import type { Schemas } from "../../api/client";
import { formatWallClockDate } from "../../lib/wallClock";
import { circleRadius, formatRadius } from "../../map/shapes";

/* The Named Places sidebar's list logic: filter, search, sort, the facts line
 * under each name, and the count/empty-state wording. Map-free and pure so it
 * can be tested on its own. */

export type Place = Schemas["PlaceItem"];
export type PlaceFilter = "all" | "with-photo" | "without-photo";
export type PlaceSort = "name" | "count" | "recent" | "created";

export const PLACE_SORTS: { value: PlaceSort; label: string }[] = [
  { value: "name", label: "A–Z" },
  { value: "count", label: "Most photos" },
  { value: "recent", label: "Most recent photo" },
  { value: "created", label: "Newest place" },
];

export const PLACE_FILTERS: { value: PlaceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "with-photo", label: "With photo" },
  { value: "without-photo", label: "No photo" },
];

const byName = (a: Place, b: Place) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const desc = (key: "photo_count" | "last_ts" | "created_at") =>
  (a: Place, b: Place) => ((b[key] ?? 0) - (a[key] ?? 0)) || byName(a, b);

// Sorts a copy: the map walks `places` in its own order, so reordering it in
// place would reshuffle map layers for a sidebar-only choice. Name breaks every
// tie so the order is stable when counts or dates match (or are missing).
export function sortPlaces(list: readonly Place[], sort: PlaceSort): Place[] {
  const cmp = { name: byName, count: desc("photo_count"), recent: desc("last_ts"), created: desc("created_at") }[sort] ?? byName;
  return [...list].sort(cmp);
}

// The filter, search and sort narrow and order the sidebar only — the map keeps
// every place drawn, so hiding a row never hides the shape you are about to drag.
export function visiblePlaces(places: readonly Place[], filter: PlaceFilter, query: string, sort: PlaceSort): Place[] {
  let out: readonly Place[] = places;
  if (filter === "with-photo") out = out.filter((p) => p.representative_photo_id);
  else if (filter === "without-photo") out = out.filter((p) => !p.representative_photo_id);
  const q = query.trim().toLowerCase();
  if (q) out = out.filter((p) => p.name.toLowerCase().includes(q));
  return sortPlaces(out, sort);
}

// "12 photos · last 3/2/2019 · 250 m" — the same facts a hotspot row carries, so
// a named place can be judged against the unnamed ones below it. photo_count is
// absent only if the stats query failed; the row then just says less.
export function placeMeta(p: Place): string {
  // A row saved before the server validated shapes (or restored from a
  // hand-edited backup) can hold bounds nothing can read. The server matches it
  // to no photos; here it is listed — so it can be deleted — but never drawn.
  if (p.bounds_valid === false) return "⚠ Unreadable shape — matches no photos. Delete it and draw it again.";
  const bits: string[] = [];
  if (typeof p.photo_count === "number") bits.push(p.photo_count === 1 ? "1 photo" : `${p.photo_count} photos`);
  if (p.last_ts) bits.push(`last ${formatWallClockDate(p.last_ts)}`);
  bits.push(p.type === "circle" ? formatRadius(circleRadius(p.bounds)) : "rectangle");
  // Time-neighbour inference, not a spatial count — see index.get_place_stats.
  // Worth a callout because it's the backlog this place could clear in one sitting.
  if (p.untagged_nearby_count) bits.push(`~${p.untagged_nearby_count} untagged nearby`);
  return bits.join(" · ");
}

/** "8 of 63" only while something is narrowing the list, so the plain count
 *  isn't dressed up as a filtered one; empty with no places at all. */
export function countLabel(shown: number, total: number): string {
  if (!total) return "";
  return shown < total ? `${shown} of ${total}` : `${total}`;
}

export function emptyListHint(total: number, query: string, filter: PlaceFilter): string {
  if (!total) return "No places yet — draw a rectangle or circle on the map.";
  if (query.trim()) return `No place name matches “${query.trim().toLowerCase()}”.`;
  return `No places ${filter === "with-photo" ? "have" : "are missing"} a representative photo.`;
}

/** Another place (not `excludeId`, the one being renamed) already has this name.
 *  A warning, not a block: two houses called "Home" in different towns is a
 *  reasonable thing to want, and only the user knows whether this is that. */
export function nameClash(places: readonly Place[], name: string, excludeId: number | null): boolean {
  const v = name.trim().toLowerCase();
  return !!v && places.some((p) => p.id !== excludeId && p.name.trim().toLowerCase() === v);
}

export function deleteMessage(p: Place): string {
  return typeof p.photo_count === "number" && p.photo_count
    ? `The ${p.photo_count} photo${p.photo_count === 1 ? "" : "s"} taken here keep their coordinates — only the name and the shape go.`
    : "Only the name and the shape go; no photo is changed.";
}
