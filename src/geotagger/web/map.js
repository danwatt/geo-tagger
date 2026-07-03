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
 * place's Voronoi cell — the exact area a coordinate must fall in to
 * reverse-geocode to that place — drawn as a translucent colored polygon
 * underneath the markers so you can see where the boundary between two
 * places actually falls.
 *
 * Past MIN_ZOOM_FOR_LANDMARKS, /api/geocode/landmarks additionally supplies
 * named landmarks fetched from Overture Maps (scripts/get_overture_landmarks.py):
 * park/building polygons plus curated POI points (monuments, stadiums, etc).
 */

const MIN_ZOOM_FOR_MARKERS = 8;
const MIN_ZOOM_FOR_VORONOI = 11;
const MIN_ZOOM_FOR_LANDMARKS = 11;
const REFRESH_DEBOUNCE_MS = 250;

let map;
let baseTileLayer = null;
let overlayTileLayer = null;
let activeBasemap = "street";
let markerCluster = null;
let voronoiLayer = null;
let voronoiEnabled = true;
let landmarkLayer = null;
let landmarkEnabled = true;
let refreshTimer = null;
let fetchSeq = 0;
let voronoiFetchSeq = 0;
let landmarkFetchSeq = 0;

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

  const landmarkToggle = document.getElementById("landmark-toggle");
  landmarkToggle.addEventListener("change", () => {
    landmarkEnabled = landmarkToggle.checked;
    refreshLandmarks();
  });
});

function initMap() {
  map = L.map("map").setView([20, 0], 2);
  setBasemap("street");
  addBasemapControl();

  // Added before the marker layer so cell/landmark polygons render underneath markers.
  voronoiLayer = L.layerGroup().addTo(map);
  landmarkLayer = L.layerGroup().addTo(map);
  markerCluster = L.markerClusterGroup({ maxClusterRadius: 60 });
  map.addLayer(markerCluster);

  map.on("moveend zoomend", scheduleRefresh);
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
  refreshLandmarks();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshMarkers();
    refreshVoronoi();
    refreshLandmarks();
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

function renderVoronoi(cells) {
  voronoiLayer.clearLayers();
  cells.forEach((cell) => {
    const color = cellColor(cell.city || `${cell.lat},${cell.lng}`);
    L.polygon(cell.polygon, {
      color,
      weight: 1.5,
      opacity: 0.8,
      fillColor: color,
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(voronoiLayer);
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

async function refreshLandmarks() {
  const zoom = map.getZoom();
  if (!landmarkEnabled || zoom < MIN_ZOOM_FOR_LANDMARKS) {
    landmarkLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++landmarkFetchSeq;
  try {
    const res = await fetch(`/api/geocode/landmarks?bbox=${encodeURIComponent(bbox)}`);
    if (!res.ok) return; // e.g. 503 when landmark data isn't fetched yet — best-effort overlay
    const data = await res.json();
    if (seq !== landmarkFetchSeq) return; // a newer request superseded this one
    renderLandmarks(data.polygons, data.points);
  } catch (e) {
    // best-effort visual overlay; the marker fetch already reports errors
  }
}

const LANDMARK_COLORS = { building: "#7ab8f5", park: "#5fbf6e" };

function renderLandmarks(polygons, points) {
  landmarkLayer.clearLayers();
  polygons.forEach((feature) => {
    const color = LANDMARK_COLORS[feature.kind] || "#e0a040";
    L.polygon(feature.polygon, {
      color,
      weight: 1.5,
      opacity: 0.9,
      fillColor: color,
      fillOpacity: 0.2,
    }).bindPopup(renderLandmarkPopup(feature), { className: "map-popup-wrap" })
      .addTo(landmarkLayer);
  });
  points.forEach((feature) => {
    L.marker([feature.lat, feature.lng], { icon: landmarkIcon() })
      .bindPopup(renderLandmarkPopup(feature), { className: "map-popup-wrap" })
      .addTo(landmarkLayer);
  });
}

function landmarkIcon() {
  return L.divIcon({
    html: `<span class="landmark-dot"></span>`,
    className: "",
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -6],
  });
}

function renderLandmarkPopup(feature) {
  return `<div class="map-popup">
    <div class="map-popup-name">${escHtml(feature.name)}</div>
    <div class="map-popup-region">${escHtml(feature.kind)}${feature.category ? " · " + escHtml(feature.category) : ""}</div>
  </div>`;
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
