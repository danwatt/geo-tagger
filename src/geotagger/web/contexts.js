/* Contexts screen — draw/manage Life Context polygons */

let map;
let baseTileLayer = null;
let overlayTileLayer = null;
let activeBasemap = "street";

// State
let contexts = [];            // loaded from API
let contextLayers = {};       // context_id -> L.polygon layer
let editingContextId = null;  // null = new, number = editing existing
let drawnPolygon = null;      // current drawn polygon vertices [[lat,lng],...]
let drawLayer = null;         // L.polygon shown while drawing / editing
let selectedContextId = null; // highlighted in sidebar

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
  loadContexts();
});

function initMap() {
  map = L.map("map").setView([20, 0], 2);
  setBasemap("street");
  addBasemapControl();

  // Init Leaflet-Geoman
  map.pm.setGlobalOptions({ snappable: true, snapDistance: 15 });
  map.on("pm:create", onGeomanCreate);
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
  document.getElementById("add-context-btn").addEventListener("click", () => openForm(null));
  document.getElementById("draw-btn").addEventListener("click", startDrawing);
  document.getElementById("form-save-btn").addEventListener("click", saveContext);
  document.getElementById("form-cancel-btn").addEventListener("click", closeForm);
}

/* ── API ── */
async function loadContexts() {
  try {
    const res = await fetch("/api/contexts");
    if (!res.ok) throw new Error(await res.text());
    contexts = await res.json();
    renderSidebar();
    renderMapLayers();
    if (contexts.length) {
      const bounds = [];
      contexts.forEach(c => c.polygon.forEach(v => bounds.push(v)));
      if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.1), { maxZoom: 14 });
    }
  } catch (e) {
    setStatus("Error loading contexts: " + e.message, true);
  }
}

async function saveContext() {
  const name = document.getElementById("form-name").value.trim();
  if (!name) { setStatus("Name is required", true); return; }
  if (!drawnPolygon || drawnPolygon.length < 3) {
    setStatus("Draw a polygon with at least 3 vertices", true);
    return;
  }
  const body = {
    name,
    polygon: drawnPolygon,
    start_date: document.getElementById("form-start").value || null,
    end_date: document.getElementById("form-end").value || null,
  };
  try {
    const url = editingContextId != null
      ? `/api/contexts/${editingContextId}`
      : "/api/contexts";
    const method = editingContextId != null ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || JSON.stringify(data));
    setStatus(editingContextId != null ? "Context updated." : "Context created.");
    closeForm();
    await loadContexts();
  } catch (e) {
    setStatus("Save failed: " + e.message, true);
  }
}

async function deleteContext(id) {
  if (!confirm("Delete this context? This cannot be undone.")) return;
  try {
    const res = await fetch(`/api/contexts/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    setStatus("Context deleted.");
    if (selectedContextId === id) selectedContextId = null;
    await loadContexts();
  } catch (e) {
    setStatus("Delete failed: " + e.message, true);
  }
}

/* ── Rendering ── */
function renderSidebar() {
  const list = document.getElementById("context-list");
  const hint = document.getElementById("no-contexts-hint");
  if (!contexts.length) {
    hint.style.display = "";
    list.innerHTML = "";
    list.appendChild(hint);
    return;
  }
  hint.style.display = "none";
  list.innerHTML = "";
  contexts.forEach(c => {
    const div = document.createElement("div");
    div.className = "context-item" + (c.id === selectedContextId ? " selected" : "");
    div.dataset.id = c.id;

    const dateStr = formatDateRange(c.start_date, c.end_date);
    const count = c.photo_count_approx != null ? `~${c.photo_count_approx} photos` : "";
    const verts = c.polygon.length;

    div.innerHTML = `
      <div class="context-item-name">${escHtml(c.name)}</div>
      <div class="context-item-meta">
        ${dateStr ? escHtml(dateStr) + "<br>" : ""}
        ${verts} vertices${count ? " · " + count : ""}
      </div>
      <div class="context-item-actions">
        <button class="edit-btn">Edit</button>
        <button class="delete-btn">Delete</button>
      </div>`;

    div.querySelector(".edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openForm(c);
    });
    div.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteContext(c.id);
    });
    div.addEventListener("click", () => selectContext(c.id));
    list.appendChild(div);
  });
}

function renderMapLayers() {
  // Remove old layers
  Object.values(contextLayers).forEach(l => map.removeLayer(l));
  contextLayers = {};

  contexts.forEach(c => {
    const latlngs = c.polygon.map(v => [v[0], v[1]]);
    const layer = L.polygon(latlngs, {
      color: "#4a8",
      fillColor: "#4a8",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(map);
    layer.bindTooltip(c.name, { permanent: false, sticky: true });
    layer.on("click", () => selectContext(c.id));
    contextLayers[c.id] = layer;
  });
}

function selectContext(id) {
  selectedContextId = id;
  // Highlight in sidebar
  document.querySelectorAll(".context-item").forEach(el => {
    el.classList.toggle("selected", parseInt(el.dataset.id) === id);
  });
  // Zoom to polygon
  const layer = contextLayers[id];
  if (layer) map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 14 });
}

/* ── Form ── */
function openForm(ctx) {
  editingContextId = ctx ? ctx.id : null;
  drawnPolygon = ctx ? [...ctx.polygon] : null;

  document.getElementById("form-title").textContent = ctx ? "Edit Context" : "New Context";
  document.getElementById("form-name").value = ctx ? ctx.name : "";
  document.getElementById("form-start").value = ctx && ctx.start_date ? ctx.start_date : "";
  document.getElementById("form-end").value = ctx && ctx.end_date ? ctx.end_date : "";

  // Show existing polygon on map
  if (drawLayer) { map.removeLayer(drawLayer); drawLayer = null; }
  if (drawnPolygon && drawnPolygon.length >= 3) {
    drawLayer = L.polygon(drawnPolygon.map(v => [v[0], v[1]]), {
      color: "#fa4", fillColor: "#fa4", fillOpacity: 0.2, weight: 2, dashArray: "6,4",
    }).addTo(map);
  }

  updatePolygonStatus();
  document.getElementById("context-form-panel").classList.add("visible");
}

function closeForm() {
  document.getElementById("context-form-panel").classList.remove("visible");
  // Stop any active drawing
  if (map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
  if (drawLayer) { map.removeLayer(drawLayer); drawLayer = null; }
  editingContextId = null;
  drawnPolygon = null;
  document.getElementById("draw-btn").classList.remove("active");
  document.getElementById("draw-btn").textContent = "Draw polygon";
}

function updatePolygonStatus() {
  const el = document.getElementById("polygon-status");
  const saveBtn = document.getElementById("form-save-btn");
  if (!drawnPolygon || drawnPolygon.length < 3) {
    el.textContent = drawnPolygon ? `${drawnPolygon.length} vertices (need ≥ 3)` : "No polygon drawn";
    el.className = "warn";
    saveBtn.disabled = !document.getElementById("form-name").value.trim() || !drawnPolygon || drawnPolygon.length < 3;
  } else {
    el.textContent = `${drawnPolygon.length} vertices`;
    el.className = "ok";
    saveBtn.disabled = !document.getElementById("form-name").value.trim();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("form-name").addEventListener("input", updatePolygonStatus);
});

/* ── Drawing ── */
function startDrawing() {
  const btn = document.getElementById("draw-btn");
  if (map.pm.globalDrawModeEnabled()) {
    map.pm.disableDraw();
    btn.classList.remove("active");
    btn.textContent = "Draw polygon";
    return;
  }
  // Remove previous draw layer so user starts fresh
  if (drawLayer) { map.removeLayer(drawLayer); drawLayer = null; }
  drawnPolygon = null;
  updatePolygonStatus();

  btn.classList.add("active");
  btn.textContent = "Click to add vertices — finish with double-click";
  map.pm.enableDraw("Polygon", {
    snappable: true,
    snapDistance: 15,
    allowSelfIntersection: false,
    finishOn: "dblclick",
  });
}

function normalizeLng(lng) {
  // Leaflet allows longitudes beyond ±180 when the map is panned across the antimeridian.
  // Wrap back into [-180, 180].
  lng = lng % 360;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return lng;
}

function onGeomanCreate(e) {
  const layer = e.layer;
  // Extract vertices from the created layer
  const latlngs = layer.getLatLngs()[0];
  drawnPolygon = latlngs.map(ll => [ll.lat, normalizeLng(ll.lng)]);

  // Remove the geoman-created layer and replace with our styled one
  map.removeLayer(layer);
  if (drawLayer) map.removeLayer(drawLayer);
  drawLayer = L.polygon(drawnPolygon.map(v => [v[0], v[1]]), {
    color: "#fa4", fillColor: "#fa4", fillOpacity: 0.2, weight: 2, dashArray: "6,4",
  }).addTo(map);

  map.pm.disableDraw();
  const btn = document.getElementById("draw-btn");
  btn.classList.remove("active");
  btn.textContent = "Redraw polygon";

  updatePolygonStatus();
}

/* ── Helpers ── */
function formatDateRange(start, end) {
  if (!start && !end) return "";
  if (start && end) return `${start} → ${end}`;
  if (start) return `from ${start}`;
  return `until ${end}`;
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
