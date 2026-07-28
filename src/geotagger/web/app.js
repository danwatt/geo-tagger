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
let undatedMode = false;  // true when browsing the Undated queue instead of a month/year

/* ── Geotag staging state ──
 * A drop on the map doesn't write: the point is reverse-geocoded, the photos are
 * pulled out of the grid and parked here under the resolved place name, and a
 * provisional pin marks the spot until the change is committed or reverted.
 * See the "Geotag staging" section for the details. */
let pendingGeo = new Map();      // photo id → { photo, lat, lng, accuracy, loc, label }
let pendingGeoMarkers = [];      // provisional pins/circles, rebuilt on every render
const geocodeLabelCache = new Map();   // "lat,lng" (4dp) → { loc, label }

/* ── Places state ── */
let places = [];
let placeShapes = {};  // place_id -> L.Rectangle or L.Circle
let drawingMode = null;  // null | "area-select"
let drawingShape = null;  // temporary shape being drawn

/* ── Area selection state ── */
let areaSelectMode = false;
let areaSelectCircle = null;
let areaSelectParams = null;  // { lat, lng, radius }

/* ── Place filter state ── */
let placeFilterParams = null;  // { placeId } — active saved-place bounds filter
let placeFilterRect = null;    // L.Rectangle drawn for the (buffered) search bounds

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
  await loadHotspots();
  await loadContextsDropdown();
  await fitMapToAllLocations();

  // A "?month=YYYY-MM" URL argument (e.g. from the homepage month charts)
  // jumps straight to that month, same as picking it from the Month Picker.
  // "?month=undated" (from the homepage's Undated link) jumps to the Undated
  // queue instead.
  const monthArg = new URLSearchParams(window.location.search).get("month");
  const monthMatch = monthArg && monthArg.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    await selectMonth(parseInt(monthMatch[1], 10), parseInt(monthMatch[2], 10));
  } else if (monthArg === "undated") {
    await selectUndated();
  } else {
    setStatus("Click 'Select Month' to begin");
  }
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
  map.on("moveend", correctWorldWrap);
  map.on("moveend", () => reloadHotspotsIfRelative("near"));
  map.on("zoomend", onZoomChanged);

  const mapPane = document.getElementById("map-pane");
  let dragAccuracyCircle = null;

  // Where a drag currently sits on the map, in map coordinates.
  const dragLatLng = (e) => {
    const rect = document.getElementById("map").getBoundingClientRect();
    return map.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top));
  };

  mapPane.addEventListener("dragover", (e) => {
    e.preventDefault();
    mapPane.classList.add("drop-target");
    const latlng = dragLatLng(e);
    showSnapPreview(latlng.lat, latlng.lng);

    const toggle = document.getElementById("imprecise-toggle");
    if (toggle && toggle.checked) {
      const radiusSelect = document.getElementById("imprecise-radius-select");
      const radius = parseFloat(radiusSelect.value);

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
    clearSnapPreview();
  });

  mapPane.addEventListener("drop", async (e) => {
    e.preventDefault();
    mapPane.classList.remove("drop-target");
    cleanupDragCircle();
    clearSnapPreview();
    const ids = JSON.parse(e.dataTransfer.getData("application/json") || "[]");
    if (!ids.length) return;
    const latlng = dragLatLng(e);

    // A near-miss on a place already in the palette lands on that place exactly,
    // so repeat visits stop drifting a few hundred feet apart.
    const point = snapPoint(latlng.lat, latlng.lng);
    const note = point.snapped
      ? ` Snapped ${Math.round(point.snapped.meters)} m to a place you already use.`
      : "";
    await stageDrop(ids, point.lat, point.lng, currentDropAccuracy(), note);
  });
}

// Leaflet projects longitude linearly with no wraparound, so continuous
// horizontal dragging lets the map's own center drift past +/-180. Pins are
// placed at their canonical (wrapped) lat/lng, so once the view has drifted a
// full world away, they'd render a full world-width off screen. Silently
// re-centering to the CRS-wrapped equivalent view fixes this — visually a
// no-op, since Leaflet's tile rendering is already seamless across world
// copies — and keeps the map's own coordinate system from drifting further.
function correctWorldWrap() {
  const center = map.getCenter();
  const wrapped = map.wrapLatLng(center);
  if (Math.abs(wrapped.lng - center.lng) > 1e-9) {
    map.setView(wrapped, map.getZoom(), { animate: false });
  }
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
    } else if (placeFilterParams) {
      const place = places.find(p => p.id === placeFilterParams.placeId);
      if (place) filterPhotosByPlace(place);
    }
  }
  // Show is a pure client-side view of the already-loaded scope — no reload.
  document.getElementById("filter-select").addEventListener("change", () => applyFilters());
  document.getElementById("include-screenshots-chk").addEventListener("change", () => applyFilters());
  document.getElementById("window-select").addEventListener("change", reloadCurrentView);
  document.getElementById("place-search-btn").addEventListener("click", doPlaceSearch);
  document.getElementById("place-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doPlaceSearch();
  });
  document.getElementById("apply-latlng-btn").addEventListener("click", doApplyLatLng);
  document.getElementById("copy-location-btn").addEventListener("click", doCopyLocation);
  document.getElementById("remove-geotag-btn").addEventListener("click", doRemoveGeotag);
  document.getElementById("mark-ignored-btn").addEventListener("click", () => doSetGeocodeIgnored(true));
  document.getElementById("unmark-ignored-btn").addEventListener("click", () => doSetGeocodeIgnored(false));

  document.getElementById("commit-all-btn").addEventListener("click",
    () => commitPendingGeo(groupPendingGeo()));
  document.getElementById("revert-all-btn").addEventListener("click",
    () => revertPendingGeo(groupPendingGeo()));
  // Staged drops live only in this tab — don't let a reload eat a tagging pass.
  window.addEventListener("beforeunload", (e) => {
    if (!pendingGeo.size) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // Places — dropdown selects a saved place to jump to. Creating/editing places
  // lives on the Custom Places page (custom-places.html).
  document.getElementById("places-select").addEventListener("change", onPlaceSelected);
  // Changing the buffer re-runs the active place filter with the new bounds.
  document.getElementById("place-buffer-select").addEventListener("change", () => {
    if (placeFilterParams) reloadCurrentView();
  });

  // Imprecise drop toggle
  const impreciseToggle = document.getElementById("imprecise-toggle");
  const impreciseRadiusSelect = document.getElementById("imprecise-radius-select");
  if (impreciseToggle && impreciseRadiusSelect) {
    impreciseToggle.addEventListener("change", () => {
      impreciseRadiusSelect.style.display = impreciseToggle.checked ? "inline-block" : "none";
    });
  }

  // Location palette
  document.getElementById("palette-sort").addEventListener("change", (e) => {
    hotspotSort = e.target.value;
    loadHotspots();
  });
  document.getElementById("palette-refresh").addEventListener("click", loadHotspots);
  document.getElementById("snap-toggle").addEventListener("change", (e) => {
    snapEnabled = e.target.checked;
    if (!snapEnabled) clearSnapPreview();
  });
  bindHotspotKeys();
  bindProposeBar();

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

    if (data.undated && data.undated.total > 0) {
      const item = document.createElement("div");
      item.className = "month-item";
      item.innerHTML = `
        <div class="month-name">📁 Undated</div>
        <div class="month-counts">
          <span class="count-badge count-total">${data.undated.total} total</span>
          <span class="count-badge count-geotagged">${data.undated.geotagged} geotagged</span>
          <span class="count-badge count-not-geotagged">${data.undated.not_geotagged} not geotagged</span>
        </div>
      `;
      item.addEventListener("click", selectUndated);
      list.appendChild(item);
    }

    if (!data.months || data.months.length === 0) {
      if (!data.undated || data.undated.total === 0) {
        list.innerHTML = "<p>No photos found with timestamps.</p>";
      }
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
  undatedMode = false;
  document.getElementById("timeline").style.display = "";
  hideMonthPicker();

  // Clear area and context selections
  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearPlaceFilter();
  clearContextFilter();

  // Update label
  document.getElementById("selected-month-label").textContent =
    `${MONTH_NAMES[month - 1]} ${year}`;

  // Load photos for this month (loadPhotos builds the timeline from them)
  await loadPhotos(true);
}

async function selectYear(year) {
  selectedYear = year;
  selectedMonth = null;
  dayIsolation = null;
  undatedMode = false;
  document.getElementById("timeline").style.display = "";
  hideMonthPicker();

  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearPlaceFilter();
  clearContextFilter();

  document.getElementById("selected-month-label").textContent = `${year} (all months)`;

  await loadPhotos(true);
}

// The Undated queue: photos with no timestamp at all, so there's no month/day
// to drill into — no histogram, no day timeline, just the grid (grouped by
// location if geotagged despite the missing date, else by containing directory
// — see renderGrid's undatedSubGroups).
async function selectUndated() {
  selectedYear = null;
  selectedMonth = null;
  dayIsolation = null;
  undatedMode = true;
  hideMonthPicker();

  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearPlaceFilter();
  clearContextFilter();

  document.getElementById("selected-month-label").textContent = "Undated photos";
  document.getElementById("timeline").style.display = "none";

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

    // Read-only display. Creating/editing/deleting places is done on the
    // Custom Places page (custom-places.html); here shapes are just jump targets.
    if (p.type === "rectangle") {
      shape = L.rectangle([[bounds.south, bounds.west], [bounds.north, bounds.east]], {
        color: "#4a90d9",
        weight: 2,
        fillOpacity: 0.1
      });
    } else if (p.type === "circle") {
      shape = L.circle([bounds.lat, bounds.lng], {
        radius: bounds.radius,
        color: "#4a90d9",
        weight: 2,
        fillOpacity: 0.1
      });
    }

    if (shape) {
      shape.bindTooltip(p.name, { permanent: false, direction: "top" });
      shape.addTo(map);
      placeShapes[p.id] = shape;
    }
  });
}

function onPlaceSelected(e) {
  const placeId = parseInt(e.target.value);
  if (!placeId) { clearPlaceFilter(); return; }

  const place = places.find(p => p.id === placeId);
  if (!place) return;

  filterPhotosByPlace(place);
}

// Bounding box of a saved place, grown outward by `bufferMiles` on every side.
// Circles collapse to their bounding box first — the user asked for a "bounds"
// filter, and a box keeps rectangles and circles on the same code path (and the
// same rectangular /api/photos/by-bounds query).
function placeBboxWithBuffer(place, bufferMiles) {
  const b = JSON.parse(place.bounds);
  let south, north, west, east;
  if (place.type === "rectangle") {
    ({ south, north, west, east } = b);
  } else {  // circle
    const latOff = b.radius / 111000;
    const lngOff = b.radius / (111000 * Math.cos(b.lat * Math.PI / 180));
    south = b.lat - latOff; north = b.lat + latOff;
    west = b.lng - lngOff;  east = b.lng + lngOff;
  }
  const meters = (bufferMiles || 0) * 1609.34;
  const latBuf = meters / 111000;
  const midLat = (south + north) / 2;
  const lngBuf = meters / (111000 * Math.cos(midLat * Math.PI / 180));
  return {
    min_lat: south - latBuf, max_lat: north + latBuf,
    min_lng: west - lngBuf,  max_lng: east + lngBuf,
  };
}

// Filter the grid/map to photos inside a saved place's (buffered) bounds. Takes
// over as the active view, clearing month/area/context selections like the other
// selectors do.
async function filterPhotosByPlace(place) {
  // Clear the other view modes
  selectedYear = null;
  selectedMonth = null;
  undatedMode = false;
  document.getElementById("selected-month-label").textContent = "No month selected";
  areaSelectParams = null;
  if (areaSelectCircle) { map.removeLayer(areaSelectCircle); areaSelectCircle = null; }
  clearContextFilter();

  const bufferMiles = parseFloat(document.getElementById("place-buffer-select").value) || 0;
  const box = placeBboxWithBuffer(place, bufferMiles);
  placeFilterParams = { placeId: place.id };

  // Draw (and zoom to) the search bounds so the buffer is visible.
  if (placeFilterRect) map.removeLayer(placeFilterRect);
  placeFilterRect = L.rectangle([[box.min_lat, box.min_lng], [box.max_lat, box.max_lng]], {
    color: "#4a90d9", weight: 2, dashArray: "5,5", fillOpacity: 0.05,
  }).addTo(map);
  map.fitBounds(placeFilterRect.getBounds().pad(0.1));

  const label = bufferMiles > 0
    ? `${place.name} (+${bufferMiles} mi)` : place.name;
  document.getElementById("selected-area-label").textContent = label;

  await loadPhotosByBounds(box, label);
}

async function loadPhotosByBounds(box, label) {
  dayIsolation = null;
  const window = document.getElementById("window-select").value;

  try {
    setStatus(`Loading photos in ${label}…`);
    const url = `/api/photos/by-bounds?min_lat=${box.min_lat}&max_lat=${box.max_lat}`
      + `&min_lng=${box.min_lng}&max_lng=${box.max_lng}&geotagged=all&window=${window}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    photos = await res.json();
    photos.forEach(p => camColor(p.camera));
    renderLegend();
    buildHistogram();
    applyFilters(false);  // don't re-fit — we already zoomed to the bounds

    setStatus(`Loaded ${photos.length} photos in ${label}`);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

function clearPlaceFilter() {
  placeFilterParams = null;
  if (placeFilterRect) { map.removeLayer(placeFilterRect); placeFilterRect = null; }
  const sel = document.getElementById("places-select");
  if (sel) sel.value = "";
}

// Shared by the Area Selection feature below (its onAreaSelectStart records the
// drag origin here). Place drawing/creation moved to the Custom Places page.
let drawStartLatLng = null;

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
  clearPlaceFilter();

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

  const url = `/api/photos?geotagged=all&context_id=${ctx.id}`;

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
    stopAreaSelection();
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

  // Clear month, place, and context selections
  selectedYear = null;
  selectedMonth = null;
  document.getElementById("selected-month-label").textContent = "No month selected";
  clearPlaceFilter();
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
  const window = document.getElementById("window-select").value;

  try {
    setStatus("Loading photos in area...");
    const res = await fetch(`/api/photos/by-area?lat=${lat}&lng=${lng}&radius=${radius}&geotagged=all&window=${window}`);

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

/* ── Load photos ── */
async function loadPhotos(fitMap = false) {
  if (!selectedYear && !undatedMode) {
    setStatus("Please select a month first", true);
    return;
  }

  // Always the whole scope — the Show filter is applied in applyFilters, so the
  // histogram counts every photo in the month and not just the visible ones.
  let url;
  if (undatedMode) {
    url = `/api/photos?geotagged=all&undated=true`;
  } else {
    let dateFrom, dateTo;
    if (selectedMonth) {
      dateFrom = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
      dateTo = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${lastDay}`;
    } else {
      dateFrom = `${selectedYear}-01-01`;
      dateTo = `${selectedYear}-12-31`;
    }
    url = `/api/photos?geotagged=all&date_from=${dateFrom}&date_to=${dateTo}`;
  }

  try {
    const res = await fetch(url);
    photos = await res.json();
    // Pre-assign colors so the legend order is stable
    photos.forEach(p => camColor(p.camera));
    renderLegend();
    if (undatedMode) {
      histBuckets = [];  // no dates here — the timeline stays hidden
    } else {
      buildHistogram();
    }
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
    if (p.lat != null || p.geocode_ignored) e.tagged++; else e.untagged++;
  });
  const mixedKeys = new Set(
    [...dayCounts.entries()].filter(([, v]) => v.tagged > 0 && v.untagged > 0).map(([k]) => k)
  );
  return photoList.filter(p => mixedKeys.has(dayKey(p) || "__undated__"));
}

// "Geotagged" for the Show filter means it needs no location: either it has one,
// or it's been marked as not needing one. Mirrors index.get_photos' SQL so the
// client-side filter and the server's agree.
function isGeotagged(photo) {
  return photo.lat != null || !!photo.geocode_ignored;
}

/* ── Apply all active filters → filteredPhotos ──
 * Every view loads its whole scope (geotagged=all) and filters here, so the
 * timeline histogram can describe the whole scope while the grid shows a subset,
 * and so flipping Show is instant instead of a round trip. */
function applyFilters(fitMap = false) {
  const includeScreenshots = document.getElementById("include-screenshots-chk").checked;
  const showFilter = document.getElementById("filter-select").value;
  filteredPhotos = photos.filter(p => {
    if (hiddenCameras.has(p.camera || "Unknown")) return false;
    if (!includeScreenshots && /\.png$/i.test(p.filename)) return false;
    if (showFilter === "yes" && !isGeotagged(p)) return false;
    if (showFilter === "no" && isGeotagged(p)) return false;
    if (dateRangeMin !== dateRangeMax) {
      const ts = p.photo_datetime || 0;
      if (ts > 0 && (ts < dateFilterLo || ts > dateFilterHi)) return false;
    }
    return true;
  });
  if (showFilter === "mixed") {
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
    (photo.lat != null ? " tagged" : "") +
    (photo.geocode_ignored ? " geo-ignored" : "");
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
  cell.addEventListener("contextmenu", (e) => openPhotoContextMenu(e, photo));
  return cell;
}

/* ── Photo right-click menu: set a photo as a named place's representative ── */
let photoCtxMenuEl = null;

function closePhotoContextMenu() {
  if (photoCtxMenuEl) { photoCtxMenuEl.remove(); photoCtxMenuEl = null; }
  document.removeEventListener("click", onPhotoCtxOutside, true);
  document.removeEventListener("keydown", onPhotoCtxKey, true);
}
function onPhotoCtxOutside(e) {
  if (photoCtxMenuEl && !photoCtxMenuEl.contains(e.target)) closePhotoContextMenu();
}
function onPhotoCtxKey(e) { if (e.key === "Escape") closePhotoContextMenu(); }

function openPhotoContextMenu(e, photo) {
  e.preventDefault();
  closePhotoContextMenu();

  const menu = document.createElement("div");
  menu.className = "photo-ctx-menu";

  const header = document.createElement("div");
  header.className = "photo-ctx-header";
  header.textContent = "Representative photo for place…";
  menu.appendChild(header);

  if (!places.length) {
    const empty = document.createElement("div");
    empty.className = "photo-ctx-empty";
    empty.textContent = "No saved places";
    menu.appendChild(empty);
  } else {
    places.forEach(place => {
      const item = document.createElement("div");
      item.className = "photo-ctx-item";
      const isRep = place.representative_photo_id === photo.id;
      // ✓ marks the place this photo already represents — clicking it clears.
      item.textContent = (isRep ? "✓ " : "") + place.name;
      item.addEventListener("click", () => {
        closePhotoContextMenu();
        setPlaceRepresentative(place, isRep ? null : photo.id);
      });
      menu.appendChild(item);
    });
  }

  document.body.appendChild(menu);
  // Position at the cursor, clamped inside the viewport.
  const rect = menu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;
  photoCtxMenuEl = menu;

  // Defer wiring the dismiss handlers so this same right-click's follow-up
  // events don't immediately close the menu.
  setTimeout(() => {
    document.addEventListener("click", onPhotoCtxOutside, true);
    document.addEventListener("keydown", onPhotoCtxKey, true);
  }, 0);
}

async function setPlaceRepresentative(place, photoId) {
  try {
    const res = await fetch(`/api/places/${place.id}/representative`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_id: photoId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.representative_photo_id = photoId;  // keep the local list in sync
    setStatus(photoId
      ? `Set representative photo for "${place.name}"`
      : `Cleared representative photo for "${place.name}"`);
  } catch (err) {
    setStatus("Failed to set representative: " + err.message, true);
  }
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  // Group filteredPhotos into calendar-day buckets. Photos with a staged
  // location have moved to the staging area below, so they're skipped here —
  // `idx` still indexes into filteredPhotos, which shift-range select needs.
  const dayGroups = [];
  let curGroup = null;
  filteredPhotos.forEach((photo, idx) => {
    if (pendingGeo.has(photo.id)) return;
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

    // The Undated day-bucket (group.key === null) collapses every dateless photo
    // into one pile — split it further by resolved location (for the few that are
    // geotagged despite missing a timestamp) or else by containing directory, so a
    // large undated backlog isn't one giant unsorted section. Dated days pass
    // through as a single "sub-group" so the loop below is a no-op for them.
    const subGroups = group.date
      ? [{ place: null, dir: null, photos: group.photos }]
      : undatedSubGroups(group.photos);

    subGroups.forEach(sub => {
      const sec = document.createElement("div");
      sec.className = `face-group-section group-tint-${groupIdx % 6}`;

      const title = group.date
        ? `${DAY_ABBRS[group.date.getDay()]} ${group.day}`
        : sub.place ? `📍 ${sub.place}` : sub.dir ? `📁 ${sub.dir}` : "Undated";
      const count = sub.photos.length;
      const isIsolated = group.key !== null && dayIsolation === group.key;
      const taggedInDay   = sub.photos.filter(({ photo }) => photo.lat != null && photo.lng != null);
      const untaggedInDay = sub.photos.filter(({ photo }) => photo.lat == null && !photo.geocode_ignored);

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
      sub.photos.forEach(({ photo, idx }) => cells.appendChild(makeThumbCell(photo, idx)));
      sec.appendChild(cells);
      grid.appendChild(sec);
      groupIdx++;
    });
  });

  // The grid and the staging area are two views of the same photo list — a
  // staged photo leaves one and appears in the other — so they render together.
  renderPendingGeo();
}

// Buckets one day-group's undated photos by resolved location (locationKey,
// from face-grid.js — same {city, sublocation, state, country} shape as the
// People page) if geotagged despite the missing timestamp, else by containing
// directory (dirLabel, also from face-grid.js).
function undatedSubGroups(photoEntries) {
  const buckets = new Map();
  photoEntries.forEach(entry => {
    const loc = locationKey(entry.photo);
    const dir = loc ? null : dirLabel(entry.photo);
    const key = loc ? `loc:${loc}` : `dir:${dir}`;
    let b = buckets.get(key);
    if (!b) { b = { place: loc || null, dir, photos: [] }; buckets.set(key, b); }
    b.photos.push(entry);
  });
  return [...buckets.values()];
}

function handleThumbClick(e, id, idx) {
  if (e.shiftKey && lastClickedIndex >= 0) {
    const lo = Math.min(lastClickedIndex, idx);
    const hi = Math.max(lastClickedIndex, idx);
    // Staged photos aren't in the grid, so a range drawn over them skips them.
    for (let i = lo; i <= hi; i++) {
      if (!pendingGeo.has(filteredPhotos[i].id)) selectedIds.add(filteredPhotos[i].id);
    }
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
  // Every selection change is a chance to answer "where was this?" up front —
  // this is the single funnel every selection path goes through.
  scheduleProposal();
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
    // Dragging a pin is the same "put this photo here" gesture as a grid drop, so
    // it stages too. This marker keeps showing the *saved* position; the staged
    // one gets a provisional pin until it's committed.
    const cur = photos.find((p) => p.id === photo.id);
    if (cur && cur.lat != null) marker.setLatLng([cur.lat, cur.lng]);
    await stageDrop([photo.id], ll.lat, ll.lng, accuracy);
  });

  markersById[photo.id] = marker;
}

// Writes the location to `ids`. Returns true on success — commitPendingGeo uses
// that to decide whether a staged batch can be cleared or has to stay put.
async function geotag(ids, lat, lng, accuracy = null) {
  setStatus(`Geotagging ${ids.length} photo(s)…`);
  try {
    const res = await fetch("/api/geotag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, lat, lng, gps_accuracy: accuracy }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    return true;
  } catch (err) {
    setStatus("Geotag error: " + err.message, true);
    return false;
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

/* ── Ignore for geocoding (e.g. screenshots) ── */
async function setGeocodeIgnored(ids, ignored) {
  if (!ids.length) return false;
  try {
    await fetch("/api/geotag/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, ignored }),
    });
    ids.forEach((id) => {
      const photo = photos.find((p) => p.id === id);
      if (photo) photo.geocode_ignored = ignored;
    });
    applyFilters();
    if (focusedPhotoId && ids.includes(focusedPhotoId)) showDetail(focusedPhotoId);
    return true;
  } catch (err) {
    setStatus("Error: " + err.message, true);
    return false;
  }
}

async function doSetGeocodeIgnored(ignored) {
  if (!selectedIds.size) { setStatus("No photos selected", true); return; }
  const ids = [...selectedIds];
  setStatus(`${ignored ? "Marking" : "Un-marking"} ${ids.length} photo(s)…`);
  const ok = await setGeocodeIgnored(ids, ignored);
  if (ok) setStatus(`${ignored ? "Marked" : "Un-marked"} ${ids.length} photo(s) as ignored for geocoding`);
}

/* ── Manual lat/lng ── */
async function doApplyLatLng() {
  const lat = parseFloat(document.getElementById("lat-input").value);
  const lng = parseFloat(document.getElementById("lng-input").value);
  if (isNaN(lat) || isNaN(lng)) { setStatus("Invalid lat/lng", true); return; }
  if (!selectedIds.size) { setStatus("No photos selected", true); return; }
  await stageDrop([...selectedIds], lat, lng, null);
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

    // "View full size" — RAW only. Opens an on-the-fly full-resolution LibRaw
    // decode (with face boxes drawn) in a new tab (see photo-fullsize.js).
    const isRaw = isRawName(data.filename);
    const fullBtn = document.getElementById("view-fullsize-btn");
    fullBtn.style.display = isRaw ? "" : "none";
    fullBtn.onclick = () => openFullSize(id);

    document.getElementById("photo-faces-btn").onclick = () => {
      window.location.href =
        `/photo-faces.html?photo_id=${id}&back=${encodeURIComponent(location.pathname + location.search)}`;
    };

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
      ["Ignore for geocoding", `<label class="inline-toggle"><input type="checkbox" id="detail-ignore-chk" ${data.geocode_ignored ? "checked" : ""}/> not applicable (e.g. screenshot)</label>`],
    ];
    const table = document.getElementById("detail-meta");
    table.innerHTML = rows.map(([k, v]) =>
      `<tr><td>${k}</td><td>${v ?? "—"}</td></tr>`
    ).join("");
    document.getElementById("detail-ignore-chk").addEventListener("change", (e) => {
      setGeocodeIgnored([id], e.target.checked);
    });

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
    reloadHotspotsIfRelative("time");   // nothing dated on screen to rank against
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
  // The date span just moved, which is what "Nearby (time)" ranks against.
  reloadHotspotsIfRelative("time");
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

  // Bucket the visible photos by camera in one pass. Doing this per bar meant a
  // full scan of filteredPhotos for every bucket, on every slider tick.
  const camCountsByBucket = histBuckets.map(() => new Map());
  filteredPhotos.forEach(p => {
    const ts = p.photo_datetime;
    if (!ts || ts <= 0) return;
    // histBucketSecs, not span/n — buildHistogram sizes the array as
    // ceil(span / histBucketSecs) + 1, so span/n is a different (wrong) width
    // and slid every photo into the neighbouring column.
    const i = Math.floor((ts - dateRangeMin) / histBucketSecs);
    if (i < 0 || i >= n) return;
    const cam = p.camera || "Unknown";
    const m = camCountsByBucket[i];
    m.set(cam, (m.get(cam) || 0) + 1);
  });

  histBuckets.forEach((bucket, i) => {
    const x = i * barW;
    const inRange = bucket.ts >= dateFilterLo && bucket.ts <= dateFilterHi;
    const camCounts = camCountsByBucket[i];

    // Every bar is scaled against the scope's busiest day, and the scope is the
    // whole month regardless of the Show filter — so the shape of the month holds
    // still while you flip between Geotagged and Not geotagged.
    if (bucket.count > 0) {
      const barH = (bucket.count / maxCount) * cssH * 0.92;
      ctx.fillStyle = inRange ? "#333" : "#262626";
      ctx.fillRect(x + 0.5, cssH - barH, barW - 1, barH);
    }

    // Visible photos stack on top of that backing bar in camera colours, so the
    // unfilled remainder is exactly what the current filter is hiding.
    if (inRange && camCounts.size) {
      let yOffset = cssH;
      camCounts.forEach((cnt, cam) => {
        const segH = (cnt / maxCount) * cssH * 0.92;
        yOffset -= segH;
        ctx.fillStyle = camColor(cam);
        ctx.fillRect(x + 0.5, yOffset, barW - 1, segH);
      });
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

/* ── Geotag staging ──
 * Dropping photos on the map (or dragging a pin, or the manual lat/lng box)
 * doesn't write. The point is reverse-geocoded through /api/geocode/lookup —
 * the same lookup the backend would persist for a photo taken there — the
 * photos leave the grid for the staging area, grouped by that place name, and a
 * provisional pin marks the spot. Only Commit calls /api/geotag.
 *
 * Entry shape: { photo, lat, lng, accuracy, loc, label }. Photos dropped at
 * different points that resolve to the same place share one group, so a commit
 * fans out into one /api/geotag call per distinct point (see commitPendingGeo). */

// Reverse-geocode a dropped point into { loc, label }. Results are cached per
// 4-decimal coordinate (~11 m — the geocoder's own quantization grid), so
// repeated drops in one spot don't re-query. A failed or empty lookup degrades
// to the raw coordinate as the label rather than blocking the drop.
async function lookupLocation(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (geocodeLabelCache.has(key)) return geocodeLabelCache.get(key);
  const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  let out = { loc: null, label: `📌 ${coords}` };
  try {
    const res = await fetch(`/api/geocode/lookup?lat=${lat}&lng=${lng}`);
    if (res.ok) {
      const data = await res.json();
      const loc = data.location;
      // locationKey (face-grid.js) formats the same {city, sublocation, state,
      // country} shape the People page groups on.
      const label = loc ? locationKey({ location: loc }) : null;
      out = { loc, label: label || `📌 ${coords}` };
    }
  } catch (err) {
    // Offline geocode data missing or unreadable — stage under the coordinate.
  }
  geocodeLabelCache.set(key, out);
  return out;
}

// Park `ids` at one dropped point. Re-dropping a staged photo overwrites its
// pending location, so moving it between groups is just another drop. `note` is
// appended to the status line by callers that did something to the point the
// user should know about (currently only snapping).
async function stageDrop(ids, lat, lng, accuracy = null, note = "") {
  if (!ids.length) return;
  setStatus(`Looking up ${ids.length} photo(s)…`);
  const { loc, label } = await lookupLocation(lat, lng);
  let staged = 0;
  ids.forEach((id) => {
    const photo = photos.find((p) => p.id === id);
    if (!photo) return;
    pendingGeo.set(id, { photo, lat, lng, accuracy, loc, label });
    selectedIds.delete(id);
    staged++;
  });
  if (!staged) { setStatus("Nothing to stage.", true); return; }
  lastClickedIndex = -1;   // the grid's index run shifts under the removed cells
  hideProposal();          // the photos it was about have left the grid
  renderGrid();            // also renders the staging area + provisional pins
  const accNote = accuracy ? ` (±${accuracy}m)` : "";
  setStatus(`Staged ${staged} photo(s) → ${label}${accNote}.${note} Nothing saved yet — ` +
            `review at the bottom of the grid, then Commit.`);
}

function unstageGeo(ids, quiet = false) {
  let removed = 0;
  ids.forEach((id) => { if (pendingGeo.delete(id)) removed++; });
  if (!removed) return;
  renderGrid();
  if (!quiet) setStatus(`Reverted ${removed} staged location(s).`);
}

// Distinct coordinate a staged photo will actually be written at — the commit
// batching key, and what the provisional pins are grouped by.
function pointKey(e) {
  return `${e.lat.toFixed(6)},${e.lng.toFixed(6)},${e.accuracy ?? ""}`;
}

// Group the staging area by resolved place, newest place first is meaningless
// here, so groups are alphabetical with raw-coordinate ones last.
function groupPendingGeo() {
  const groups = new Map();
  pendingGeo.forEach((e) => {
    let g = groups.get(e.label);
    if (!g) { g = { label: e.label, entries: [] }; groups.set(e.label, g); }
    g.entries.push(e);
  });
  return [...groups.values()].sort((a, b) => {
    const ua = a.label.startsWith("📌"), ub = b.label.startsWith("📌");
    if (ua !== ub) return ua ? 1 : -1;   // un-geocoded points sink to the bottom
    return a.label.localeCompare(b.label);
  });
}

function renderPendingGeo() {
  const pane = document.getElementById("pending-pane");
  const wrap = document.getElementById("pending-groups");
  wrap.innerHTML = "";
  renderPendingGeoMarkers();
  if (!pendingGeo.size) { pane.style.display = "none"; return; }
  pane.style.display = "";

  const groups = groupPendingGeo();
  groups.forEach((g, i) => wrap.appendChild(makePendingGeoGroup(g, i)));
  document.getElementById("pending-summary").textContent =
    `${pendingGeo.size} staged location(s) in ${groups.length} place(s) — not saved yet`;
}

function makePendingGeoGroup(g, groupIdx) {
  const sec = document.createElement("div");
  sec.className = `face-group-section pending-group group-tint-${groupIdx % 6}`;
  const points = new Set(g.entries.map(pointKey)).size;
  sec.appendChild(faceGroupHeader({
    title: g.label,
    meta: `· ${g.entries.length} photo${g.entries.length !== 1 ? "s" : ""}` +
          (points > 1 ? ` · ${points} drop points` : ""),
    extraClass: "amber",
    buttons: [
      { icon: "⛶", label: "Zoom to these photos",
        title: "Fit the map to this group's staged point(s)",
        onClick: () => {
          const bounds = L.latLngBounds(g.entries.map(e => [e.lat, e.lng]));
          map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 15, duration: 0.6 });
        } },
      { label: `✔ Commit (${g.entries.length})`, kind: "primary",
        title: `Write just this place's ${g.entries.length} location(s) to the photos`,
        onClick: () => commitPendingGeo([g], g.label) },
      { label: "↩ Revert", kind: "danger",
        title: "Discard this place's staged locations and put the photos back in the grid",
        onClick: () => revertPendingGeo([g], g.label) },
    ],
  }));

  const cells = document.createElement("div");
  cells.className = "face-group-cells";
  g.entries.forEach(e => cells.appendChild(makePendingGeoCell(e)));
  sec.appendChild(cells);
  return sec;
}

function makePendingGeoCell(e) {
  const photo = e.photo;
  const cell = document.createElement("div");
  cell.className = "thumb-cell pending-cell" +
    (photo.id === focusedPhotoId ? " focused" : "");
  cell.dataset.id = photo.id;

  const strip = document.createElement("div");
  strip.className = "cam-strip";
  strip.style.background = camColor(photo.camera);
  cell.appendChild(strip);

  const img = document.createElement("img");
  img.src = `/api/thumbnail/${photo.id}`;
  img.loading = "lazy";
  img.alt = photo.filename;
  cell.appendChild(img);

  const chip = document.createElement("div");
  chip.className = "face-label pending-label";
  chip.textContent = `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}` +
    (e.accuracy ? ` ±${e.accuracy}m` : "");
  chip.title = `${photo.filename} → ${e.label}`;
  cell.appendChild(chip);

  const undo = document.createElement("button");
  undo.className = "pending-undo";
  undo.textContent = "✕";
  undo.title = "Revert this photo (back to the grid, location unchanged)";
  undo.addEventListener("click", (ev) => {
    ev.stopPropagation();
    unstageGeo([photo.id]);
  });
  cell.appendChild(undo);

  // Click previews the photo and pans to where it would land.
  cell.addEventListener("click", () => {
    showDetail(photo.id);
    renderPendingGeo();   // move the focus ring
    map.panTo([e.lat, e.lng]);
  });
  return cell;
}

// One provisional pin per distinct staged point (dashed, amber, badged with the
// photo count), plus its uncertainty circle for imprecise drops. Rebuilt wholesale
// — there are only ever a handful, and it keeps them in sync with the staging area.
function renderPendingGeoMarkers() {
  pendingGeoMarkers.forEach(m => m.remove());
  pendingGeoMarkers = [];
  if (!map || !pendingGeo.size) return;

  const byPoint = new Map();
  pendingGeo.forEach((e) => {
    const k = pointKey(e);
    if (!byPoint.has(k)) byPoint.set(k, { ...e, count: 0 });
    byPoint.get(k).count++;
  });

  byPoint.forEach((p) => {
    if (p.accuracy) {
      pendingGeoMarkers.push(L.circle([p.lat, p.lng], {
        radius: p.accuracy,
        color: "#e0a040", fillColor: "#e0a040", fillOpacity: 0.1,
        weight: 1.5, opacity: 0.6, dashArray: "5, 5", interactive: false,
      }).addTo(map));
    }
    const marker = L.marker([p.lat, p.lng], {
      icon: makePendingPinIcon(p.count),
      zIndexOffset: 500,   // staged pins sit above the saved ones
    }).addTo(map);
    marker.bindTooltip(`Staged: ${p.count} photo(s) → ${p.label}`);
    pendingGeoMarkers.push(marker);
  });
}

// Dashed amber teardrop with a count — deliberately unlike the solid camera-colored
// pins, so "not saved yet" reads at a glance.
function makePendingPinIcon(count) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="0 0 24 34">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 8 12 22 12 22s12-14 12-22C24 5.373 18.627 0 12 0z"
          fill="#e0a040" fill-opacity="0.85" stroke="#fff2d8" stroke-width="1.5" stroke-dasharray="3,2"/>
    <text x="12" y="16" text-anchor="middle" font-size="11" font-weight="bold"
          font-family="system-ui, sans-serif" fill="#3a2a08">${count}</text>
  </svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [24, 34], iconAnchor: [12, 34] });
}

async function commitPendingGeo(groups, what) {
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  if (!total) { setStatus("Nothing staged to commit.", true); return; }
  if (!confirm(`Commit ${total} staged location(s)${what ? ` — ${what}` : ""}? ` +
               `This writes them to the photos.`)) return;
  setStatus(`Committing ${total} location(s)…`);

  let saved = 0;
  const failures = [];
  for (const g of groups) {
    // Photos in one place group can come from several drops — one call per point.
    const byPoint = new Map();
    g.entries.forEach((e) => {
      const k = pointKey(e);
      if (!byPoint.has(k)) byPoint.set(k, { lat: e.lat, lng: e.lng, accuracy: e.accuracy, ids: [] });
      byPoint.get(k).ids.push(e.photo.id);
    });
    for (const p of byPoint.values()) {
      const ok = await geotag(p.ids, p.lat, p.lng, p.accuracy);
      if (ok) {
        // Only clear what actually landed — a failed point stays staged.
        p.ids.forEach(id => pendingGeo.delete(id));
        saved += p.ids.length;
      } else {
        failures.push(`${g.label} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`);
      }
    }
  }

  renderGrid();
  if (saved) loadHotspots();   // committed points are palette entries now
  if (failures.length) {
    setStatus(`Committed ${saved} of ${total} location(s). Still staged after failing: ` +
              failures.join(", ") + ".", true);
  } else {
    setStatus(`Committed ${saved} location(s).`);
  }
}

function revertPendingGeo(groups, what) {
  const ids = groups.flatMap(g => g.entries.map(e => e.photo.id));
  if (!ids.length) { setStatus("Nothing staged to revert.", true); return; }
  if (ids.length > 3 &&
      !confirm(`Discard ${ids.length} staged location(s)${what ? ` — ${what}` : ""}?`)) return;
  unstageGeo(ids);
}

/* ── Location palette (hotspots) ──
 * The same handful of places come up month after month, so the fastest drop
 * target isn't a spot on the map you have to pan and zoom to find — it's a row
 * in a list. /api/geotag/hotspots mines those places from the coordinates
 * already on the photos and clusters them, so drops a few hundred feet apart at
 * one real place count as a single entry.
 *
 * A palette row is three things at once: a drag-and-drop target, a click target
 * that stages the current selection, and (for the first nine) a number key. */

let hotspots = [];
let hotspotSort = "count";
let snapEnabled = true;

// Snap radius, matched to the server's cluster merge radius — a drop closer than
// this to a known place is the same place, just aimed by hand.
const SNAP_METERS = 300;

let snapRowIndex = -1;         // palette entry currently flagged as the snap target

const METERS_PER_DEG_LAT = 111320;

// Equirectangular approximation. Exact enough at the few-hundred-metre scale we
// snap at, and it runs on every dragover frame.
function metersBetween(lat1, lng1, lat2, lng2) {
  const dy = (lat2 - lat1) * METERS_PER_DEG_LAT;
  const dx = (lng2 - lng1) * METERS_PER_DEG_LAT * Math.cos(lat1 * Math.PI / 180);
  return Math.hypot(dx, dy);
}

// Nearest palette entry within `maxMeters`, as { hotspot, index, meters }, or null.
function nearestHotspot(lat, lng, maxMeters = SNAP_METERS) {
  let best = null;
  hotspots.forEach((h, i) => {
    const m = metersBetween(lat, lng, h.lat, h.lng);
    if (m <= maxMeters && (!best || m < best.meters)) best = { hotspot: h, index: i, meters: m };
  });
  return best;
}

// Widen the on-screen time span by a month either side for the "Nearby (time)"
// ranking — the trip that explains an untagged June photo often starts in May.
const TIME_SORT_SLACK_SECS = 31 * 86400;

// Query string for the current ranking. "near" and "time" are relative to what's
// on screen, so they carry the map centre / the loaded photos' date span.
function hotspotQuery() {
  const params = new URLSearchParams({ limit: "40", sort: hotspotSort });
  if (hotspotSort === "near") {
    if (!map) return null;
    const c = map.getCenter();
    params.set("lat", c.lat);
    params.set("lng", c.lng);
  } else if (hotspotSort === "time") {
    // dateRangeMin/Max come from the loaded photos, so this follows whichever
    // view is active — a month, an area, a context — not just the month picker.
    if (!dateRangeMin || !dateRangeMax) return null;
    params.set("from_ts", Math.round(dateRangeMin - TIME_SORT_SLACK_SECS));
    params.set("to_ts", Math.round(dateRangeMax + TIME_SORT_SLACK_SECS));
  }
  return params;
}

async function loadHotspots() {
  const list = document.getElementById("palette-list");
  const params = hotspotQuery();
  if (!params) {
    // "Nearby (time)" before any photos are loaded — nothing to be near to.
    hotspots = [];
    list.innerHTML = `<div class="palette-empty">Pick a month to see the places
      you tagged around then.</div>`;
    return;
  }
  try {
    const res = await fetch(`/api/geotag/hotspots?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hotspots = data.hotspots;
  } catch (err) {
    hotspots = [];
    list.innerHTML = `<div class="palette-empty">Couldn't load places: ${err.message}</div>`;
    return;
  }
  renderPalette();
}

// "Nearby (map)" has to follow the map, and "Nearby (time)" the loaded photos.
// Both changes arrive in bursts (a pan is many moveends, a view switch reloads
// photos), so the reload is debounced.
let hotspotReloadTimer = null;
function reloadHotspotsIfRelative(mode) {
  if (hotspotSort !== mode) return;
  clearTimeout(hotspotReloadTimer);
  hotspotReloadTimer = setTimeout(loadHotspots, 350);
}

const PALETTE_EMPTY_TEXT = {
  near: "Nothing tagged near this part of the map yet.",
  time: "Nothing tagged in the months on screen yet.",
};

function renderPalette() {
  const list = document.getElementById("palette-list");
  list.innerHTML = "";
  renderHotspotMarkers();   // the list and its map circles are one view
  if (!hotspots.length) {
    list.innerHTML = `<div class="palette-empty">${PALETTE_EMPTY_TEXT[hotspotSort] ||
      "No places yet — tag some photos and the spots you use most will collect here."}</div>`;
    return;
  }
  hotspots.forEach((h, i) => list.appendChild(makePaletteRow(h, i)));
}

/* ── Hotspot circles ──
 * Every palette entry is also a permanent circle on the map, in the colour of
 * its row, so the list and the map read as one thing: press 3, watch the third
 * colour light up. The keyed top nine get distinct colours; past that there are
 * no more colours worth telling apart, so the tail goes uniform grey.
 *
 * Deliberately unlike both the camera-coloured photo pins (teardrops) and the
 * amber staged pins — these are flat rings that sit under everything else. */

const HOTSPOT_COLORS = [
  "#4ad9c8", // teal
  "#f2a33c", // amber
  "#7c9ef5", // periwinkle
  "#e56ab3", // magenta
  "#8ed44f", // lime
  "#f26a5c", // coral
  "#b98cf0", // violet
  "#3fc4f0", // cyan
  "#d9c341", // gold
];
const HOTSPOT_TAIL_COLOR = "#8a8a8a";

let hotspotMarkers = [];

function hotspotColor(i) {
  return i < HOTSPOT_COLORS.length ? HOTSPOT_COLORS[i] : HOTSPOT_TAIL_COLOR;
}

/* The ring *is* the snap catchment, drawn at its true ground size (L.circle takes
 * metres, so it rescales with the map for free). Nothing about it is fudged for
 * legibility, because the moment the drawn radius stops equalling SNAP_METERS the
 * ring starts lying: a drop that looks safely outside it gets captured anyway.
 * Inside the ring snaps, outside it doesn't, and you can see which is which.
 *
 * That honesty is only affordable while 300 m is big enough to aim inside. Zoomed
 * out past HOTSPOT_MIN_ZOOM the circle is a few pixels wide — too small to hit or
 * avoid deliberately — so the whole mechanism switches off rather than quietly
 * hijacking drops aimed kilometres away. */
const HOTSPOT_MIN_ZOOM = 13;   // 300 m is ~20 px here, and halves with each step out

function hotspotsActiveOnMap() {
  return !!map && map.getZoom() >= HOTSPOT_MIN_ZOOM;
}

// Photo count rides on stroke weight rather than size, since size is spoken for.
function hotspotWeight(count, maxCount) {
  return 1.5 + 2.5 * Math.sqrt(Math.min(count, maxCount) / Math.max(maxCount, 1));
}

// Rings live above the photo pins in their own pane. Underneath them they were
// invisible in exactly the case that matters — a well-used place has a stack of
// pins standing on its centroid, hiding anything drawn there. Unfilled, so
// sitting on top costs nothing: only the stroke is ever over a pin.
function ensureHotspotPane() {
  if (map.getPane("hotspotPane")) return;
  const pane = map.createPane("hotspotPane");
  pane.style.zIndex = 610;   // markerPane is 600, tooltipPane 650
}

function renderHotspotMarkers() {
  hotspotMarkers.forEach(m => m.remove());
  hotspotMarkers = [];
  updateSnapHint();
  if (!map || !hotspots.length || !hotspotsActiveOnMap()) return;
  ensureHotspotPane();

  const maxCount = Math.max(...hotspots.map(h => h.count), 1);
  hotspots.forEach((h, i) => {
    const color = hotspotColor(i);
    // L.circle, not L.circleMarker — metres on the ground, not pixels on screen.
    const marker = L.circle([h.lat, h.lng], {
      radius: SNAP_METERS,
      color,
      weight: hotspotWeight(h.count, maxCount),
      fill: false,
      opacity: 0.95,
      pane: "hotspotPane",
    }).addTo(map);
    marker._baseWeight = marker.options.weight;   // restored when un-highlighted

    const key = i < 9 ? ` · press ${i + 1}` : "";
    marker.bindTooltip(`${h.label} — ${h.count} photo${h.count !== 1 ? "s" : ""}${key}`);
    // Clicking a circle does what clicking its row does.
    marker.on("click", () => {
      if (selectedIds.size) stageAtHotspot(i);
      else map.panTo([h.lat, h.lng]);
    });
    // Hovering either the circle or the row highlights both.
    marker.on("mouseover", () => setHotspotHighlight(i, true));
    marker.on("mouseout", () => setHotspotHighlight(i, false));
    hotspotMarkers.push(marker);
  });
}

// L.circle rescales itself, so a zoom only decides whether the rings exist at all.
function onZoomChanged() {
  const active = hotspotsActiveOnMap();
  if (active === !!hotspotMarkers.length) return;   // nothing to do
  clearSnapPreview();
  renderHotspotMarkers();
}

// Tell the user why snapping isn't happening, rather than letting it look broken.
function updateSnapHint() {
  const hint = document.getElementById("snap-hint");
  if (!hint) return;
  const off = map && !hotspotsActiveOnMap();
  hint.textContent = off ? `zoom in to ${HOTSPOT_MIN_ZOOM}+ to use` : "";
  hint.style.display = off ? "" : "none";
}

// Two-way hover link between a palette row and its circle.
function setHotspotHighlight(i, on) {
  const row = document.querySelector(`.palette-row[data-index="${i}"]`);
  if (row) row.classList.toggle("hovered", on);
  const marker = hotspotMarkers[i];
  if (marker) {
    // Hover fills the ring in — the only time it's allowed to cover the pins.
    marker.setStyle(on
      ? { weight: marker._baseWeight + 3, fill: true, fillOpacity: 0.35 }
      : { weight: marker._baseWeight, fill: false });
    if (on) marker.bringToFront();
  }
}

function formatMiles(meters) {
  const miles = meters / 1609.34;
  if (miles < 0.1) return `${Math.round(meters)} m`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

function makePaletteRow(h, i) {
  const row = document.createElement("div");
  row.className = "palette-row";
  row.dataset.index = i;
  // Same colour as this entry's map circle — the only thing tying the two together.
  row.style.borderLeftColor = hotspotColor(i);

  if (h.sample_photo_id) {
    const img = document.createElement("img");
    img.className = "palette-thumb";
    img.src = `/api/thumbnail/${h.sample_photo_id}`;
    img.loading = "lazy";
    img.alt = "";
    row.appendChild(img);
  }

  const body = document.createElement("div");
  body.className = "palette-body";
  const label = document.createElement("div");
  label.className = "palette-label";
  label.textContent = h.label;
  // Lead the meta line with whatever the active ranking sorted on, so the order
  // on screen is always explained by the number next to it.
  const meta = document.createElement("div");
  meta.className = "palette-meta";
  const bits = [];
  if (h.meters !== undefined) bits.push(formatMiles(h.meters));
  if (h.window_count !== undefined) bits.push(`${h.window_count} then`);
  bits.push(`${h.count} photo${h.count !== 1 ? "s" : ""}`);
  if (h.last_ts) bits.push(new Date(h.last_ts * 1000).toLocaleDateString());
  meta.textContent = bits.join(" · ");
  body.appendChild(label);
  body.appendChild(meta);
  row.appendChild(body);

  // Only the first nine get a key; past that the label would be a lie. The key
  // chip wears the entry's colour, so the number on the keyboard, the chip, and
  // the circle on the map are all the same thing.
  if (i < 9) {
    const key = document.createElement("span");
    key.className = "palette-key";
    key.textContent = String(i + 1);
    key.style.borderColor = hotspotColor(i);
    key.style.color = hotspotColor(i);
    row.appendChild(key);
  }

  const zoom = document.createElement("button");
  zoom.className = "palette-zoom";
  zoom.textContent = "⛶";
  zoom.title = "Move the map here";
  zoom.addEventListener("click", (e) => {
    e.stopPropagation();   // don't also stage the selection
    map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  });
  row.appendChild(zoom);

  row.title = `${h.label}\n${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}\n` +
    (i < 9 ? `Drop photos here, click to stage the selection, or press ${i + 1}`
           : "Drop photos here, or click to stage the selection");

  // Clicking with nothing selected is a navigation request, not a tagging one.
  row.addEventListener("click", () => {
    if (selectedIds.size) stageAtHotspot(i);
    else map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  });

  row.addEventListener("mouseenter", () => setHotspotHighlight(i, true));
  row.addEventListener("mouseleave", () => setHotspotHighlight(i, false));

  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    row.classList.add("drop-target");
    setHotspotHighlight(i, true);   // show on the map where this drop would land
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-target");
    setHotspotHighlight(i, false);
  });
  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-target");
    setHotspotHighlight(i, false);
    const ids = JSON.parse(e.dataTransfer.getData("application/json") || "[]");
    if (ids.length) await stageDrop(ids, h.lat, h.lng, currentDropAccuracy());
  });

  return row;
}

// The imprecise-drop toggle applies wherever a drop happens — map or palette.
function currentDropAccuracy() {
  const toggle = document.getElementById("imprecise-toggle");
  if (!toggle || !toggle.checked) return null;
  return parseFloat(document.getElementById("imprecise-radius-select").value);
}

async function stageAtHotspot(i) {
  const h = hotspots[i];
  if (!h) return;
  if (!selectedIds.size) { setStatus("Select some photos first.", true); return; }
  await stageDrop([...selectedIds], h.lat, h.lng, currentDropAccuracy());
}

/* ── Snapping ──
 * Aiming by hand at the same place on different days lands a few hundred feet
 * apart every time, which fragments the staging groups and smears the palette.
 * Snapping folds a near-miss onto the exact point already in use. */

// Resolve a raw drop point to where it will actually land. Only a drop *inside* a
// drawn ring moves — nearestHotspot' cutoff is SNAP_METERS, the same number the
// ring is drawn at — so aiming anywhere else on the map still lands exactly where
// you let go, which is the whole point of being able to see the rings.
function snapPoint(lat, lng) {
  if (!snapEnabled || !hotspotsActiveOnMap()) return { lat, lng, snapped: null };
  const near = nearestHotspot(lat, lng);
  if (!near) return { lat, lng, snapped: null };
  return { lat: near.hotspot.lat, lng: near.hotspot.lng, snapped: near };
}

// Live feedback while a drag is over the map. The hotspot circles are already on
// the map, so the target just gets swollen and its palette row flagged — no
// separate ghost ring to explain.
function showSnapPreview(lat, lng) {
  const near = (snapEnabled && hotspotsActiveOnMap()) ? nearestHotspot(lat, lng) : null;
  const index = near ? near.index : -1;
  if (index === snapRowIndex) return;

  clearSnapPreview();
  snapRowIndex = index;
  if (index < 0) return;

  const row = document.querySelector(`.palette-row[data-index="${index}"]`);
  if (row) row.classList.add("snap-target");
  setHotspotHighlight(index, true);
}

function clearSnapPreview() {
  if (snapRowIndex >= 0) {
    const row = document.querySelector(`.palette-row[data-index="${snapRowIndex}"]`);
    if (row) row.classList.remove("snap-target");
    setHotspotHighlight(snapRowIndex, false);
  }
  snapRowIndex = -1;
}

/* ── Number-key shortcuts ── */
function bindHotspotKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Never steal a digit the user is typing into a field.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" ||
              t.isContentEditable)) return;
    if (document.getElementById("month-picker-modal").style.display !== "none") return;
    if (!/^[1-9]$/.test(e.key)) return;
    if (!selectedIds.size) return;    // leave the key alone when it would do nothing
    e.preventDefault();
    stageAtHotspot(parseInt(e.key, 10) - 1);
  });
}

/* ── Proposal banner ──
 * Most selections are a run of photos from one outing, and the outing next to it
 * in time is usually already tagged. Asking the server where the selection's
 * time-neighbours are geotagged answers "where was this?" before the user has
 * touched the map at all. */

let proposeTimer = null;
let proposeAbort = null;
let proposeDismissedFor = "";   // selection signature the user waved off

function selectionSignature() {
  return [...selectedIds].sort((a, b) => a - b).join(",");
}

function hideProposal() {
  document.getElementById("propose-bar").style.display = "none";
}

// Debounced: a shift-range drag fires a selection change per cell.
function scheduleProposal() {
  clearTimeout(proposeTimer);
  if (!selectedIds.size) { hideProposal(); return; }
  proposeTimer = setTimeout(fetchProposal, 250);
}

async function fetchProposal() {
  const sig = selectionSignature();
  if (!sig || sig === proposeDismissedFor) { hideProposal(); return; }

  // Only the newest selection's answer matters — drop the previous request.
  if (proposeAbort) proposeAbort.abort();
  proposeAbort = new AbortController();
  const signal = proposeAbort.signal;

  let data;
  try {
    const res = await fetch("/api/geotag/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selectedIds] }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    if (err.name !== "AbortError") hideProposal();
    return;
  }
  // The selection moved on while we were waiting.
  if (sig !== selectionSignature()) return;
  renderProposal(data);
}

function renderProposal(data) {
  const bar = document.getElementById("propose-bar");
  const actions = document.getElementById("propose-actions");
  if (!data.candidates.length) { hideProposal(); return; }

  const top = data.candidates[0];
  document.getElementById("propose-summary").textContent =
    `${top.votes} of ${data.selected} nearby →`;

  actions.innerHTML = "";
  data.candidates.forEach((c, i) => {
    const btn = document.createElement("button");
    if (i === 0) btn.className = "primary";
    btn.textContent = i === 0 ? `📍 Stage all at ${c.label}` : `${c.label} (${c.votes})`;
    btn.title = `Stage the ${selectedIds.size} selected photo(s) at ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    btn.addEventListener("click", async () => {
      await stageDrop([...selectedIds], c.lat, c.lng, currentDropAccuracy());
    });
    actions.appendChild(btn);
  });
  bar.style.display = "flex";
}

function bindProposeBar() {
  document.getElementById("propose-dismiss").addEventListener("click", () => {
    proposeDismissedFor = selectionSignature();
    hideProposal();
  });
}

/* ── Status ── */
function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}
