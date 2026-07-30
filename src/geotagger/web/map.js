/* Places DB map — plots the GeoNames reference data (the populated places
 * geocode.py reverse-geocodes photo coordinates against), not photos. Lets
 * you check what place name a location in your library would resolve to.
 *
 * The GeoNames cities500 set has ~200k entries worldwide, so nothing is
 * fetched until the map is zoomed in past MIN_ZOOM_FOR_MARKERS; below that a
 * hint is shown instead. Once zoomed in, places within the current viewport
 * are fetched from /api/geocode/places and plotted with Leaflet.markercluster.
 * The server caps how many it returns per request and, when capped, prefers
 * the largest places by population so the view stays representative.
 *
 * Past MIN_ZOOM_FOR_VORONOI, /api/geocode/voronoi additionally supplies each
 * place's cell — the area a coordinate must fall in to reverse-geocode to that
 * place — drawn as a translucent colored polygon underneath the markers so you
 * can see where the boundary between two places actually falls. With the
 * population-weighted lookup on (the default) those boundaries are curved and
 * the server traces them off a grid, so a cell can come back as more than one
 * ring; `cell.polygons` carries them all.
 *
 * Past MIN_ZOOM_FOR_OSM, /api/geocode/osm-places additionally supplies real
 * OSM boundaries (cities, parks, stadiums, campuses, neighborhoods, named
 * buildings) as a GeoJSON FeatureCollection, rendered with Leaflet's built-in
 * L.geoJSON() layer (no extra plugin needed — GeoJSON support is core Leaflet).
 *
 * Past MIN_ZOOM_FOR_CENSUS, /api/geocode/census-places can overlay US Census place
 * boundaries (incorporated places + CDPs) — the source consulted after OSM and
 * before the GeoNames nearest-place estimate. Off by default: these tile the map
 * wall-to-wall, so they're drawn dashed and unfilled and only when asked for.
 *
 * Named buildings vastly outnumber every other OSM category and are only
 * meaningful once you can see individual rooftops, so they're held back
 * behind their own, deeper MIN_ZOOM_FOR_BUILDINGS threshold — the osm-places
 * request omits them (buildings=false) below that zoom, rather than fetching
 * and then hiding them.
 */

const MIN_ZOOM_FOR_MARKERS = 8;
const MIN_ZOOM_FOR_VORONOI = 11;
const MIN_ZOOM_FOR_OSM = 11;
const MIN_ZOOM_FOR_CENSUS = 9;   // whole-place polygons, readable further out than OSM's features
const MIN_ZOOM_FOR_BUILDINGS = 17;
const REFRESH_DEBOUNCE_MS = 250;

// Distinct color per OSM place category so a stadium vs. a park vs. a campus
// reads at a glance. Keep in sync with build_osm_places.classify categories.
const OSM_CATEGORY_COLORS = {
  city: "#4f8cff",
  neighbourhood: "#00b3a4",
  park: "#3fbf5f",
  venue: "#ff8c42",
  campus: "#a06bff",
  attraction: "#ff5fa2",
  building: "#9aa0a6",
};

let map;
let baseTileLayer = null;
let overlayTileLayer = null;
let activeBasemap = "street";
let markerCluster = null;
let voronoiLayer = null;
let voronoiEnabled = true;
let osmLayer = null;
let osmEnabled = true;
let censusLayer = null;
let censusEnabled = false;   // off by default: it blankets the map, unlike OSM's sparser features
let probeSeq = 0;
let refreshTimer = null;
let fetchSeq = 0;
let voronoiFetchSeq = 0;
let osmFetchSeq = 0;
let censusFetchSeq = 0;

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

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  fitToLibrary();

  const toggle = document.getElementById("voronoi-toggle");
  toggle.addEventListener("change", () => {
    voronoiEnabled = toggle.checked;
    refreshVoronoi();
  });

  const osmToggle = document.getElementById("osm-toggle");
  osmToggle.addEventListener("change", () => {
    osmEnabled = osmToggle.checked;
    refreshOsm();
  });

  const censusToggle = document.getElementById("census-toggle");
  censusToggle.checked = censusEnabled;
  censusToggle.addEventListener("change", () => {
    censusEnabled = censusToggle.checked;
    refreshCensus();
  });
});

function initMap() {
  map = L.map("map").setView([20, 0], 2);
  setBasemap("street");
  addBasemapControl();

  // Added before the marker layer so cell polygons render underneath markers.
  // osmLayer is added after voronoiLayer so its outlines draw over the
  // translucent Voronoi fills; both stay under the marker pane.
  voronoiLayer = L.layerGroup().addTo(map);
  // interactive:false so clicks fall through to the map's own click handler
  // (probePoint) everywhere — including inside an OSM polygon — instead of the
  // polygon swallowing the click. The polygon's name still surfaces: probePoint
  // reverse-geocodes the clicked point, and the containing city/feature come back
  // as the geocode result.
  osmLayer = L.geoJSON(null, { style: osmFeatureStyle, interactive: false }).addTo(map);
  // Census place boundaries, drawn dashed so they read as a different source than
  // the OSM outlines they sit next to (and often overlap).
  censusLayer = L.geoJSON(null, { style: censusFeatureStyle, interactive: false }).addTo(map);
  markerCluster = L.markerClusterGroup({ maxClusterRadius: 60 });
  map.addLayer(markerCluster);

  map.on("moveend", correctWorldWrap);
  map.on("moveend zoomend", scheduleRefresh);
  map.on("click", probePoint);
}

// Leaflet projects longitude linearly with no wraparound, so continuous
// horizontal dragging lets the map's own center drift past +/-180 (the same
// root cause as getBounds() returning e.g. lng=-458 instead of -98 — see
// contexts.normalize_lng_bbox on the backend, which fixes the *query*). But
// every vector layer we draw (GeoNames markers, Voronoi cells, OSM polygons)
// is placed at its canonical (wrapped) longitude, so once the view has
// drifted a full world away, those layers render a full world-width off
// screen. Silently re-centering to the CRS-wrapped equivalent view fixes
// this for every layer at once — visually a no-op, since Leaflet's tile
// rendering is already seamless across world copies — and keeps the map's
// own coordinate system in sync with the canonical data going forward.
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

async function fitToLibrary() {
  try {
    const res = await fetch("/api/stats/bounds");
    const data = await res.json();
    if (data.has_data) {
      map.fitBounds(
        [[data.min_lat, data.min_lng], [data.max_lat, data.max_lng]],
        { padding: [40, 40] }
      );
    }
  } catch (e) {
    // keep default world view
  }
  refreshMarkers();
  refreshVoronoi();
  refreshOsm();
  refreshCensus();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshMarkers();
    refreshVoronoi();
    refreshOsm();
    refreshCensus();
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshMarkers() {
  const zoom = map.getZoom();
  if (zoom < MIN_ZOOM_FOR_MARKERS) {
    markerCluster.clearLayers();
    showHint("Zoom in to see reverse-geocode places");
    setStatus("");
    return;
  }
  hideHint();

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++fetchSeq;
  setStatus("Loading places…");
  try {
    const res = await fetch(`/api/geocode/places?bbox=${encodeURIComponent(bbox)}`);
    if (res.status === 503) {
      markerCluster.clearLayers();
      showHint("GeoNames data not installed — run scripts/get_geonames.py");
      setStatus("");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== fetchSeq) return; // a newer request superseded this one
    renderMarkers(data.places);
    if (voronoiEnabled && zoom < MIN_ZOOM_FOR_VORONOI) {
      showHint("Zoom in further to see place boundaries");
    }
    const shown = data.places.length.toLocaleString();
    setStatus(data.truncated
      ? `Showing ${shown} largest of ${data.total.toLocaleString()} places in view — zoom in for the rest`
      : `${shown} place${data.places.length === 1 ? "" : "s"} in view`);
  } catch (e) {
    if (seq === fetchSeq) setStatus("Error loading places: " + e.message, true);
  }
}

async function refreshVoronoi() {
  const zoom = map.getZoom();
  if (!voronoiEnabled || zoom < MIN_ZOOM_FOR_VORONOI) {
    voronoiLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++voronoiFetchSeq;
  try {
    const res = await fetch(`/api/geocode/voronoi?bbox=${encodeURIComponent(bbox)}`);
    if (!res.ok) return; // the marker fetch already surfaces load errors in the status bar
    const data = await res.json();
    if (seq !== voronoiFetchSeq) return; // a newer request superseded this one
    renderVoronoi(data.cells);
  } catch (e) {
    // best-effort visual overlay; the marker fetch already reports errors
  }
}

async function refreshOsm() {
  const zoom = map.getZoom();
  if (!osmEnabled || zoom < MIN_ZOOM_FOR_OSM) {
    osmLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const buildings = zoom >= MIN_ZOOM_FOR_BUILDINGS;
  const seq = ++osmFetchSeq;
  try {
    const res = await fetch(
      `/api/geocode/osm-places?bbox=${encodeURIComponent(bbox)}&buildings=${buildings}`
    );
    if (res.status === 503) {
      osmLayer.clearLayers();
      setStatus("OSM places DB not built — run scripts/build_osm_places.py <region>.osm.pbf", true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();
    if (seq !== osmFetchSeq) return; // a newer request superseded this one
    osmLayer.clearLayers();
    osmLayer.addData(geojson);
  } catch (e) {
    if (seq === osmFetchSeq) setStatus("Error loading OSM places: " + e.message, true);
  }
}

async function refreshCensus() {
  const zoom = map.getZoom();
  if (!censusEnabled || zoom < MIN_ZOOM_FOR_CENSUS) {
    censusLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++censusFetchSeq;
  try {
    const res = await fetch(`/api/geocode/census-places?bbox=${encodeURIComponent(bbox)}`);
    if (res.status === 503) {
      censusLayer.clearLayers();
      setStatus("Census places DB not built — run scripts/get_census_places.py", true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();
    if (seq !== censusFetchSeq) return; // a newer request superseded this one
    censusLayer.clearLayers();
    censusLayer.addData(geojson);
  } catch (e) {
    if (seq === censusFetchSeq) setStatus("Error loading Census places: " + e.message, true);
  }
}

// style/onEachFeature callbacks for the osmLayer L.geoJSON() instance (created
// once in initMap; refreshOsm just swaps the data via clearLayers()/addData()).
function osmFeatureStyle(feature) {
  const color = OSM_CATEGORY_COLORS[feature.properties.category] || "#888";
  return { color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.12 };
}

// Census places: one color, dashed, no fill — they tile the map wall-to-wall, so a
// fill would bury everything under it, and the dashes distinguish a CDP boundary
// from the OSM city boundary it may sit on top of.
function censusFeatureStyle(feature) {
  const isCdp = feature.properties.kind === "CDP";
  return {
    color: isCdp ? "#ffd166" : "#f4a259",
    weight: 2,
    opacity: 0.95,
    dashArray: "6 4",
    fill: false,
  };
}

// Click anywhere on the map to reverse-geocode that exact point the way a photo
// taken there would be, and show what would be persisted. Opens a popup with a
// loading state, then fills it in once /api/geocode/lookup responds.
async function probePoint(e) {
  const { lat, lng } = e.latlng;
  const popup = L.popup({ className: "map-popup-wrap" })
    .setLatLng(e.latlng)
    .setContent(`<div class="map-popup"><div class="map-popup-meta">Geocoding…</div></div>`)
    .openOn(map);
  const seq = ++probeSeq;
  try {
    const res = await fetch(`/api/geocode/lookup?lat=${lat}&lng=${lng}`);
    if (res.status === 503) {
      if (seq === probeSeq) popup.setContent(probeMessage("No geocode data installed"));
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== probeSeq) return; // superseded by a newer click
    popup.setContent(renderProbe(data));
  } catch (err) {
    if (seq === probeSeq) popup.setContent(probeMessage("Error: " + err.message));
  }
}

function probeMessage(msg) {
  return `<div class="map-popup"><div class="map-popup-meta">${escHtml(msg)}</div></div>`;
}

// Header = the resolved place name; the labeled rows below are the exact fields
// that would be written to a photo geotagged at this point (city + OSM
// sub-location, plus GeoNames state/county/country).
function renderProbe(data) {
  const loc = data.location;
  const coords = `${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}`;
  const name = loc && (loc.city || loc.sublocation) ? (loc.city || loc.sublocation) : "(no place resolves here)";
  const fields = loc ? [
    ["Sub-location", loc.sublocation],
    ["City", loc.city],
    ["County", loc.county],
    ["State", loc.state],
    ["Country", loc.country],
    ["Country code", loc.country_code],
  ].filter(([, v]) => v) : [];
  const rows = fields.map(([k, v]) =>
    `<div class="map-popup-field"><span class="map-popup-field-key">${k}</span>${escHtml(v)}</div>`
  ).join("");
  return `<div class="map-popup map-popup-probe">
    <div class="map-popup-name">${escHtml(name)}</div>
    <div class="map-popup-probe-label">Would be saved for a photo here:</div>
    ${rows || `<div class="map-popup-meta">(nothing — no location)</div>`}
    <div class="map-popup-meta">${coords}</div>
  </div>`;
}

function renderVoronoi(cells) {
  voronoiLayer.clearLayers();
  cells.forEach((cell) => {
    const color = cellColor(cell.city || `${cell.lat},${cell.lng}`);
    // One L.polygon per ring rather than one multi-ring polygon: Leaflet reads
    // trailing rings as holes, which is wrong for the disjoint pieces a
    // grid-traced weighted cell can break into.
    (cell.polygons || [cell.polygon]).forEach((ring) => {
      L.polygon(ring, {
        color,
        weight: 1.5,
        opacity: 0.8,
        fillColor: color,
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(voronoiLayer);
    });
  });
}

// Deterministic color per place name/coordinate, so the same place gets the
// same hue across refreshes (helps eyeballing a cell's shape as you pan).
function cellColor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function renderMarkers(places) {
  markerCluster.clearLayers();
  places.forEach((place) => {
    const marker = L.marker([place.lat, place.lng], { icon: placeIcon() });
    marker.bindPopup(renderPopup(place), { className: "map-popup-wrap" });
    markerCluster.addLayer(marker);
  });
}

function placeIcon() {
  return L.divIcon({
    html: `<span class="place-dot"></span>`,
    className: "",
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -6],
  });
}

function renderPopup(place) {
  const region = [place.county, place.state].filter(Boolean).join(", ");
  return `<div class="map-popup">
    <div class="map-popup-name">${escHtml(place.city || "(unnamed)")}</div>
    ${region ? `<div class="map-popup-region">${escHtml(region)}</div>` : ""}
    <div class="map-popup-country">${escHtml(place.country || place.country_code || "")}</div>
    <div class="map-popup-meta">Population: ${place.population.toLocaleString()}</div>
    <div class="map-popup-meta">${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}</div>
  </div>`;
}

function showHint(msg) {
  const el = document.getElementById("map-hint");
  el.textContent = msg;
  el.classList.add("visible");
}

function hideHint() {
  document.getElementById("map-hint").classList.remove("visible");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.className = isError ? "error" : "";
}
