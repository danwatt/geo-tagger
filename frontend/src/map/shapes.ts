/* Saved-shape geometry with no Leaflet in it: parsing and serialising the
 * `bounds` JSON string a saved place carries, the size floors the draw and edit
 * tools enforce, and the corner/translate maths the edit handles use. Pure so it
 * can be unit-tested; the Leaflet side (shapeHandles.ts, DrawShapeTool.tsx)
 * calls into it. Shared with Geocode's area tools when that page is ported. */

export type RectBounds = { north: number; south: number; east: number; west: number };
export type CircleBounds = { lat: number; lng: number; radius: number };
export type ShapeType = "rectangle" | "circle";
export type Shape =
  | { type: "rectangle"; bounds: RectBounds }
  | { type: "circle"; bounds: CircleBounds };

export type LatLngLike = { lat: number; lng: number };
export type Bbox = { min_lat: number; max_lat: number; min_lng: number; max_lng: number };

/** Smallest circle the draw and edit tools allow, in metres. */
export const MIN_RADIUS_M = 2;
/** Smallest rectangle side, in degrees (~3.3 m at the equator). */
export const MIN_RECT_DEG = 0.00003;
export const METERS_PER_DEG_LAT = 111320;
/** Leaflet's CRS.Earth.R, so distances agree with what the map draws. */
const EARTH_RADIUS_M = 6371000;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A saved place's bounds string as a shape, or null when it can't be read (a
 *  row saved before the server validated shapes, or a hand-edited backup). */
export function parseShape(type: string, json: string): Shape | null {
  let b: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    b = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (type === "rectangle") {
    const { north, south, east, west } = b;
    if (![north, south, east, west].every(finite)) return null;
    return { type, bounds: { north: north as number, south: south as number, east: east as number, west: west as number } };
  }
  if (type === "circle") {
    const { lat, lng, radius } = b;
    if (![lat, lng, radius].every(finite)) return null;
    return { type, bounds: { lat: lat as number, lng: lng as number, radius: radius as number } };
  }
  return null;
}

/** The JSON string the places API stores — same key order the legacy page sent. */
export function serializeShape(shape: Shape): string {
  if (shape.type === "rectangle") {
    const { north, south, east, west } = shape.bounds;
    return JSON.stringify({ north, south, east, west });
  }
  const { lat, lng, radius } = shape.bounds;
  return JSON.stringify({ lat, lng, radius });
}

/** The radius of a circle place's bounds, 0 when unreadable. */
export function circleRadius(json: string): number {
  const s = parseShape("circle", json);
  return s?.type === "circle" ? s.bounds.radius : 0;
}

export function formatRadius(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 2)} km`;
  return `${Math.round(m)} m`;
}

/** Below the draw tool's minimum size — a drag that didn't really take. */
export function isTooSmall(shape: Shape): boolean {
  if (shape.type === "circle") return shape.bounds.radius < MIN_RADIUS_M;
  const b = shape.bounds;
  return Math.abs(b.east - b.west) < MIN_RECT_DEG || Math.abs(b.north - b.south) < MIN_RECT_DEG;
}

/** Rectangle from two opposite corners, in any order. */
export function rectFromCorners(a: LatLngLike, b: LatLngLike): RectBounds {
  return {
    north: Math.max(a.lat, b.lat), south: Math.min(a.lat, b.lat),
    east: Math.max(a.lng, b.lng), west: Math.min(a.lng, b.lng),
  };
}

export type CornerKey = "nw" | "ne" | "se" | "sw";
// Corner key -> opposite corner key. Dragging a corner resizes around the one
// diagonally across from it, same as the browser's own resize handles.
export const RECT_OPPOSITE_CORNER: Record<CornerKey, CornerKey> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

export function rectCorner(b: RectBounds, key: CornerKey): LatLngLike {
  return { lat: key[0] === "n" ? b.north : b.south, lng: key[1] === "e" ? b.east : b.west };
}

export function rectCenter(b: RectBounds): LatLngLike {
  return { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
}

/** The rectangle a corner drag makes: the dragged point and the fixed diagonal
 *  opposite, pushed apart to the minimum side so it can't collapse to a line. */
export function resizeRect(fixed: LatLngLike, dragged: LatLngLike): RectBounds {
  let { lat, lng } = dragged;
  if (Math.abs(lat - fixed.lat) < MIN_RECT_DEG) lat = fixed.lat + Math.sign(lat - fixed.lat || 1) * MIN_RECT_DEG;
  if (Math.abs(lng - fixed.lng) < MIN_RECT_DEG) lng = fixed.lng + Math.sign(lng - fixed.lng || 1) * MIN_RECT_DEG;
  return rectFromCorners(fixed, { lat, lng });
}

/** Move a rectangle by an offset in degrees — so its lat/lng extent is kept
 *  exactly (a metre-preserving move would reshape it with latitude). Clamped so
 *  it can't be pushed past either pole. */
export function translateRect(b: RectBounds, dLat: number, dLng: number): RectBounds {
  const d = Math.max(-90 - b.south, Math.min(90 - b.north, dLat));
  return { north: b.north + d, south: b.south + d, east: b.east + dLng, west: b.west + dLng };
}

/** Due east of the centre at `radius` metres. The cosine is floored so a place
 *  near a pole can't divide the offset up to infinity. */
export function edgeLatLng(center: LatLngLike, radius: number): LatLngLike {
  const cos = Math.max(1e-6, Math.cos(center.lat * Math.PI / 180));
  return { lat: center.lat, lng: center.lng + radius / (METERS_PER_DEG_LAT * cos) };
}

/** Great-circle distance in metres (haversine, Leaflet's earth radius). */
export function distanceMeters(a: LatLngLike, b: LatLngLike): number {
  const rad = Math.PI / 180;
  const sinDLat = Math.sin((b.lat - a.lat) * rad / 2);
  const sinDLon = Math.sin((b.lng - a.lng) * rad / 2);
  const h = sinDLat * sinDLat + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** The box the R*Tree query understands. A circle's box overshoots its corners
 *  by ~27% of the area, so circle callers follow up with insideShape. */
export function shapeBbox(shape: Shape): Bbox {
  if (shape.type === "rectangle") {
    const b = shape.bounds;
    return { min_lat: b.south, max_lat: b.north, min_lng: b.west, max_lng: b.east };
  }
  const { lat, lng, radius } = shape.bounds;
  const latOff = radius / METERS_PER_DEG_LAT;
  const lngOff = radius / (METERS_PER_DEG_LAT * Math.max(1e-6, Math.cos(lat * Math.PI / 180)));
  return { min_lat: lat - latOff, max_lat: lat + latOff, min_lng: lng - lngOff, max_lng: lng + lngOff };
}

/** [[south, west], [north, east]] — what map.fitBounds takes. */
export function shapeLatLngBounds(shape: Shape): [[number, number], [number, number]] {
  const b = shapeBbox(shape);
  return [[b.min_lat, b.min_lng], [b.max_lat, b.max_lng]];
}

/** Exact containment past the bbox prefilter. A rectangle's bbox *is* the shape. */
export function insideShape(shape: Shape, p: LatLngLike): boolean {
  if (shape.type === "rectangle") return true;
  return distanceMeters(shape.bounds, p) <= shape.bounds.radius;
}
