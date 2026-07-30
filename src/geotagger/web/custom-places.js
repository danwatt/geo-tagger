/* Custom Places screen — draw/manage saved rectangles & circles.
   These are stored in our own DB (separate from GeoNames/OSM) via /api/places
   and selectable as jump targets on the Geocode page. */

let map;
let baseTileLayer = null;
let overlayTileLayer = null;
let activeBasemap = "street";

// State
let places = [];            // loaded from /api/places
let placeShapes = {};       // place_id -> L.Rectangle | L.Circle
let selectedPlaceId = null; // highlighted in sidebar

let drawingMode = null;     // null | "rectangle" | "circle"
let drawingShape = null;    // temporary shape being drawn
let drawStartLatLng = null;

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

/* ── Init ── */
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindToolbar();
  loadPlaces();
});

function initMap() {
  map = L.map("map").setView([20, 0], 2);
  setBasemap("street");
  addBasemapControl();
  map.on("moveend", correctWorldWrap);
}

// See map.js — keeps the map's own center from drifting past ±180 when
// panning continuously across the antimeridian, which would otherwise render
// canonical shapes a full world-width off screen.
function correctWorldWrap() {
  const center = map.getCenter();
  const wrapped = map.wrapLatLng(center);
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

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("draw-rectangle-btn").addEventListener("click", () => startDrawing("rectangle"));
  document.getElementById("draw-circle-btn").addEventListener("click", () => startDrawing("circle"));
}

/* ── API ── */
async function loadPlaces() {
  try {
    const res = await fetch("/api/places");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    places = await res.json();
    renderSidebar();
    renderPlaces();
  } catch (e) {
    setStatus("Failed to load places: " + e.message, true);
  }
}

/* ── Rendering ── */
function renderSidebar() {
  const list = document.getElementById("place-list");
  const hint = document.getElementById("no-places-hint");
  if (!places.length) {
    list.innerHTML = "";
    hint.style.display = "";
    list.appendChild(hint);
    return;
  }
  hint.style.display = "none";
  list.innerHTML = "";
  places.forEach(p => {
    const div = document.createElement("div");
    div.className = "place-item" + (p.id === selectedPlaceId ? " selected" : "");
    div.dataset.id = p.id;

    // Representative photo (set from the Geo page's right-click menu) shown as a
    // thumbnail, with a Clear action when present.
    const repThumb = p.representative_photo_id
      ? `<img class="place-rep-thumb" src="/api/thumbnail/${p.representative_photo_id}"
             alt="Representative photo" title="Representative photo"/>`
      : "";
    const clearRepBtn = p.representative_photo_id
      ? `<button class="clear-rep-btn" title="Remove representative photo">Clear photo</button>`
      : "";

    div.innerHTML = `
      <div class="place-item-name">${escHtml(p.name)}</div>
      <div class="place-item-meta">${p.type}</div>
      ${repThumb}
      <div class="place-item-actions">
        <button class="zoom-btn">Zoom</button>
        <button class="rename-btn">Rename</button>
        ${clearRepBtn}
        <button class="delete-btn">Delete</button>
      </div>`;

    div.querySelector(".zoom-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectPlace(p.id);
    });
    div.querySelector(".rename-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      renamePlace(p);
    });
    div.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeletePlace(p);
    });
    const clearBtn = div.querySelector(".clear-rep-btn");
    if (clearBtn) clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearRepresentative(p);
    });
    div.addEventListener("click", () => selectPlace(p.id));
    list.appendChild(div);
  });
}

function renderPlaces() {
  Object.values(placeShapes).forEach(shape => map.removeLayer(shape));
  placeShapes = {};

  places.forEach(p => {
    const bounds = JSON.parse(p.bounds);
    let shape;

    if (p.type === "rectangle") {
      shape = L.rectangle([[bounds.south, bounds.west], [bounds.north, bounds.east]], {
        color: "#4a90d9", weight: 2, fillOpacity: 0.1, draggable: true,
      });
    } else if (p.type === "circle") {
      shape = L.circle([bounds.lat, bounds.lng], {
        radius: bounds.radius, color: "#4a90d9", weight: 2, fillOpacity: 0.1, draggable: true,
      });
    }

    if (shape) {
      shape.bindTooltip(p.name, { permanent: false, direction: "top" });
      shape.on("click", () => selectPlace(p.id));
      shape.on("dragend", () => updatePlaceBounds(p));
      shape.addTo(map);
      placeShapes[p.id] = shape;
    }
  });
}

function selectPlace(placeId) {
  selectedPlaceId = placeId;
  document.querySelectorAll(".place-item").forEach(el => {
    el.classList.toggle("selected", parseInt(el.dataset.id) === placeId);
  });
  const shape = placeShapes[placeId];
  if (!shape) return;
  if (shape.getBounds) {
    map.fitBounds(shape.getBounds().pad(0.2), { maxZoom: 15 });
  }
}

async function updatePlaceBounds(place) {
  const shape = placeShapes[place.id];
  if (!shape) return;

  let boundsData;
  if (place.type === "rectangle") {
    const b = shape.getBounds();
    boundsData = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  } else if (place.type === "circle") {
    const c = shape.getLatLng();
    boundsData = { lat: c.lat, lng: c.lng, radius: shape.getRadius() };
  }

  try {
    const res = await fetch(`/api/places/${place.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bounds: JSON.stringify(boundsData) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.bounds = JSON.stringify(boundsData);
    setStatus(`Updated "${place.name}"`);
  } catch (err) {
    setStatus("Failed to update place: " + err.message, true);
    await loadPlaces();  // snap shape back to saved bounds
  }
}

async function renamePlace(place) {
  const name = prompt(`Rename "${place.name}" to:`, place.name);
  if (name === null) return;               // cancelled
  const trimmed = name.trim();
  if (!trimmed || trimmed === place.name) return;

  try {
    const res = await fetch(`/api/places/${place.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.name = trimmed;
    setStatus(`Renamed to "${trimmed}"`);
    renderSidebar();
    renderPlaces();
  } catch (err) {
    setStatus("Failed to rename place: " + err.message, true);
  }
}

async function clearRepresentative(place) {
  try {
    const res = await fetch(`/api/places/${place.id}/representative`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_id: null }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.representative_photo_id = null;
    setStatus(`Cleared representative photo for "${place.name}"`);
    renderSidebar();
  } catch (err) {
    setStatus("Failed to clear representative: " + err.message, true);
  }
}

async function confirmDeletePlace(place) {
  if (!confirm(`Delete place "${place.name}"?`)) return;
  try {
    const res = await fetch(`/api/places/${place.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Place "${place.name}" deleted`);
    if (selectedPlaceId === place.id) selectedPlaceId = null;
    await loadPlaces();
  } catch (err) {
    setStatus("Error deleting place: " + err.message, true);
  }
}

/* ── Drawing (click-drag rectangle/circle) ── */
function startDrawing(type) {
  if (drawingMode) stopDrawing();

  drawingMode = type;
  document.getElementById(`draw-${type}-btn`).classList.add("active");
  setStatus(`Drawing ${type}… click, hold and drag to set size, then release`);
  map.getContainer().style.cursor = "crosshair";
  map.dragging.disable();
  map.once("mousedown", onDrawStart);
}

function stopDrawing() {
  document.querySelectorAll("#draw-rectangle-btn, #draw-circle-btn")
    .forEach(b => b.classList.remove("active"));
  drawingMode = null;
  map.getContainer().style.cursor = "";
  map.off("mousedown", onDrawStart);
  map.off("mousemove", onDrawMove);
  map.off("mouseup", onDrawEnd);
  map.dragging.enable();
  if (drawingShape) { map.removeLayer(drawingShape); drawingShape = null; }
}

function onDrawStart(e) {
  drawStartLatLng = e.latlng;
  if (drawingMode === "rectangle") {
    drawingShape = L.rectangle([e.latlng, e.latlng], {
      color: "#e0a040", weight: 2, fillOpacity: 0.2,
    }).addTo(map);
  } else if (drawingMode === "circle") {
    drawingShape = L.circle(e.latlng, {
      radius: 0, color: "#e0a040", weight: 2, fillOpacity: 0.2,
    }).addTo(map);
  }
  map.on("mousemove", onDrawMove);
  map.once("mouseup", onDrawEnd);
}

function onDrawMove(e) {
  if (!drawingShape || !drawStartLatLng) return;
  if (drawingMode === "rectangle") {
    drawingShape.setBounds([drawStartLatLng, e.latlng]);
  } else if (drawingMode === "circle") {
    drawingShape.setRadius(drawStartLatLng.distanceTo(e.latlng));
  }
}

async function onDrawEnd(e) {
  map.off("mousemove", onDrawMove);

  if (!drawingShape || !drawStartLatLng) { stopDrawing(); return; }

  // Minimum size guard
  let tooSmall = false;
  if (drawingMode === "rectangle") {
    const b = drawingShape.getBounds();
    const width = Math.abs(b.getEast() - b.getWest());
    const height = Math.abs(b.getNorth() - b.getSouth());
    tooSmall = width < 0.00003 || height < 0.00003;  // ~3.3m at equator
  } else if (drawingMode === "circle") {
    tooSmall = drawingShape.getRadius() < 2;  // 2m minimum
  }
  if (tooSmall) {
    alert("Shape is too small. Please drag to create a larger shape.");
    stopDrawing();
    return;
  }

  const name = prompt(`Name this ${drawingMode}:`);
  if (!name) { stopDrawing(); return; }

  let boundsData;
  if (drawingMode === "rectangle") {
    const b = drawingShape.getBounds();
    boundsData = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  } else if (drawingMode === "circle") {
    const c = drawingShape.getLatLng();
    boundsData = { lat: c.lat, lng: c.lng, radius: drawingShape.getRadius() };
  }

  const type = drawingMode;  // stopDrawing() clears drawingMode
  try {
    const res = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type, bounds: JSON.stringify(boundsData) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Place "${name}" saved`);
    stopDrawing();
    await loadPlaces();
  } catch (err) {
    setStatus("Error saving place: " + err.message, true);
    stopDrawing();
  }
}

/* ── Helpers ── */
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
