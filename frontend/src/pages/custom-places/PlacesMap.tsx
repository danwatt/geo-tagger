import { useEffect, useRef, useState, type Ref, type RefObject } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import { circle as leafletCircle, rectangle as leafletRectangle, type Circle, type Map as LeafletMap, type PathOptions, type Rectangle } from "leaflet";
import { MapView, cssVar } from "../../map/MapView";
import { DrawShapeTool } from "../../map/DrawShapeTool";
import { attachShapeHandles, type ShapeHandles } from "../../map/shapeHandles";
import { parseShape, type Shape, type ShapeType } from "../../map/shapes";
import type { Hotspot } from "./hotspots";
import type { Hover } from "./PlaceList";
import type { Place } from "./places";

/* The Named Places map: every saved place drawn (in `places` order — the
 * sidebar's sort never reshuffles map layers), the selected one with its edit
 * handles, the hotspot rings when that overlay is on, and the draw tool. The
 * Leaflet side is imperative (one layer per place, rebuilt when the list
 * changes), the way the legacy page drew it; all state lives in the page. */

// The world view is only the starting point: the page restores the last view
// or fits the places as soon as it knows them.
const START_CENTER: [number, number] = [20, 0];
const START_ZOOM = 2;

/* ── Map labels ──
 * Zoomed out, a name on every place is a wall of text over the tiles — and the
 * shapes are specks anyway. Zoomed in, the shapes are what you're working with
 * and the hover tooltip means the map can't be read without the mouse. So the
 * same tooltip is permanent past LABEL_ZOOM and hover-only below it; Leaflet
 * fixes permanence at bind time, hence the rebind. */
export const LABEL_ZOOM = 12;

function placeStyles(): { base: PathOptions; hover: PathOptions } {
  return {
    base: { color: cssVar("--accent", "#4a90d9"), weight: 2, fillOpacity: 0.1 },
    hover: { color: cssVar("--accent-text", "#7ab8f5"), weight: 4, fillOpacity: 0.3 },
  };
}

/** Tooltip content as a text node: names are user data, and a string tooltip is HTML. */
function textEl(text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

export type PlacesMapProps = {
  mapRef: Ref<LeafletMap>;
  places: readonly Place[];
  /** Bumped to force the shapes to be rebuilt from `places` (a failed save
   *  snaps the dragged shape back to what's stored). */
  revision: number;
  selectedId: number | null;
  hover: Hover;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  onBoundsCommit: (place: Place, shape: Shape) => void;
  handlesRef: RefObject<ShapeHandles | null>;
  hotspots: readonly Hotspot[];
  hotspotRadius: number;
  onHotspotClick: (h: Hotspot) => void;
  drawMode: ShapeType | null;
  onDrawn: (shape: Shape) => void;
  onTooSmall: () => void;
  onDrawCancel: () => void;
  onMoveEnd: (map: LeafletMap) => void;
};

export function PlacesMap(props: PlacesMapProps) {
  return (
    <MapView id="map" mapRef={props.mapRef} center={START_CENTER} zoom={START_ZOOM} basemaps>
      <MoveEvents onMoveEnd={props.onMoveEnd} />
      <PlaceShapes {...props} />
      <HotspotRings hotspots={props.hotspots} radius={props.hotspotRadius} onClick={props.onHotspotClick} />
      <DrawShapeTool mode={props.drawMode} onDrawn={props.onDrawn} onTooSmall={props.onTooSmall} onCancel={props.onDrawCancel} />
    </MapView>
  );
}

function MoveEvents({ onMoveEnd }: { onMoveEnd: (map: LeafletMap) => void }) {
  const cb = useRef(onMoveEnd);
  cb.current = onMoveEnd;
  const map = useMapEvents({ moveend: () => cb.current(map) });
  return null;
}

function PlaceShapes({ places, revision, selectedId, hover, onSelect, onHover, onBoundsCommit, handlesRef }: PlacesMapProps) {
  const map = useMap();
  const shapes = useRef(new Map<number, Rectangle | Circle>());
  const [built, setBuilt] = useState(0);
  const cb = useRef({ onSelect, onHover, onBoundsCommit });
  cb.current = { onSelect, onHover, onBoundsCommit };

  // One layer per drawable place. No `draggable` here: core Leaflet ignores it
  // on a path — the selected shape is moved/resized by the handles below.
  useEffect(() => {
    const { base } = placeStyles();
    const layers = new Map<number, Rectangle | Circle>();
    for (const p of places) {
      if (p.bounds_valid === false) continue;   // listed as broken in the sidebar instead
      const shape = parseShape(p.type, p.bounds);
      if (!shape) continue;
      const layer = shape.type === "rectangle"
        ? leafletRectangle([[shape.bounds.south, shape.bounds.west], [shape.bounds.north, shape.bounds.east]], { ...base })
        : leafletCircle([shape.bounds.lat, shape.bounds.lng], { radius: shape.bounds.radius, ...base });
      layer.on("click", () => cb.current.onSelect(p.id));
      layer.on("mouseover", () => cb.current.onHover(p.id));
      layer.on("mouseout", () => cb.current.onHover(null));
      layer.addTo(map);
      layers.set(p.id, layer);
    }
    shapes.current = layers;
    setBuilt((n) => n + 1);
    return () => layers.forEach((l) => l.remove());
  }, [map, places, revision]);

  // Labels: rebound on every rebuild (the new shapes carry none yet), then only
  // when the zoom crosses LABEL_ZOOM.
  useEffect(() => {
    let permanent: boolean | null = null;
    const apply = () => {
      const next = map.getZoom() >= LABEL_ZOOM;
      if (next === permanent) return;
      permanent = next;
      for (const p of places) {
        const layer = shapes.current.get(p.id);
        if (!layer) continue;
        layer.unbindTooltip();
        layer.bindTooltip(textEl(p.name), { permanent: next, direction: "top", className: "place-label" });
      }
    };
    apply();
    map.on("zoomend", apply);
    return () => { map.off("zoomend", apply); };
  }, [map, places, built]);

  // Row ↔ shape highlight, from either side.
  useEffect(() => {
    const { base, hover: hot } = placeStyles();
    shapes.current.forEach((layer, id) => {
      const on = hover?.id === id;
      layer.setStyle(on ? hot : base);
      if (on) layer.bringToFront();
    });
  }, [hover, built]);

  // The selected place's edit handles.
  useEffect(() => {
    if (selectedId == null) return;
    const place = places.find((p) => p.id === selectedId);
    const layer = shapes.current.get(selectedId);
    if (!place || !layer) return;
    const handles = attachShapeHandles(map, layer, place.type as ShapeType, {
      onCommit: (shape) => cb.current.onBoundsCommit(place, shape),
    });
    handlesRef.current = handles;
    return () => {
      handles.remove();
      if (handlesRef.current === handles) handlesRef.current = null;
    };
    // `built` is the rebuild signal; `places` only matters through it.
  }, [map, selectedId, built, handlesRef]);

  return null;
}

/* Hotspot rings: L.circle, not L.circleMarker — the ring is metres on the
 * ground, and it is exactly the shape the place would be saved as. Amber and
 * dashed, apart from the blue of a saved place. */
function HotspotRings({ hotspots, radius, onClick }: { hotspots: readonly Hotspot[]; radius: number; onClick: (h: Hotspot) => void }) {
  const map = useMap();
  const cb = useRef(onClick);
  cb.current = onClick;
  useEffect(() => {
    const color = cssVar("--gold", "#e0a040");
    const rings = hotspots.map((h) => {
      const ring = leafletCircle([h.lat, h.lng], { radius, color, weight: 2, fillOpacity: 0.12, dashArray: "5,4" });
      ring.bindTooltip(textEl(`${h.label} ·${h.count} photo${h.count !== 1 ? "s" : ""}`), { direction: "top" });
      ring.on("click", () => cb.current(h));
      ring.addTo(map);
      return ring;
    });
    return () => rings.forEach((r) => r.remove());
  }, [map, hotspots, radius]);
  return null;
}

