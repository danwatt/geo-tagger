/* ── State ── */
let photos = [];          // full list from API
let filteredPhotos = [];  // after camera hide + date range filter
let selectedIds = new Set();
let lastClickedIndex = -1;
let markersById = {};     // photo id → its saved-location pin (a member of photoCluster)
let photoCluster = null;  // L.markerClusterGroup holding every pin in markersById
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
let placeFilterParams = null;  // { placeId } or { location } — active location filter
let geocodeLocationPicker = null;
let placeFilterRect = null;    // L.Rectangle drawn for the (buffered) search bounds

/* ── Date range filter state ── */
let dateRangeMin = 0;   // Unix ts — absolute min across all photos
let dateRangeMax = 0;   // Unix ts — absolute max across all photos
let dateFilterLo = 0;   // current low bound (inclusive)
let dateFilterHi = 0;   // current high bound (inclusive)

/* ── Basemaps ── BASEMAPS / setBasemap / addBasemapControl / correctWorldWrap
 * live in basemaps.js. This page credits the satellite imagery in full. */
BASEMAPS.satellite.options.attribution =
  "Tiles © Esri — Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community";

/* ── Camera colors ── camColor / renderLegend / hiddenCameras live in camera-colors.js. */

/* ── Photo timestamps are wall clock, not instants ──
 * photo_datetime is the EXIF datetime read as if it were UTC (sidecar.py's
 * _parse_exif_datetime → calendar.timegm), so "2007:07:11 20:07:11" is stored
 * as 20:07 *UTC* no matter which zone the camera was in — there's no offset in
 * the file to do better. Reading it back with the browser's local getters
 * therefore shifts every photo by the viewer's own offset: in US Central that
 * 20:07 photo lands in the 3 PM band, and photos near midnight land on the
 * wrong day entirely. So every calendar field the UI shows is taken with the
 * UTC getters, which hand back exactly the wall clock the camera wrote. The
 * backend already does the same (serializers.photo_to_dict, index.py's
 * timegm-based date filters, the timeline's strftime(...,'unixepoch')). */
const UTC = { timeZone: "UTC" };

function dayKey(photo) {
  if (!photo.photo_datetime) return null;
  return wallClockDay(photo.photo_datetime);
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
  await loadDirFacet();
  await fitMapToAllLocations();

  // A "?month=YYYY-MM" URL argument (e.g. from the homepage month charts)
  // jumps straight to that month, same as picking it from the Month Picker.
  // "?month=undated" (from the homepage's Undated link) jumps to the Undated
  // queue instead.
  const params = new URLSearchParams(window.location.search);
  // "?batch=<id>" (from the Home work queue) loads that batch and selects it.
  const batchArg = params.get("batch");
  if (batchArg) {
    await enterBatch(batchArg);
    return;
  }
  // "?ids=1,2,3" (from the Search page's "Open in Geocode") loads exactly that
  // photo set, in place of a month/folder/batch scope.
  const idsArg = params.get("ids");
  if (idsArg) {
    const ids = idsArg.split(",").map(Number).filter(Number.isFinite);
    if (ids.length) {
      await loadPhotosByIds(ids, `${ids.length.toLocaleString()} photo(s) from Search`);
      return;
    }
  }
  const monthArg = params.get("month");
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
    if (!res.ok) return;   // a server error isn't "ExifTool missing"
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

  // Saved-location pins are clustered (same library and version as map.js), so a
  // month of photos isn't thousands of live DOM markers. Only these: staged,
  // guess and accuracy layers go straight on the map and are never hidden in a
  // cluster. The radius is kept small — about a pin's width — so only pins that
  // were already stacked on top of each other merge; pins that stood apart stay
  // individually clickable and draggable at the zoom they always were.
  photoCluster = L.markerClusterGroup({
    maxClusterRadius: 30,
    chunkedLoading: true,
    showCoverageOnHover: false,
  });
  map.addLayer(photoCluster);

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

async function fitMapToAllLocations() {
  try {
    const res = await fetch("/api/stats/bounds");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

function bindToolbar() {
  document.getElementById("select-month-btn").addEventListener("click", showMonthPicker);
  document.getElementById("select-area-btn").addEventListener("click", startAreaSelection);
  function reloadCurrentView() {
    // enterScope leaves exactly one of these set, so the order is only a tiebreak.
    if (batchScope) {
      loadPhotoScope(batchScope.url, batchScope.label, { timeline: batchScope.timeline });
    } else if (selectedYear || undatedMode) {
      loadPhotos();
    } else if (areaSelectParams) {
      loadPhotosByArea(areaSelectParams.lat, areaSelectParams.lng, areaSelectParams.radius);
    } else if (placeFilterParams) {
      if (placeFilterParams.location) {
        filterPhotosByRecordedLocation(placeFilterParams.location);
      } else {
        const place = places.find(p => p.id === placeFilterParams.placeId);
        if (place) filterPhotosByPlace(place);
      }
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

  // Row banding is pure presentation of the loaded photos — re-render the grid,
  // nothing else. The choice sticks per browser, like the recent-locations list.
  const bandSelect = document.getElementById("band-select");
  const savedBand = localStorage.getItem(BAND_SECS_KEY);
  if (savedBand !== null && [...bandSelect.options].some(o => o.value === savedBand)) {
    bandSelect.value = savedBand;
  }
  bandSecs = Number(bandSelect.value);
  bandSelect.addEventListener("change", () => {
    bandSecs = Number(bandSelect.value);
    localStorage.setItem(BAND_SECS_KEY, bandSelect.value);
    renderGrid();
  });
  document.getElementById("place-search-btn").addEventListener("click", doPlaceSearch);
  document.getElementById("place-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doPlaceSearch();
  });
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
  wireGeocodeLocationPicker();
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
  bindBatchMode();
  bindGridKeyboardShortcuts();
  document.getElementById("shortcuts-help-btn").addEventListener("click", openShortcutsHelp);
  document.getElementById("shortcuts-help-close").addEventListener("click", closeShortcutsHelp);
  document.getElementById("shortcuts-help-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "shortcuts-help-backdrop") closeShortcutsHelp();
  });

  // Location picker — the map-free way to tag a selection at a place that
  // already exists. "l" is the shortcut; the toolbar button is the discoverable
  // form of the same thing.
  // Wrapped, not passed by reference: the click event would land in `ids`.
  document.getElementById("tag-as-btn").addEventListener("click", () => openLocationPicker());
  document.addEventListener("keydown", (e) => {
    if (isTypingTarget(e)) return;   // common.js — always first
    if (e.key !== "l" && e.key !== "L") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;
    // Don't stack the picker on top of the month/timeline modals.
    if (anyModalOpen()) return;
    e.preventDefault();
    openLocationPicker();
  });

  // Esc drops the "Show nearby on map" day override — but only once whatever it
  // is stacked on top of (picker, modal) has taken its own turn at the key.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !mapDayOverride) return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;
    if (anyModalOpen()) return;
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

/* ── Month Picker ──
 * Two levels: a year grid first (one card per year, with a 12-cell strip that
 * shows each month's volume + geotag coverage at a glance), then drill into a
 * single year for the full month grid. The old flat year-headed list meant
 * scrolling past ~12 rows per year to reach anything older. */
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let monthStats = null;   // cached /api/stats/months payload, reused by both picker views

async function showMonthPicker() {
  try {
    const res = await fetch("/api/stats/months");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    monthStats = await res.json();
    renderPickerYears();
    document.getElementById("month-picker-modal").style.display = "flex";
  } catch (e) {
    console.error("Failed to load month stats:", e);
    setStatus("Error loading months: " + e.message, true);
  }
}

function hideMonthPicker() {
  document.getElementById("month-picker-modal").style.display = "none";
}

function pickerTitle(text) {
  document.querySelector("#month-picker-modal h2").textContent = text;
}

function fmtCount(n) {
  return (n || 0).toLocaleString();
}

// Geotagged share of a bucket, as a slim two-tone bar.
function coverageBarHtml(geotagged, total) {
  const pct = total ? Math.round((geotagged / total) * 100) : 0;
  return `<div class="yp-bar" title="${pct}% geotagged"><div class="yp-bar-fill" style="width:${pct}%"></div></div>`;
}

function countsHtml(m) {
  return `<span class="count-badge count-total">${fmtCount(m.total)} total</span>
          <span class="count-badge count-geotagged">${fmtCount(m.geotagged)} geotagged</span>
          <span class="count-badge count-not-geotagged">${fmtCount(m.not_geotagged)} not geotagged</span>`;
}

function pickerMonthsByYear() {
  const byYear = {};
  (monthStats.months || []).forEach(m => {
    if (!byYear[m.year]) byYear[m.year] = [];
    byYear[m.year].push(m);
  });
  return byYear;
}

function renderPickerYears() {
  const list = document.getElementById("month-picker-list");
  list.innerHTML = "";
  pickerTitle("Select Year");

  if (monthStats.undated && monthStats.undated.total > 0) {
    const u = monthStats.undated;
    const item = document.createElement("div");
    item.className = "yp-undated";
    item.innerHTML = `<div class="yp-undated-name">📁 Undated</div>
                      <div class="month-counts">${countsHtml(u)}</div>`;
    item.addEventListener("click", selectUndated);
    list.appendChild(item);
  }

  if (!monthStats.months || monthStats.months.length === 0) {
    if (!monthStats.undated || monthStats.undated.total === 0) {
      list.innerHTML = "<p>No photos found with timestamps.</p>";
    }
    return;
  }

  const byYear = pickerMonthsByYear();
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

  // Month cells are scaled against the busiest month in the whole library, so
  // the strips are comparable across years rather than each year self-scaling.
  const peak = Math.max(...monthStats.months.map(m => m.total), 1);

  const grid = document.createElement("div");
  grid.className = "yp-year-grid";

  years.forEach(year => {
    const months = byYear[year];
    const tot = months.reduce((a, m) => a + m.total, 0);
    const geo = months.reduce((a, m) => a + m.geotagged, 0);
    const nogeo = months.reduce((a, m) => a + m.not_geotagged, 0);
    const byMonth = {};
    months.forEach(m => { byMonth[m.month] = m; });

    const card = document.createElement("div");
    card.className = "yp-year-card";
    card.innerHTML = `
      <div class="yp-year-top">
        <span class="yp-year-num">${year}</span>
        <button type="button" class="yp-all-btn" title="Load every photo from ${year}">All year</button>
      </div>
      ${coverageBarHtml(geo, tot)}
      <div class="month-counts">
        <span class="count-badge count-total">${fmtCount(tot)} total</span>
        <span class="count-badge count-geotagged">${fmtCount(geo)}</span>
        <span class="count-badge count-not-geotagged">${fmtCount(nogeo)}</span>
      </div>
      <div class="yp-spark"></div>
    `;

    const spark = card.querySelector(".yp-spark");
    for (let mo = 1; mo <= 12; mo++) {
      const m = byMonth[mo];
      const cell = document.createElement("div");
      cell.className = m ? "yp-spark-cell" : "yp-spark-cell empty";
      if (m) {
        // Height encodes volume (sqrt so a single huge month doesn't flatten
        // the rest), fill color encodes geotag coverage.
        const h = Math.max(0.12, Math.sqrt(m.total / peak));
        const pct = m.total ? Math.round((m.geotagged / m.total) * 100) : 0;
        cell.innerHTML = `<div class="yp-spark-bar" style="height:${(h * 100).toFixed(0)}%"><div class="yp-spark-geo" style="height:${pct}%"></div></div>`;
        cell.title = `${MONTH_NAMES[mo - 1]} ${year} — ${fmtCount(m.total)} photos, ${pct}% geotagged`;
        cell.addEventListener("click", (e) => { e.stopPropagation(); selectMonth(year, mo); });
      }
      spark.appendChild(cell);
    }

    card.querySelector(".yp-all-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectYear(year);
    });
    card.addEventListener("click", () => renderPickerMonths(year));
    grid.appendChild(card);
  });

  list.appendChild(grid);
  list.scrollTop = 0;
}

function renderPickerMonths(year) {
  const list = document.getElementById("month-picker-list");
  const byYear = pickerMonthsByYear();
  const months = byYear[year] || [];
  const byMonth = {};
  months.forEach(m => { byMonth[m.month] = m; });

  list.innerHTML = "";
  pickerTitle(`Select Month — ${year}`);

  const bar = document.createElement("div");
  bar.className = "yp-crumb";
  bar.innerHTML = `<button type="button" class="yp-back">← All years</button>
                   <button type="button" class="yp-all-btn">Browse all ${year}</button>`;
  bar.querySelector(".yp-back").addEventListener("click", renderPickerYears);
  bar.querySelector(".yp-all-btn").addEventListener("click", () => selectYear(year));
  list.appendChild(bar);

  const grid = document.createElement("div");
  grid.className = "yp-month-grid";
  for (let mo = 1; mo <= 12; mo++) {
    const m = byMonth[mo];
    const cell = document.createElement("div");
    cell.className = m ? "yp-month-card" : "yp-month-card empty";
    if (!m) {
      cell.innerHTML = `<div class="yp-month-name">${MONTH_ABBR[mo - 1]}</div>
                        <div class="yp-month-none">—</div>`;
    } else {
      cell.innerHTML = `
        <div class="yp-month-name">${MONTH_NAMES[mo - 1]}</div>
        <div class="yp-month-total">${fmtCount(m.total)}</div>
        ${coverageBarHtml(m.geotagged, m.total)}
        <div class="month-counts">
          <span class="count-badge count-geotagged">${fmtCount(m.geotagged)}</span>
          <span class="count-badge count-not-geotagged">${fmtCount(m.not_geotagged)}</span>
        </div>
      `;
      cell.addEventListener("click", () => selectMonth(year, mo));
    }
    grid.appendChild(cell);
  }
  list.appendChild(grid);
  list.scrollTop = 0;
}

async function selectMonth(year, month) {
  enterScope("month", `${MONTH_NAMES[month - 1]} ${year}`);
  selectedYear = year;
  selectedMonth = month;
  setTimelineAvailable(true);
  // Load photos for this month (loadPhotos builds the timeline from them)
  await loadPhotos(true);
}

async function selectYear(year) {
  enterScope("month", `${year} (all months)`);
  selectedYear = year;
  setTimelineAvailable(true);
  await loadPhotos(true);
}

// The Undated queue: photos with no timestamp at all, so there's no month/day
// to drill into — no histogram, no day timeline, just the grid (grouped by
// location if geotagged despite the missing date, else by containing directory
// — see renderGrid's undatedSubGroups).
async function selectUndated() {
  enterScope("month", "Undated photos");
  undatedMode = true;
  setTimelineAvailable(false);
  await loadPhotos(true);
}

/* ── Places Management ── */

async function loadPlaces() {
  try {
    const res = await fetch("/api/places");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    places = await res.json();

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
      shape.bindTooltip(escapeHtml(p.name), { permanent: false, direction: "top" });
      shape.addTo(map);
      placeShapes[p.id] = shape;
    }
  });
}

function wireGeocodeLocationPicker() {
  const help = document.getElementById("geocode-location-help");
  geocodeLocationPicker = createLocationPicker({
    input: document.getElementById("geocode-location-input"),
    box: document.getElementById("geocode-location-suggest"),
    emptyMessage: "No saved or recorded locations match. Try a city, county, or saved place name.",
    errorMessage: "Could not load locations. Type to retry.",
    async onSelect(item) {
      document.getElementById("place-buffer-select").value = "0";
      if (item.kind === "place") {
        // Refresh shapes as well: saved places may have changed in another tab.
        await loadPlaces();
        if (document.getElementById("geocode-location-input").value !== item.label) return;
        const place = places.find(p => p.id === item.id);
        if (!place) { setStatus("Saved place is unavailable. Choose another location.", true); return; }
        filterPhotosByPlace(place);
      } else {
        filterPhotosByRecordedLocation(item);
      }
    },
    onEdit() {
      help.textContent = "Choose a suggestion to change the loaded location.";
    },
  });
}

async function filterPhotosByRecordedLocation(location) {
  enterScope("location");
  placeFilterParams = { location };
  document.getElementById("selected-area-label").textContent = location.label;
  document.getElementById("geocode-location-input").value = location.label;
  document.getElementById("place-buffer-select").hidden = true;
  document.getElementById("geocode-location-help").textContent = "Matches recorded photo locations; includes untagged candidates within the time window.";
  const params = new URLSearchParams({
    location_fields: JSON.stringify(location.fields),
    window: document.getElementById("window-select").value,
  });
  try {
    setStatus(`Loading photos in ${location.label}…`);
    const data = await fetchPhotoScope(`/api/photos/by-location?${params}`);
    if (data === LATEST_ONLY_STALE) return;
    setScopePhotos(data, { fitMap: true });
    setStatus(`Loaded ${photos.length} photos in ${location.label}`);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
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
  enterScope("place");
  document.getElementById("geocode-location-input").value = place.name;
  document.getElementById("place-buffer-select").hidden = false;
  document.getElementById("geocode-location-help").textContent = "Matches saved bounds; includes untagged candidates within the time window.";

  const bufferMiles = parseFloat(document.getElementById("place-buffer-select").value) || 0;
  const box = placeBboxWithBuffer(place, bufferMiles);
  placeFilterParams = { placeId: place.id };

  // Draw (and zoom to) the search bounds so the buffer is visible. (enterScope
  // already removed the previous rectangle.)
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
  const window = document.getElementById("window-select").value;

  try {
    setStatus(`Loading photos in ${label}…`);
    const url = `/api/photos/by-bounds?min_lat=${box.min_lat}&max_lat=${box.max_lat}`
      + `&min_lng=${box.min_lng}&max_lng=${box.max_lng}&geotagged=all&window=${window}`;
    const data = await fetchPhotoScope(url);
    if (data === LATEST_ONLY_STALE) return;
    setScopePhotos(data);  // no fitMap — we already zoomed to the bounds

    setStatus(`Loaded ${photos.length} photos in ${label}`);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

// No need to cancel an in-flight place load here: every caller is switching to
// another scope, and that scope's load supersedes it through fetchPhotoScope.
function clearPlaceFilter() {
  placeFilterParams = null;
  if (placeFilterRect) { map.removeLayer(placeFilterRect); placeFilterRect = null; }
  geocodeLocationPicker?.close();
  document.getElementById("geocode-location-input").value = "";
  document.getElementById("place-buffer-select").hidden = true;
  document.getElementById("geocode-location-help").textContent = "Choose a location to load photos and nearby untagged candidates.";
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
    // Truthiness, not `> 0`: pre-1970 dates are negative; undated is 0/null.
    if (!p.photo_datetime) return;
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

  // The area takes over as the scope. Before adopting the new circle, because
  // enterScope removes whatever area circle is up.
  enterScope("area");
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
  document.getElementById("selected-area-label").textContent =
    `Area: ${(radius / 1000).toFixed(2)}km radius`;

  await loadPhotosByArea(center.lat, center.lng, radius);
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

// Returns false when a newer scope load superseded this one (nothing applied).
async function loadPhotosByArea(lat, lng, radius) {
  const window = document.getElementById("window-select").value;

  try {
    setStatus("Loading photos in area...");
    const data = await fetchPhotoScope(
      `/api/photos/by-area?lat=${lat}&lng=${lng}&radius=${radius}&geotagged=all&window=${window}`);
    if (data === LATEST_ONLY_STALE) return false;
    setScopePhotos(data, { fitMap: true });

    setStatus(`Loaded ${photos.length} photos in area`);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
  return true;
}

/* ── Load photos ──
 * Every scope loader (month/year/undated, batch, folder, area, place, recorded
 * location) fills the same `photos`, so they all fetch through this one
 * latest-only wrapper (common.js): pick month A then month B, and A's response —
 * cancelled, or arriving late anyway — resolves to LATEST_ONLY_STALE and is
 * never applied over B. */
const fetchPhotoScope = latestOnly(async (signal, url) => {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
});

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
      const lastDay = daysInMonth(selectedYear, selectedMonth);
      dateTo = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${lastDay}`;
    } else {
      dateFrom = `${selectedYear}-01-01`;
      dateTo = `${selectedYear}-12-31`;
    }
    url = `/api/photos?geotagged=all&date_from=${dateFrom}&date_to=${dateTo}`;
  }

  await loadPhotoScope(url, null, { timeline: !undatedMode, fitMap });
}

/* Load one scope's photos and render everything that hangs off them. Shared by
 * the month/year/undated views and by batch mode, which loads a date range or a
 * single directory instead. `label` (when given) replaces the scope label in the
 * toolbar; `timeline` false means the scope has no usable dates. */
async function loadPhotoScope(url, label = null, { timeline = true, fitMap = false } = {}) {
  try {
    const data = await fetchPhotoScope(url);
    if (data === LATEST_ONLY_STALE) return;
    if (label !== null) {
      document.getElementById("selected-month-label").textContent = label;
    }
    setScopePhotos(data, { timeline, fitMap });
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

/* ── Folder facet ──
 * The month picker can't reach an undated scan folder at all, and even a dated
 * one is a folder first — so directories are their own way into a scope, sharing
 * the `dir` filter the work queue's folder batches use. */
async function loadDirFacet() {
  const select = document.getElementById("dir-select");
  if (!select) return;
  let dirs;
  try {
    const res = await fetch("/api/photos/dirs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dirs = await res.json();
  } catch (err) {
    return;   // the facet is a shortcut; the month picker still works without it
  }
  dirs.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.dir;
    // Untagged first in the label as well as the order — that's what says whether
    // a folder is worth opening.
    opt.textContent = d.untagged
      ? `${shortDir(d.dir)} — ${d.untagged.toLocaleString()} untagged of ${d.total.toLocaleString()}`
      : `${shortDir(d.dir)} — all ${d.total.toLocaleString()} done`;
    opt.title = d.dir;
    select.appendChild(opt);
  });
  select.addEventListener("change", async () => {
    const dir = select.value;
    if (!dir) return;
    // Choosing a scope by hand means the user has stopped being driven by the
    // queue; leaving the banner up would lie about what is loaded.
    if (activeBatch) exitBatch();
    await loadPhotosByDir(dir, shortDir(dir));
  });
}

// Last two path components: a full path is unreadable in a dropdown and the tail
// is what identifies the folder. Mirrors work_queue_service.short_dir.
function shortDir(dir) {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  return "…" + sep + parts.slice(-2).join(sep);
}

/* ── Scope changes ──
 * The page has one loaded scope at a time, and several ways into it:
 *   "month"    — month / year / Undated (selectMonth, selectYear, selectUndated;
 *                also ?month=)
 *   "batch"    — a work-queue outing's date range (openBatch; also ?batch=)
 *   "dir"      — one folder (the folder facet, or a folder batch)
 *   "ids"      — an explicit photo set (?ids= from Search)
 *   "area"     — a circle drawn on the map
 *   "place"    — a saved place's (buffered) bounds
 *   "location" — a recorded location from the location picker
 *   "roadtrip" — a route corridor (roadtrip.js, when it's loaded)
 * Each keeps its own "what is loaded" variable, and reloadCurrentView re-runs
 * whichever is set — so a scope that forgot to clear another's (batchScope was
 * never nulled) made a Window/buffer change reload the *old* scope. Every entry
 * point calls enterScope first, which clears all of them; the caller then sets
 * its own. The data side of the reset — date filter, selection, shift-click
 * anchor, detail focus — happens when the photos arrive, in setScopePhotos. */
function enterScope(kind, label = "No month selected") {
  // Any in-flight load is for the scope being left. The fetchPhotoScope loaders
  // supersede each other anyway; this also covers loaders that fetch on their
  // own (roadtrip) and so would otherwise be painted over by a slow older load.
  fetchPhotoScope.cancel();
  // Picking a scope by hand means the user has stopped being driven by the work
  // queue — the banner would lie about what is loaded, and batchRemaining would
  // read 0 for members that aren't loaded and auto-advance on the next commit.
  // A batch's own loads ("batch", and "dir" for a folder batch) keep it; the
  // folder facet exits the batch itself before loading.
  if (activeBatch && kind !== "batch" && kind !== "dir") exitBatch();

  selectedYear = null;
  selectedMonth = null;
  undatedMode = false;
  batchScope = null;
  const dirSelect = document.getElementById("dir-select");
  if (dirSelect) dirSelect.value = "";
  areaSelectParams = null;
  if (areaSelectCircle) {
    map.removeLayer(areaSelectCircle);
    areaSelectCircle = null;
  }
  clearPlaceFilter();
  dayIsolation = null;
  mapDayOverride = null;   // the "show this day" override was for the old scope
  document.getElementById("selected-area-label").textContent = "";
  document.getElementById("selected-month-label").textContent = label;
  hideMonthPicker();
}

// Back to "no date filter". setTimelineAvailable(false) clears the picker's UI
// but, like setDates, never fires onChange — so the four bounds have to be
// zeroed here, or the previous scope's range keeps filtering the new one (a
// June 2019 range hid every photo of a 2021 folder). dateRangeMin === Max is
// what applyFilters reads as "off".
function resetDateFilter() {
  dateRangeMin = dateRangeMax = 0;
  dateFilterLo = dateFilterHi = 0;
  setTimelineAvailable(false);
}

// Empty the detail pane (and what hangs off the focused photo: guess, accuracy
// circle) — used when the focused photo isn't part of the new scope at all.
function clearDetail() {
  showDetail.cancel();
  doGuess.cancel();
  resetGuessButton();
  dismissGuess();
  focusedPhotoId = null;
  showAccuracyCircle(null);
  document.getElementById("detail-placeholder").style.display = "";
  document.getElementById("detail-content").style.display = "none";
}

/* Adopt a freshly loaded scope's photos and render everything off them. The
 * single landing point for every scope loader, so the per-scope resets can't be
 * forgotten by one of them. `timeline` false means the scope has no usable dates
 * (a folder): the date filter is switched off rather than left at the last
 * scope's range. */
function setScopePhotos(data, { timeline = true, fitMap = false } = {}) {
  photos = data;
  // Pre-assign colors so the legend order is stable
  photos.forEach(p => camColor(p.camera));
  renderLegend();
  if (timeline) {
    buildHistogram();   // resets the range to the new scope's own span
  } else {
    resetDateFilter();
  }
  // filteredPhotos is about to be rebuilt from different photos: an anchor
  // index into the old array would point at an unrelated photo (or past the end).
  lastClickedIndex = -1;
  // Also on a same-scope reload (Window/buffer change): the day may be gone.
  dayIsolation = null;
  mapDayOverride = null;
  // A focused photo from the old scope would keep feeding g/Guess and the detail
  // pane while not being anywhere on the page. A staged one is still on the page
  // (the staging area), so it keeps its preview.
  if (focusedPhotoId != null && !pendingGeo.has(focusedPhotoId) &&
      !photos.some(p => p.id === focusedPhotoId)) {
    clearDetail();
  }
  applyFilters(fitMap);   // also prunes the selection to what's visible
}

/* ── Batch scopes ──
 * A batch straddles months (and a folder has no dates at all), so neither
 * selectMonth nor selectUndated can express one — these load the scope directly. */
async function loadPhotosByDateRange(from, to, label) {
  enterScope("batch", label);
  setTimelineAvailable(true);
  batchScope = { url: `/api/photos?geotagged=all&date_from=${from}&date_to=${to}`, label,
                 timeline: true };
  await loadPhotoScope(batchScope.url, label, { timeline: true });
}

async function loadPhotosByIds(ids, label) {
  enterScope("ids", label);
  setTimelineAvailable(true);
  batchScope = { url: `/api/photos?ids=${ids.join(",")}`, label, timeline: true };
  await loadPhotoScope(batchScope.url, label, { timeline: true });
}

async function loadPhotosByDir(dir, label) {
  enterScope("dir", label);
  const select = document.getElementById("dir-select");
  // A folder batch arriving from the queue should show up in the picker too.
  if (select && select.value !== dir) {
    select.value = [...select.options].some(o => o.value === dir) ? dir : "";
  }
  // A scanned folder is usually undated, and even a dated one is a folder first —
  // the histogram would describe a span the user isn't working in.
  setTimelineAvailable(false);
  batchScope = { url: `/api/photos?geotagged=all&dir=${encodeURIComponent(dir)}`, label,
                 timeline: false };
  await loadPhotoScope(batchScope.url, label, { timeline: false });
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
let applyFiltersFrame = 0;

// applyFilters for high-frequency callers (the date scrubber): at most one
// rebuild per animation frame, always of the state current when it runs.
function scheduleApplyFilters() {
  if (applyFiltersFrame) return;
  applyFiltersFrame = requestAnimationFrame(() => {
    applyFiltersFrame = 0;
    applyFilters();
  });
}

function applyFilters(fitMap = false) {
  // A direct call renders the latest state, so a queued frame would only repeat it.
  if (applyFiltersFrame) {
    cancelAnimationFrame(applyFiltersFrame);
    applyFiltersFrame = 0;
  }
  // The shift-click / shift+j anchor is an index into filteredPhotos, which is
  // about to be rebuilt — so carry it over by photo id, not by position.
  const anchorId = filteredPhotos[lastClickedIndex]?.id;
  filteredPhotos = photos.filter(p => {
    if (hiddenCameras.has(p.camera || "Unknown")) return false;
    // Screenshots cuts across the buckets rather than being one of them — a
    // screenshot is usually also untagged, and hiding the noise shouldn't cost
    // you the rest of the untagged photos.
    if (!FILTER_TOGGLES.screenshots && /\.png$/i.test(p.filename)) return false;
    if (!FILTER_TOGGLES[photoBucket(p)]) return false;
    if (dateRangeMin !== dateRangeMax) {
      // Undated (0/null) stays visible; negative = pre-1970, still range-filtered.
      const ts = p.photo_datetime || 0;
      if (ts && (ts < dateFilterLo || ts > dateFilterHi)) return false;
    }
    return true;
  });
  lastClickedIndex = anchorId == null ? -1 : filteredPhotos.findIndex(p => p.id === anchorId);

  // What you see is what you act on: L, I, drag, the context menu, Remove geotag
  // and the propose bar all take the whole selection, so a selected photo a
  // filter has just hidden would be tagged without ever being on screen. Hidden
  // photos are deselected rather than kept-but-skipped — the "N selected" chip
  // then always matches the highlighted cells, at the price of re-selecting
  // after showing them again. Staged photos left the selection when they were
  // staged, so they're never in here.
  const visible = new Set(filteredPhotos.map(p => p.id));
  let deselected = 0;
  selectedIds.forEach((id) => {
    if (!visible.has(id)) { selectedIds.delete(id); deselected++; }
  });

  renderGrid();
  renderMarkers();
  // Only on a change: the scrubber calls this every frame, and each call would
  // otherwise re-arm the propose request.
  if (deselected) refreshSelectionUI();
  setStatus(`Showing ${filteredPhotos.length} of ${photos.length} photos` +
            (deselected ? ` · deselected ${deselected} now hidden` : ""));
  if (fitMap) fitMapToPhotos();
}

function fitMapToPhotos() {
  const tagged = filteredPhotos.filter(p => p.lat != null);
  if (tagged.length === 0) return;
  const bounds = L.latLngBounds(tagged.map(p => [p.lat, p.lng]));
  map.flyToBounds(bounds, { padding: [40, 40], duration: 1.2, maxZoom: 16 });
}

const DAY_ABBRS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ── Grid ── */
// Each photo's cell, built once and re-used by every renderGrid. A filter
// flip, a stage or a commit re-lays the day sections, but the cells (and their
// <img>s, already decoded) just move into the new sections instead of being
// rebuilt. Keyed by the photo *object*, so loading a new scope — which brings
// fresh objects — starts clean and the old cells are collected with the old list.
const thumbCells = new WeakMap();

function makeThumbCell(photo, idx) {
  let cell = thumbCells.get(photo);
  if (!cell) {
    cell = buildThumbCell(photo);
    thumbCells.set(photo, cell);
  }
  // State that changes between renders is (re)applied on every render.
  cell.className = "thumb-cell" +
    (selectedIds.has(photo.id) ? " selected" : "") +
    (photo.lat != null ? " tagged" : "") +
    (photo.geocode_ignored ? " geo-ignored" : "");
  cell.dataset.idx = idx;
  return cell;
}

function buildThumbCell(photo) {
  const cell = document.createElement("div");
  cell.dataset.id = photo.id;
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

  // The index into filteredPhotos changes with every filter, so it's read off
  // the cell at click time (makeThumbCell keeps it current).
  cell.addEventListener("click", (e) => handleThumbClick(e, photo.id, Number(cell.dataset.idx)));
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

  const add = (label, title, onClick, disabled = false) => {
    const item = document.createElement("div");
    item.className = "photo-ctx-item" + (disabled ? " disabled" : "");
    item.textContent = label;
    item.title = title;
    if (!disabled) {
      item.addEventListener("click", () => { closePhotoContextMenu(); onClick(); });
    }
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

  // Road Trip mode (roadtrip.js) appends "start/end the trip here" entries. The
  // page works without that file loaded, so the hook is optional.
  if (typeof window.roadtripContextItems === "function") window.roadtripContextItems(photo, add);

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
      year = date.getUTCFullYear();
      month = date.getUTCMonth();
      day = date.getUTCDate();
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
        ? `${DAY_ABBRS[group.date.getUTCDay()]} ${group.day}`
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

      // Inside a dated day the cells break again into time bands (width from the
      // Rows dropdown): a day on the road is a hundred thumbnails, and "which of
      // these are the 3pm ones" is the question you're actually asking when
      // placing them. A day that falls in one band gets no label — it would only
      // repeat the header. Undated sub-groups have no clock to band by.
      const bands = group.date ? timeBands(sub.photos) : [{ start: null, photos: sub.photos }];
      bands.forEach((band, bandIdx) => {
        if (band.start !== null && bands.length > 1) {
          const div = document.createElement("div");
          div.className = "grid-band-divider" + (bandIdx === 0 ? " first-band" : "");
          div.textContent = `${bandLabel(band.start)} · ${band.photos.length}`;
          sec.appendChild(div);
        }
        const cells = document.createElement("div");
        cells.className = "face-group-cells";
        band.photos.forEach(({ photo, idx }) => cells.appendChild(makeThumbCell(photo, idx)));
        sec.appendChild(cells);
      });
      grid.appendChild(sec);
      groupIdx++;
    });
  });

  // The grid and the staging area are two views of the same photo list — a
  // staged photo leaves one and appears in the other — so they render together.
  renderPendingGeo();
}

/* ── Time bands inside a day ──
 * Band width in seconds, or 0 for "don't split the day at all". Every width on
 * offer divides an hour evenly, so bucketing on the raw epoch second puts the
 * boundaries on clock times (:00, :05, :10 …) — that works because
 * photo_datetime is wall-clock-as-UTC (see the note above dayKey), so epoch
 * zero is midnight on the same clock the photos were taken by. */
const BAND_SECS_KEY = "geotagger.gridBandSecs";
let bandSecs = 3600;

// Consecutive runs of photos that share a band. filteredPhotos is in time
// order, so a run *is* a band — no sorting or bucketing needed.
function timeBands(entries) {
  if (!bandSecs) return [{ start: null, photos: entries }];
  const bands = [];
  entries.forEach(entry => {
    const ts = entry.photo.photo_datetime;
    const start = ts ? Math.floor(ts / bandSecs) * bandSecs : null;
    const last = bands[bands.length - 1];
    if (!last || last.start !== start) bands.push({ start, photos: [entry] });
    else last.photos.push(entry);
  });
  return bands;
}

// UTC on purpose — see the note above dayKey. Hour bands leave off the ":00"
// that would otherwise be on every label.
function bandLabel(startTs) {
  const opts = { hour: "numeric", timeZone: "UTC" };
  if (bandSecs < 3600) opts.minute = "2-digit";
  return new Date(startTs * 1000).toLocaleTimeString(undefined, opts);
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
  focusPhotoAt(idx);
}

// Shared tail of a click or keyboard-nav move: park the grid's keyboard/detail
// focus on filteredPhotos[idx] and give it the same treatment a click gets
// (detail pane, accuracy circle, map fly-to, scrolled into view).
function focusPhotoAt(idx) {
  lastClickedIndex = idx;
  refreshSelectionUI();
  const photo = filteredPhotos[idx];
  if (!photo) return;
  showDetail(photo.id);
  showAccuracyCircle(photo);
  if (photo.lat != null) map.flyTo([photo.lat, photo.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
  document.querySelector(`.thumb-cell[data-id="${photo.id}"]`)?.scrollIntoView({ block: "nearest" });
}

// j/k (or arrow keys): move keyboard focus by `delta` photos, collapsing the
// selection to just that one — mirrors a plain click on the destination cell.
function moveGridFocus(delta) {
  if (!filteredPhotos.length) return;
  let idx = filteredPhotos.findIndex(p => p.id === focusedPhotoId);
  idx = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
  idx = Math.max(0, Math.min(filteredPhotos.length - 1, idx + delta));
  selectedIds.clear();
  selectedIds.add(filteredPhotos[idx].id);
  focusPhotoAt(idx);
}

// Shift+j/k: extends the selection from the last click/nav position to `delta`
// photos past the current focus — mirrors shift-click's range select.
function extendGridFocus(delta) {
  if (!filteredPhotos.length) return;
  const anchor = lastClickedIndex >= 0 ? lastClickedIndex :
    Math.max(0, filteredPhotos.findIndex(p => p.id === focusedPhotoId));
  let idx = filteredPhotos.findIndex(p => p.id === focusedPhotoId);
  idx = idx === -1 ? anchor : idx;
  idx = Math.max(0, Math.min(filteredPhotos.length - 1, idx + delta));
  const lo = Math.min(anchor, idx);
  const hi = Math.max(anchor, idx);
  for (let i = lo; i <= hi; i++) {
    if (!pendingGeo.has(filteredPhotos[i].id)) selectedIds.add(filteredPhotos[i].id);
  }
  focusPhotoAt(idx);
}

function toggleGridFocusSelection() {
  if (!focusedPhotoId) return;
  selectedIds.has(focusedPhotoId) ? selectedIds.delete(focusedPhotoId) : selectedIds.add(focusedPhotoId);
  refreshSelectionUI();
}

function refreshSelectionUI() {
  const selectionActions = document.getElementById("photo-selection-actions");
  if (selectionActions) {
    selectionActions.hidden = selectedIds.size === 0;
    document.getElementById("workspace-selection-count").textContent = `${selectedIds.size} selected`;
  }
  document.querySelectorAll(".thumb-cell").forEach((cell) => {
    const id = Number(cell.dataset.id);
    cell.classList.toggle("selected", selectedIds.has(id));
  });
  // Every selection change is a chance to answer "where was this?" up front —
  // this is the single funnel every selection path goes through.
  scheduleProposal();
  renderBatchBanner();
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
  const wanted = new Map();   // photo id → photo, for every pin that should exist
  pinnable.forEach((photo) => {
    if (isolatedSet && !isolatedSet.has(photo.id)) return;
    if (photo.lat != null && photo.lng != null) wanted.set(photo.id, photo);
  });
  // Diff against the pins already up, and hand the cluster group its changes in
  // bulk: one addLayers/removeLayers re-clusters once, where per-pin calls would
  // re-cluster per pin.
  const stale = [];
  Object.entries(markersById).forEach(([id, m]) => {
    if (!wanted.has(Number(id))) {
      stale.push(m);
      delete markersById[id];
    }
  });
  if (stale.length) photoCluster.removeLayers(stale);
  const fresh = [];
  wanted.forEach((photo) => {
    const created = addOrUpdateMarker(photo);
    if (created) fresh.push(created);
  });
  if (fresh.length) photoCluster.addLayers(fresh);
}

// Brings photo's pin up to date. An existing pin is touched only if its position
// or look changed (a move re-files it in the cluster tree, and a new icon
// rebuilds its DOM, so doing either for every pin on every render is the cost
// this avoids). A new pin is returned, *not* yet added: renderMarkers adds the
// whole batch to photoCluster at once.
function addOrUpdateMarker(photo) {
  const color = camColor(photo.camera);
  const isImprecise = !!(photo.gps_accuracy && photo.gps_accuracy > 30);
  const look = `${color}|${isImprecise}`;
  const existing = markersById[photo.id];
  if (existing) {
    const ll = existing.getLatLng();
    if (ll.lat !== photo.lat || ll.lng !== photo.lng) existing.setLatLng([photo.lat, photo.lng]);
    if (existing._gtLook !== look) {
      existing.setIcon(makePinIcon(color, isImprecise));
      existing._gtLook = look;
    }
    return null;
  }
  const marker = L.marker([photo.lat, photo.lng], {
    draggable: true,
    icon: makePinIcon(color, isImprecise),
  });
  marker._gtLook = look;

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
  return marker;
}

// Parses a /api/geotag[/remove] reply. The server answers 200 with a
// {results, written, failed, not_found} breakdown, or the same body under 502/404
// when nothing at all was written; anything else (400/422/500) has no `written`.
async function readBatchReply(res) {
  const out = await res.json().catch(() => null);
  if (!out || !Array.isArray(out.written)) {
    throw new Error(out && typeof out.detail === "string" ? out.detail : `HTTP ${res.status}`);
  }
  return out;
}

// "2 failed: <first reason>" for the status line, or "" when everything landed.
function batchProblems(out) {
  const bad = out.failed.length + out.not_found.length;
  if (!bad) return "";
  const first = out.failed.length ? out.failed[0].error : "photo not found";
  return `${bad} failed: ${first}`;
}

// Writes the location to `ids`. Returns {written, error} — commitPendingGeo clears
// from its staged set only the ids in `written`, so a photo that failed stays
// staged. `error` is the problem summary ("2 failed: <reason>"), the server's
// detail when the request itself failed (written is then []), or "".
// `render: false` updates `photos` only; the caller re-renders once after a
// batch of calls (commitPendingGeo commits one call per point).
async function geotag(ids, lat, lng, accuracy = null, { render = true } = {}) {
  setStatus(`Geotagging ${ids.length} photo(s)…`);
  try {
    const res = await fetch("/api/geotag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, lat, lng, gps_accuracy: accuracy }),
    });
    const out = await readBatchReply(res);
    const byId = new Map(photos.map((p) => [p.id, p]));
    out.results.forEach((u) => {
      const photo = byId.get(u.id);
      if (photo) {
        photo.lat = u.lat;
        photo.lng = u.lng;
        photo.geotag_source = u.geotag_source;
        photo.gps_accuracy = u.gps_accuracy;
      }
    });
    // applyFilters, not renderGrid — these photos just became geotagged, which
    // can move them out of the Show filter ("Not geotagged", "Mixed geotagged
    // days"). renderGrid alone re-draws the stale filteredPhotos, leaving them
    // on screen until the dropdown is touched. Its renderMarkers pass is what
    // pins the newly tagged photos (and moves re-tagged ones).
    if (render) applyFilters();
    const accLog = accuracy ? ` (accuracy: ±${accuracy}m)` : "";
    const problems = batchProblems(out);
    if (problems) {
      setStatus(`Tagged ${out.written.length} of ${ids.length}; ${problems}`, true);
    } else {
      setStatus(`Tagged ${out.written.length} photo(s) at ${lat.toFixed(5)}, ${lng.toFixed(5)}${accLog}`);
    }
    if (focusedPhotoId && ids.includes(focusedPhotoId)) showDetail(focusedPhotoId);
    return { written: out.written, error: problems };
  } catch (err) {
    setStatus("Geotag error: " + err.message, true);
    return { written: [], error: err.message };
  }
}

async function doRemoveGeotag() {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];
  setStatus(`Removing geotag from ${ids.length} photo(s)…`);
  try {
    const res = await fetch("/api/geotag/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const out = await readBatchReply(res);
    // Only photos the server actually cleared lose their pin; failed ones keep it.
    out.written.forEach((id) => {
      const photo = photos.find((p) => p.id === id);
      if (photo) { photo.lat = null; photo.lng = null; photo.geotag_source = "none"; }
      if (markersById[id]) { photoCluster.removeLayer(markersById[id]); delete markersById[id]; }
    });
    // Same reason as geotag(): losing a geotag can move a photo into or out of
    // the Show filter, so the filtered set has to be rebuilt, not just redrawn.
    applyFilters();
    const problems = batchProblems(out);
    if (problems) {
      setStatus(`Removed geotag from ${out.written.length} of ${ids.length}; ${problems}`, true);
    } else {
      setStatus(`Removed geotag from ${out.written.length} photo(s)`);
    }
    if (focusedPhotoId && ids.includes(focusedPhotoId)) showDetail(focusedPhotoId);
  } catch (err) {
    setStatus("Remove error: " + err.message, true);
  }
}

/* ── Ignore for geocoding (e.g. screenshots) ── */
// Returns {ok: true} or {ok: false, error}. Local state is only touched after the
// server accepted the write — on a 4xx/5xx the photos keep their old flag, and
// commitPendingGeo keeps them staged (it reports `error` in its summary).
async function setGeocodeIgnored(ids, ignored, { render = true } = {}) {
  if (!ids.length) return { ok: false, error: "no photos" };
  try {
    await postJson("/api/geotag/ignore", { ids, ignored });
  } catch (err) {
    setStatus("Ignore for geocoding failed: " + err.message, true);
    return { ok: false, error: err.message };
  }
  const byId = new Map(photos.map((p) => [p.id, p]));
  ids.forEach((id) => {
    const photo = byId.get(id);
    if (photo) photo.geocode_ignored = ignored;
  });
  if (render) applyFilters();
  if (focusedPhotoId && ids.includes(focusedPhotoId)) showDetail(focusedPhotoId);
  return { ok: true };
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
  refreshSelectionUI();    // same reason as stageDrop: the selection just shrank
  setStatus(`Staged ${staged} photo(s) as needing no location. Nothing saved yet — ` +
            `review at the bottom of the grid, then Commit.`);
}

/* ── Place search ── */
// Offline: matches saved places and locations already in the library's photo
// metadata (the same source as the search page's location picker). No online
// geocoder — see CLAUDE.md. A place with no photos/saved area won't be found.
async function doPlaceSearch() {
  const q = document.getElementById("place-search").value.trim();
  if (!q) return;
  try {
    const res = await fetch(`/api/search/locations?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { locations } = await res.json();
    // Best-ranked match that has coordinates (metadata-only rows may not).
    const hit = locations.find((l) => l.bounds);
    if (!hit) {
      setStatus(locations.length
        ? `"${locations[0].label}" has no GPS coordinates to jump to`
        : "No saved place or photo location matches — place search only knows " +
          "places in your library");
      return;
    }
    const [s, w, n, e] = hit.bounds;
    // A single photo gives a zero-size box; maxZoom keeps that from zooming to street level.
    map.flyToBounds([[s, w], [n, e]], { maxZoom: 14, padding: [40, 40] });
    setStatus(`Flew to: ${hit.label}`);
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

/* ── Detail pane ──
 * Latest-only (common.js): holding j/k fires one of these per photo, and only
 * the photo focused last may fill the pane. */
const showDetail = latestOnly(async (signal, id) => {
  focusedPhotoId = id;
  // A guess still in flight is for the photo we're leaving — drop it.
  doGuess.cancel();
  resetGuessButton();
  dismissGuess();
  try {
    const res = await fetch(`/api/photo/${id}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (signal.aborted) return;

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
      // Third element marks a value that is our own trusted markup, not data.
      ["Ignore for geocoding", `<label class="inline-toggle"><input type="checkbox" id="detail-ignore-chk" ${data.geocode_ignored ? "checked" : ""}/> not applicable (e.g. screenshot)</label>`, true],
    ];
    const table = document.getElementById("detail-meta");
    table.innerHTML = rows.map(([k, v, isHtml]) =>
      `<tr><td>${k}</td><td>${isHtml ? v : escapeHtml(v ?? "—")}</td></tr>`
    ).join("");
    document.getElementById("detail-ignore-chk").addEventListener("change", async (e) => {
      const chk = e.target;
      chk.disabled = true;
      const { ok } = await setGeocodeIgnored([id], chk.checked);
      // On failure the photo kept its old flag — put the box back to match.
      if (!ok) chk.checked = !chk.checked;
      chk.disabled = false;
    });

    // Show guess bar only for untagged photos that have a timestamp
    const guessBar = document.getElementById("guess-bar");
    guessBar.style.display = (data.lat == null && data.datetime) ? "" : "none";
    document.getElementById("guess-result").style.display = "none";
  } catch (err) {
    if (signal.aborted) return;   // superseded by a newer photo — not a failure
    setStatus("Couldn't load photo details: " + err.message, true);
  }
});

/* ── Guess location ── */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("guess-btn").addEventListener("click", doGuess);
  document.getElementById("guess-apply-btn").addEventListener("click", applyGuess);
  document.getElementById("guess-dismiss-btn").addEventListener("click", dismissGuess);
});

// Latest-only (common.js), and bound to the photo focused at the time: showDetail
// cancels it when focus moves, and the pending guess records its own photo id so
// Apply can never geotag whatever happens to be focused by then.
const doGuess = latestOnly(async (signal) => {
  const photoId = focusedPhotoId;
  if (!photoId) return;
  document.getElementById("guess-btn").disabled = true;
  document.getElementById("guess-btn").textContent = "Searching…";
  dismissGuess(false);   // clear old pin but keep button

  try {
    const window = document.getElementById("window-select").value;
    const res = await fetch(`/api/guess/${photoId}?window=${window}`, { signal });
    const data = await res.json();
    if (signal.aborted || focusedPhotoId !== photoId) return;
    if (!res.ok) {
      setStatus(data.detail || "No nearby geotagged photos found", true);
      return;
    }

    guessPending = { photoId, lat: data.lat, lng: data.lng };

    // Place source photo pins (before=blue, after=green, brightness by proximity)
    data.sources.forEach(src => {
      const icon = makeSourcePinIcon(src.delta_sec, src.is_before, data.window_sec);
      const mins = src.delta_sec < 60
        ? `${src.delta_sec}s`
        : `${Math.round(src.delta_sec / 60)}min`;
      const direction = src.is_before ? "before" : "after";
      const popupHtml = `
        <div class="source-popup">
          <img src="/api/thumbnail/${src.id}" alt="${escapeHtml(src.filename)}"/>
          <div class="source-popup-label">${escapeHtml(src.filename)}</div>
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
      if (guessPending) guessPending = { ...guessPending, lat: ll.lat, lng: ll.lng };
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
    if (signal.aborted) return;
    setStatus("Guess error: " + err.message, true);
  } finally {
    // A newer guess owns the button while it runs; showDetail resets it itself
    // when it cancels one.
    if (!signal.aborted) resetGuessButton();
  }
});

function resetGuessButton() {
  document.getElementById("guess-btn").disabled = false;
  document.getElementById("guess-btn").textContent = "Guess location";
}

async function applyGuess() {
  if (!guessPending) return;
  // The guess carries the photo it was made for — focus may have moved since.
  const { photoId, lat, lng } = guessPending;
  await geotag([photoId], lat, lng);
  if (focusedPhotoId !== photoId) return;   // the new focus's detail is already shown
  dismissGuess();
  showDetail(photoId);
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

/* ── Date range ──
 * The shared control (date-range-picker.js) replaces the old histogram modal:
 * a compact trigger in the toolbar, and a popover holding the presets rail,
 * typed bounds, monthly scrubber and day calendars.
 *
 * It is fed the *loaded scope's* own daily counts, not the library's, so the
 * bars describe this month or place — the same thing the old canvas did. And it
 * runs in live mode: this filters photos already in memory, so waiting for an
 * Apply click would feel broken. */

let dateRangePicker = null;

// Keep the date control discoverable even before dated photos are loaded.
function setTimelineAvailable(available) {
  dateRangePicker?.setEnabled(available, available
    ? "Filter the loaded photos down to a date range"
    : "Load dated photos to narrow the date range");
  if (!available) dateRangePicker?.setDates([]);
}

/* Photos are bucketed by UTC day, matching how the rest of this page reads
   photo_datetime (see the UTC const and the strftime(...,'unixepoch') queries
   behind it) — bucketing locally would slide photos into the wrong day. */
function dayCountsFromPhotos() {
  const byDay = new Map();
  for (const p of photos) {
    const ts = p.photo_datetime;
    if (!ts) continue;   // undated; negative (pre-1970) is a real date
    const key = wallClockDay(ts);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  return [...byDay].map(([date, count]) => ({ date, count }));
}

function bindTimeline() {
  dateRangePicker = createDateRangePicker({
    root: document.getElementById("date-range"),
    compact: true,
    live: true,
    // The scope is already in memory; never go to the network for it.
    loadDates: async () => dayCountsFromPhotos(),
    onChange({ from, to }) {
      // A bound day is inclusive, so the end bound runs to that day's last
      // second; an unset bound falls back to the scope's own edge.
      const lo = from ? parseWallClockDay(from) : dateRangeMin;
      const hi = to ? parseWallClockDay(to) + 86399 : dateRangeMax;
      // A scrubber drag commits on every pointermove, most of which land on the
      // same day as the last one — those change nothing.
      if (lo === dateFilterLo && hi === dateFilterHi) return;
      dateFilterLo = lo;
      dateFilterHi = hi;
      // …and the rest arrive faster than a grid + map rebuild can finish, so
      // they coalesce into one rebuild per frame. The bounds are stored above
      // synchronously, so the frame always renders the latest edge, including
      // the one the drag ended on.
      scheduleApplyFilters();
    },
  });
  setTimelineAvailable(false);
}

function buildHistogram() {
  const tsList = photos.map(p => p.photo_datetime).filter(Boolean);  // keeps pre-1970 (negative)
  if (tsList.length < 2) {
    resetDateFilter();
    return;
  }

  dateRangeMin = Math.min(...tsList);
  dateRangeMax = Math.max(...tsList);
  dateFilterLo = dateRangeMin;
  dateFilterHi = dateRangeMax;

  // setDates drops any previous range — it described the scope we just left.
  dateRangePicker?.setDates(dayCountsFromPhotos());
  setTimelineAvailable(true);
}

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
  // Staging empties (or shrinks) the selection, so the "N selected" readouts —
  // the workspace chip and the batch banner — have to follow it down.
  refreshSelectionUI();
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
    marker.bindTooltip(`Staged: ${p.count} photo(s) → ${escapeHtml(p.label)}`);
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

// Set while a commit's requests are in flight: a second Commit click (or Ctrl+S)
// would otherwise re-send the same still-staged entries alongside the first.
let commitInFlight = false;

async function commitPendingGeo(groups, what) {
  if (commitInFlight) { setStatus("A commit is already in progress…", true); return; }
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  if (!total) { setStatus("Nothing staged to commit.", true); return; }
  if (!confirm(`Commit ${total} staged change(s)${what ? ` — ${what}` : ""}? ` +
               `This writes them to the photos.`)) return;
  commitInFlight = true;
  try {
    await commitGroups(groups, total);
  } finally {
    commitInFlight = false;
  }
}

async function commitGroups(groups, total) {
  setStatus(`Committing ${total} change(s)…`);

  let saved = 0;
  const failures = [];
  for (const g of groups) {
    // The no-location group writes a flag, not a coordinate — one call for all
    // of it, and no Recent entry, since it isn't a place anyone will reuse.
    if (g.ignore) {
      const ids = g.entries.map(e => e.photo.id);
      const done = await setGeocodeIgnored(ids, true, { render: false });
      if (done.ok) {
        ids.forEach(id => pendingGeo.delete(id));
        saved += ids.length;
      } else {
        failures.push(`${g.label} (${ids.length} photo(s)) — ${done.error}`);
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
      const done = await geotag(p.ids, p.lat, p.lng, p.accuracy, { render: false });
      const landed = done ? done.written : [];
      // Only clear what actually landed — failed photos (or a failed point) stay staged.
      landed.forEach(id => pendingGeo.delete(id));
      saved += landed.length;
      if (landed.length) {
        // A committed point is a location the user demonstrably uses — it heads
        // the location picker's Recent list from here on.
        rememberLocation(p.lat, p.lng, p.accuracy, g.label);
      }
      if (landed.length < p.ids.length) {
        const why = done && done.error ? ` — ${done.error}` : "";
        failures.push(`${g.label} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})${why}`);
      }
    }
  }

  // One render for the whole commit (the calls above only update `photos`).
  // applyFilters rather than renderGrid: the committed photos changed bucket,
  // so the Show filter has to be re-run, and their pins drawn.
  applyFilters();
  if (failures.length) {
    setStatus(`Committed ${saved} of ${total} change(s). Still staged after failing: ` +
              failures.join(", ") + ".", true);
  } else {
    setStatus(`Committed ${saved} change(s).`);
  }
  // In batch mode a clean sweep means the batch is done — roll on.
  if (!failures.length) maybeAdvanceBatch();
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


/* ── Batch mode (the Home work queue, driven from here) ──
 * A batch is one outing or one scanned folder: the queue picks it, this loads its
 * scope, selects its still-untagged members and lets the propose bar fire. The
 * queue itself is computed server-side and never stored, so nothing here has to
 * be kept in sync — a batch that gets tagged simply stops being returned. */
let activeBatch = null;          // the /api/work-queue/batch record being worked
let batchScope = null;           // { url, label } so reloads re-run the batch, not a month
let batchAdvanceTimer = null;    // pending auto-advance after a batch is finished
// Batches passed over with "Next" this session. Separate from the skip list: the
// user said "not this one, now", not "not this one, ever" — so it lives in memory
// and is forgotten on reload. Without it, Next on an untouched batch would fetch
// the same queue head straight back and look broken.
let passedOverBatches = new Set();

function loadSkippedBatches() {
  try {
    const raw = JSON.parse(localStorage.getItem(SKIPPED_BATCHES_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(x => typeof x === "string") : [];
  } catch (e) {
    return [];
  }
}

function saveSkippedBatches(ids) {
  try {
    localStorage.setItem(SKIPPED_BATCHES_KEY, JSON.stringify(ids));
  } catch (e) {
    // A full/blocked localStorage costs the skip list, not the tagging pass.
  }
}

// photo_datetime is stored wall-clock-as-UTC and /api/photos parses date_from /
// date_to as UTC days, so the batch's span has to be formatted in UTC too — a
// local-time conversion would clip the first or last photos of the outing.
function utcDay(ts) {
  return wallClockDay(ts);
}

async function enterBatch(id) {
  setStatus("Loading batch…");
  let res;
  try {
    res = await fetch(`/api/work-queue/batch/${encodeURIComponent(id)}`);
  } catch (err) {
    setStatus("Batch load error: " + err.message, true);
    return;
  }
  if (res.status === 404) {
    // Tagged (or ignored) since the link was made — go straight to what's next.
    setStatus("That batch is already done — loading the next one…");
    await loadNextBatch();
    return;
  }
  if (!res.ok) { setStatus(`Batch load failed: HTTP ${res.status}`, true); return; }
  await openBatch(await res.json());
}

async function loadNextBatch() {
  cancelBatchAdvance();
  // Move past whatever is on screen. A finished batch is already gone from the
  // queue; an unfinished one has to be stepped over explicitly.
  if (activeBatch) passedOverBatches.add(activeBatch.id);
  setStatus("Finding the next batch…");

  const skip = [...new Set([...loadSkippedBatches(), ...passedOverBatches])].join(",");
  let res;
  try {
    res = await fetch(`/api/work-queue/next?skip=${encodeURIComponent(skip)}`);
  } catch (err) {
    setStatus("Work queue error: " + err.message, true);
    return;
  }
  if (res.status === 404) {
    // Everything left was passed over rather than skipped — wrap to the top
    // instead of pretending the queue is empty.
    if (passedOverBatches.size) {
      passedOverBatches = new Set();
      activeBatch = null;          // don't re-add it on the way round
      setStatus("Back to the top of the queue.");
      await loadNextBatch();
      return;
    }
    exitBatch();
    setStatus("No batches left — everything is either tagged or too small to batch.");
    return;
  }
  if (!res.ok) { setStatus(`Work queue failed: HTTP ${res.status}`, true); return; }
  await openBatch(await res.json());
}

async function openBatch(batch) {
  cancelBatchAdvance();
  activeBatch = batch;
  // Keep the URL honest so a reload (or the back button) lands on this batch and
  // not on whatever the page was showing before it.
  history.replaceState(null, "", `?batch=${encodeURIComponent(batch.id)}`);

  if (batch.kind === "folder") {
    await loadPhotosByDir(batch.dir, batch.title);
  } else {
    await loadPhotosByDateRange(utcDay(batch.start_ts), utcDay(batch.end_ts), batch.title);
  }

  // The batch is untagged photos by definition; anything else on screen is
  // context, so the one filter that must be on is "Not tagged".
  setFilterToggle("untagged", true);

  // Only what is actually on screen — a member tagged between the queue build and
  // now, or one a camera/Screenshots filter hides, would otherwise sit in the
  // selection invisibly (applyFilters keeps the same rule from here on).
  const visible = new Set(filteredPhotos.map(p => p.id));
  selectedIds = new Set(batch.photo_ids.filter(id => visible.has(id) && !pendingGeo.has(id)));
  lastClickedIndex = -1;
  proposeDismissedFor = "";      // a new batch is a new question
  refreshSelectionUI();          // → scheduleProposal(), which raises the propose bar

  if (batch.proposal) {
    map.setView([batch.proposal.lat, batch.proposal.lng], 14);
  } else {
    fitMapToPhotos();            // no guess: the tagged photos in the span are the clue
  }
  renderBatchBanner();
}

function skipBatch() {
  if (!activeBatch) return;
  const skipped = loadSkippedBatches();
  if (!skipped.includes(activeBatch.id)) skipped.push(activeBatch.id);
  saveSkippedBatches(skipped);
  loadNextBatch();
}

// Leaves the photos loaded — the user asked to stop being driven, not to lose
// the scope they were looking at.
function exitBatch() {
  cancelBatchAdvance();
  activeBatch = null;
  selectedIds.clear();
  refreshSelectionUI();
  renderBatchBanner();
  history.replaceState(null, "", window.location.pathname);
}

function setFilterToggle(key, on) {
  if (FILTER_TOGGLES[key] === on) return;
  FILTER_TOGGLES[key] = on;
  const btn = document.querySelector(`#filter-toggles .filter-toggle[data-filter="${key}"]`);
  if (btn) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
  }
  applyFilters();
}

function renderBatchBanner() {
  const banner = document.getElementById("batch-banner");
  if (!banner) return;
  banner.hidden = !activeBatch;
  if (!activeBatch) return;
  const b = activeBatch;
  // Three spans, not one string: the grid pane is narrow, and the position and
  // the live count are the parts that must never be the ones ellipsized away.
  document.getElementById("batch-banner-pos").textContent =
    `⚡ Batch ${b.position + 1} of ${b.total_batches}`;
  const title = document.getElementById("batch-banner-title");
  title.textContent = b.title + (b.start_ts ? "" : " · no dates");
  title.title = b.title;
  document.getElementById("batch-banner-count").textContent =
    `${selectedIds.size.toLocaleString()} selected`;
}

// How many of the batch's members still need a decision. Staged-but-uncommitted
// ones count as done — the user has made the call, Commit just writes it.
function batchRemaining() {
  if (!activeBatch) return 0;
  return activeBatch.photo_ids.filter((id) => {
    if (pendingGeo.has(id)) return false;
    const p = photos.find(x => x.id === id);
    return p ? (p.lat == null && !p.geocode_ignored) : false;
  }).length;
}

function cancelBatchAdvance() {
  if (batchAdvanceTimer) { clearTimeout(batchAdvanceTimer); batchAdvanceTimer = null; }
}

// Called after a commit: when nothing in the batch is left, roll on. The delay is
// there to be interrupted — any click cancels it, so "one more look" always wins.
function maybeAdvanceBatch() {
  if (!activeBatch || batchRemaining() > 0) return;
  setStatus("Batch done — loading the next one…");
  cancelBatchAdvance();
  batchAdvanceTimer = setTimeout(() => { batchAdvanceTimer = null; loadNextBatch(); }, 2000);
}

/* ── Keyboard shortcuts help ── */
function openShortcutsHelp() {
  document.getElementById("shortcuts-help-backdrop").style.display = "flex";
}
function closeShortcutsHelp() {
  document.getElementById("shortcuts-help-backdrop").style.display = "none";
}
function isShortcutsHelpOpen() {
  return document.getElementById("shortcuts-help-backdrop").style.display !== "none";
}

// Grid keyboard nav — j/k move, space select, shift extends, l tag-as (bound
// separately above), i ignore, g guess, Enter commits staged. Ported from
// People's shortcut set (see people.js's bindKeyboardShortcuts).
function bindGridKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Fields first (common.js): "?" typed into the place search is a character,
    // not a request for the help sheet (W7).
    if (isTypingTarget(e)) return;
    if (isShortcutsHelpOpen()) {
      if (e.key === "Escape" || e.key === "?") { e.preventDefault(); closeShortcutsHelp(); }
      return;
    }
    if (e.key === "?") { e.preventDefault(); openShortcutsHelp(); return; }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Space/Enter on a focused button is that button's click, not a grid key.
    if (e.target instanceof Element && e.target.tagName === "BUTTON") return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;
    if (anyModalOpen()) return;

    switch (e.key) {
      case "ArrowDown": case "j":
        e.preventDefault();
        e.shiftKey ? extendGridFocus(1) : moveGridFocus(1);
        break;
      case "ArrowUp": case "k":
        e.preventDefault();
        e.shiftKey ? extendGridFocus(-1) : moveGridFocus(-1);
        break;
      case " ":
        e.preventDefault();
        toggleGridFocusSelection();
        break;
      case "g":
        if (document.getElementById("guess-bar").style.display !== "none") {
          e.preventDefault();
          doGuess();
        }
        break;
      case "i":
        e.preventDefault();
        stageIgnore();
        break;
      case "Enter":
        if (pendingGeo.size) { e.preventDefault(); commitPendingGeo(groupPendingGeo()); }
        break;
    }
  });
}

function bindBatchMode() {
  document.getElementById("batch-next-btn").addEventListener("click", loadNextBatch);
  document.getElementById("batch-skip-btn").addEventListener("click", skipBatch);
  document.getElementById("batch-exit-btn").addEventListener("click", exitBatch);
  document.getElementById("next-batch-btn").addEventListener("click", loadNextBatch);
  // Any click is "I'm still looking at this" — it stops the auto-advance.
  document.addEventListener("click", cancelBatchAdvance, true);

  document.addEventListener("keydown", (e) => {
    // Same guards as the "l" shortcut: never steal a keystroke from a field or
    // from whatever is stacked on top of the grid.
    if (isTypingTarget(e)) return;
    if (!activeBatch) return;
    const key = e.key.toLowerCase();
    if (key !== "n" && key !== "s") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;
    if (anyModalOpen()) return;
    e.preventDefault();
    key === "n" ? loadNextBatch() : skipBatch();
  });
}

/* ── Status ── setStatus lives in status-bar.js. */
