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
  map.on("moveend", onMapMovedForHotspots);
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

  const chk = document.getElementById("show-hotspots-chk");
  const controls = document.getElementById("hotspot-controls");
  const sort = document.getElementById("hotspot-sort");
  const inView = document.getElementById("hotspot-in-view-chk");
  chk.addEventListener("change", () => {
    showHotspots = chk.checked;
    controls.style.display = showHotspots ? "" : "none";
    if (showHotspots) loadHotspots(); else clearHotspots();
  });
  sort.addEventListener("change", () => {
    hotspotSort = sort.value;
    if (showHotspots) loadHotspots();
  });
  inView.addEventListener("change", () => {
    hotspotInView = inView.checked;
    if (showHotspots) loadHotspots();
  });

  document.getElementById("rep-picker-close").addEventListener("click", closeRepPicker);
  document.getElementById("rep-picker-done").addEventListener("click", closeRepPicker);
  document.getElementById("rep-picker-modal").addEventListener("click", (e) => {
    if (e.target.id === "rep-picker-modal") closeRepPicker();
  });
  document.getElementById("rep-picker-clear").addEventListener("click", () => {
    const place = repPickerPlace;
    closeRepPicker();
    if (place) clearRepresentative(place);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRepPicker();
  });
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
  // The hint is re-created rather than hidden and kept: it lives *inside* the
  // list, so the innerHTML reset below destroys it, and a second render would
  // otherwise reach for a node that no longer exists.
  list.innerHTML = "";
  if (!places.length) {
    list.innerHTML = `<div id="no-places-hint">No places yet — draw a rectangle
      or circle on the map.</div>`;
    return;
  }
  places.forEach(p => {
    const div = document.createElement("div");
    div.className = "place-item" + (p.id === selectedPlaceId ? " selected" : "");
    div.dataset.id = p.id;

    // Representative photo (set from the Geo page's right-click menu) shown as a
    // thumbnail, with a Clear action when present.
    const repThumb = p.representative_photo_id
      ? `<img class="place-rep-thumb" src="/api/thumbnail/${p.representative_photo_id}"
             alt="Representative photo" title="Click to choose a different photo"/>`
      : `<button class="rep-empty" title="Choose a representative photo from the photos taken here">
           🖼 Choose a photo
         </button>`;
    const clearRepBtn = p.representative_photo_id
      ? `<button class="clear-rep-btn" title="Remove representative photo">Clear photo</button>`
      : "";

    div.innerHTML = `
      <div class="place-item-name">${escHtml(p.name)}</div>
      <div class="place-item-meta">${placeMeta(p)}</div>
      ${repThumb}
      <div class="place-item-actions">
        <button class="zoom-btn">Zoom</button>
        <button class="rename-btn">Rename</button>
        ${clearRepBtn}
        <button class="delete-btn">Delete</button>
      </div>`;

    // The thumbnail (or its placeholder button) is the way into the picker.
    div.querySelector(".place-rep-thumb, .rep-empty").addEventListener("click", (e) => {
      e.stopPropagation();
      openRepPicker(p);
    });

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

    // No `draggable` here: core Leaflet ignores it on a path. Circles are moved
    // and resized by the handles below; rectangles are on their way out.
    if (p.type === "rectangle") {
      shape = L.rectangle([[bounds.south, bounds.west], [bounds.north, bounds.east]], {
        color: "#4a90d9", weight: 2, fillOpacity: 0.1,
      });
    } else if (p.type === "circle") {
      shape = L.circle([bounds.lat, bounds.lng], {
        radius: bounds.radius, color: "#4a90d9", weight: 2, fillOpacity: 0.1,
      });
    }

    if (shape) {
      shape.bindTooltip(p.name, { permanent: false, direction: "top" });
      shape.on("click", () => selectPlace(p.id));
      shape.addTo(map);
      placeShapes[p.id] = shape;
    }
  });

  // The shapes were just rebuilt, so the old handles point at layers that are
  // no longer on the map.
  clearCircleHandles();
  const selected = places.find(p => p.id === selectedPlaceId);
  if (selected) showCircleHandles(selected);
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
  showCircleHandles(places.find(p => p.id === placeId));
}

/* ── Moving and resizing a circle ──
 * The selected circle gets two draggable markers: a round one on the centre that
 * moves it, and a square one on the eastern edge whose distance from that centre
 * *is* the radius. Markers, not the path itself — core Leaflet only drags
 * markers; `draggable: true` on an L.circle needs the Leaflet.Path.Drag plugin,
 * which this app doesn't load.
 *
 * Both handles write through updatePlaceBounds, which reads the live shape, so
 * there's one save path however the shape got where it is.
 *
 * Rectangles are deliberately left alone — they're being phased out. */

const MIN_RADIUS_M = 2;          // same floor the draw tool enforces
const METERS_PER_DEG_LAT = 111320;

let moveHandle = null;
let radiusHandle = null;

function circleRadius(place) {
  try {
    const b = JSON.parse(place.bounds);
    return typeof b.radius === "number" ? b.radius : 0;
  } catch (err) {
    return 0;
  }
}

function formatRadius(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 2)} km`;
  return `${Math.round(m)} m`;
}

function placeMeta(place) {
  return place.type === "circle"
    ? `circle · ${formatRadius(circleRadius(place))}` : place.type;
}

// Due east of the centre at `radius` metres. The cosine is floored so a place
// near a pole can't divide the offset up to infinity.
function edgeLatLng(center, radius) {
  const cos = Math.max(1e-6, Math.cos(center.lat * Math.PI / 180));
  return L.latLng(center.lat, center.lng + radius / (METERS_PER_DEG_LAT * cos));
}

function clearCircleHandles() {
  [moveHandle, radiusHandle].forEach(h => { if (h) map.removeLayer(h); });
  moveHandle = null;
  radiusHandle = null;
}

function showCircleHandles(place) {
  clearCircleHandles();
  if (!place || place.type !== "circle") return;
  const shape = placeShapes[place.id];
  if (!shape || !shape.getRadius) return;

  const handle = (latlng, className, tooltip, direction) => L.marker(latlng, {
    draggable: true,
    icon: L.divIcon({ className, html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
    zIndexOffset: 1000,
  }).addTo(map).bindTooltip(tooltip, { direction });

  moveHandle = handle(shape.getLatLng(), "move-handle", "Drag to move", "left");
  radiusHandle = handle(edgeLatLng(shape.getLatLng(), shape.getRadius()),
                        "radius-handle", formatRadius(shape.getRadius()), "right");

  // Move: the circle follows the centre handle, and the edge handle rides along
  // so the radius it reports doesn't lie mid-drag.
  moveHandle.on("drag", () => {
    const c = moveHandle.getLatLng();
    shape.setLatLng(c);
    radiusHandle.setLatLng(edgeLatLng(c, shape.getRadius()));
  });
  moveHandle.on("dragend", () => updatePlaceBounds(place));

  // Resize: dragging anywhere works — it's the distance from the centre that
  // counts, not staying on the ring — so the handle only snaps back due east
  // once released. The centre is read live, since the move handle may have
  // shifted it since this listener was wired.
  radiusHandle.on("drag", () => {
    const c = shape.getLatLng();
    const r = Math.max(MIN_RADIUS_M, c.distanceTo(radiusHandle.getLatLng()));
    shape.setRadius(r);
    radiusHandle.setTooltipContent(formatRadius(r));
    updateRadiusMeta(place, r);
  });
  radiusHandle.on("dragend", async () => {
    radiusHandle.setLatLng(edgeLatLng(shape.getLatLng(), shape.getRadius()));
    await updatePlaceBounds(place);
  });
}

// Keep the sidebar's size text in step with a drag without re-rendering the
// list — a re-render on every mousemove would fight the drag.
function updateRadiusMeta(place, radius) {
  const meta = document.querySelector(`.place-item[data-id="${place.id}"] .place-item-meta`);
  if (meta) meta.textContent = `circle · ${formatRadius(radius)}`;
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
    setStatus(place.type === "circle"
      ? `Updated "${place.name}" — radius ${formatRadius(boundsData.radius)}`
      : `Updated "${place.name}"`);
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

/* ── Representative photo picker ──
 * A place's representative photo is picked from the photos taken inside it —
 * that's the whole candidate set, so the picker is just those photos in a grid.
 * Newest first: the most recent visit is usually the one you remember.
 *
 * Bounds are the box the R*Tree query understands; a circle then gets an exact
 * distance pass client-side, since its bounding box overshoots the corners by
 * ~40%, which at a 5 km place is a lot of photos from down the road. */

const REP_PICKER_LIMIT = 200;

let repPickerPlace = null;

function placeBbox(place) {
  const b = JSON.parse(place.bounds);
  if (place.type === "rectangle") {
    return { min_lat: b.south, max_lat: b.north, min_lng: b.west, max_lng: b.east };
  }
  const latOff = b.radius / METERS_PER_DEG_LAT;
  const lngOff = b.radius / (METERS_PER_DEG_LAT * Math.max(1e-6, Math.cos(b.lat * Math.PI / 180)));
  return {
    min_lat: b.lat - latOff, max_lat: b.lat + latOff,
    min_lng: b.lng - lngOff, max_lng: b.lng + lngOff,
  };
}

function photosInsidePlace(place, photosList) {
  if (place.type !== "circle") return photosList;
  const b = JSON.parse(place.bounds);
  const center = L.latLng(b.lat, b.lng);
  return photosList.filter(p => center.distanceTo(L.latLng(p.lat, p.lng)) <= b.radius);
}

async function openRepPicker(place) {
  repPickerPlace = place;
  const modal = document.getElementById("rep-picker-modal");
  const grid = document.getElementById("rep-picker-grid");
  document.getElementById("rep-picker-title").textContent = `Representative photo — ${place.name}`;
  document.getElementById("rep-picker-clear").style.display =
    place.representative_photo_id ? "" : "none";
  grid.innerHTML = `<div class="rep-picker-empty">Loading photos taken here…</div>`;
  modal.style.display = "";

  const box = placeBbox(place);
  // geotagged=yes + window=0: only photos actually located here, not the untagged
  // time-neighbours by-bounds folds in for the geocode page's benefit.
  const params = new URLSearchParams({ ...box, geotagged: "yes", window: "0" });
  try {
    const res = await fetch(`/api/photos/by-bounds?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const inside = photosInsidePlace(place, await res.json());
    inside.reverse();                      // the endpoint sorts oldest-first
    renderRepPicker(inside.slice(0, REP_PICKER_LIMIT), inside.length);
  } catch (err) {
    grid.innerHTML = `<div class="rep-picker-empty">Couldn't load photos: ${escHtml(err.message)}</div>`;
  }
}

function renderRepPicker(shown, total) {
  const grid = document.getElementById("rep-picker-grid");
  grid.innerHTML = "";
  if (!shown.length) {
    grid.innerHTML = `<div class="rep-picker-empty">No geotagged photos inside this place yet.
      Tag some on the Geocode page, or widen the circle.</div>`;
    return;
  }

  shown.forEach(photo => {
    const cell = document.createElement("button");
    cell.className = "rep-picker-cell" +
      (photo.id === repPickerPlace.representative_photo_id ? " selected" : "");
    cell.title = photo.filename;
    cell.innerHTML = `<img src="/api/thumbnail/${photo.id}" loading="lazy" alt=""/>`;
    cell.addEventListener("click", () => setRepresentative(repPickerPlace, photo.id));
    grid.appendChild(cell);
  });

  if (total > shown.length) {
    const note = document.createElement("div");
    note.className = "rep-picker-note";
    note.textContent = `Showing the ${shown.length} most recent of ${total} photos here.`;
    grid.appendChild(note);
  }
}

function closeRepPicker() {
  document.getElementById("rep-picker-modal").style.display = "none";
  repPickerPlace = null;
}

async function setRepresentative(place, photoId) {
  try {
    const res = await fetch(`/api/places/${place.id}/representative`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_id: photoId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.representative_photo_id = photoId;
    setStatus(`Set the representative photo for "${place.name}"`);
    closeRepPicker();
    renderSidebar();
  } catch (err) {
    setStatus("Failed to set representative: " + err.message, true);
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
    // Whatever this place was covering is an unnamed hotspot again.
    if (showHotspots) await loadHotspots();
  } catch (err) {
    setStatus("Error deleting place: " + err.message, true);
  }
}

/* ── Hotspots ──
 * The places you keep tagging at but never named. /api/geotag/hotspots mines
 * them from the coordinates already on the photos and clusters them, so drops a
 * few hundred feet apart at one real place count as one entry. Shown here only
 * on request, because they are noise once the ones worth keeping are named.
 *
 * A hotspot is already the shape of a named place — a point you come back to —
 * so promoting one is a name away, and beats redrawing it by hand. It saves as
 * a circle at the server's own cluster merge radius: any smaller and drops the
 * server considers the same place would fall outside the shape.
 *
 * hide_named=true means a hotspot a saved place already covers isn't returned,
 * so naming one makes it leave this list on the next load — that disappearance
 * is the confirmation. */

let hotspots = [];
let hotspotShapes = [];
let hotspotSort = "count";
let showHotspots = false;
let hotspotInView = false;    // narrow the list to the map's current view
let hotspotTotal = 0;         // how many matched before the server's limit slice
let hotspotMoveTimer = null;
let selectedHotspotKey = null;   // highlighted row, identified by its coordinate

const hotspotKey = (h) => `${h.lat.toFixed(5)},${h.lng.toFixed(5)}`;
// Overwritten from the API's own merge_meters, so the drawn shape can't drift
// out of step with the clustering it came from.
let hotspotRadius = 100;

const HOTSPOT_LIMIT = 60;

// The map's view as the API's four bounds, or null for "don't filter". Leaflet
// reports longitudes outside ±180 once you pan past the antimeridian, so they're
// wrapped back — a view straddling it then arrives as min_lng > max_lng, which
// hotspots_service.in_bbox reads as a wrapped box.
function viewBbox() {
  const b = map.getBounds();
  if (b.getEast() - b.getWest() >= 360) return null;   // whole world in view
  const wrap = (lng) => ((lng + 180) % 360 + 360) % 360 - 180;
  return {
    min_lat: Math.max(-90, b.getSouth()),
    max_lat: Math.min(90, b.getNorth()),
    min_lng: wrap(b.getWest()),
    max_lng: wrap(b.getEast()),
  };
}

async function loadHotspots() {
  const list = document.getElementById("hotspot-list");
  document.getElementById("hotspot-section").style.display = "";
  if (!hotspots.length) list.innerHTML = `<div class="hotspot-empty">Loading…</div>`;

  const params = new URLSearchParams({
    limit: String(HOTSPOT_LIMIT), hide_named: "true", sort: hotspotSort,
  });
  const box = hotspotInView ? viewBbox() : null;
  if (box) Object.entries(box).forEach(([k, v]) => params.set(k, v));

  try {
    const res = await fetch(`/api/geotag/hotspots?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hotspots = data.hotspots || [];
    hotspotTotal = data.total ?? hotspots.length;
    if (data.merge_meters) hotspotRadius = data.merge_meters;
    renderHotspots();
  } catch (err) {
    hotspots = [];
    renderHotspotShapes();
    list.innerHTML = `<div class="hotspot-empty">Couldn't load hotspots: ${escHtml(err.message)}</div>`;
    document.getElementById("hotspot-count").textContent = "";
  }
}

// Panning is continuous and the query is a full clustering pass, so the refresh
// waits for the map to settle rather than firing on every frame of a drag.
function onMapMovedForHotspots() {
  if (!showHotspots || !hotspotInView) return;
  clearTimeout(hotspotMoveTimer);
  hotspotMoveTimer = setTimeout(loadHotspots, 350);
}

function clearHotspots() {
  hotspots = [];
  renderHotspotShapes();
  document.getElementById("hotspot-section").style.display = "none";
}

function renderHotspots() {
  renderHotspotShapes();
  renderHotspotSidebar();
}

function renderHotspotShapes() {
  hotspotShapes.forEach(s => map.removeLayer(s));
  hotspotShapes = [];
  if (!showHotspots) return;

  hotspots.forEach((h, i) => {
    // L.circle, not L.circleMarker — the ring is metres on the ground, and it is
    // exactly the shape the place would be saved as.
    const circle = L.circle([h.lat, h.lng], {
      radius: hotspotRadius,
      color: "#e0a040", weight: 2, fillOpacity: 0.12, dashArray: "5,4",
    });
    circle.bindTooltip(`${h.label} · ${h.count} photo${h.count !== 1 ? "s" : ""}`,
                       { direction: "top" });
    circle.on("click", () => selectHotspot(i));
    circle.addTo(map);
    hotspotShapes.push(circle);
  });
}

function renderHotspotSidebar() {
  const list = document.getElementById("hotspot-list");
  const count = document.getElementById("hotspot-count");
  list.innerHTML = "";
  // "40 of 112" when the server's limit cut the list short, so a short list in a
  // busy area doesn't read as the whole truth.
  count.textContent = !hotspots.length ? ""
    : (hotspotTotal > hotspots.length ? `${hotspots.length} of ${hotspotTotal}` : `${hotspots.length}`)
      + (hotspotInView ? " in view" : "");

  if (!hotspots.length) {
    list.innerHTML = hotspotInView
      ? `<div class="hotspot-empty">No unnamed hotspots in this view — pan or zoom out,
         or untick "Only in view".</div>`
      : `<div class="hotspot-empty">Nothing unnamed left — every recurring
         spot in your photos is already covered by a place above.</div>`;
    return;
  }

  hotspots.forEach((h, i) => {
    const div = document.createElement("div");
    div.className = "hotspot-item";
    div.dataset.idx = i;

    const thumb = h.sample_photo_id
      ? `<img class="hotspot-thumb" src="/api/thumbnail/${h.sample_photo_id}"
             alt="" title="A photo tagged here"/>`
      : "";

    div.innerHTML = `
      ${thumb}
      <div class="hotspot-body">
        <div class="hotspot-label">${escHtml(h.label)}</div>
        <div class="hotspot-meta">${h.count} photo${h.count !== 1 ? "s" : ""}${
          h.last_ts ? ` · last ${new Date(h.last_ts * 1000).toLocaleDateString()}` : ""}</div>
        <div class="hotspot-actions">
          <button class="zoom-btn">Zoom</button>
          <button class="name-btn primary">✏️ Name it…</button>
        </div>
      </div>`;

    div.querySelector(".zoom-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectHotspot(i);
    });
    div.querySelector(".name-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      savePlaceFromHotspot(h);
    });
    div.addEventListener("click", () => selectHotspot(i));
    list.appendChild(div);
  });

  markSelectedHotspot();
}

function selectHotspot(idx) {
  const h = hotspots[idx];
  // Zooming fires moveend, which in "only in view" mode reloads and re-renders
  // the list — so the highlight is remembered by coordinate, not by row index.
  selectedHotspotKey = h ? hotspotKey(h) : null;
  markSelectedHotspot();
  const shape = hotspotShapes[idx];
  if (shape) map.fitBounds(shape.getBounds().pad(0.6), { maxZoom: 17 });
}

function markSelectedHotspot() {
  document.querySelectorAll(".hotspot-item").forEach(el => {
    const h = hotspots[Number(el.dataset.idx)];
    el.classList.toggle("selected", !!h && hotspotKey(h) === selectedHotspotKey);
  });
}

// The geocoded label is only a suggestion — it names the neighbourhood, not the
// place ("Elm St, Springfield" for what you'd call "Mom's house"), so the prompt
// starts there and expects to be typed over.
async function savePlaceFromHotspot(h) {
  const name = prompt("Name this place:", h.label);
  if (name === null) return;                 // cancelled
  const trimmed = name.trim();
  if (!trimmed) { setStatus("A place needs a name.", true); return; }

  const bounds = { lat: h.lat, lng: h.lng, radius: hotspotRadius };
  try {
    const res = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed, type: "circle", bounds: JSON.stringify(bounds) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPlaces();
    if (showHotspots) await loadHotspots();  // this hotspot is covered now — it goes
    setStatus(`Saved "${trimmed}" as a place (${Math.round(hotspotRadius)} m radius).`);
  } catch (err) {
    setStatus("Could not save place: " + err.message, true);
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
