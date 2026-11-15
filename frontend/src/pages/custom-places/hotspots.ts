import type { Schemas } from "../../api/client";
import { formatWallClockDate } from "../../lib/wallClock";
import type { Bbox } from "../../map/shapes";

/* Hotspots: the places you keep tagging at but never named.
 * /api/geotag/hotspots mines them from the coordinates already on the photos and
 * clusters them, so drops a few hundred feet apart at one real place count as
 * one entry. A hotspot is already the shape of a named place — a point you come
 * back to — so promoting one is a name away, and beats redrawing it by hand. It
 * saves as a circle at the server's own cluster merge radius: any smaller and
 * drops the server considers the same place would fall outside the shape.
 *
 * hide_named=true means a hotspot a saved place already covers isn't returned,
 * so naming one makes it leave the list on the next load — that disappearance
 * is the confirmation. */

export type Hotspot = Schemas["Hotspot"];
export type HotspotSort = "count" | "recent";

export const HOTSPOT_LIMIT = 60;
/** Until the API says otherwise (merge_meters), so the drawn ring can't drift
 *  out of step with the clustering it came from. */
export const DEFAULT_HOTSPOT_RADIUS = 100;
// Panning is continuous and the query is a full clustering pass, so the
// in-view refresh waits for the map to settle.
export const HOTSPOT_MOVE_DEBOUNCE_MS = 350;

/** A hotspot's identity across reloads: its coordinate. Zooming in "only in
 *  view" mode reloads the list, so a row index wouldn't survive. */
export const hotspotKey = (h: { lat: number; lng: number }) => `${h.lat.toFixed(5)},${h.lng.toFixed(5)}`;

export function hotspotMeta(h: Hotspot): string {
  return `${h.count} photo${h.count !== 1 ? "s" : ""}${h.last_ts ? ` · last ${formatWallClockDate(h.last_ts)}` : ""}`;
}

/** "40 of 112" when the server's limit cut the list short, so a short list in a
 *  busy area doesn't read as the whole truth. */
export function hotspotCountLabel(shown: number, total: number, inView: boolean): string {
  if (!shown) return "";
  return (total > shown ? `${shown} of ${total}` : `${shown}`) + (inView ? " in view" : "");
}

const wrapLng = (lng: number) => ((lng + 180) % 360 + 360) % 360 - 180;

/** The map's view as the API's four bounds, or null for "don't filter". Leaflet
 *  reports longitudes outside ±180 once you pan past the antimeridian, so
 *  they're wrapped back — a view straddling it then arrives as min_lng > max_lng,
 *  which hotspots_service.in_bbox reads as a wrapped box. */
export function viewBbox(b: { south: number; north: number; west: number; east: number }): Bbox | null {
  if (b.east - b.west >= 360) return null;    // whole world in view
  return {
    min_lat: Math.max(-90, b.south),
    max_lat: Math.min(90, b.north),
    min_lng: wrapLng(b.west),
    max_lng: wrapLng(b.east),
  };
}

/* ── Suggest a new place ──
 * The Hotspots list is opt-in — accurate, but easy to never look at. The
 * suggestion is the same data surfaced without asking: the single busiest
 * unnamed coordinate, shown as a standing banner once it clears a minimum photo
 * count. Dismissing one is remembered per browser by coordinate; a dismissed
 * spot stays hidden until it's named or a bigger one displaces it. */

export const SUGGEST_MIN_COUNT = 10;
export const SUGGEST_DISMISS_KEY = "dismissedPlaceSuggestions";

export function loadDismissed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SUGGEST_DISMISS_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(set: Set<string>) {
  try {
    localStorage.setItem(SUGGEST_DISMISS_KEY, JSON.stringify([...set]));
  } catch {
    // Private-mode/blocked storage: the dismiss just won't stick across reloads.
  }
}

export function pickSuggestion(candidates: readonly Hotspot[], dismissed: Set<string>): Hotspot | null {
  return candidates.find((h) => h.count >= SUGGEST_MIN_COUNT && !dismissed.has(hotspotKey(h))) ?? null;
}
