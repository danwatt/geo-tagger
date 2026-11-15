import { ApiError } from "../../api/errors";
import type { Schemas } from "../../api/client";
import type { Status } from "../../shell/StatusBar";

/* Geo Data (map.html) — plots the reverse-geocode reference data, not photos:
 * the GeoNames populated places, their boundary cells, and the OSM / Census /
 * ZIP polygons the lookup chain consults. Everything here is the map-free half:
 * zoom thresholds, the status line and hint, colours and the probe readout, so
 * it can be tested without Leaflet.
 *
 * The GeoNames cities500 set has ~200k entries worldwide, so nothing is fetched
 * until the map is zoomed in past MIN_ZOOM_FOR_MARKERS; below that a hint is
 * shown instead. The server caps how many it returns per request and, when
 * capped, prefers the largest places by population so the view stays
 * representative. Each overlay only draws past its own threshold. */

export const MIN_ZOOM_FOR_MARKERS = 8;
export const MIN_ZOOM_FOR_VORONOI = 11;
export const MIN_ZOOM_FOR_OSM = 11;
export const MIN_ZOOM_FOR_CENSUS = 9;   // whole-place polygons, readable further out than OSM's features
// ZIP areas are a metro-scale layer: a labeled polygon per ZIP is unreadable
// (and a large payload) once the view spans several states. Leaflet zoom z is
// ~156543*cos(lat)/2^z metres per pixel, so at Houston's latitude a ~1400px-wide
// window covers roughly 370 km at z9, 185 km at z10, 95 km at z11 — z10 is the
// "whole metro, ~50 mile radius" view, and anything wider stays blank rather
// than fetching.
export const MIN_ZOOM_FOR_ZCTA = 10;
// Named buildings vastly outnumber every other OSM category and are only
// meaningful once you can see individual rooftops, so the osm-places request
// omits them (buildings=false) below this zoom rather than fetching and hiding.
export const MIN_ZOOM_FOR_BUILDINGS = 17;
export const REFRESH_DEBOUNCE_MS = 250;

export type OverlayKey = "voronoi" | "osm" | "census" | "zcta";

// Place boundaries and OSM start on; Census places and ZIP areas tile the map
// wall-to-wall, so they start off and draw only when asked for. Nothing is
// requested for an overlay that's off.
export const OVERLAYS: { key: OverlayKey; label: string; hint: string; minZoom: number; defaultOn: boolean }[] = [
  { key: "voronoi", label: "Place boundaries", hint: "place boundaries", minZoom: MIN_ZOOM_FOR_VORONOI, defaultOn: true },
  { key: "osm", label: "OSM places", hint: "OSM places", minZoom: MIN_ZOOM_FOR_OSM, defaultOn: true },
  { key: "census", label: "Census places", hint: "Census places", minZoom: MIN_ZOOM_FOR_CENSUS, defaultOn: false },
  { key: "zcta", label: "ZIP areas", hint: "ZIP areas", minZoom: MIN_ZOOM_FOR_ZCTA, defaultOn: false },
];

export const DEFAULT_OVERLAYS: ReadonlySet<OverlayKey> = new Set(OVERLAYS.filter((o) => o.defaultOn).map((o) => o.key));

export function overlayMinZoom(key: OverlayKey): number {
  return OVERLAYS.find((o) => o.key === key)!.minZoom;
}

/** The API's bbox: minLng,minLat,maxLng,maxLat (raw — the server unwraps). */
export function bboxParam(b: { west: number; south: number; east: number; north: number }): string {
  return `${b.west},${b.south},${b.east},${b.north}`;
}

const is503 = (e: unknown) => e instanceof ApiError && e.status === 503;

/** The floating hint over the map, or null for none. Each overlay only draws
 *  past its own zoom threshold, so one switched on from too far out would
 *  silently show nothing and read as broken — say so instead. Below
 *  MIN_ZOOM_FOR_MARKERS the stronger "nothing at all is loaded here" wins. */
export function mapHint(zoom: number, enabled: ReadonlySet<OverlayKey>, markersError: unknown): string | null {
  if (zoom < MIN_ZOOM_FOR_MARKERS) return "Zoom in to see reverse-geocode places";
  if (is503(markersError)) return "GeoNames data not installed — run scripts/get_geonames.py";
  const waiting = OVERLAYS.filter((o) => enabled.has(o.key) && zoom < o.minZoom).map((o) => o.hint);
  return waiting.length ? `Zoom in further to see ${waiting.join(", ")}` : null;
}

/** An overlay's failure as a status line. 503 = that dataset isn't built. */
export function overlayErrorMessage(key: Exclude<OverlayKey, "voronoi">, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (key === "osm") {
    return is503(error) ? "OSM places DB not built — run scripts/build_osm_places.py <region>.osm.pbf" : "Error loading OSM places: " + msg;
  }
  if (key === "census") {
    return is503(error) ? "Census places DB not built — run scripts/get_census_places.py" : "Error loading Census places: " + msg;
  }
  // The server says why: no census DB at all, or one built without ZIP areas.
  if (!is503(error)) return "Error loading ZIP areas: " + msg;
  const detail = ((error as ApiError).body as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail ? detail : "Census ZIP areas not built — run scripts/get_census_places.py";
}

type MarkersData = Schemas["GeoNamesPlacesResponse"];

/** The status line. The legacy page let whichever fetch finished last write it;
 *  here the order is fixed: loading, then an overlay failure, then the GeoNames
 *  answer. Place-boundary (Voronoi) failures are best-effort and silent — the
 *  marker fetch already reports a broken dataset. */
export function mapStatus({ zoom, markersLoading, markersError, markers, overlayErrors }: {
  zoom: number;
  markersLoading: boolean;
  markersError: unknown;
  markers: MarkersData | undefined;
  overlayErrors: string[];
}): Status {
  if (zoom < MIN_ZOOM_FOR_MARKERS) return { message: "" };
  if (markersLoading) return { message: "Loading places…" };
  if (overlayErrors.length) return { message: overlayErrors[0]!, isError: true };
  if (markersError) {
    if (is503(markersError)) return { message: "" };
    return { message: "Error loading places: " + (markersError as Error).message, isError: true };
  }
  if (!markers) return { message: "" };
  const shown = markers.places.length.toLocaleString();
  return {
    message: markers.truncated
      ? `Showing ${shown} largest of ${markers.total.toLocaleString()} places in view — zoom in for the rest`
      : `${shown} place${markers.places.length === 1 ? "" : "s"} in view`,
  };
}

/** Deterministic colour per place name/coordinate, so the same place gets the
 *  same hue across refreshes (helps eyeballing a cell's shape as you pan). */
export function cellColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 65%, 55%)`;
}

// Distinct colour per OSM place category so a stadium vs. a park vs. a campus
// reads at a glance. Keep in sync with build_osm_places.classify categories
// (and the --osm-* tokens in theme.css).
export const OSM_CATEGORY_TOKENS: Record<string, [token: string, fallback: string]> = {
  city: ["--osm-city", "#4f8cff"],
  neighbourhood: ["--osm-neighbourhood", "#00b3a4"],
  park: ["--osm-park", "#3fbf5f"],
  venue: ["--osm-venue", "#ff8c42"],
  campus: ["--osm-campus", "#a06bff"],
  attraction: ["--osm-attraction", "#ff5fa2"],
  building: ["--osm-building", "#9aa0a6"],
};
export const OSM_OTHER_TOKEN: [string, string] = ["--osm-other", "#888888"];

/* ── Click-to-probe ──
 * Header = the resolved place name; the labelled rows are the exact fields that
 * would be written to a photo geotagged at this point (city + OSM sub-location,
 * plus state/county/country). Then which source produced the city, and what the
 * others said — the whole point of the OSM -> Census place -> ZCTA -> GeoNames
 * chain is that you can't tell from the result alone which step answered. */

export type Probe = Schemas["ProbeResponse"];

export type ProbeView = {
  name: string;
  fields: [label: string, value: string][];
  candidates: { label: string; value: string; won: boolean }[];
  coords: string;
};

export function probeView(data: Probe): ProbeView {
  const loc = data.location ?? null;
  const name = loc?.city || loc?.sublocation || "(no place resolves here)";
  const fields = (loc ? [
    ["Sub-location", loc.sublocation],
    ["City", loc.city],
    ["ZIP", loc.postal_code],
    ["County", loc.county],
    ["State", loc.state],
    ["Country", loc.country],
    ["Country code", loc.country_code],
  ] : []).filter((f): f is [string, string] => !!f[1]);
  const s = data.sources;
  const winner = loc?.city;
  const candidates = ([
    ["OSM", s.osm?.city],
    ["Census place", s.census?.city],
    ["ZIP city", s.zcta?.postal_city],
    ["GeoNames", s.geonames?.city],
  ] as [string, string | null | undefined][])
    .filter((c): c is [string, string] => !!c[1])
    .map(([label, value]) => ({ label, value, won: value === winner }));
  return { name, fields, candidates, coords: `${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}` };
}

/** A probe failure as the popup's one line. */
export function probeErrorMessage(error: unknown): string {
  if (is503(error)) return "No geocode data installed";
  return "Error: " + (error instanceof Error ? error.message : String(error));
}
