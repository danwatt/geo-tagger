/* Shared basemap switcher for the Leaflet pages (Geocode, Map, Custom Places).
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
