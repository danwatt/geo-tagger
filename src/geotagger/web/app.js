/* ── State ── */
let photos = [];
let selectedIds = new Set();
let lastClickedIndex = -1;
let markersById = {};
let focusedPhotoId = null;
let map;

/* ── Camera colors ── */
const CAM_PALETTE = [
  "#e05c5c", // red
  "#e0a040", // amber
  "#d4d43a", // yellow
  "#5cb85c", // green
  "#3ab8b8", // teal
  "#4a90d9", // blue
  "#9b5ce0", // purple
  "#e05cbc", // pink
  "#e07840", // orange
  "#7ab85c", // lime
];
const camColorMap = {};   // camera string -> hex color
let camPaletteCursor = 0;
let hiddenCameras = new Set();

function camColor(camera) {
  const key = camera || "Unknown";
  if (!camColorMap[key]) {
    camColorMap[key] = CAM_PALETTE[camPaletteCursor % CAM_PALETTE.length];
    camPaletteCursor++;
  }
  return camColorMap[key];
}

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  bindToolbar();
  await checkStatus();
});

async function checkStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (!data.ok) {
      setStatus("⚠ ExifTool not found — run: uv run python scripts/get_exiftool.py  |  " + data.error, true);
    }
  } catch (e) {
    // server not yet ready
  }
}

function initMap() {
  map = L.map("map").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);

  const mapPane = document.getElementById("map-pane");

  mapPane.addEventListener("dragover", (e) => {
    e.preventDefault();
    mapPane.classList.add("drop-target");
  });
  mapPane.addEventListener("dragleave", () => mapPane.classList.remove("drop-target"));
  mapPane.addEventListener("drop", async (e) => {
    e.preventDefault();
    mapPane.classList.remove("drop-target");
    const ids = JSON.parse(e.dataTransfer.getData("application/json") || "[]");
    if (!ids.length) return;
    const rect = document.getElementById("map").getBoundingClientRect();
    const point = L.point(e.clientX - rect.left, e.clientY - rect.top);
    const latlng = map.containerPointToLatLng(point);
    await geotag(ids, latlng.lat, latlng.lng);
  });
}

function bindToolbar() {
  document.getElementById("scan-btn").addEventListener("click", doScan);
  document.getElementById("dir-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doScan();
  });
  document.getElementById("filter-select").addEventListener("change", () => loadPhotos());
  document.getElementById("place-search-btn").addEventListener("click", doPlaceSearch);
  document.getElementById("place-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doPlaceSearch();
  });
  document.getElementById("apply-latlng-btn").addEventListener("click", doApplyLatLng);
  document.getElementById("copy-location-btn").addEventListener("click", doCopyLocation);
  document.getElementById("remove-geotag-btn").addEventListener("click", doRemoveGeotag);
}

/* ── Scan ── */
async function doScan() {
  const dir = document.getElementById("dir-input").value.trim();
  if (!dir) return;
  setStatus("Scanning…");
  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: dir }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    setStatus(`Scanned ${data.count} files. ${data.warnings.length ? data.warnings.join(" | ") : ""}`);
    await loadPhotos();
  } catch (err) {
    setStatus("Scan error: " + err.message, true);
  }
}

/* ── Load photos ── */
async function loadPhotos() {
  const filter = document.getElementById("filter-select").value;
  try {
    const res = await fetch(`/api/photos?geotagged=${filter}`);
    photos = await res.json();
    // Pre-assign colors so the legend order is stable
    photos.forEach(p => camColor(p.camera));
    renderLegend();
    renderGrid();
    renderMarkers();
    setStatus(`${photos.length} photos`);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

/* ── Camera legend ── */
function renderLegend() {
  const legend = document.getElementById("cam-legend");
  legend.innerHTML = "";
  Object.entries(camColorMap).forEach(([cam, color]) => {
    const item = document.createElement("div");
    item.className = "cam-legend-item" + (hiddenCameras.has(cam) ? " dimmed" : "");
    item.title = `Click to hide/show ${cam}`;
    item.innerHTML = `<div class="cam-legend-dot" style="background:${color}"></div><span>${cam}</span>`;
    item.addEventListener("click", () => {
      hiddenCameras.has(cam) ? hiddenCameras.delete(cam) : hiddenCameras.add(cam);
      item.classList.toggle("dimmed");
      renderGrid();
    });
    legend.appendChild(item);
  });
}

/* ── Grid ── */
function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  photos.forEach((photo, idx) => {
    const camKey = photo.camera || "Unknown";
    if (hiddenCameras.has(camKey)) return;

    const cell = document.createElement("div");
    cell.className = "thumb-cell" +
      (selectedIds.has(photo.id) ? " selected" : "") +
      (photo.lat != null ? " tagged" : "");
    cell.dataset.id = photo.id;
    cell.dataset.idx = idx;
    cell.draggable = true;

    const strip = document.createElement("div");
    strip.className = "cam-strip";
    strip.style.background = camColor(photo.camera);

    const img = document.createElement("img");
    img.src = `/api/thumbnail/${photo.id}`;
    img.loading = "lazy";
    img.alt = photo.filename;

    const name = document.createElement("div");
    name.className = "thumb-name";
    name.textContent = photo.filename;

    cell.appendChild(strip);
    cell.appendChild(img);
    cell.appendChild(name);
    grid.appendChild(cell);

    cell.addEventListener("click", (e) => handleThumbClick(e, photo.id, idx));
    cell.addEventListener("dragstart", (e) => handleDragStart(e, photo.id));
  });
}

function handleThumbClick(e, id, idx) {
  if (e.shiftKey && lastClickedIndex >= 0) {
    const lo = Math.min(lastClickedIndex, idx);
    const hi = Math.max(lastClickedIndex, idx);
    for (let i = lo; i <= hi; i++) selectedIds.add(photos[i].id);
  } else if (e.ctrlKey || e.metaKey) {
    selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
  } else {
    selectedIds.clear();
    selectedIds.add(id);
  }
  lastClickedIndex = idx;
  refreshSelectionUI();
  showDetail(id);
}

function refreshSelectionUI() {
  document.querySelectorAll(".thumb-cell").forEach((cell) => {
    const id = Number(cell.dataset.id);
    cell.classList.toggle("selected", selectedIds.has(id));
  });
}

/* ── Drag ── */
function handleDragStart(e, id) {
  if (!selectedIds.has(id)) {
    selectedIds.clear();
    selectedIds.add(id);
    refreshSelectionUI();
  }
  e.dataTransfer.setData("application/json", JSON.stringify([...selectedIds]));
  e.dataTransfer.effectAllowed = "copy";
}

/* ── Markers ── */
function makePinIcon(color) {
  // SVG teardrop pin. Outline is a slightly darker shade for contrast.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="0 0 24 34">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 8 12 22 12 22s12-14 12-22C24 5.373 18.627 0 12 0z"
          fill="${color}" stroke="rgba(0,0,0,0.45)" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="5" fill="rgba(255,255,255,0.35)"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: "",          // suppress Leaflet's default white box
    iconSize: [24, 34],
    iconAnchor: [12, 34],   // tip of pin
    popupAnchor: [0, -34],
  });
}

function renderMarkers() {
  Object.values(markersById).forEach((m) => m.remove());
  markersById = {};
  photos.forEach((photo) => {
    if (photo.lat != null && photo.lng != null) {
      addOrUpdateMarker(photo);
    }
  });
}

function addOrUpdateMarker(photo) {
  const color = camColor(photo.camera);
  if (markersById[photo.id]) {
    markersById[photo.id].setLatLng([photo.lat, photo.lng]);
    markersById[photo.id].setIcon(makePinIcon(color));
    return;
  }
  const marker = L.marker([photo.lat, photo.lng], {
    draggable: true,
    icon: makePinIcon(color),
  }).addTo(map).bindPopup(photo.filename);

  marker.on("dragend", async () => {
    const ll = marker.getLatLng();
    await geotag([photo.id], ll.lat, ll.lng);
  });

  markersById[photo.id] = marker;
}

/* ── Geotag / remove ── */
async function geotag(ids, lat, lng) {
  setStatus(`Geotagging ${ids.length} photo(s)…`);
  try {
    const res = await fetch("/api/geotag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, lat, lng }),
    });
    const updated = await res.json();
    updated.forEach((u) => {
      const photo = photos.find((p) => p.id === u.id);
      if (photo) { photo.lat = u.lat; photo.lng = u.lng; photo.geotag_source = u.geotag_source; }
      addOrUpdateMarker({ id: u.id, lat: u.lat, lng: u.lng,
        filename: photo?.filename || "", camera: photo?.camera });
    });
    renderGrid();
    setStatus(`Tagged ${updated.length} photo(s) at ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    if (focusedPhotoId && ids.includes(focusedPhotoId)) showDetail(focusedPhotoId);
  } catch (err) {
    setStatus("Geotag error: " + err.message, true);
  }
}

async function doRemoveGeotag() {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];
  setStatus(`Removing geotag from ${ids.length} photo(s)…`);
  try {
    await fetch("/api/geotag/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    ids.forEach((id) => {
      const photo = photos.find((p) => p.id === id);
      if (photo) { photo.lat = null; photo.lng = null; photo.geotag_source = "none"; }
      if (markersById[id]) { markersById[id].remove(); delete markersById[id]; }
    });
    renderGrid();
    setStatus(`Removed geotag from ${ids.length} photo(s)`);
    if (focusedPhotoId && ids.includes(focusedPhotoId)) showDetail(focusedPhotoId);
  } catch (err) {
    setStatus("Remove error: " + err.message, true);
  }
}

/* ── Manual lat/lng ── */
async function doApplyLatLng() {
  const lat = parseFloat(document.getElementById("lat-input").value);
  const lng = parseFloat(document.getElementById("lng-input").value);
  if (isNaN(lat) || isNaN(lng)) { setStatus("Invalid lat/lng", true); return; }
  if (!selectedIds.size) { setStatus("No photos selected", true); return; }
  await geotag([...selectedIds], lat, lng);
}

/* ── Copy location ── */
async function doCopyLocation() {
  if (!focusedPhotoId) { setStatus("No photo in detail pane", true); return; }
  const source = photos.find((p) => p.id === focusedPhotoId);
  if (!source?.lat) { setStatus("Focused photo has no location", true); return; }
  const targets = [...selectedIds].filter((id) => id !== focusedPhotoId);
  if (!targets.length) { setStatus("No other photos selected", true); return; }
  await geotag(targets, source.lat, source.lng);
}

/* ── Place search ── */
let _lastPlaceSearch = 0;
async function doPlaceSearch() {
  const q = document.getElementById("place-search").value.trim();
  if (!q) return;
  const now = Date.now();
  if (now - _lastPlaceSearch < 1000) {
    setStatus("Please wait 1 second between place searches");
    return;
  }
  _lastPlaceSearch = now;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "User-Agent": "geo-tagger/1.0 (local)" } });
    const results = await res.json();
    if (!results.length) { setStatus("Place not found"); return; }
    const { lat, lon, display_name } = results[0];
    map.flyTo([parseFloat(lat), parseFloat(lon)], 12);
    setStatus(`Flew to: ${display_name}`);
  } catch (err) {
    setStatus("Place search error: " + err.message, true);
  }
}

/* ── Detail pane ── */
async function showDetail(id) {
  focusedPhotoId = id;
  try {
    const res = await fetch(`/api/photo/${id}`);
    const data = await res.json();

    document.getElementById("detail-placeholder").style.display = "none";
    document.getElementById("detail-content").style.display = "";
    document.getElementById("detail-img").src = `/api/preview/${id}`;

    const rows = [
      ["File", data.filename],
      ["Type", data.media_type],
      ["Camera", data.camera || "—"],
      ["Date", data.datetime || "—"],
      ["Dimensions", data.dimensions || "—"],
      ["Latitude", data.lat != null ? data.lat.toFixed(6) : "—"],
      ["Longitude", data.lng != null ? data.lng.toFixed(6) : "—"],
      ["Geotag source", data.geotag_source],
      ["Sidecar", data.sidecar_path ? data.sidecar_path.split(/[\\/]/).pop() : "none"],
    ];
    const table = document.getElementById("detail-meta");
    table.innerHTML = rows.map(([k, v]) =>
      `<tr><td>${k}</td><td>${v ?? "—"}</td></tr>`
    ).join("");
  } catch (err) {
    // ignore
  }
}

/* ── Status ── */
function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}
