import { point, type LatLng, type Map as LeafletMap } from "leaflet";

/* Drag-to-draw gesture. Port of web/basemaps.js armMapDrawGesture.
 *
 * Arms `map` for one press-drag-release gesture: the Named Places rectangle /
 * circle and (later) Geocode's area-select circle. Leaflet's own map
 * mousedown/mousemove/mouseup only fire over the map, so a release outside it
 * used to be lost — draw mode stayed armed with map dragging off. Pointer events
 * with pointer capture on the container fix that: every move and the release
 * come back to the map wherever the pointer goes, and the same code serves
 * mouse, touch and pen.
 *
 * onStart(latlng) on press, onMove(latlng) while dragging, onEnd(latlng) on
 * release, onCancel() if the gesture is torn away (pointercancel, lost capture,
 * window blur). Points are clamped to the visible map, so dragging off the edge
 * pins the shape there rather than growing it into the unseen.
 *
 * Map dragging, the cursor and touch-action are restored before onEnd/onCancel
 * run. The returned disarm() does the same restore with no callback, for the
 * page's own stop (Escape, the button again). */

export type DrawGestureHandlers = {
  onStart: (latlng: LatLng) => void;
  onMove: (latlng: LatLng) => void;
  onEnd: (latlng: LatLng) => void;
  onCancel?: () => void;
};

export function armMapDrawGesture(map: LeafletMap, { onStart, onMove, onEnd, onCancel }: DrawGestureHandlers): () => void {
  const el = map.getContainer();
  const prevTouchAction = el.style.touchAction;
  let pointerId: number | null = null;
  let armed = true;

  map.dragging.disable();
  el.style.cursor = "crosshair";
  // With dragging off Leaflet drops its touch-drag class, and the container
  // falls back to touch-action: pan-x pan-y — a finger drag would scroll the
  // page and end in pointercancel instead of drawing.
  el.style.touchAction = "none";

  function pointLatLng(e: PointerEvent): LatLng {
    const size = map.getSize();
    const p = map.mouseEventToContainerPoint(e as unknown as MouseEvent);
    return map.containerPointToLatLng(point(
      Math.max(0, Math.min(size.x, p.x)), Math.max(0, Math.min(size.y, p.y))));
  }

  function onDown(e: PointerEvent) {
    if (pointerId !== null || !e.isPrimary) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Zoom buttons, basemap switcher, attribution: still theirs to click.
    if (e.target instanceof Element && e.target.closest(".leaflet-control")) return;
    // No text selection, and no compatibility mousedown for Leaflet's own
    // handlers (shift box-zoom) to act on mid-draw.
    e.preventDefault();
    pointerId = e.pointerId;
    try { el.setPointerCapture(pointerId); } catch { /* window listeners still see it */ }
    onStart(pointLatLng(e));
  }
  function onPtrMove(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    onMove(pointLatLng(e));
  }
  function onUp(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const last = pointLatLng(e);
    disarm();
    onEnd(last);
  }
  function onTornAway(e?: Event) {
    if (pointerId === null) return;
    if (e && "pointerId" in e && (e as PointerEvent).pointerId !== pointerId) return;
    disarm();
    onCancel?.();
  }

  // pointerdown in the capture phase so a place shape or marker under the press
  // can't swallow it; the rest on window so they arrive even if capture failed.
  el.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onPtrMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onTornAway, true);
  // lostpointercapture also follows a normal release, but onUp has already
  // disarmed by then, so only an unexpected loss reaches onTornAway.
  el.addEventListener("lostpointercapture", onTornAway);
  window.addEventListener("blur", onTornAway);

  function disarm() {
    if (!armed) return;
    armed = false;
    el.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onPtrMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onTornAway, true);
    el.removeEventListener("lostpointercapture", onTornAway);
    window.removeEventListener("blur", onTornAway);
    if (pointerId !== null && el.hasPointerCapture?.(pointerId)) {
      try { el.releasePointerCapture(pointerId); } catch { /* already gone */ }
    }
    pointerId = null;
    map.dragging.enable();
    el.style.cursor = "";
    el.style.touchAction = prevTouchAction;
  }
  return disarm;
}
