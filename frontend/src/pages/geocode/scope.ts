import type { Schemas } from "../../api/client";
import type { LocationItem } from "../../ui/LocationPicker";
import { MONTH_NAMES } from "../../lib/format";

/* ── Scopes ──
 * The page has one loaded scope at a time, and several ways into it:
 *   month    — one month or a whole year (Select Month; also ?month=YYYY-MM)
 *   undated  — photos with no timestamp at all (?month=undated)
 *   range    — a work-queue outing's date span (?batch=)
 *   dir      — one folder (the folder facet, or a folder batch)
 *   ids      — an explicit photo set (?ids= / ?handoff= from Search)
 *   area     — a circle drawn on the map
 *   place    — a saved place's (buffered) bounds
 *   location — a recorded location from the location picker
 * A scope is a plain value, so "reload the current view" (a Window or buffer
 * change) re-runs exactly the scope that is loaded — the legacy page kept one
 * variable per kind and a scope that forgot to clear another's reloaded the
 * *old* one. Port of app.js's scope loaders; URLs and request shapes unchanged. */

export type Place = Schemas["PlaceItem"];

export type ScopeDef =
  | { kind: "month"; year: number; month: number | null }
  | { kind: "undated" }
  | { kind: "range"; from: string; to: string; label: string }
  | { kind: "dir"; dir: string; label: string }
  | { kind: "ids"; ids: number[]; label: string }
  | { kind: "area"; lat: number; lng: number; radius: number }
  | { kind: "place"; place: Place; buffer: number }
  | { kind: "location"; item: LocationItem };

export type ScopeRequest = { url: string; init?: RequestInit; timeline: boolean };

/** Days in a month (1-based month). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export type Bbox = { min_lat: number; max_lat: number; min_lng: number; max_lng: number };

/** Bounding box of a saved place, grown outward by `bufferMiles` on every side.
 *  Circles collapse to their bounding box first — the filter is a "bounds"
 *  filter, and a box keeps rectangles and circles on the same code path (and
 *  the same rectangular /api/photos/by-bounds query). */
export function placeBboxWithBuffer(place: Pick<Place, "type" | "bounds">, bufferMiles: number): Bbox {
  const b = JSON.parse(place.bounds) as Record<string, number>;
  let south: number, north: number, west: number, east: number;
  if (place.type === "rectangle") {
    ({ south, north, west, east } = b as { south: number; north: number; west: number; east: number });
  } else {
    const lat = b.lat!, lng = b.lng!, radius = b.radius!;
    const latOff = radius / 111000;
    const lngOff = radius / (111000 * Math.cos(lat * Math.PI / 180));
    south = lat - latOff; north = lat + latOff;
    west = lng - lngOff; east = lng + lngOff;
  }
  const meters = (bufferMiles || 0) * 1609.34;
  const latBuf = meters / 111000;
  const midLat = (south + north) / 2;
  const lngBuf = meters / (111000 * Math.cos(midLat * Math.PI / 180));
  return { min_lat: south - latBuf, max_lat: north + latBuf, min_lng: west - lngBuf, max_lng: east + lngBuf };
}

/** The request a scope loads — always the whole scope (geotagged=all): the Show
 *  filter is applied client-side, so the date picker counts every photo in it.
 *  `timeline` false means the scope has no usable dates (Undated, a folder). */
export function scopeRequest(def: ScopeDef, windowSecs: string | number): ScopeRequest {
  switch (def.kind) {
    case "month": {
      const { year, month } = def;
      let from: string, to: string;
      if (month) {
        const mm = String(month).padStart(2, "0");
        from = `${year}-${mm}-01`;
        to = `${year}-${mm}-${daysInMonth(year, month)}`;
      } else {
        from = `${year}-01-01`;
        to = `${year}-12-31`;
      }
      return { url: `/api/photos?geotagged=all&date_from=${from}&date_to=${to}`, timeline: true };
    }
    case "undated":
      return { url: "/api/photos?geotagged=all&undated=true", timeline: false };
    case "range":
      return { url: `/api/photos?geotagged=all&date_from=${def.from}&date_to=${def.to}`, timeline: true };
    case "dir":
      // A scanned folder is usually undated, and even a dated one is a folder
      // first — the date picker would describe a span the user isn't working in.
      return { url: `/api/photos?geotagged=all&dir=${encodeURIComponent(def.dir)}`, timeline: false };
    case "ids":
      // POSTed, not ?ids=: a Search hand-off can be tens of thousands of ids, past
      // what fits in a request line (A3).
      return {
        url: "/api/photos/by-ids",
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: def.ids }) },
        timeline: true,
      };
    case "area":
      return { url: `/api/photos/by-area?lat=${def.lat}&lng=${def.lng}&radius=${def.radius}&geotagged=all&window=${windowSecs}`, timeline: true };
    case "place": {
      const box = placeBboxWithBuffer(def.place, def.buffer);
      return {
        url: `/api/photos/by-bounds?min_lat=${box.min_lat}&max_lat=${box.max_lat}` +
          `&min_lng=${box.min_lng}&max_lng=${box.max_lng}&geotagged=all&window=${windowSecs}`,
        timeline: true,
      };
    }
    case "location": {
      const params = new URLSearchParams({ location_fields: JSON.stringify(def.item.fields), window: String(windowSecs) });
      return { url: `/api/photos/by-location?${params}`, timeline: true };
    }
  }
}

export const NO_MONTH_LABEL = "No month selected";

/** The two toolbar labels a scope sets (the month/scope label, and the area
 *  label for map- and location-based scopes) — the workspace scope line reads
 *  both. */
export function scopeLabels(def: ScopeDef | null): { month: string; area: string } {
  if (!def) return { month: NO_MONTH_LABEL, area: "" };
  switch (def.kind) {
    case "month":
      return { month: def.month ? `${MONTH_NAMES[def.month - 1]} ${def.year}` : `${def.year} (all months)`, area: "" };
    case "undated": return { month: "Undated photos", area: "" };
    case "range": case "dir": case "ids": return { month: def.label, area: "" };
    case "area": return { month: NO_MONTH_LABEL, area: `Area: ${(def.radius / 1000).toFixed(2)}km radius` };
    case "place": return { month: NO_MONTH_LABEL, area: def.buffer > 0 ? `${def.place.name} (+${def.buffer} mi)` : def.place.name };
    case "location": return { month: NO_MONTH_LABEL, area: def.item.label };
  }
}

/** Status line while a scope loads, and once it lands (`n` photos). Only the
 *  location scopes report; the rest show the Show-filter count instead. */
export function scopeLoadingText(def: ScopeDef): string | null {
  if (def.kind === "area") return "Loading photos in area...";
  if (def.kind === "place" || def.kind === "location") return `Loading photos in ${scopeLabels(def).area}…`;
  return null;
}
export function scopeLoadedText(def: ScopeDef, n: number): string | null {
  if (def.kind === "area") return `Loaded ${n} photos in area`;
  if (def.kind === "place" || def.kind === "location") return `Loaded ${n} photos in ${scopeLabels(def).area}`;
  return null;
}

/** The workspace scope line: what is loaded · bounds · dates. */
export function workspaceScopeText(def: ScopeDef | null, dateLabel: string | null): string {
  const { month, area } = scopeLabels(def);
  const bounds = def?.kind === "place" && def.buffer === 0 ? "Within bounds" : "";
  return [area || (month !== NO_MONTH_LABEL ? month : "Choose a location or month"), bounds, dateLabel || "All dates"]
    .filter(Boolean).join(" · ");
}

// ── URL entry points ──

export type UrlScope =
  | { kind: "batch"; id: string }
  | { kind: "ids"; ids: number[] }
  | { kind: "handoff-missing" }
  | { kind: "month"; year: number; month: number }
  | { kind: "undated" }
  | { kind: "none" };

const SEARCH_HANDOFF_PREFIX = "geotagger.searchHandoff.";

/** The ids Search parked in this tab's sessionStorage under `token` (A3), or
 *  null when missing or unreadable. The entry is left in place so a reload of
 *  this page still finds it. */
export function readSearchHandoff(token: string): number[] | null {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(SEARCH_HANDOFF_PREFIX + token) || "null");
    return Array.isArray(stored) ? (stored as number[]) : null;
  } catch {
    return null;   // unreadable storage → same as missing
  }
}

/** Which scope the page opens on. ?batch= (from Home's work queue) wins, then
 *  ?ids= / ?handoff= (Search's "Open in Geocode"), then ?month=YYYY-MM or
 *  ?month=undated (Home's month charts and Undated link). */
export function parseScopeUrl(search: string, readHandoff: (token: string) => number[] | null = readSearchHandoff): UrlScope {
  const params = new URLSearchParams(search);
  const batch = params.get("batch");
  if (batch) return { kind: "batch", id: batch };
  const idsArg = params.get("ids");
  const handoff = params.get("handoff");
  let handoffIds: number[] | null = null;
  if (handoff) {
    handoffIds = readHandoff(handoff);
    if (!handoffIds) return { kind: "handoff-missing" };
  }
  if (idsArg || handoffIds) {
    const ids = (handoffIds || idsArg!.split(",")).map(Number).filter(Number.isFinite);
    if (ids.length) return { kind: "ids", ids };
  }
  const month = params.get("month");
  const m = month?.match(/^(\d{4})-(\d{2})$/);
  if (m) return { kind: "month", year: parseInt(m[1]!, 10), month: parseInt(m[2]!, 10) };
  if (month === "undated") return { kind: "undated" };
  return { kind: "none" };
}

/** Last two path components: a full path is unreadable in a dropdown and the
 *  tail is what identifies the folder. Mirrors work_queue_service.short_dir. */
export function shortDir(dir: string): string {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  return "…" + sep + parts.slice(-2).join(sep);
}

/** "YYYY-MM-DD" of a wall-clock epoch. photo_datetime is stored wall-clock-as-UTC
 *  and /api/photos parses date_from / date_to as UTC days, so a batch's span is
 *  formatted in UTC too — a local-time conversion would clip the first or last
 *  photos of the outing. */
export function wallClockDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Wall-clock epoch of a "YYYY-MM-DD" day's midnight (explicit Z: a date-only
 *  string with a time part would parse as local). */
export function parseWallClockDay(s: string): number {
  return Date.parse(`${s}T00:00:00Z`) / 1000;
}
