/* Shared basemap switcher for the Leaflet pages (Geocode, Map, Custom Places),
 * plus the press-drag-release draw gesture two of them share (armMapDrawGesture).
 *
 * Loaded after common.js and before the page script. Everything here is a
 * top-level global because the page scripts call it directly. The functions
 * read the page's own top-level `map` (declared by the page script as
 * `let map`), so they must only be called once the page has created it.
 */

/* ── Basemap definitions ── */
const BASEMAPS = {
  street: {
    label: "Street",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { attribution: "© OpenStreetMap contributors", maxZoom: 19 },
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: { attribution: "Tiles © Esri", maxZoom: 19 },
  },
  hybrid: {
    label: "Hybrid",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    overlayUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    options: { attribution: "Tiles © Esri", maxZoom: 19 },
  },
};

let activeBasemap = "street";
let baseTileLayer = null;
let overlayTileLayer = null;

// Leaflet projects longitude linearly with no wraparound, so continuous
// horizontal dragging lets the map's own center drift past +/-180 (the same
// root cause as getBounds() returning e.g. lng=-458 instead of -98 — see
// geometry.normalize_lng_bbox on the backend, which fixes the *query*). But
// every vector layer we draw (pins, GeoNames markers, Voronoi cells, OSM
// polygons, custom-place shapes) is placed at its canonical (wrapped)
// longitude, so once the view has drifted a full world away, those layers
// render a full world-width off screen. Silently re-centering to the
// CRS-wrapped equivalent view fixes this for every layer at once — visually a
// no-op, since Leaflet's tile rendering is already seamless across world
// copies — and keeps the map's own coordinate system in sync with the
// canonical data going forward.
function correctWorldWrap() {
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

function setBasemap(key) {
  activeBasemap = key;
  const def = BASEMAPS[key];

  if (baseTileLayer) { map.removeLayer(baseTileLayer); baseTileLayer = null; }
  if (overlayTileLayer) { map.removeLayer(overlayTileLayer); overlayTileLayer = null; }

  baseTileLayer = L.tileLayer(def.url, def.options).addTo(map);
  if (def.overlayUrl) {
    overlayTileLayer = L.tileLayer(def.overlayUrl, { maxZoom: 19, opacity: 1 }).addTo(map);
  }

  // Update button states
  document.querySelectorAll(".basemap-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.key === key);
  });
}

function addBasemapControl() {
  const BasemapControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const div = L.DomUtil.create("div", "basemap-control");
      L.DomEvent.disableClickPropagation(div);
      Object.entries(BASEMAPS).forEach(([key, def]) => {
        const btn = L.DomUtil.create("button", "basemap-btn", div);
        btn.textContent = def.label;
        btn.dataset.key = key;
        if (key === activeBasemap) btn.classList.add("active");
        L.DomEvent.on(btn, "click", () => setBasemap(key));
      });
      return div;
    },
  });
  new BasemapControl().addTo(map);
}

/* ── Drag-to-draw gesture ──
 * Arms `targetMap` for one press-drag-release gesture: the Custom Places
 * rectangle/circle and Geocode's area-select circle. Leaflet's own map
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
 * page's own stop (Escape, the button again) — call it from there. */
function armMapDrawGesture(targetMap, { onStart, onMove, onEnd, onCancel }) {
  const el = targetMap.getContainer();
  const prevTouchAction = el.style.touchAction;
  let pointerId = null;
  let last = null;
  let armed = true;

  targetMap.dragging.disable();
  el.style.cursor = "crosshair";
  // With dragging off Leaflet drops its touch-drag class, and the container
  // falls back to touch-action: pan-x pan-y — a finger drag would scroll the
  // page and end in pointercancel instead of drawing.
  el.style.touchAction = "none";

  function pointLatLng(e) {
    const size = targetMap.getSize();
    const p = targetMap.mouseEventToContainerPoint(e);
    return targetMap.containerPointToLatLng(L.point(
      Math.max(0, Math.min(size.x, p.x)), Math.max(0, Math.min(size.y, p.y))));
  }

  function onDown(e) {
    if (pointerId !== null || !e.isPrimary) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Zoom buttons, basemap switcher, attribution: still theirs to click.
    if (e.target instanceof Element && e.target.closest(".leaflet-control")) return;
    // No text selection, and no compatibility mousedown for Leaflet's own
    // handlers (shift box-zoom) to act on mid-draw.
    e.preventDefault();
    pointerId = e.pointerId;
    try { el.setPointerCapture(pointerId); } catch (_) { /* window listeners still see it */ }
    last = pointLatLng(e);
    onStart(last);
  }
  function onPtrMove(e) {
    if (e.pointerId !== pointerId) return;
    last = pointLatLng(e);
    onMove(last);
  }
  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    last = pointLatLng(e);
    disarm();
    onEnd(last);
  }
  function onTornAway(e) {
    if (pointerId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
    disarm();
    if (onCancel) onCancel();
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
    if (pointerId !== null && el.hasPointerCapture && el.hasPointerCapture(pointerId)) {
      try { el.releasePointerCapture(pointerId); } catch (_) { /* already gone */ }
    }
    pointerId = null;
    targetMap.dragging.enable();
    el.style.cursor = "";
    el.style.touchAction = prevTouchAction;
  }
  return disarm;
}
