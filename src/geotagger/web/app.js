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
let accuracyCircle = null;     // L.circle shown for selected photo's GPS accuracy
let selectedYear = null;
let selectedMonth = null;
let undatedMode = false;  // true when browsing the Undated queue instead of a month/year

/* ── Geotag staging state ──
 * A drop on the map doesn't write: the point is reverse-geocoded, the photos are
 * pulled out of the grid and parked here under the resolved place name, and a
 * provisional pin marks the spot until the change is committed or reverted.
 * See the "Geotag staging" section for the details. */
// photo id → { photo, lat, lng, accuracy, loc, label } for a staged drop, or
// { photo, ignore: true, label } for a staged "no location needed" mark. Both
// kinds share the staging area, the revert buttons and Commit.
let pendingGeo = new Map();
let pendingGeoMarkers = [];      // provisional pins/circles, rebuilt on every render
const geocodeLabelCache = new Map();   // "lat,lng" (4dp) → { loc, label }
// Grid "Show" toggles, keyed by the buttons' data-filter. Ignored starts off:
// those photos are done, and the point of this screen is the ones that aren't.
// Must match the `on` classes / aria-pressed in geocode.html.
const FILTER_TOGGLES = {
  geotagged: true,
  untagged: true,
  screenshots: true,
  ignored: false,
};

// Group heading for staged "needs no location" marks. Doubles as their key in
// groupPendingGeo, so it must not collide with a real geocoded place name.
const IGNORE_LABEL = "🚫 No location needed";

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
  });

  mapPane.addEventListener("drop", async (e) => {
    e.preventDefault();
    mapPane.classList.remove("drop-target");
    cleanupDragCircle();
    const ids = JSON.parse(e.dataTransfer.getData("application/json") || "[]");
    if (!ids.length) return;
    const latlng = dragLatLng(e);
    await stageDrop(ids, latlng.lat, latlng.lng, currentDropAccuracy());
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
  document.getElementById("select-month-btn").addEventListener("click", showMonthPicker);
  document.getElementById("select-area-btn").addEventListener("click", startAreaSelection);
  function reloadCurrentView() {
    if (selectedYear) {
      loadPhotos();
    } else if (areaSelectParams) {
      loadPhotosByArea(areaSelectParams.lat, areaSelectParams.lng, areaSelectParams.radius);
    } else if (placeFilterParams) {
      const place = places.find(p => p.id === placeFilterParams.placeId);
      if (place) filterPhotosByPlace(place);
    }
  }
  // Show is a pure client-side view of the already-loaded scope — no reload.
  document.getElementById("filter-toggles").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-toggle");
    if (!btn) return;
    const key = btn.dataset.filter;
    FILTER_TOGGLES[key] = !FILTER_TOGGLES[key];
    btn.classList.toggle("on", FILTER_TOGGLES[key]);
    btn.setAttribute("aria-pressed", String(FILTER_TOGGLES[key]));
    applyFilters();
  });
  document.getElementById("window-select").addEventListener("change", reloadCurrentView);
  document.getElementById("place-search-btn").addEventListener("click", doPlaceSearch);
  document.getElementById("place-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doPlaceSearch();
  });
  document.getElementById("apply-latlng-btn").addEventListener("click", doApplyLatLng);
  document.getElementById("copy-location-btn").addEventListener("click", doCopyLocation);
  document.getElementById("remove-geotag-btn").addEventListener("click", doRemoveGeotag);
  document.getElementById("mark-ignored-btn").addEventListener("click", () => stageIgnore());

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

  bindProposeBar();

  // Location picker — the map-free way to tag a selection at a place that
  // already exists. "l" is the shortcut; the toolbar button is the discoverable
  // form of the same thing.
  // Wrapped, not passed by reference: the click event would land in `ids`.
  document.getElementById("tag-as-btn").addEventListener("click", () => openLocationPicker());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "l" && e.key !== "L") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
              t.tagName === "SELECT" || t.isContentEditable)) return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;
    // Don't stack the picker on top of the month/timeline modals.
    const openModal = [...document.querySelectorAll(".modal")]
      .some(m => m.style.display !== "none");
    if (openModal) return;
    e.preventDefault();
    openLocationPicker();
  });

  // Esc drops the "Show nearby on map" day override — but only once whatever it
  // is stacked on top of (picker, modal) has taken its own turn at the key.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !mapDayOverride) return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;
    const openModal = [...document.querySelectorAll(".modal")]
      .some(m => m.style.display !== "none");
    if (openModal) return;
    clearDayOnMap();
  });

  // Modal close handlers
  // Scoped: there is more than one .modal-close on the page now.
  document.querySelector("#month-picker-modal .modal-close")
    .addEventListener("click", hideMonthPicker);
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
  mapDayOverride = null;   // new scope, so the "show this day" map override is stale
  undatedMode = false;
  setTimelineAvailable(true);
  hideMonthPicker();

  // Clear area and place selections
  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearPlaceFilter();

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
  mapDayOverride = null;   // new scope, so the "show this day" map override is stale
  undatedMode = false;
  setTimelineAvailable(true);
  hideMonthPicker();

  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearPlaceFilter();

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
  mapDayOverride = null;   // new scope, so the "show this day" map override is stale
  undatedMode = true;
  hideMonthPicker();

  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  document.getElementById("selected-area-label").textContent = "";
  clearPlaceFilter();

  document.getElementById("selected-month-label").textContent = "Undated photos";
  setTimelineAvailable(false);

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
// over as the active view, clearing month/area selections like the other
// selectors do.
async function filterPhotosByPlace(place) {
  // Clear the other view modes
  selectedYear = null;
  selectedMonth = null;
  undatedMode = false;
  document.getElementById("selected-month-label").textContent = "No month selected";
  areaSelectParams = null;
  if (areaSelectCircle) { map.removeLayer(areaSelectCircle); areaSelectCircle = null; }

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
  mapDayOverride = null;   // new scope, so the "show this day" map override is stale
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

/* ── Location picker ──
 * Most tagging is repeat business: the same house, the same park, the same
 * relatives' addresses, over and over. Hunting each of them down on the map
 * again is the slow part, so this is the map-free path — select photos, press
 * "l", type a few letters, Enter. It picks from the locations that already
 * exist, in the order they're likely to be wanted:
 *
 *   Recent   — what this browser committed lately (localStorage, this machine).
 *   Places   — saved places from the Custom Places page, at their centre.
 *   Hotspots — /api/geotag/hotspots, the recurring drop points mined from the
 *              coordinates already on the photos. Places you use but never
 *              bothered to name.
 *
 * A pick stages, exactly as a map drop does — nothing here writes to a photo
 * without going through the staging area and Commit. */

const RECENT_LOCATIONS_KEY = "geotagger.recentLocations";
const RECENT_LOCATIONS_MAX = 12;
// Hotspots are ranked over the span of photos on screen, widened by a month
// either side — see the sort="time" note in services/hotspots_service.py.
const PICKER_SPAN_PAD = 30 * 86400;

// 4 decimals ≈ 11 m: the grid lookupLocation caches on, and close enough that
// two drops the user thinks of as "the same spot" collapse into one entry.
function coordKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function loadRecentLocations() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_LOCATIONS_KEY) || "[]");
    return Array.isArray(list)
      ? list.filter(r => r && typeof r.lat === "number" && typeof r.lng === "number")
      : [];
  } catch (err) {
    return [];   // unreadable or from an older shape — start the history over
  }
}

function rememberLocation(lat, lng, accuracy, label) {
  const key = coordKey(lat, lng);
  const list = loadRecentLocations().filter(r => coordKey(r.lat, r.lng) !== key);
  list.unshift({ lat, lng, accuracy: accuracy ?? null, label: label || "", ts: Date.now() });
  try {
    localStorage.setItem(RECENT_LOCATIONS_KEY,
                         JSON.stringify(list.slice(0, RECENT_LOCATIONS_MAX)));
  } catch (err) {
    // Quota or private browsing — the picker just loses its history.
  }
}

// The single point a saved place stands for. Rectangles collapse to their
// centre, which is what "tag these as being at this place" has to mean.
function placeCenter(place) {
  try {
    const b = JSON.parse(place.bounds);
    if (place.type === "circle") return { lat: b.lat, lng: b.lng };
    return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
  } catch (err) {
    return null;
  }
}

// Time span the hotspot ranking should answer for: the selection if there is
// one, else everything loaded. Reduce, not Math.min(...arr) — the argument list
// of a month with thousands of photos overflows the stack.
function pickerTimeSpan() {
  let lo = Infinity, hi = -Infinity;
  photos.forEach((p) => {
    if (!(p.photo_datetime > 0)) return;
    if (selectedIds.size && !selectedIds.has(p.id)) return;
    if (p.photo_datetime < lo) lo = p.photo_datetime;
    if (p.photo_datetime > hi) hi = p.photo_datetime;
  });
  if (lo === Infinity) return null;
  return { from: Math.round(lo - PICKER_SPAN_PAD), to: Math.round(hi + PICKER_SPAN_PAD) };
}

async function fetchPickerHotspots() {
  const span = pickerTimeSpan();
  const base = "/api/geotag/hotspots?limit=25&hide_named=true&sort=";
  const get = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).hotspots || [];
  };
  try {
    if (!span) return await get(base + "count");
    // sort=time drops places with nothing in the window, so a span with no
    // history at all comes back empty — fall back to the all-time favourites
    // rather than showing the user an empty section.
    const timed = await get(`${base}time&from_ts=${span.from}&to_ts=${span.to}`);
    return timed.length ? timed : await get(base + "count");
  } catch (err) {
    return [];   // no geotags yet, or no geocode data installed
  }
}

function relativeDay(ts) {
  if (!ts) return "";
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

// One de-duplicated, group-ordered list for openEntityPicker. Earlier sources
// win: a coordinate you used this morning shouldn't also appear as a hotspot.
async function buildLocationItems() {
  const items = [];
  const seen = new Set();
  const add = (item) => {
    const k = coordKey(item.lat, item.lng);
    if (seen.has(k)) return;
    seen.add(k);
    items.push(item);
  };

  // Saved places indexed first, but emitted after Recent. Committing at a saved
  // place also writes a Recent entry at the same coordinate, labelled with the
  // *reverse-geocoded* name — so plain "earlier source wins" dedup swallowed the
  // place and its name became unsearchable ("Home - Weston Ln" gone, only
  // "Weston Lane, Austin" left). A recent that lands on a saved place now
  // borrows that place's name and thumbnail instead of hiding it.
  // Fetched fresh, not read off the page-load `places` global: places created on
  // the Custom Places page in another tab would otherwise be missing here until
  // a reload. Local only — the dropdown/map shapes stay as loadPlaces left them,
  // so an active place filter keeps its selection.
  let livePlaces = places;
  try {
    const res = await fetch("/api/places");
    if (res.ok) livePlaces = await res.json();
  } catch (err) {
    // Offline or server hiccup — fall back to what the page loaded with.
  }

  const placeByKey = new Map();
  livePlaces.forEach((p) => {
    const c = placeCenter(p);
    if (!c) return;
    const k = coordKey(c.lat, c.lng);
    if (!placeByKey.has(k)) placeByKey.set(k, { place: p, center: c });
  });

  loadRecentLocations().forEach((r) => {
    const hit = placeByKey.get(coordKey(r.lat, r.lng));
    const p = hit && hit.place;
    add({
      group: "Recent",
      name: p ? p.name : (r.label || `📌 ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`),
      meta: relativeDay(Math.round(r.ts / 1000)),
      thumb: p && p.representative_photo_id
        ? `/api/thumbnail/${p.representative_photo_id}` : null,
      lat: r.lat, lng: r.lng, accuracy: r.accuracy,
    });
  });

  placeByKey.forEach(({ place: p, center: c }) => {
    add({
      group: "Saved places",
      name: p.name,
      meta: `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`,
      thumb: p.representative_photo_id
        ? `/api/thumbnail/${p.representative_photo_id}` : null,
      lat: c.lat, lng: c.lng, accuracy: null,
    });
  });

  (await fetchPickerHotspots()).forEach((h) => {
    add({
      group: "Hotspots",
      name: h.label,
      meta: relativeDay(h.last_ts),
      count: h.window_count ?? h.count,
      thumb: h.sample_photo_id ? `/api/thumbnail/${h.sample_photo_id}` : null,
      lat: h.lat, lng: h.lng, accuracy: null,
    });
  });

  return items;
}

// `ids` defaults to the grid selection (the toolbar button and the "l" shortcut);
// the photo context menu passes its own target set instead.
async function openLocationPicker(ids = [...selectedIds]) {
  if (!ids.length) { setStatus("Select some photos first, then pick a location.", true); return; }

  setStatus("Loading known locations…");
  const items = await buildLocationItems();
  if (!items.length) {
    setStatus("No saved places, recent locations or hotspots yet — " +
              "drop photos on the map once and they'll show up here.", true);
    return;
  }
  setStatus(`Pick a location for ${ids.length} photo(s).`);

  openEntityPicker(items, {
    title: `Tag ${ids.length} photo(s) as…`,
    placeholder: "Search places, recents, hotspots…",
    emptyText: "No known locations yet.",
    wide: true,
    cards: true,                 // thumbnail on top, place name under it
    allowCreate: false,          // new locations are made by dropping on the map
    onClose: () => setStatus(""),
    onPick: (item) => {
      // Recents keep the accuracy they were tagged with; anything else follows
      // whatever the imprecise-drop toggle currently says, like a map drop.
      stageDrop(ids, item.lat, item.lng, item.accuracy ?? currentDropAccuracy());
    },
  });
}

// Shared by the Area Selection feature below (its onAreaSelectStart records the
// drag origin here). Place drawing/creation moved to the Custom Places page.
let drawStartLatLng = null;

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

  // Clear month and place selections
  selectedYear = null;
  selectedMonth = null;
  document.getElementById("selected-month-label").textContent = "No month selected";
  clearPlaceFilter();
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
  mapDayOverride = null;   // new scope, so the "show this day" map override is stale
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

// Which of the three mutually exclusive buckets a photo is in. Ignored wins over
// having a coordinate: a photo marked "no location needed" belongs under 🚫 even
// if it happens to carry one from a previous pass.
function photoBucket(photo) {
  if (photo.geocode_ignored) return "ignored";
  return photo.lat != null ? "geotagged" : "untagged";
}

/* ── Apply all active filters → filteredPhotos ──
 * Every view loads its whole scope (geotagged=all) and filters here, so the
 * timeline histogram can describe the whole scope while the grid shows a subset,
 * and so flipping a toggle is instant instead of a round trip. */
function applyFilters(fitMap = false) {
  filteredPhotos = photos.filter(p => {
    if (hiddenCameras.has(p.camera || "Unknown")) return false;
    // Screenshots cuts across the buckets rather than being one of them — a
    // screenshot is usually also untagged, and hiding the noise shouldn't cost
    // you the rest of the untagged photos.
    if (!FILTER_TOGGLES.screenshots && /\.png$/i.test(p.filename)) return false;
    if (!FILTER_TOGGLES[photoBucket(p)]) return false;
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

/* ── Photo right-click menu ──
 * The quick actions for one photo, in the shape the Faces page uses: right-click
 * a thumbnail, act on it without first building a selection. Acting on the whole
 * selection when the clicked photo is part of it is the rule everywhere else in
 * this grid, so the menu follows it and says how many it will touch.
 *
 * (Choosing a place's representative photo used to live here. It moved to the
 * Custom Places page, where the place being edited is on screen.) */
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

  // Right-clicking inside the selection acts on all of it; right-clicking
  // outside acts on that one photo and leaves the selection alone.
  const ids = selectedIds.has(photo.id) ? [...selectedIds] : [photo.id];
  const n = ids.length;
  const suffix = n > 1 ? ` (${n})` : "";

  const header = document.createElement("div");
  header.className = "photo-ctx-header";
  header.textContent = n > 1 ? `${n} selected photos` : photo.filename;
  header.title = photo.filename;
  menu.appendChild(header);

  const add = (label, title, onClick) => {
    const item = document.createElement("div");
    item.className = "photo-ctx-item";
    item.textContent = label;
    item.title = title;
    item.addEventListener("click", () => { closePhotoContextMenu(); onClick(); });
    menu.appendChild(item);
  };

  add(`🚫 Ignore location${suffix}`,
      "Stage as needing no location — review and Commit below",
      () => stageIgnore(ids));
  add(`📍 Assign location…${suffix}`,
      "Pick from saved places, recent locations and hotspots (same as the L key)",
      () => openLocationPicker(ids));
  add("🗺 Show nearby on map",
      "Put every photo from this photo's day on the map, whatever the Show toggles say",
      () => showDayOnMap(photo));

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

/* ── "Show nearby on map" ──
 * Answering "where was I that day?" means seeing the day's *geotagged* photos —
 * which are usually exactly the ones the Show toggles have hidden, since the
 * reason you're here is the untagged ones. So the map takes a day override that
 * outranks the toggles, and the grid is left alone. */
let mapDayOverride = null;   // dayKey string, or null

// Photos the map should pin: everything the filters kept, plus the override
// day's photos even when a toggle excludes them.
function markerPhotos() {
  if (!mapDayOverride) return filteredPhotos;
  const shown = new Set(filteredPhotos.map(p => p.id));
  return filteredPhotos.concat(
    photos.filter(p => !shown.has(p.id) && dayKey(p) === mapDayOverride));
}

function showDayOnMap(photo) {
  const key = dayKey(photo);
  if (!key) { setStatus("That photo has no date, so it has no day to show.", true); return; }
  mapDayOverride = key;
  dayIsolation = null;    // an isolation would fight the override
  renderMarkers();

  const dayPhotos = photos.filter(p => dayKey(p) === key);
  const located = dayPhotos.filter(p => p.lat != null && p.lng != null);
  if (located.length) {
    map.flyToBounds(L.latLngBounds(located.map(p => [p.lat, p.lng])),
                    { padding: [50, 50], maxZoom: 15, duration: 0.8 });
  }
  setStatus(`Map: ${located.length} of ${dayPhotos.length} photo(s) from ${key} ` +
            `(ignoring the Show toggles). Press Esc to clear.`);
}

function clearDayOnMap() {
  if (!mapDayOverride) return false;
  mapDayOverride = null;
  renderMarkers();
  setStatus("Map back to the filtered photos.");
  return true;
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
  const pinnable = markerPhotos();
  const isolatedSet = dayIsolation
    ? new Set(pinnable.filter(p => dayKey(p) === dayIsolation).map(p => p.id))
    : null;
  const inScope = new Set(pinnable.map(p => p.id));
  Object.entries(markersById).forEach(([id, m]) => {
    const nid = Number(id);
    if (!inScope.has(nid) || (isolatedSet && !isolatedSet.has(nid))) {
      m.remove();
      delete markersById[id];
    }
  });
  pinnable.forEach((photo) => {
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
    // applyFilters, not renderGrid — these photos just became geotagged, which
    // can move them out of the Show filter ("Not geotagged", "Mixed geotagged
    // days"). renderGrid alone re-draws the stale filteredPhotos, leaving them
    // on screen until the dropdown is touched.
    applyFilters();
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
    // Same reason as geotag(): losing a geotag can move a photo into or out of
    // the Show filter, so the filtered set has to be rebuilt, not just redrawn.
    applyFilters();
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

// "This photo needs no location" is a judgement like any other tag, and just as
// easy to make on the wrong selection — so it stages next to the dropped
// locations instead of writing straight through, and Revert undoes it for free.
// Un-ignoring is the detail pane's checkbox (one photo at a time, immediate);
// nothing bulk-restores, because a wrong bulk mark is now caught before commit.
function stageIgnore(ids = [...selectedIds]) {
  if (!ids.length) { setStatus("No photos selected", true); return; }
  let staged = 0;
  ids.forEach((id) => {
    const photo = photos.find((p) => p.id === id);
    if (!photo) return;
    // Overwrites a staged drop for the same photo, exactly as re-dropping does.
    pendingGeo.set(id, { photo, ignore: true, label: IGNORE_LABEL });
    selectedIds.delete(id);
    staged++;
  });
  if (!staged) { setStatus("Nothing to stage.", true); return; }
  lastClickedIndex = -1;   // the grid's index run shifts under the removed cells
  hideProposal();
  renderGrid();
  setStatus(`Staged ${staged} photo(s) as needing no location. Nothing saved yet — ` +
            `review at the bottom of the grid, then Commit.`);
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

    // Fit map to include the source pins and the guess pin
    const allPoints = [[data.lat, data.lng], ...data.sources.map(s => [s.lat, s.lng])];
    map.flyToBounds(L.latLngBounds(allPoints).pad(0.3), { duration: 1, maxZoom: 16 });

    // Build summary text
    let summaryText;
    {
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

/* ── Timeline histogram ──
 * The histogram lives in a modal rather than a permanent strip under the
 * toolbar: it's a once-per-month adjustment that was costing every screen 72px
 * of grid height. The toolbar keeps a button and, once the range is narrowed,
 * the range itself — so a filter hidden behind a modal can't be forgotten. */

// Whether the loaded photos carry enough dates to filter on. Hides the toolbar
// entry (and closes the modal) when they don't.
function setTimelineAvailable(available) {
  document.getElementById("timeline-toolbar-group").style.display = available ? "" : "none";
  if (!available) hideTimelineModal();
}

function showTimelineModal() {
  document.getElementById("timeline-modal").style.display = "flex";
  // The canvas had no layout while the modal was hidden, so offsetWidth was 0
  // and every draw during that time was a no-op — redraw now that it has size.
  drawHistogram();
}

function hideTimelineModal() {
  document.getElementById("timeline-modal").style.display = "none";
}

function resetDateFilter() {
  document.getElementById("range-lo").value = 0;
  document.getElementById("range-hi").value = 1000;
  updateDateFilter();
  applyFilters();
}

function bindTimeline() {
  const lo = document.getElementById("range-lo");
  const hi = document.getElementById("range-hi");

  document.getElementById("timeline-btn").addEventListener("click", showTimelineModal);
  document.getElementById("timeline-modal-close").addEventListener("click", hideTimelineModal);
  document.getElementById("timeline-done-btn").addEventListener("click", hideTimelineModal);
  document.getElementById("timeline-reset-btn").addEventListener("click", resetDateFilter);
  document.getElementById("timeline-modal").addEventListener("click", (e) => {
    if (e.target.id === "timeline-modal") hideTimelineModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTimelineModal();
  });

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
    setTimelineAvailable(false);
    dateRangeMin = dateRangeMax = 0;
    dateFilterLo = dateFilterHi = 0;
    histBuckets = [];
    return;
  }
  setTimelineAvailable(true);

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

  // Mirror the range into the toolbar — with the histogram behind a modal this
  // is the only place a narrowed range is visible.
  const label = document.getElementById("timeline-range-label");
  const narrowed = dateFilterLo > dateRangeMin || dateFilterHi < dateRangeMax;
  if (!narrowed) {
    label.textContent = "All dates";
    label.style.color = "";
  } else {
    label.textContent = `${fmtDate(dateFilterLo)} – ${fmtDate(dateFilterHi)}`;
    label.style.color = "#e0a030";   // an active filter reads as a warning, not chrome
  }
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
  // Modal closed: no layout box, nothing to draw. showTimelineModal redraws.
  if (!cssW || !cssH) return;
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
// user should know about.
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
  if (!quiet) setStatus(`Reverted ${removed} staged change(s).`);
}

// Distinct coordinate a staged photo will actually be written at — the commit
// batching key, and what the provisional pins are grouped by.
function pointKey(e) {
  return `${e.lat.toFixed(6)},${e.lng.toFixed(6)},${e.accuracy ?? ""}`;
}

// Group the staging area by resolved place, newest place first is meaningless
// here, so groups are alphabetical with raw-coordinate ones last and the
// no-location group — which isn't a place at all — last of all.
function groupPendingGeo() {
  const groups = new Map();
  pendingGeo.forEach((e) => {
    let g = groups.get(e.label);
    if (!g) { g = { label: e.label, ignore: !!e.ignore, entries: [] }; groups.set(e.label, g); }
    g.entries.push(e);
  });
  return [...groups.values()].sort((a, b) => {
    if (a.ignore !== b.ignore) return a.ignore ? 1 : -1;
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
    `${pendingGeo.size} staged change(s) in ${groups.length} group(s) — not saved yet`;
}

function makePendingGeoGroup(g, groupIdx) {
  const sec = document.createElement("div");
  sec.className = `face-group-section pending-group group-tint-${groupIdx % 6}` +
    (g.ignore ? " pending-ignore-group" : "");
  const points = g.ignore ? 0 : new Set(g.entries.map(pointKey)).size;
  const buttons = [];
  // Nothing to zoom to: the no-location group has no coordinates.
  if (!g.ignore) {
    buttons.push({ icon: "⛶", label: "Zoom to these photos",
      title: "Fit the map to this group's staged point(s)",
      onClick: () => {
        const bounds = L.latLngBounds(g.entries.map(e => [e.lat, e.lng]));
        map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 15, duration: 0.6 });
      } });
  }
  buttons.push(
    { label: `✔ Commit (${g.entries.length})`, kind: "primary",
      title: g.ignore
        ? `Mark these ${g.entries.length} photo(s) as needing no location`
        : `Write just this place's ${g.entries.length} location(s) to the photos`,
      onClick: () => commitPendingGeo([g], g.label) },
    { label: "↩ Revert", kind: "danger",
      title: g.ignore
        ? "Discard these staged marks and put the photos back in the grid"
        : "Discard this place's staged locations and put the photos back in the grid",
      onClick: () => revertPendingGeo([g], g.label) },
  );
  sec.appendChild(faceGroupHeader({
    title: g.label,
    meta: `· ${g.entries.length} photo${g.entries.length !== 1 ? "s" : ""}` +
          (points > 1 ? ` · ${points} drop points` : ""),
    extraClass: "amber",
    buttons,
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
  chip.textContent = e.ignore
    ? "🚫 no location"
    : `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}` + (e.accuracy ? ` ±${e.accuracy}m` : "");
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

  // Click previews the photo and pans to where it would land — an ignored photo
  // has nowhere to pan to, so it just previews.
  cell.addEventListener("click", () => {
    showDetail(photo.id);
    renderPendingGeo();   // move the focus ring
    if (!e.ignore) map.panTo([e.lat, e.lng]);
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
    if (e.ignore) return;   // no coordinate, nothing to pin
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
  if (!confirm(`Commit ${total} staged change(s)${what ? ` — ${what}` : ""}? ` +
               `This writes them to the photos.`)) return;
  setStatus(`Committing ${total} change(s)…`);

  let saved = 0;
  const failures = [];
  for (const g of groups) {
    // The no-location group writes a flag, not a coordinate — one call for all
    // of it, and no Recent entry, since it isn't a place anyone will reuse.
    if (g.ignore) {
      const ids = g.entries.map(e => e.photo.id);
      if (await setGeocodeIgnored(ids, true)) {
        ids.forEach(id => pendingGeo.delete(id));
        saved += ids.length;
      } else {
        failures.push(`${g.label} (${ids.length} photo(s))`);
      }
      continue;
    }
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
        // A committed point is a location the user demonstrably uses — it heads
        // the location picker's Recent list from here on.
        rememberLocation(p.lat, p.lng, p.accuracy, g.label);
      } else {
        failures.push(`${g.label} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`);
      }
    }
  }

  renderGrid();
  if (failures.length) {
    setStatus(`Committed ${saved} of ${total} change(s). Still staged after failing: ` +
              failures.join(", ") + ".", true);
  } else {
    setStatus(`Committed ${saved} change(s).`);
  }
}

// The imprecise-drop toggle applies wherever a drop happens.
function currentDropAccuracy() {
  const toggle = document.getElementById("imprecise-toggle");
  if (!toggle || !toggle.checked) return null;
  return parseFloat(document.getElementById("imprecise-radius-select").value);
}

function revertPendingGeo(groups, what) {
  const ids = groups.flatMap(g => g.entries.map(e => e.photo.id));
  if (!ids.length) { setStatus("Nothing staged to revert.", true); return; }
  if (ids.length > 3 &&
      !confirm(`Discard ${ids.length} staged change(s)${what ? ` — ${what}` : ""}?`)) return;
  unstageGeo(ids);
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
