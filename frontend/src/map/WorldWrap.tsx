import { useMapEvents } from "react-leaflet";
import type { Map as LeafletMap } from "leaflet";

/* Port of web/basemaps.js correctWorldWrap.
 *
 * Leaflet projects longitude linearly with no wraparound, so continuous
 * horizontal dragging lets the map's own center drift past +/-180 (the same
 * root cause as getBounds() returning e.g. lng=-458 instead of -98 — see
 * geometry.normalize_lng_bbox on the backend, which fixes the *query*). But
 * every vector layer we draw (pins, GeoNames markers, Voronoi cells, OSM
 * polygons, custom-place shapes) is placed at its canonical (wrapped)
 * longitude, so once the view has drifted a full world away, those layers
 * render a full world-width off screen. Silently re-centering to the
 * CRS-wrapped equivalent view fixes this for every layer at once — visually a
 * no-op, since Leaflet's tile rendering is already seamless across world
 * copies — and keeps the map's own coordinate system in sync with the
 * canonical data going forward. */

export function correctWorldWrap(map: LeafletMap) {
  const center = map.getCenter();
  const wrapped = map.wrapLatLng(center);
  // Epsilon, not strict equality: wrapping an already-in-range value can
  // reintroduce a little floating-point noise via its internal modulo, which
  // would otherwise trigger a spurious (if harmless-looking) setView on every
  // single pan.
  if (Math.abs(wrapped.lng - center.lng) > 1e-9) {
    map.setView(wrapped, map.getZoom(), { animate: false });
  }
}

/** Drop inside a MapContainer to keep the view wrapped after every pan. */
export function WorldWrap() {
  const map = useMapEvents({ moveend: () => correctWorldWrap(map) });
  return null;
}
