import type { Schemas } from "../../api/client";

type Segment = Schemas["StreetSegment"];

export type StreetGroup = { key: string; ways: Segment[] };

/* Segments, not streets: OSM splits a road at every junction and tag change, so
 * one named road comes back as dozens of ways. Group by name (plus route ref when
 * it differs) for the list, most segments first; each way stays its own polyline
 * on the map so gaps between segments stay honest. */
export function groupStreets(streets: Segment[]): StreetGroup[] {
  const byName = new Map<string, StreetGroup>();
  for (const s of streets) {
    const key = s.name + (s.ref && s.ref !== s.name ? ` (${s.ref})` : "");
    const group = byName.get(key) ?? { key, ways: [] };
    group.ways.push(s);
    byName.set(key, group);
  }
  return [...byName.values()].sort((a, b) => b.ways.length - a.ways.length || a.key.localeCompare(b.key));
}

type Box = { min_lat: number; max_lat: number; min_lng: number; max_lng: number };

/** The box covering every given box, as Leaflet [[south, west], [north, east]]. */
export function unionBounds(boxes: Box[]): [[number, number], [number, number]] | null {
  if (!boxes.length) return null;
  return [
    [Math.min(...boxes.map((b) => b.min_lat)), Math.min(...boxes.map((b) => b.min_lng))],
    [Math.max(...boxes.map((b) => b.max_lat)), Math.max(...boxes.map((b) => b.max_lng))],
  ];
}
