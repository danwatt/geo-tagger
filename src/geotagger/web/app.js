/* ── State ── */
let photos = [];          // full list from API
let filteredPhotos = [];  // after camera hide + date range filter
let selectedIds = new Set();
let lastClickedIndex = -1;
let markersById = {};
let dayIsolation = null; // "YYYY-MM-DD" key, or null when all days are shown
let focusedPhotoId = null;
let map;
let guessMarker = null;        // temporary guess pin (amber ?)
let guessSourceMarkers = [];   // source photo pins shown during guess
let guessPending = null;       // { lat, lng } awaiting apply/dismiss
let guessContextLayers = [];   // context polygons shown during guess
let accuracyCircle = null;     // L.circle shown for selected photo's GPS accuracy
let selectedYear = null;
let selectedMonth = null;

/* ── Places state ── */
let places = [];
let placeShapes = {};  // place_id -> L.Rectangle or L.Circle
let drawingMode = null;  // null | "rectangle" | "circle" | "area-select"
let drawingShape = null;  // temporary shape being drawn

/* ── Area selection state ── */
let areaSelectMode = false;
let areaSelectCircle = null;
let areaSelectParams = null;  // { lat, lng, radius }

/* ── Context filter state ── */
let contextFilterData = null;  // full context object from API when active
let contextPolygonLayer = null;

/* ── Date range filter state ── */
let dateRangeMin = 0;   // Unix ts — absolute min across all photos
let dateRangeMax = 0;   // Unix ts — absolute max across all photos
let dateFilterLo = 0;   // current low handle value
let dateFilterHi = 0;   // current high handle value
let histBuckets = [];   // [{ts, count}] for drawing
let histBucketSecs = 86400; // granularity of current histogram

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

function dayKey(photo) {
  if (!photo.photo_datetime) return null;
  const d = new Date(photo.photo_datetime * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isolateDay(key) {
  dayIsolation = (dayIsolation === key) ? null : key;
  renderMarkers();
  renderGrid();
}

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  bindToolbar();
  bindTimeline();
  await checkStatus();
  await loadPlaces();
  await loadContextsDropdown();
  await fitMapToAllLocations();
  setStatus("Click 'Select Month' to begin");
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
  let dragAccuracyCircle = null;

  mapPane.addEventListener("dragover", (e) => {
    e.preventDefault();
    mapPane.classList.add("drop-target");

    const toggle = document.getElementById("imprecise-toggle");
    if (toggle && toggle.checked) {
      const radiusSelect = document.getElementById("imprecise-radius-select");
      const radius = parseFloat(radiusSelect.value);
      const rect = document.getElementById("map").getBoundingClientRect();
      const point = L.point(e.clientX - rect.left, e.clientY - rect.top);
      const latlng = map.containerPointToLatLng(point);

      if (!dragAccuracyCircle) {
        dragAccuracyCircle = L.circle(latlng, {
          radius: radius,
          color: "#e0a040",
          fillColor: "#e0a040",
          fillOpacity: 0.15,
          weight: 1.5,
          opacity: 0.6,
          dashArray: "5, 5",
          interactive: false
        }).addTo(map);
      } else {
        dragAccuracyCircle.setLatLng(latlng);
        dragAccuracyCircle.setRadius(radius);
      }
    } else if (dragAccuracyCircle) {
      dragAccuracyCircle.remove();
      dragAccuracyCircle = null;
    }
  });

  const cleanupDragCircle = () => {
    if (dragAccuracyCircle) {
      dragAccuracyCircle.remove();
      dragAccuracyCircle = null;
    }
  };

  mapPane.addEventListener("dragleave", () => {
    mapPane.classList.remove("drop-target");
    cleanupDragCircle();
  });

  mapPane.addEventListener("drop", async (e) => {
    e.preventDefault();
    mapPane.classList.remove("drop-target");
    cleanupDragCircle();
    const ids = JSON.parse(e.dataTransfer.getData("application/json") || "[]");
    if (!ids.length) return;
    const rect = document.getElementById("map").getBoundingClientRect();
    const point = L.point(e.clientX - rect.left, e.clientY - rect.top);
    const latlng = map.containerPointToLatLng(point);

    let accuracy = null;
    const toggle = document.getElementById("imprecise-toggle");
    if (toggle && toggle.checked) {
      const radiusSelect = document.getElementById("imprecise-radius-select");
      accuracy = parseFloat(radiusSelect.value);
    }
    await geotag(ids, latlng.lat, latlng.lng, accuracy);
  });
}

async function fitMapToAllLocations() {
  try {
    const res = await fetch("/api/stats/bounds");
    const data = await res.json();
    if (data.has_data) {
      map.fitBounds(
        [[data.min_lat, data.min_lng], [data.max_lat, data.max_lng]],
        { padding: [40, 40], maxZoom: 14 }
      );
    }
  } catch (e) {
    // keep default world view
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

function bindToolbar() {
  // View navigation
  document.getElementById("timesync-view-btn").addEventListener("click", () => {
    window.location.href = "/timesync.html";
  });
  document.getElementById("people-view-btn").addEventListener("click", () => {
    window.location.href = "/people.html";
  });
  document.getElementById("contexts-view-btn").addEventListener("click", () => {
    window.location.href = "/contexts.html";
  });

  document.getElementById("context-filter-select").addEventListener("change", async (e) => {
    const id = parseInt(e.target.value);
    if (!id) {
      clearContextFilter();
      return;
    }
    // Find the context in the already-loaded list
    const res = await fetch("/api/contexts");
    const all = await res.json();
    const ctx = all.find(c => c.id === id);
    if (ctx) await loadPhotosByContext(ctx);
  });

  document.getElementById("select-month-btn").addEventListener("click", showMonthPicker);
  document.getElementById("select-area-btn").addEventListener("click", startAreaSelection);
  function reloadCurrentView() {
    if (contextFilterData) {
      loadPhotosByContext(contextFilterData);
    } else if (selectedYear) {
      loadPhotos();
    } else if (areaSelectParams) {
      loadPhotosByArea(areaSelectParams.lat, areaSelectParams.lng, areaSelectParams.radius);
    }
  }
  document.getElementById("filter-select").addEventListener("change", reloadCurrentView);
  document.getElementById("include-screenshots-chk").addEventListener("change", () => applyFilters());
  document.getElementById("window-select").addEventListener("change", reloadCurrentView);
  document.getElementById("place-search-btn").addEventListener("click", doPlaceSearch);
  document.getElementById("place-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doPlaceSearch();
  });
  document.getElementById("apply-latlng-btn").addEventListener("click", doApplyLatLng);
  document.getElementById("copy-location-btn").addEventListener("click", doCopyLocation);
  document.getElementById("remove-geotag-btn").addEventListener("click", doRemoveGeotag);

  // Places
  document.getElementById("places-select").addEventListener("change", onPlaceSelected);
  document.getElementById("draw-rectangle-btn").addEventListener("click", () => startDrawing("rectangle"));
  document.getElementById("draw-circle-btn").addEventListener("click", () => startDrawing("circle"));

  // Imprecise drop toggle
  const impreciseToggle = document.getElementById("imprecise-toggle");
  const impreciseRadiusSelect = document.getElementById("imprecise-radius-select");
  if (impreciseToggle && impreciseRadiusSelect) {
    impreciseToggle.addEventListener("change", () => {
      impreciseRadiusSelect.style.display = impreciseToggle.checked ? "inline-block" : "none";
    });
  }

  // Modal close handlers
  document.querySelector(".modal-close").addEventListener("click", hideMonthPicker);
  document.getElementById("month-picker-modal").addEventListener("click", (e) => {
    if (e.target.id === "month-picker-modal") hideMonthPicker();
  });
}

/* ── Month Picker ── */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

async function showMonthPicker() {
  try {
    const res = await fetch("/api/stats/months");
    const data = await res.json();

    const list = document.getElementById("month-picker-list");
    list.innerHTML = "";

    if (!data.months || data.months.length === 0) {
      list.innerHTML = "<p>No photos found with timestamps.</p>";
      document.getElementById("month-picker-modal").style.display = "flex";
      return;
    }

    // Group by year
    const byYear = {};
    data.months.forEach(m => {
      if (!byYear[m.year]) byYear[m.year] = [];
      byYear[m.year].push(m);
    });

    // Render years (most recent first)
    const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
    years.forEach(year => {
      const yearSection = document.createElement("div");
      yearSection.className = "month-year-section";

      const yearHeader = document.createElement("div");
      yearHeader.className = "month-year-header";
      yearHeader.innerHTML = `${year} <span class="year-browse-all">Browse all</span>`;
      yearHeader.title = `Load all photos from ${year}`;
      yearHeader.addEventListener("click", () => selectYear(year));
      yearSection.appendChild(yearHeader);

      // Render months (most recent first)
      byYear[year].sort((a, b) => b.month - a.month).forEach(m => {
        const item = document.createElement("div");
        item.className = "month-item";
        item.dataset.year = m.year;
        item.dataset.month = m.month;

        const monthName = document.createElement("div");
        monthName.className = "month-name";
        monthName.textContent = MONTH_NAMES[m.month - 1];

        const counts = document.createElement("div");
        counts.className = "month-counts";
        counts.innerHTML = `
          <span class="count-badge count-total">${m.total} total</span>
          <span class="count-badge count-geotagged">${m.geotagged} geotagged</span>
          <span class="count-badge count-not-geotagged">${m.not_geotagged} not geotagged</span>
        `;

        item.appendChild(monthName);
        item.appendChild(counts);
        item.addEventListener("click", () => selectMonth(m.year, m.month));

        yearSection.appendChild(item);
      });

      list.appendChild(yearSection);
    });

    document.getElementById("month-picker-modal").style.display = "flex";
  } catch (e) {
    console.error("Failed to load month stats:", e);
    setStatus("Error loading months: " + e.message, true);
  }
}

function hideMonthPicker() {
  document.getElementById("month-picker-modal").style.display = "none";
}

async function selectMonth(year, month) {
  selectedYear = year;
  selectedMonth = month;
  dayIsolation = null;
  hideMonthPicker();

  // Clear area and context selections
  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearContextFilter();

  // Update label
  document.getElementById("selected-month-label").textContent =
    `${MONTH_NAMES[month - 1]} ${year}`;

  // Load daily histogram for this month
  await loadMonthHistogram(year, month);

  // Load photos for this month
  await loadPhotos(true);
}

async function selectYear(year) {
  selectedYear = year;
  selectedMonth = null;
  dayIsolation = null;
  hideMonthPicker();

  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearContextFilter();

  document.getElementById("selected-month-label").textContent = `${year} (all months)`;

  await loadPhotos(true);
}

/* ── Places Management ── */

async function loadPlaces() {
  try {
    const res = await fetch("/api/places");
    places = await res.json();

    // Update dropdown
    const select = document.getElementById("places-select");
    select.innerHTML = '<option value="">Select a place...</option>';
    places.forEach(p => {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.name;
      select.appendChild(option);
    });

    // Display all places on map
    renderPlaces();
  } catch (e) {
    console.error("Failed to load places:", e);
  }
}

function renderPlaces() {
  // Clear existing shapes
  Object.values(placeShapes).forEach(shape => map.removeLayer(shape));
  placeShapes = {};

  // Render each place
  places.forEach(p => {
    const bounds = JSON.parse(p.bounds);
    let shape;

    if (p.type === "rectangle") {
      shape = L.rectangle([[bounds.south, bounds.west], [bounds.north, bounds.east]], {
        color: "#4a90d9",
        weight: 2,
        fillOpacity: 0.1,
        draggable: true
      });
    } else if (p.type === "circle") {
      shape = L.circle([bounds.lat, bounds.lng], {
        radius: bounds.radius,
        color: "#4a90d9",
        weight: 2,
        fillOpacity: 0.1,
        draggable: true
      });
    }

    if (shape) {
      shape.bindTooltip(p.name, { permanent: false, direction: "top" });
      shape.on("contextmenu", () => confirmDeletePlace(p));

      // Enable editing on click
      shape.on("click", () => enableShapeEditing(shape, p));

      // Save new position when dragged
      shape.on("dragend", () => updatePlaceBounds(p));

      shape.addTo(map);
      placeShapes[p.id] = shape;
    }
  });
}

let editingShape = null;

function enableShapeEditing(shape, place) {
  // For now, shapes can be dragged to reposition
  // To resize, users should delete and redraw
  setStatus(`Drag to reposition "${place.name}". Right-click to delete.`, false);
}

function disableShapeEditing() {
  if (editingShape) {
    editingShape.setStyle({ color: "#4a90d9", weight: 2 });
    editingShape.off("dragend");
    editingShape = null;
  }
}

async function updatePlaceBounds(place) {
  const shape = placeShapes[place.id];
  if (!shape) return;

  let boundsData;
  if (place.type === "rectangle") {
    const bounds = shape.getBounds();
    boundsData = {
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest()
    };
  } else if (place.type === "circle") {
    boundsData = {
      lat: shape.getLatLng().lat,
      lng: shape.getLatLng().lng,
      radius: shape.getRadius()
    };
  }

  try {
    // Update the place on the backend
    await fetch(`/api/places/${place.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bounds: JSON.stringify(boundsData) })
    });

    // Update local state
    place.bounds = JSON.stringify(boundsData);
    setStatus(`Updated ${place.name}`);

    // Re-enable normal mode
    disableShapeEditing();
  } catch (err) {
    setStatus("Failed to update place: " + err.message, true);
  }
}

function onPlaceSelected(e) {
  const placeId = parseInt(e.target.value);
  if (!placeId) return;

  const place = places.find(p => p.id === placeId);
  if (!place) return;

  const bounds = JSON.parse(place.bounds);

  if (place.type === "rectangle") {
    map.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [50, 50] });
  } else if (place.type === "circle") {
    map.setView([bounds.lat, bounds.lng], 13);
  }

  // Reset dropdown
  setTimeout(() => { e.target.value = ""; }, 100);
}

function startDrawing(type) {
  if (drawingMode) {
    stopDrawing();
  }

  drawingMode = type;
  setStatus(`Drawing ${type}... Click, hold, and drag to set size, then release`, false);
  map.getContainer().style.cursor = "crosshair";

  // Disable map dragging while drawing
  map.dragging.disable();

  // Set up drawing handlers
  map.once("mousedown", onDrawStart);
}

function stopDrawing() {
  drawingMode = null;
  map.getContainer().style.cursor = "";
  map.off("mousedown", onDrawStart);
  map.off("mousemove", onDrawMove);
  map.off("mouseup", onDrawEnd);

  // Re-enable map dragging
  map.dragging.enable();

  if (drawingShape) {
    map.removeLayer(drawingShape);
    drawingShape = null;
  }
}

let drawStartLatLng = null;

function onDrawStart(e) {
  drawStartLatLng = e.latlng;

  if (drawingMode === "rectangle") {
    drawingShape = L.rectangle([e.latlng, e.latlng], {
      color: "#e0a040",
      weight: 2,
      fillOpacity: 0.2
    }).addTo(map);
  } else if (drawingMode === "circle") {
    drawingShape = L.circle(e.latlng, {
      radius: 0,
      color: "#e0a040",
      weight: 2,
      fillOpacity: 0.2
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
    const radius = drawStartLatLng.distanceTo(e.latlng);
    drawingShape.setRadius(radius);
  }
}

async function onDrawEnd(e) {
  map.off("mousemove", onDrawMove);

  if (!drawingShape || !drawStartLatLng) {
    stopDrawing();
    return;
  }

  // Check minimum size (allow down to ~10 square meters)
  let tooSmall = false;
  if (drawingMode === "rectangle") {
    const bounds = drawingShape.getBounds();
    const width = Math.abs(bounds.getEast() - bounds.getWest());
    const height = Math.abs(bounds.getNorth() - bounds.getSouth());
    // 0.00003 degrees ≈ 3.3 meters at equator
    tooSmall = width < 0.00003 || height < 0.00003;
  } else if (drawingMode === "circle") {
    tooSmall = drawingShape.getRadius() < 2;  // 2 meters minimum
  }

  if (tooSmall) {
    alert("Shape is too small. Please drag to create a larger shape.");
    stopDrawing();
    return;
  }

  // Prompt for name
  const name = prompt(`Name this ${drawingMode}:`);
  if (!name) {
    stopDrawing();
    return;
  }

  // Calculate bounds
  let boundsData;
  if (drawingMode === "rectangle") {
    const bounds = drawingShape.getBounds();
    boundsData = {
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest()
    };
  } else if (drawingMode === "circle") {
    boundsData = {
      lat: drawingShape.getLatLng().lat,
      lng: drawingShape.getLatLng().lng,
      radius: drawingShape.getRadius()
    };
  }

  // Save to backend
  try {
    const res = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name,
        type: drawingMode,
        bounds: JSON.stringify(boundsData)
      })
    });

    if (!res.ok) throw new Error("Failed to save place");

    setStatus(`Place "${name}" saved`, false);
    await loadPlaces();  // Reload to get the new place
  } catch (err) {
    setStatus(`Error saving place: ${err.message}`, true);
  }

  stopDrawing();
}

async function confirmDeletePlace(place) {
  if (!confirm(`Delete place "${place.name}"?`)) return;

  try {
    const res = await fetch(`/api/places/${place.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete place");

    setStatus(`Place "${place.name}" deleted`, false);
    await loadPlaces();
  } catch (err) {
    setStatus(`Error deleting place: ${err.message}`, true);
  }
}

/* ── Context Filter ── */

async function loadContextsDropdown() {
  try {
    const res = await fetch("/api/contexts");
    if (!res.ok) return;
    const contexts = await res.json();
    const select = document.getElementById("context-filter-select");
    // Preserve current value if possible
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- none --</option>';
    contexts.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.id;
      const dateStr = c.start_date && c.end_date
        ? ` (${c.start_date.slice(0,4)}–${c.end_date.slice(0,4)})`
        : c.start_date ? ` (from ${c.start_date.slice(0,4)})`
        : c.end_date   ? ` (until ${c.end_date.slice(0,4)})`
        : "";
      opt.textContent = c.name + dateStr;
      select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;
  } catch (e) {
    console.error("Failed to load contexts for dropdown:", e);
  }
}

async function loadPhotosByContext(ctx) {
  contextFilterData = ctx;
  dayIsolation = null;

  // Draw / update the polygon layer
  if (contextPolygonLayer) { map.removeLayer(contextPolygonLayer); contextPolygonLayer = null; }
  if (ctx.polygon && ctx.polygon.length >= 3) {
    contextPolygonLayer = L.polygon(ctx.polygon.map(v => [v[0], v[1]]), {
      color: "#4a8", fillColor: "#4a8", fillOpacity: 0.08, weight: 2,
    }).addTo(map).bindTooltip(ctx.name, { sticky: true });
    map.fitBounds(contextPolygonLayer.getBounds().pad(0.15), { maxZoom: 12 });
  }

  // Update label
  document.getElementById("selected-context-label").textContent = ctx.name;

  const filter = document.getElementById("filter-select").value;
  const apiFilter = filter === "mixed" ? "all" : filter;
  const url = `/api/photos?geotagged=${apiFilter}&context_id=${ctx.id}`;

  try {
    setStatus(`Loading photos in context "${ctx.name}"…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    photos = await res.json();
    photos.forEach(p => camColor(p.camera));
    renderLegend();
    buildHistogram();
    applyFilters(false);  // don't re-fit map — we already zoomed to polygon
    const tagged = photos.filter(p => p.lat != null).length;
    const untagged = photos.length - tagged;
    setStatus(`"${ctx.name}": ${photos.length} photos (${tagged} geotagged, ${untagged} untagged)`);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

function clearContextFilter() {
  if (contextPolygonLayer) { map.removeLayer(contextPolygonLayer); contextPolygonLayer = null; }
  contextFilterData = null;
  const sel = document.getElementById("context-filter-select");
  if (sel) sel.value = "";
  const lbl = document.getElementById("selected-context-label");
  if (lbl) lbl.textContent = "";
}

/* ── Area Selection ── */
function startAreaSelection() {
  if (drawingMode) {
    stopDrawing();
  }

  areaSelectMode = true;
  drawingMode = "area-select";
  setStatus("Draw a circle on the map to select photos in that area", false);
  map.getContainer().style.cursor = "crosshair";

  // Disable map dragging while drawing
  map.dragging.disable();

  // Set up drawing handlers
  map.once("mousedown", onAreaSelectStart);
}

function onAreaSelectStart(e) {
  drawStartLatLng = e.latlng;

  drawingShape = L.circle(e.latlng, {
    radius: 0,
    color: "#e0a040",
    weight: 2,
    fillOpacity: 0.2
  }).addTo(map);

  map.on("mousemove", onAreaSelectMove);
  map.once("mouseup", onAreaSelectEnd);
}

function onAreaSelectMove(e) {
  if (!drawingShape || !drawStartLatLng) return;
  const radius = drawStartLatLng.distanceTo(e.latlng);
  drawingShape.setRadius(radius);
}

async function onAreaSelectEnd(e) {
  map.off("mousemove", onAreaSelectMove);

  if (!drawingShape || !drawStartLatLng) {
    stopAreaSelection();
    return;
  }

  const radius = drawingShape.getRadius();

  // Check minimum size
  if (radius < 2) {
    alert("Area is too small. Please drag to create a larger area.");
    stopAreaSelection();
    return;
  }

  // Store the circle for display
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
  }
  areaSelectCircle = drawingShape;
  areaSelectCircle.setStyle({ color: "#4a90d9", weight: 2 });

  // Clear drawing state
  drawingShape = null;
  drawingMode = null;
  map.getContainer().style.cursor = "";
  map.dragging.enable();

  // Load photos in this area
  const center = areaSelectCircle.getLatLng();

  // Store params for filter changes
  areaSelectParams = { lat: center.lat, lng: center.lng, radius: radius };

  await loadPhotosByArea(center.lat, center.lng, radius);

  // Update label
  document.getElementById("selected-area-label").textContent =
    `Area: ${(radius / 1000).toFixed(2)}km radius`;

  // Clear month and context selections
  selectedYear = null;
  selectedMonth = null;
  document.getElementById("selected-month-label").textContent = "No month selected";
  clearContextFilter();
}

function stopAreaSelection() {
  areaSelectMode = false;
  drawingMode = null;
  map.getContainer().style.cursor = "";
  map.dragging.enable();
  map.off("mousedown", onAreaSelectStart);
  map.off("mousemove", onAreaSelectMove);
  map.off("mouseup", onAreaSelectEnd);

  if (drawingShape) {
    map.removeLayer(drawingShape);
    drawingShape = null;
  }
}

async function loadPhotosByArea(lat, lng, radius) {
  dayIsolation = null;
  const filter = document.getElementById("filter-select").value;
  const apiFilter = filter === "mixed" ? "all" : filter;
  const window = document.getElementById("window-select").value;

  try {
    setStatus("Loading photos in area...");
    const res = await fetch(`/api/photos/by-area?lat=${lat}&lng=${lng}&radius=${radius}&geotagged=${apiFilter}&window=${window}`);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    photos = await res.json();

    // Pre-assign colors so the legend order is stable
    photos.forEach(p => camColor(p.camera));
    renderLegend();
    buildHistogram();
    applyFilters(true);

    setStatus(`Loaded ${photos.length} photos in area`);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

/* ── Load month histogram ── */
async function loadMonthHistogram(year, month) {
  try {
    const res = await fetch(`/api/stats/dates?year=${year}&month=${month}`);
    const data = await res.json();

    if (data.dates && data.dates.length > 0) {
      buildHistogramFromDateStats(data.dates);
    } else {
      document.getElementById("timeline").style.display = "none";
    }
  } catch (e) {
    console.error("Failed to load month histogram:", e);
  }
}

/* ── Build histogram from date statistics ── */
function buildHistogramFromDateStats(dateStats) {
  if (dateStats.length === 0) {
    document.getElementById("timeline").style.display = "none";
    return;
  }
  document.getElementById("timeline").style.display = "";

  // Convert date strings to timestamps
  const dataWithTs = dateStats.map(d => ({
    date: d.date,
    count: d.count,
    ts: new Date(d.date + "T00:00:00").getTime() / 1000
  }));

  dateRangeMin = Math.min(...dataWithTs.map(d => d.ts));
  dateRangeMax = Math.max(...dataWithTs.map(d => d.ts));
  dateFilterLo = dateRangeMin;
  dateFilterHi = dateRangeMax;

  // Reset sliders
  document.getElementById("range-lo").value = 0;
  document.getElementById("range-hi").value = 1000;

  // For a single month, always use daily buckets
  const bucketSecs = 86400;  // daily
  histBucketSecs = bucketSecs;
  const bucketCount = Math.ceil((dateRangeMax - dateRangeMin) / bucketSecs) + 1;
  const counts = new Array(bucketCount).fill(0);

  // Aggregate counts into buckets
  dataWithTs.forEach(d => {
    const idx = Math.floor((d.ts - dateRangeMin) / bucketSecs);
    if (idx >= 0 && idx < bucketCount) {
      counts[idx] += d.count;
    }
  });

  histBuckets = counts.map((count, i) => ({
    ts: dateRangeMin + i * bucketSecs,
    count
  }));

  renderHistogram();
  updateHistogramLabels();
}

/* ── Load photos ── */
async function loadPhotos(fitMap = false) {
  if (!selectedYear) {
    setStatus("Please select a month first", true);
    return;
  }

  const filter = document.getElementById("filter-select").value;
  const apiFilter = filter === "mixed" ? "all" : filter;

  let dateFrom, dateTo;
  if (selectedMonth) {
    dateFrom = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
    const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
    dateTo = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${lastDay}`;
  } else {
    dateFrom = `${selectedYear}-01-01`;
    dateTo = `${selectedYear}-12-31`;
  }

  try {
    const url = `/api/photos?geotagged=${apiFilter}&date_from=${dateFrom}&date_to=${dateTo}`;

    const res = await fetch(url);
    photos = await res.json();
    // Pre-assign colors so the legend order is stable
    photos.forEach(p => camColor(p.camera));
    renderLegend();
    buildHistogram();
    applyFilters(fitMap);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

function filterMixedDays(photoList) {
  const dayCounts = new Map(); // dayKey -> { tagged, untagged }
  photoList.forEach(p => {
    const k = dayKey(p) || "__undated__";
    if (!dayCounts.has(k)) dayCounts.set(k, { tagged: 0, untagged: 0 });
    const e = dayCounts.get(k);
    if (p.lat != null) e.tagged++; else e.untagged++;
  });
  const mixedKeys = new Set(
    [...dayCounts.entries()].filter(([, v]) => v.tagged > 0 && v.untagged > 0).map(([k]) => k)
  );
  return photoList.filter(p => mixedKeys.has(dayKey(p) || "__undated__"));
}

/* ── Apply all active filters → filteredPhotos ── */
function applyFilters(fitMap = false) {
  const includeScreenshots = document.getElementById("include-screenshots-chk").checked;
  filteredPhotos = photos.filter(p => {
    if (hiddenCameras.has(p.camera || "Unknown")) return false;
    if (!includeScreenshots && /\.png$/i.test(p.filename)) return false;
    if (dateRangeMin !== dateRangeMax) {
      const ts = p.photo_datetime || 0;
      if (ts > 0 && (ts < dateFilterLo || ts > dateFilterHi)) return false;
    }
    return true;
  });
  if (document.getElementById("filter-select").value === "mixed") {
    filteredPhotos = filterMixedDays(filteredPhotos);
  }
  renderGrid();
  renderMarkers();
  drawHistogram();
  setStatus(`Showing ${filteredPhotos.length} of ${photos.length} photos`);
  if (fitMap) fitMapToPhotos();
}

function fitMapToPhotos() {
  const tagged = filteredPhotos.filter(p => p.lat != null);
  if (tagged.length === 0) return;
  const bounds = L.latLngBounds(tagged.map(p => [p.lat, p.lng]));
  map.flyToBounds(bounds, { padding: [40, 40], duration: 1.2, maxZoom: 16 });
}

/* ── Camera legend ── */
function renderLegend() {
  const legend = document.getElementById("cam-legend");
  legend.innerHTML = "";

  // Get unique cameras from currently loaded photos (filtered by month)
  const currentCameras = new Set(photos.map(p => p.camera || "Unknown"));

  // Only show cameras that are in the current month's photos
  Object.entries(camColorMap).forEach(([cam, color]) => {
    if (!currentCameras.has(cam)) return;  // Skip cameras not in current selection

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

const DAY_ABBRS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ── Grid ── */
function makeThumbCell(photo, idx) {
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

  cell.addEventListener("click", (e) => handleThumbClick(e, photo.id, idx));
  cell.addEventListener("dragstart", (e) => handleDragStart(e, photo.id));
  return cell;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  // Group filteredPhotos into calendar-day buckets
  const dayGroups = [];
  let curGroup = null;
  filteredPhotos.forEach((photo, idx) => {
    const key = dayKey(photo);
    let year = null, month = null, day = null, date = null;
    if (photo.photo_datetime) {
      date = new Date(photo.photo_datetime * 1000);
      year = date.getFullYear();
      month = date.getMonth();
      day = date.getDate();
    }
    if (!curGroup || curGroup.key !== key ||
        curGroup.year !== year || curGroup.month !== month || curGroup.day !== day) {
      curGroup = { key, year, month, day, date, photos: [] };
      dayGroups.push(curGroup);
    }
    curGroup.photos.push({ photo, idx });
  });

  let curYear = null, curMonth = null, groupIdx = 0;
  dayGroups.forEach(group => {
    if (group.year !== curYear) {
      curYear = group.year;
      curMonth = null;
      if (group.year !== null) {
        const div = document.createElement("div");
        div.className = "grid-year-divider";
        div.textContent = group.year;
        grid.appendChild(div);
      }
    }
    if (group.month !== curMonth) {
      curMonth = group.month;
      if (group.month !== null) {
        const div = document.createElement("div");
        div.className = "grid-month-divider";
        div.textContent = MONTH_NAMES[group.month];
        grid.appendChild(div);
      }
    }

    const sec = document.createElement("div");
    sec.className = `face-group-section group-tint-${groupIdx % 6}`;

    const title = group.date
      ? `${DAY_ABBRS[group.date.getDay()]} ${group.day}`
      : "Undated";
    const count = group.photos.length;
    const isIsolated = group.key !== null && dayIsolation === group.key;
    const taggedInDay   = group.photos.filter(({ photo }) => photo.lat != null && photo.lng != null);
    const untaggedInDay = group.photos.filter(({ photo }) => photo.lat == null);

    sec.appendChild(faceGroupHeader({
      title,
      meta: `· ${count} photo${count !== 1 ? "s" : ""}`,
      buttons: group.key ? [
        {
          icon: "📍",
          label: isIsolated ? "Show all days on map" : "Show only this day on map",
          title: isIsolated ? "Show all days on map" : "Show only this day on map",
          kind: isIsolated ? "active" : "",
          onClick: () => isolateDay(group.key),
        },
        {
          icon: "⛶",
          label: "Zoom to this day",
          title: taggedInDay.length
            ? `Zoom map to fit ${taggedInDay.length} geotagged photo${taggedInDay.length !== 1 ? "s" : ""} on this day`
            : "No geotagged photos on this day",
          disabled: taggedInDay.length === 0,
          onClick: () => {
            const bounds = L.latLngBounds(taggedInDay.map(({ photo }) => [photo.lat, photo.lng]));
            map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 16, duration: 0.8 });
          },
        },
        {
          icon: "☐",
          label: "Select untagged",
          title: untaggedInDay.length
            ? `Select ${untaggedInDay.length} untagged photo${untaggedInDay.length !== 1 ? "s" : ""} on this day`
            : "No untagged photos on this day",
          disabled: untaggedInDay.length === 0,
          onClick: () => {
            selectedIds.clear();
            untaggedInDay.forEach(({ photo }) => selectedIds.add(photo.id));
            refreshSelectionUI();
            setStatus(`Selected ${untaggedInDay.length} untagged photo(s) on ${title}.`);
          },
        },
      ] : [],
    }));

    const cells = document.createElement("div");
    cells.className = "face-group-cells";
    group.photos.forEach(({ photo, idx }) => cells.appendChild(makeThumbCell(photo, idx)));
    sec.appendChild(cells);
    grid.appendChild(sec);
    groupIdx++;
  });
}

function handleThumbClick(e, id, idx) {
  if (e.shiftKey && lastClickedIndex >= 0) {
    const lo = Math.min(lastClickedIndex, idx);
    const hi = Math.max(lastClickedIndex, idx);
    for (let i = lo; i <= hi; i++) selectedIds.add(filteredPhotos[i].id);
  } else if (e.ctrlKey || e.metaKey) {
    selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
  } else {
    selectedIds.clear();
    selectedIds.add(id);
  }
  lastClickedIndex = idx;
  refreshSelectionUI();
  showDetail(id);
  const photo = filteredPhotos[idx];
  showAccuracyCircle(photo);
  if (photo?.lat != null) map.flyTo([photo.lat, photo.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
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
function makePinIcon(color, isImprecise = false) {
  // SVG teardrop pin. Outline is a slightly darker shade for contrast.
  const strokeDash = isImprecise ? 'stroke-dasharray="3,2"' : '';
  const innerCircle = isImprecise
    ? `<circle cx="12" cy="12" r="5" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.2" stroke-dasharray="1.5,1"/>`
    : `<circle cx="12" cy="12" r="5" fill="rgba(255,255,255,0.35)"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="0 0 24 34">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 8 12 22 12 22s12-14 12-22C24 5.373 18.627 0 12 0z"
          fill="${color}" stroke="rgba(0,0,0,0.55)" stroke-width="1.5" ${strokeDash}/>
    ${innerCircle}
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
  const isolatedSet = dayIsolation
    ? new Set(filteredPhotos.filter(p => dayKey(p) === dayIsolation).map(p => p.id))
    : null;
  const inScope = new Set(filteredPhotos.map(p => p.id));
  Object.entries(markersById).forEach(([id, m]) => {
    const nid = Number(id);
    if (!inScope.has(nid) || (isolatedSet && !isolatedSet.has(nid))) {
      m.remove();
      delete markersById[id];
    }
  });
  filteredPhotos.forEach((photo) => {
    if (isolatedSet && !isolatedSet.has(photo.id)) return;
    if (photo.lat != null && photo.lng != null) addOrUpdateMarker(photo);
  });
}

function addOrUpdateMarker(photo) {
  const color = camColor(photo.camera);
  const isImprecise = photo.gps_accuracy && photo.gps_accuracy > 30;
  if (markersById[photo.id]) {
    markersById[photo.id].setLatLng([photo.lat, photo.lng]);
    markersById[photo.id].setIcon(makePinIcon(color, isImprecise));
    return;
  }
  const marker = L.marker([photo.lat, photo.lng], {
    draggable: true,
    icon: makePinIcon(color, isImprecise),
  }).addTo(map);

  marker.on("click", () => {
    selectedIds.clear();
    selectedIds.add(photo.id);
    refreshSelectionUI();
    showDetail(photo.id);
    showAccuracyCircle(photo);
  });

  marker.on("dragend", async () => {
    const ll = marker.getLatLng();
    let accuracy = null;
    const toggle = document.getElementById("imprecise-toggle");
    if (toggle && toggle.checked) {
      const radiusSelect = document.getElementById("imprecise-radius-select");
      accuracy = parseFloat(radiusSelect.value);
    }
    await geotag([photo.id], ll.lat, ll.lng, accuracy);
  });

  markersById[photo.id] = marker;
}

async function geotag(ids, lat, lng, accuracy = null) {
  setStatus(`Geotagging ${ids.length} photo(s)…`);
  try {
    const res = await fetch("/api/geotag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, lat, lng, gps_accuracy: accuracy }),
    });
    const updated = await res.json();
    updated.forEach((u) => {
      const photo = photos.find((p) => p.id === u.id);
      if (photo) {
        photo.lat = u.lat;
        photo.lng = u.lng;
        photo.geotag_source = u.geotag_source;
        photo.gps_accuracy = u.gps_accuracy;
      }
      addOrUpdateMarker({ id: u.id, lat: u.lat, lng: u.lng,
        filename: photo?.filename || "", camera: photo?.camera,
        gps_accuracy: u.gps_accuracy });
    });
    renderGrid();
    const accLog = accuracy ? ` (accuracy: ±${accuracy}m)` : "";
    setStatus(`Tagged ${updated.length} photo(s) at ${lat.toFixed(5)}, ${lng.toFixed(5)}${accLog}`);
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

function formatAccuracy(meters) {
  if (meters == null || meters <= 0) return "—";
  if (meters >= 160.934) {
    const miles = meters / 1609.344;
    let milesStr = miles.toFixed(2);
    if (milesStr.endsWith(".00")) milesStr = miles.toFixed(0);
    else if (milesStr.endsWith("0")) milesStr = miles.toFixed(1);
    
    let kmStr = (meters / 1000).toFixed(2);
    if (kmStr.endsWith(".00")) kmStr = (meters / 1000).toFixed(0);
    else if (kmStr.endsWith("0")) kmStr = (meters / 1000).toFixed(1);

    return `±${milesStr} miles (~${kmStr} km)`;
  }
  return `±${meters.toFixed(1)} m`;
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

    // Reverse-geocoded place name (city / state / country), when available.
    const loc = data.location;
    const placeStr = loc
      ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ")
      : null;

    const rows = [
      ["File", data.filename],
      ["Type", data.media_type],
      ["Camera", data.camera || "—"],
      ["Date", data.datetime || "—"],
      ["Dimensions", data.dimensions || "—"],
      ["Latitude", data.lat != null ? data.lat.toFixed(6) : "—"],
      ["Longitude", data.lng != null ? data.lng.toFixed(6) : "—"],
      ["Location", placeStr || "—"],
      ["GPS accuracy", formatAccuracy(data.gps_accuracy)],
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
    const window = document.getElementById("window-select").value;
    const res = await fetch(`/api/guess/${focusedPhotoId}?window=${window}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.detail || "No nearby geotagged photos found", true);
      return;
    }

    guessPending = { lat: data.lat, lng: data.lng };

    // Draw matched context polygons (faint green outline)
    if (data.contexts && data.contexts.length) {
      data.contexts.forEach(ctx => {
        const layer = L.polygon(ctx.polygon.map(v => [v[0], v[1]]), {
          color: "#4a8", fillColor: "#4a8", fillOpacity: 0.08, weight: 2, dashArray: "6,3",
        }).addTo(map).bindTooltip(ctx.name, { sticky: true });
        guessContextLayers.push(layer);
      });
    }

    // Place source photo pins (before=blue, after=green, brightness by proximity)
    data.sources.forEach(src => {
      const icon = makeSourcePinIcon(src.delta_sec, src.is_before, data.window_sec);
      const mins = src.delta_sec < 60
        ? `${src.delta_sec}s`
        : `${Math.round(src.delta_sec / 60)}min`;
      const direction = src.is_before ? "before" : "after";
      const popupHtml = `
        <div class="source-popup">
          <img src="/api/thumbnail/${src.id}" alt="${src.filename}"/>
          <div class="source-popup-label">${src.filename}</div>
          <div class="source-popup-time">${mins} ${direction}</div>
        </div>`;
      const m = L.marker([src.lat, src.lng], { icon, interactive: true })
        .addTo(map)
        .bindPopup(popupHtml, { maxWidth: 160, className: "source-popup-wrap" });
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

    // Fit map to include source pins, context polygons, and the guess pin
    const allPoints = [[data.lat, data.lng], ...data.sources.map(s => [s.lat, s.lng])];
    if (data.contexts && data.contexts.length) {
      data.contexts.forEach(ctx => ctx.polygon.forEach(v => allPoints.push([v[0], v[1]])));
    }
    map.flyToBounds(L.latLngBounds(allPoints).pad(0.3), { duration: 1, maxZoom: 16 });

    // Build summary text
    let summaryText;
    if (data.source === "context-centroid") {
      const ctxNames = (data.contexts || []).map(c => c.name).join(", ");
      summaryText = `No time neighbors — center of context: ${ctxNames}`;
    } else {
      const srcList = data.sources.slice(0, 3)
        .map(s => {
          const mins = s.delta_sec < 60 ? `${s.delta_sec}s` : `${Math.round(s.delta_sec / 60)}min`;
          return `${s.filename} (${mins} ${s.is_before ? "before" : "after"})`;
        })
        .join(", ");
      const more = data.source_count > 3 ? ` +${data.source_count - 3} more` : "";
      summaryText = `Based on ${data.source_count} nearby photo${data.source_count > 1 ? "s" : ""}: ${srcList}${more}`;
    }
    document.getElementById("guess-summary").textContent = summaryText;
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
  guessContextLayers.forEach(l => l.remove());
  guessContextLayers = [];
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

/* ── GPS accuracy circle ── */
function showAccuracyCircle(photo) {
  if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; }
  if (photo?.lat == null || !(photo.gps_accuracy > 0)) return;
  const color = camColor(photo.camera);
  accuracyCircle = L.circle([photo.lat, photo.lng], {
    radius: photo.gps_accuracy,
    color,
    fillColor: color,
    fillOpacity: 0.12,
    weight: 1.5,
    opacity: 0.5,
    interactive: false,
  }).addTo(map);
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

  const canvas = document.getElementById("hist-canvas");
  const tooltip = document.createElement("div");
  tooltip.id = "hist-tooltip";
  document.body.appendChild(tooltip);

  canvas.addEventListener("mousemove", (e) => {
    if (!histBuckets.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const bucketIdx = Math.min(
      Math.floor((x / rect.width) * histBuckets.length),
      histBuckets.length - 1
    );
    const bucket = histBuckets[bucketIdx];
    if (!bucket) return;

    const d = new Date(bucket.ts * 1000);
    let label;
    if (histBucketSecs <= 86400) {
      label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    } else if (histBucketSecs <= 86400 * 7) {
      const end = new Date((bucket.ts + histBucketSecs - 86400) * 1000);
      label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
              " – " + end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } else {
      label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    if (bucket.count) label += ` · ${bucket.count}`;

    tooltip.textContent = label;
    tooltip.style.display = "block";
    // Keep tooltip inside viewport
    const tipW = tooltip.offsetWidth;
    const left = Math.min(e.clientX + 12, window.innerWidth - tipW - 8);
    tooltip.style.left = left + "px";
    tooltip.style.top = (e.clientY - 32) + "px";
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });
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
  histBucketSecs = bucketSecs;

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
