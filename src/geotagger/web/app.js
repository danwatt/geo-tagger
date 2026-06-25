/* ── State ── */
let photos = [];          // full list from API
let filteredPhotos = [];  // after camera hide + date range filter
let selectedIds = new Set();
let lastClickedIndex = -1;
let markersById = {};
let focusedPhotoId = null;
let map;
let guessMarker = null;        // temporary guess pin (amber ?)
let guessSourceMarkers = [];   // source photo pins shown during guess
let guessPending = null;       // { lat, lng } awaiting apply/dismiss

/* ── Date range filter state ── */
let dateRangeMin = 0;   // Unix ts — absolute min across all photos
let dateRangeMax = 0;   // Unix ts — absolute max across all photos
let dateFilterLo = 0;   // current low handle value
let dateFilterHi = 0;   // current high handle value
let histBuckets = [];   // [{ts, count}] for drawing

/* ── Basemap definitions ── */
const BASEMAPS = {
  street: {
    label: "Street",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    },
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: "Tiles © Esri — Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
      maxZoom: 19,
    },
  },
  hybrid: {
    label: "Hybrid",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    overlayUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: "Tiles © Esri",
      maxZoom: 19,
    },
  },
};

let activeBasemap = "street";
let baseTileLayer = null;
let overlayTileLayer = null;

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
  bindTimeline();
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
  setBasemap("street");
  addBasemapControl();

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
    buildHistogram();
    applyFilters();
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

/* ── Apply all active filters → filteredPhotos ── */
function applyFilters() {
  filteredPhotos = photos.filter(p => {
    if (hiddenCameras.has(p.camera || "Unknown")) return false;
    if (dateRangeMin !== dateRangeMax) {
      const ts = p.photo_datetime || 0;
      if (ts > 0 && (ts < dateFilterLo || ts > dateFilterHi)) return false;
    }
    return true;
  });
  renderGrid();
  renderMarkers();
  drawHistogram();
  setStatus(`Showing ${filteredPhotos.length} of ${photos.length} photos`);
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
      applyFilters();
    });
    legend.appendChild(item);
  });
}

/* ── Grid ── */
function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  filteredPhotos.forEach((photo, idx) => {
    const camKey = photo.camera || "Unknown";

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
  const visibleIds = new Set(filteredPhotos.map(p => p.id));
  Object.entries(markersById).forEach(([id, m]) => {
    if (!visibleIds.has(Number(id))) { m.remove(); delete markersById[id]; }
  });
  filteredPhotos.forEach((photo) => {
    if (photo.lat != null && photo.lng != null) addOrUpdateMarker(photo);
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
  }).addTo(map);

  marker.on("click", () => {
    selectedIds.clear();
    selectedIds.add(photo.id);
    refreshSelectionUI();
    showDetail(photo.id);
  });

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
  dismissGuess();
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

    // Show guess bar only for untagged photos that have a timestamp
    const guessBar = document.getElementById("guess-bar");
    guessBar.style.display = (data.lat == null && data.datetime) ? "" : "none";
    document.getElementById("guess-result").style.display = "none";
  } catch (err) {
    // ignore
  }
}

/* ── Guess location ── */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("guess-btn").addEventListener("click", doGuess);
  document.getElementById("guess-apply-btn").addEventListener("click", applyGuess);
  document.getElementById("guess-dismiss-btn").addEventListener("click", dismissGuess);
});

async function doGuess() {
  if (!focusedPhotoId) return;
  document.getElementById("guess-btn").disabled = true;
  document.getElementById("guess-btn").textContent = "Searching…";
  dismissGuess(false);   // clear old pin but keep button

  try {
    const res = await fetch(`/api/guess/${focusedPhotoId}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.detail || "No nearby geotagged photos found", true);
      return;
    }

    guessPending = { lat: data.lat, lng: data.lng };

    // Place source photo pins (before=blue, after=green, brightness by proximity)
    data.sources.forEach(src => {
      const icon = makeSourcePinIcon(src.delta_sec, src.is_before, data.window_sec);
      const mins = src.delta_sec < 60
        ? `${src.delta_sec}s`
        : `${Math.round(src.delta_sec / 60)}min`;
      const direction = src.is_before ? "before" : "after";
      const m = L.marker([src.lat, src.lng], { icon, interactive: true })
        .addTo(map)
        .bindTooltip(`${src.filename}<br>${mins} ${direction}`, { direction: "top" });
      guessSourceMarkers.push(m);
    });

    // Place the centre-of-mass guess pin on top — draggable for manual refinement
    guessMarker = L.marker([data.lat, data.lng], {
      icon: makeGuessPinIcon(),
      draggable: true,
      zIndexOffset: 1000,
    }).addTo(map);

    guessMarker.on("dragend", () => {
      const ll = guessMarker.getLatLng();
      guessPending = { lat: ll.lat, lng: ll.lng };
    });

    // Fit map to show all source pins + guess pin
    const allPoints = [
      [data.lat, data.lng],
      ...data.sources.map(s => [s.lat, s.lng]),
    ];
    map.flyToBounds(L.latLngBounds(allPoints).pad(0.3), { duration: 1, maxZoom: 16 });

    // Build summary text
    const srcList = data.sources.slice(0, 3)
      .map(s => {
        const mins = s.delta_sec < 60 ? `${s.delta_sec}s` : `${Math.round(s.delta_sec / 60)}min`;
        return `${s.filename} (${mins} ${s.is_before ? "before" : "after"})`;
      })
      .join(", ");
    const more = data.source_count > 3 ? ` +${data.source_count - 3} more` : "";
    document.getElementById("guess-summary").textContent =
      `Based on ${data.source_count} nearby photo${data.source_count > 1 ? "s" : ""}: ${srcList}${more}`;
    document.getElementById("guess-result").style.display = "";
  } catch (err) {
    setStatus("Guess error: " + err.message, true);
  } finally {
    document.getElementById("guess-btn").disabled = false;
    document.getElementById("guess-btn").textContent = "Guess location";
  }
}

async function applyGuess() {
  if (!guessPending || !focusedPhotoId) return;
  await geotag([focusedPhotoId], guessPending.lat, guessPending.lng);
  dismissGuess();
  showDetail(focusedPhotoId);
}

function dismissGuess(hideResult = true) {
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  guessSourceMarkers.forEach(m => m.remove());
  guessSourceMarkers = [];
  guessPending = null;
  if (hideResult) document.getElementById("guess-result").style.display = "none";
}

function makeSourcePinIcon(deltaSec, isBefore, windowSec = 900) {
  // proximity 1 = very close in time, 0 = at the edge of the window
  const proximity = Number.isFinite(deltaSec / windowSec)
    ? Math.max(0, 1 - deltaSec / windowSec)
    : 0.5;

  // Before: blue family  hsl(210, sat, lightness)
  // After:  green family hsl(145, sat, lightness)
  // Vivid when close (high proximity), muted when far
  const hue = isBefore ? 210 : 145;
  const sat = Math.round(40 + proximity * 55);       // 40% → 95%
  const lit = Math.round(28 + proximity * 38);        // 28% → 66%
  const fill = `hsl(${hue},${sat}%,${lit}%)`;
  const stroke = `hsl(${hue},${Math.max(20, sat - 20)}%,${Math.min(90, lit + 25)}%)`;

  // Small circle pin — clearly distinct from the teardrop confirmed pins
  const r = Math.round(7 + proximity * 4);  // 7–11px radius, closer = larger
  const sz = (r + 3) * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}">
    <circle cx="${sz/2}" cy="${sz/2}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
    tooltipAnchor: [0, -(sz / 2)],
  });
}

function makeGuessPinIcon() {
  // Dashed-outline pin in amber to distinguish from confirmed pins
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38">
    <path d="M14 1C7.373 1 2 6.373 2 13c0 9 12 24 12 24S26 22 26 13C26 6.373 20.627 1 14 1z"
          fill="#f0a500" fill-opacity="0.85"
          stroke="#fff" stroke-width="2" stroke-dasharray="4 3"/>
    <circle cx="14" cy="13" r="5" fill="rgba(255,255,255,0.4)"/>
    <text x="14" y="17" text-anchor="middle" font-size="9" fill="white" font-family="sans-serif">?</text>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [28, 38],
    iconAnchor: [14, 38],
    popupAnchor: [0, -38],
  });
}

/* ── Timeline histogram ── */
function bindTimeline() {
  const lo = document.getElementById("range-lo");
  const hi = document.getElementById("range-hi");

  function onInput() {
    // Prevent handles from crossing
    if (Number(lo.value) > Number(hi.value)) {
      if (this === lo) lo.value = hi.value;
      else hi.value = lo.value;
    }
    updateDateFilter();
    applyFilters();
  }

  lo.addEventListener("input", onInput);
  hi.addEventListener("input", onInput);
}

function buildHistogram() {
  const tsList = photos.map(p => p.photo_datetime).filter(ts => ts && ts > 0);
  if (tsList.length < 2) {
    // Hide timeline if there's no date data
    document.getElementById("timeline").style.display = "none";
    dateRangeMin = dateRangeMax = 0;
    dateFilterLo = dateFilterHi = 0;
    histBuckets = [];
    return;
  }
  document.getElementById("timeline").style.display = "";

  dateRangeMin = Math.min(...tsList);
  dateRangeMax = Math.max(...tsList);
  dateFilterLo = dateRangeMin;
  dateFilterHi = dateRangeMax;

  // Reset sliders
  document.getElementById("range-lo").value = 0;
  document.getElementById("range-hi").value = 1000;

  // Choose bucket granularity
  const spanDays = (dateRangeMax - dateRangeMin) / 86400;
  let bucketSecs;
  if (spanDays <= 90)       bucketSecs = 86400;        // daily
  else if (spanDays <= 365) bucketSecs = 86400 * 7;    // weekly
  else                      bucketSecs = 86400 * 30;   // monthly

  const bucketCount = Math.ceil((dateRangeMax - dateRangeMin) / bucketSecs) + 1;
  const counts = new Array(bucketCount).fill(0);
  tsList.forEach(ts => {
    const idx = Math.floor((ts - dateRangeMin) / bucketSecs);
    if (idx >= 0 && idx < bucketCount) counts[idx]++;
  });

  histBuckets = counts.map((count, i) => ({
    ts: dateRangeMin + i * bucketSecs,
    count,
  }));

  updateDateLabels();
  drawHistogram();
}

function updateDateFilter() {
  const lo = Number(document.getElementById("range-lo").value) / 1000;
  const hi = Number(document.getElementById("range-hi").value) / 1000;
  const span = dateRangeMax - dateRangeMin;
  dateFilterLo = Math.round(dateRangeMin + lo * span);
  dateFilterHi = Math.round(dateRangeMin + hi * span);
  updateDateLabels();
}

function updateDateLabels() {
  document.getElementById("hist-label-lo").textContent = fmtDate(dateFilterLo);
  document.getElementById("hist-label-hi").textContent = fmtDate(dateFilterHi);
}

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function drawHistogram() {
  const canvas = document.getElementById("hist-canvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  // Size canvas to its CSS size
  const cssW = canvas.offsetWidth;
  const cssH = canvas.offsetHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
  }
  ctx.clearRect(0, 0, cssW, cssH);

  if (!histBuckets.length || dateRangeMin === dateRangeMax) return;

  const n = histBuckets.length;
  const maxCount = Math.max(...histBuckets.map(b => b.count), 1);
  const barW = cssW / n;
  const span = dateRangeMax - dateRangeMin;

  histBuckets.forEach((bucket, i) => {
    const h = (bucket.count / maxCount) * cssH * 0.92;
    const x = i * barW;
    const inRange = bucket.ts >= dateFilterLo && bucket.ts <= dateFilterHi;

    // Count photos in this bucket by camera for color stacking
    const camCounts = {};
    filteredPhotos
      .filter(p => {
        if (!p.photo_datetime || p.photo_datetime <= 0) return false;
        const bucketSecs = span / n;
        const bIdx = Math.floor((p.photo_datetime - dateRangeMin) / bucketSecs);
        return bIdx === i;
      })
      .forEach(p => {
        const c = p.camera || "Unknown";
        camCounts[c] = (camCounts[c] || 0) + 1;
      });

    if (inRange && Object.keys(camCounts).length > 0) {
      // Stacked color bars
      let yOffset = cssH;
      Object.entries(camCounts).forEach(([cam, cnt]) => {
        const segH = (cnt / maxCount) * cssH * 0.92;
        yOffset -= segH;
        ctx.fillStyle = camColor(cam);
        ctx.fillRect(x + 0.5, yOffset, barW - 1, segH);
      });
    } else {
      // Out-of-range or undated: dim gray bar
      const barH = (bucket.count / maxCount) * cssH * 0.92;
      ctx.fillStyle = inRange ? "#444" : "#2a2a2a";
      ctx.fillRect(x + 0.5, cssH - barH, barW - 1, barH);
    }
  });

  // Draw range boundary lines
  const loX = ((dateFilterLo - dateRangeMin) / span) * cssW;
  const hiX = ((dateFilterHi - dateRangeMin) / span) * cssW;
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(loX, 0); ctx.lineTo(loX, cssH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(hiX, 0); ctx.lineTo(hiX, cssH); ctx.stroke();
}

window.addEventListener("resize", () => {
  if (histBuckets.length) drawHistogram();
});

/* ── Status ── */
function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}
