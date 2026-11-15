import { divIcon, latLngBounds, marker as leafletMarker, point, type Circle, type LatLngExpression, type Map as LeafletMap, type Marker, type Rectangle } from "leaflet";
import {
  MIN_RADIUS_M, RECT_OPPOSITE_CORNER, distanceMeters, edgeLatLng, formatRadius, rectCenter, rectCorner,
  resizeRect, translateRect, type CornerKey, type RectBounds, type Shape,
} from "./shapes";

/* Moving and resizing a saved shape. Port of the handle code in
 * web/custom-places.js.
 *
 * The shape gets draggable markers — core Leaflet only drags markers;
 * `draggable: true` on a path needs the Leaflet.Path.Drag plugin, which this app
 * doesn't load. A circle gets a centre (move) and an east-edge (radius) handle;
 * a rectangle gets one handle per corner, each dragging that corner while its
 * diagonal opposite stays put, plus a centre (move) handle like the circle's
 * that translates the whole rectangle.
 *
 * Every handle commits through `onCommit` with the live shape read back off the
 * layer, so there's one save path however the shape got where it is. Every
 * handle is also wired through armHandle, so cancelDrag() (Escape) mid-drag puts
 * the shape back and commits nothing.
 *
 * Keyboard path: each handle is a focusable marker (Leaflet gives it tabindex
 * and role=button). Arrow keys nudge it 10 px (Shift: 50 px) as if dragged; the
 * commit waits until the keys have been still for KEY_SETTLE_MS, so holding an
 * arrow down saves once, and Escape before then cancels like a mouse drag. */

const KEY_STEP_PX = 10;
const KEY_STEP_BIG_PX = 50;
const KEY_SETTLE_MS = 500;

export type ShapeHandles = {
  /** Escape mid-drag. True if a drag was cancelled (the caller reports it). */
  cancelDrag: () => boolean;
  remove: () => void;
};

type ActiveDrag = { marker: Marker; restore: () => void; cancelled: boolean };

export function attachShapeHandles(
  map: LeafletMap,
  layer: Rectangle | Circle,
  kind: Shape["type"],
  { onCommit }: { onCommit: (shape: Shape) => void },
): ShapeHandles {
  const handles: Marker[] = [];
  let active: ActiveDrag | null = null;

  const isCircle = (_l: Rectangle | Circle): _l is Circle => kind === "circle";
  const rectOf = (l: Rectangle): RectBounds => {
    const b = l.getBounds();
    return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  };
  const liveShape = (): Shape => {
    if (isCircle(layer)) {
      const c = layer.getLatLng();
      return { type: "circle", bounds: { lat: c.lat, lng: c.lng, radius: layer.getRadius() } };
    }
    return { type: "rectangle", bounds: rectOf(layer as Rectangle) };
  };
  const setRect = (b: RectBounds) => (layer as Rectangle).setBounds(latLngBounds([b.south, b.west], [b.north, b.east]));

  function makeHandle(at: LatLngExpression, className: string, tooltip: string, label: string, direction: "left" | "right" | "top"): Marker {
    const m = leafletMarker(at, {
      draggable: true,
      icon: divIcon({ className, html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
      zIndexOffset: 1000,
    }).addTo(map).bindTooltip(tooltip, { direction });
    m.getElement()?.setAttribute("aria-label", `${label} (arrow keys nudge it)`);
    handles.push(m);
    return m;
  }

  // Wire a draggable handle: `onDrag` runs per move, `onEnd` on a release.
  // Snapshots the shape's geometry at dragstart; cancelDrag puts it back, and
  // the drag's remaining events are then swallowed so nothing is saved.
  // `resync` re-places every handle onto the (restored) shape.
  function armHandle(m: Marker, { onStart, onDrag, onEnd, resync }: {
    onStart?: () => void; onDrag: () => void; onEnd: () => void; resync: () => void;
  }) {
    m.on("dragstart", () => {
      let restoreShape: () => void;
      if (isCircle(layer)) {
        const c = layer, latlng = c.getLatLng(), radius = c.getRadius();
        restoreShape = () => { c.setLatLng(latlng); c.setRadius(radius); };
      } else {
        const r = layer as Rectangle, bounds = r.getBounds();
        restoreShape = () => { r.setBounds(bounds); };
      }
      active = {
        marker: m, cancelled: false,
        restore: () => { restoreShape(); resync(); },
      };
      onStart?.();
    });
    m.on("drag", () => {
      if (active?.cancelled) return;
      onDrag();
    });
    m.on("dragend", () => {
      const drag = active;
      active = null;
      // Re-synced again here: Leaflet leaves the handle wherever the pointer was.
      if (drag?.cancelled) { resync(); return; }
      onEnd();
    });
    wireKeyboard(m);
  }

  // Arrow-key nudges replay a drag: dragstart on the first key, drag per key,
  // dragend once the keys settle.
  const keyTimers = new Map<Marker, ReturnType<typeof setTimeout>>();
  function wireKeyboard(m: Marker) {
    const el = m.getElement();
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? KEY_STEP_BIG_PX : KEY_STEP_PX;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta) return;
      e.preventDefault();
      e.stopPropagation();   // the map's own keyboard pan must not move under it
      if (!keyTimers.has(m)) m.fire("dragstart");
      else clearTimeout(keyTimers.get(m));
      // Cancelled with Escape: swallow the keys until they stop, then end it.
      if (active?.marker === m && !active.cancelled) {
        const p = map.latLngToContainerPoint(m.getLatLng()).add(point(delta[0]!, delta[1]!));
        m.setLatLng(map.containerPointToLatLng(p));
        m.fire("drag");
      }
      keyTimers.set(m, setTimeout(() => {
        keyTimers.delete(m);
        if (active?.marker === m) m.fire("dragend");
      }, KEY_SETTLE_MS));
    });
  }

  if (isCircle(layer)) {
    const circle = layer;
    const moveHandle = makeHandle(circle.getLatLng(), "move-handle", "Drag to move", "Move circle", "left");
    const radiusHandle = makeHandle(edgeLatLng(circle.getLatLng(), circle.getRadius()), "radius-handle",
      formatRadius(circle.getRadius()), "Resize circle", "right");
    const resync = () => {
      moveHandle.setLatLng(circle.getLatLng());
      radiusHandle.setLatLng(edgeLatLng(circle.getLatLng(), circle.getRadius()));
      radiusHandle.setTooltipContent(formatRadius(circle.getRadius()));
    };

    // Move: the circle follows the centre handle, and the edge handle rides along
    // so the radius it reports doesn't lie mid-drag.
    armHandle(moveHandle, {
      resync,
      onDrag: () => {
        const c = moveHandle.getLatLng();
        circle.setLatLng(c);
        radiusHandle.setLatLng(edgeLatLng(c, circle.getRadius()));
      },
      onEnd: () => onCommit(liveShape()),
    });

    // Resize: dragging anywhere works — it's the distance from the centre that
    // counts, not staying on the ring — so the handle only snaps back due east
    // once released. The centre is read live, since the move handle may have
    // shifted it since this listener was wired.
    armHandle(radiusHandle, {
      resync,
      onDrag: () => {
        const r = Math.max(MIN_RADIUS_M, distanceMeters(circle.getLatLng(), radiusHandle.getLatLng()));
        circle.setRadius(r);
        // The handle tooltip is the only live size readout — the sidebar row
        // shows the name and photo, nothing about geometry.
        radiusHandle.setTooltipContent(formatRadius(r));
      },
      onEnd: () => {
        radiusHandle.setLatLng(edgeLatLng(circle.getLatLng(), circle.getRadius()));
        onCommit(liveShape());
      },
    });
  } else {
    const rect = layer as Rectangle;
    const corners = {} as Record<CornerKey, Marker>;
    let moveHandle: Marker | null = null;
    // Every handle (corners + centre) back onto the shape's actual geometry.
    const resync = () => {
      const b = rectOf(rect);
      (Object.keys(corners) as CornerKey[]).forEach((k) => corners[k].setLatLng(rectCorner(b, k)));
      moveHandle?.setLatLng(rectCenter(b));
    };

    (Object.keys(RECT_OPPOSITE_CORNER) as CornerKey[]).forEach((key) => {
      const m = makeHandle(rectCorner(rectOf(rect), key), "rect-handle", "Drag to resize", `Resize rectangle (${key} corner)`, "top");
      corners[key] = m;
      // The dragged corner and its fixed diagonal opposite define the new
      // rectangle; the other two corners (and their handles) follow along.
      armHandle(m, {
        resync,
        onDrag: () => {
          const ll = m.getLatLng();
          setRect(resizeRect(rectCorner(rectOf(rect), RECT_OPPOSITE_CORNER[key]), { lat: ll.lat, lng: ll.lng }));
          resync();
        },
        onEnd: () => {
          // Snap every handle back onto the saved shape's actual corners, same
          // as the circle's radius handle does after a drag that hit the floor.
          resync();
          onCommit(liveShape());
        },
      });
    });

    // Move: translate the whole rectangle by however far the centre handle has
    // gone since dragstart — an offset in degrees, so its extent is kept exactly.
    const mh = makeHandle(rectCenter(rectOf(rect)), "move-handle", "Drag to move", "Move rectangle", "left");
    moveHandle = mh;
    let start: RectBounds | null = null;
    armHandle(mh, {
      resync,
      onStart: () => { start = rectOf(rect); },
      onDrag: () => {
        if (!start) return;
        const c = mh.getLatLng(), c0 = rectCenter(start);
        setRect(translateRect(start, c.lat - c0.lat, c.lng - c0.lng));
        const b = rectOf(rect);
        (Object.keys(corners) as CornerKey[]).forEach((k) => corners[k].setLatLng(rectCorner(b, k)));
      },
      onEnd: () => {
        start = null;
        resync();
        onCommit(liveShape());
      },
    });
  }

  return {
    cancelDrag() {
      const drag = active;
      if (!drag || drag.cancelled) return false;
      drag.cancelled = true;
      drag.restore();
      // End Leaflet's own drag too, so the handle stops following the pointer.
      // finishDrag fires dragend, which clears the drag and re-syncs. (Internal
      // to L.Draggable, hence the guard — without it the handle just keeps
      // tracking the pointer until release, still saving nothing.)
      const draggable = (drag.marker.dragging as unknown as { _draggable?: { _moving?: boolean; finishDrag?: () => void } } | undefined)?._draggable;
      if (draggable?._moving && typeof draggable.finishDrag === "function") {
        try { draggable.finishDrag(); } catch { /* the release ends it instead */ }
      }
      return true;
    },
    remove() {
      keyTimers.forEach((t) => clearTimeout(t));
      keyTimers.clear();
      handles.forEach((h) => h.remove());
      handles.length = 0;
    },
  };
}
