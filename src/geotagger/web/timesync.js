/* ── State ── */
let photos = [];          // full list from API
let filteredPhotos = [];  // after camera hide + date range filter
let selectedIds = new Set();
let lastClickedIndex = -1;
let focusedPhotoId = null;
let timeline = null;
let timelineItems = new vis.DataSet();
let timelineGroups = new vis.DataSet();
let selectedYear = null;
let selectedMonth = null;
let shiftKeyPressed = false;

/* ── Time offset state ── */
let appliedOffsets = {};  // photo_id -> offset in seconds
let hasUnsavedChanges = false;

/* ── Date range filter state ── */
let dateRangeMin = 0;   // Unix ts — absolute min across all photos
let dateRangeMax = 0;   // Unix ts — absolute max across all photos
let dateFilterLo = 0;   // current low handle value
let dateFilterHi = 0;   // current high handle value
let histBuckets = [];   // [{ts, count}] for drawing

/* ── Camera colors ── */
const CAM_PALETTE = [
  "#e05c5c", "#e0a040", "#d4d43a", "#5cb85c", "#3ab8b8",
  "#4a90d9", "#9b5ce0", "#e05cbc", "#e07840", "#7ab85c",
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
  initTimeline();
  bindToolbar();
  bindTimeline();
  bindKeyboardEvents();
  await checkStatus();
  setStatus("Click 'Select Month' to begin");
});

/* ── Keyboard events ── */
function bindKeyboardEvents() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Shift") {
      shiftKeyPressed = true;
    }
  });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift") {
      shiftKeyPressed = false;
    }
  });
}

async function checkStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (data.scan_needed) {
      setStatus("No scan data found. Please run a scan first.", true);
    }
  } catch (err) {
    setStatus("Connection error: " + err.message, true);
  }
}

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}

/* ── Timeline initialization ── */
function initTimeline() {
  const container = document.getElementById("timeline-container");
  const options = {
    orientation: 'top',
    stack: false,
    zoomMin: 1000 * 60,  // 1 minute
    zoomMax: 1000 * 60 * 60 * 24 * 31,  // 31 days
    multiselect: true,
    selectable: true,
    snap: null,
    editable: {
      updateTime: false,
      updateGroup: false,
    },
    template: (item) => {
      if (!item.photoId) return '';

      const offset = appliedOffsets[item.photoId] || 0;
      const shiftedClass = offset !== 0 ? 'time-shifted' : '';

      return `<img src="/api/thumbnail/${item.photoId}"
                   class="${shiftedClass}"
                   title="${item.filename}"
                   style="border: 2px solid ${camColor(item.camera)}"/>`;
    },
  };

  timeline = new vis.Timeline(container, timelineItems, timelineGroups, options);

  // Handle selection
  timeline.on('select', (properties) => {
    let items = properties.items;

    // If shift-selecting, filter to only items from the same camera
    if (shiftKeyPressed && items.length > 1 && selectedIds.size > 0) {
      // Get the camera of the previously selected item(s)
      const prevSelectedId = [...selectedIds][0];
      const prevPhoto = photos.find(p => p.id === prevSelectedId);
      if (prevPhoto) {
        const targetCamera = prevPhoto.camera || "Unknown";

        // Filter new selection to only include photos from the same camera
        items = items.filter(id => {
          const photo = photos.find(p => p.id === id);
          return photo && (photo.camera || "Unknown") === targetCamera;
        });

        // Update the timeline selection to reflect the filtered set
        timeline.setSelection(items);
      }
    }

    selectedIds = new Set(items);

    // Update focused photo if single selection
    if (items.length === 1) {
      focusedPhotoId = items[0];
    }

    renderGrid();
    updateDetailPane();
  });

  // Handle double-click to focus
  timeline.on('doubleClick', (properties) => {
    if (properties.item) {
      focusedPhotoId = properties.item;
      renderGrid();
      updateDetailPane();
    }
  });
}

/* ── Toolbar ── */
function bindToolbar() {
  // Month picker
  document.getElementById("select-month-btn").addEventListener("click", showMonthPicker);
  document.querySelector(".modal-close").addEventListener("click", () => {
    document.getElementById("month-picker-modal").style.display = "none";
  });

  // Filter
  document.getElementById("filter-select").addEventListener("change", (e) => {
    applyFilters();
  });

  // Time offset controls
  document.getElementById("apply-offset-btn").addEventListener("click", applyTimeOffset);
  document.getElementById("reset-offset-btn").addEventListener("click", resetTimeOffsets);
  document.getElementById("save-times-btn").addEventListener("click", saveTimesToSidecars);
}

/* ── Month Picker ── */
async function showMonthPicker() {
  const modal = document.getElementById("month-picker-modal");
  const list = document.getElementById("month-picker-list");
  list.innerHTML = "<p style='color:#888'>Loading...</p>";
  modal.style.display = "flex";

  try {
    const res = await fetch("/api/stats/months");
    const data = await res.json();

    if (!data.months || data.months.length === 0) {
      list.innerHTML = "<p style='color:#888'>No photos found</p>";
      return;
    }

    // Group by year
    const byYear = {};
    data.months.forEach(m => {
      if (!byYear[m.year]) byYear[m.year] = [];
      byYear[m.year].push(m);
    });

    list.innerHTML = "";
    const years = Object.keys(byYear).sort((a, b) => b - a);

    years.forEach(year => {
      const section = document.createElement("div");
      section.className = "month-year-section";

      const header = document.createElement("div");
      header.className = "month-year-header";
      header.textContent = year;
      section.appendChild(header);

      byYear[year].forEach(m => {
        const monthName = new Date(m.year, m.month - 1, 1).toLocaleString('default', { month: 'long' });
        const item = document.createElement("div");
        item.className = "month-item";
        item.innerHTML = `
          <span class="month-name">${monthName}</span>
          <div class="month-counts">
            <span class="count-badge count-geotagged">${m.geotagged} tagged</span>
            <span class="count-badge count-not-geotagged">${m.not_geotagged} not tagged</span>
            <span class="count-badge count-total">${m.total} total</span>
          </div>
        `;
        item.addEventListener("click", () => {
          selectMonth(m.year, m.month);
          modal.style.display = "none";
        });
        section.appendChild(item);
      });

      list.appendChild(section);
    });
  } catch (err) {
    list.innerHTML = `<p style='color:#f88'>Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function selectMonth(year, month) {
  selectedYear = year;
  selectedMonth = month;

  const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' });
  document.getElementById("selected-month-label").textContent = `${monthName} ${year}`;

  await loadMonthHistogram(year, month);
  await loadPhotos(true);
}

async function loadMonthHistogram(year, month) {
  try {
    const res = await fetch(`/api/stats/dates?year=${year}&month=${month}`);
    const data = await res.json();

    if (!data.dates || data.dates.length === 0) {
      histBuckets = [];
      return;
    }

    histBuckets = data.dates.map(d => ({
      ts: new Date(d.date).getTime() / 1000,
      count: d.total
    }));

    if (histBuckets.length > 0) {
      dateRangeMin = histBuckets[0].ts;
      dateRangeMax = histBuckets[histBuckets.length - 1].ts + 86400;
      dateFilterLo = dateRangeMin;
      dateFilterHi = dateRangeMax;

      document.getElementById("range-lo").value = 0;
      document.getElementById("range-hi").value = 1000;
      updateHistLabels();
    }
  } catch (err) {
    console.error("Failed to load histogram:", err);
  }
}

/* ── Timeline histogram ── */
function bindTimeline() {
  const loRange = document.getElementById("range-lo");
  const hiRange = document.getElementById("range-hi");

  loRange.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    const hiVal = parseInt(hiRange.value);
    if (val > hiVal) {
      e.target.value = hiVal;
      return;
    }
    dateFilterLo = dateRangeMin + (val / 1000) * (dateRangeMax - dateRangeMin);
    updateHistLabels();
    drawHistogram();
    applyFilters();
  });

  hiRange.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    const loVal = parseInt(loRange.value);
    if (val < loVal) {
      e.target.value = loVal;
      return;
    }
    dateFilterHi = dateRangeMin + (val / 1000) * (dateRangeMax - dateRangeMin);
    updateHistLabels();
    drawHistogram();
    applyFilters();
  });
}

function updateHistLabels() {
  const formatDate = (ts) => {
    if (ts === 0) return "";
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  document.getElementById("hist-label-lo").textContent = formatDate(dateFilterLo);
  document.getElementById("hist-label-hi").textContent = formatDate(dateFilterHi);
}

function drawHistogram() {
  const canvas = document.getElementById("hist-canvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);

  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;

  ctx.clearRect(0, 0, w, h);

  if (histBuckets.length === 0) return;

  const maxCount = Math.max(...histBuckets.map(b => b.count), 1);
  const binWidth = w / histBuckets.length;

  histBuckets.forEach((bucket, i) => {
    const x = i * binWidth;
    const barH = (bucket.count / maxCount) * h;
    const inRange = bucket.ts >= dateFilterLo && bucket.ts <= dateFilterHi;
    ctx.fillStyle = inRange ? "#4a90d9" : "#333";
    ctx.fillRect(x, h - barH, binWidth - 1, barH);
  });
}

/* ── Load photos ── */
async function loadPhotos(fitTimeline = false) {
  if (!selectedYear || !selectedMonth) return;

  const filter = document.getElementById("filter-select").value;
  const dateFrom = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
  const dateTo = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${lastDay}`;

  try {
    let url = `/api/photos?geotagged=${filter}&date_from=${dateFrom}&date_to=${dateTo}`;
    const res = await fetch(url);
    photos = await res.json();

    // Pre-assign colors
    photos.forEach(p => camColor(p.camera));

    renderLegend();
    buildTimeline();
    applyFilters(fitTimeline);
  } catch (err) {
    setStatus("Load error: " + err.message, true);
  }
}

/* ── Build timeline ── */
function buildTimeline() {
  // Clear existing
  timelineItems.clear();
  timelineGroups.clear();

  // Get unique cameras
  const cameras = [...new Set(photos.map(p => p.camera || "Unknown"))];

  // Add groups for each camera
  cameras.forEach(cam => {
    timelineGroups.add({
      id: cam,
      content: cam,
      style: `background: ${camColor(cam)}22; color: #ddd;`
    });
  });

  // Add items for each photo
  photos.forEach(photo => {
    if (!photo.photo_datetime || photo.photo_datetime === 0) return;

    const offset = appliedOffsets[photo.id] || 0;
    const adjustedTime = new Date((photo.photo_datetime + offset) * 1000);

    timelineItems.add({
      id: photo.id,
      group: photo.camera || "Unknown",
      start: adjustedTime,
      type: 'point',
      // Store photo data in the item for template access
      photoId: photo.id,
      filename: photo.filename,
      camera: photo.camera,
    });
  });
}

/* ── Apply filters ── */
function applyFilters(fitTimeline = false) {
  filteredPhotos = photos.filter(p => {
    if (hiddenCameras.has(p.camera || "Unknown")) return false;
    if (dateRangeMin !== dateRangeMax) {
      const ts = p.photo_datetime || 0;
      if (ts > 0 && (ts < dateFilterLo || ts > dateFilterHi)) return false;
    }
    return true;
  });

  renderGrid();
  drawHistogram();
  setStatus(`Showing ${filteredPhotos.length} of ${photos.length} photos`);

  if (fitTimeline && filteredPhotos.length > 0) {
    const times = filteredPhotos
      .filter(p => p.photo_datetime && p.photo_datetime > 0)
      .map(p => {
        const offset = appliedOffsets[p.id] || 0;
        return (p.photo_datetime + offset) * 1000;
      });

    if (times.length > 0) {
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      timeline.setWindow(new Date(minTime), new Date(maxTime), { animation: true });
    }
  }
}

/* ── Camera legend ── */
function renderLegend() {
  const legend = document.getElementById("cam-legend");
  legend.innerHTML = "";

  const currentCameras = new Set(photos.map(p => p.camera || "Unknown"));

  Object.entries(camColorMap).forEach(([cam, color]) => {
    if (!currentCameras.has(cam)) return;

    const item = document.createElement("div");
    item.className = "cam-legend-item" + (hiddenCameras.has(cam) ? " dimmed" : "");
    item.title = `Click to hide/show ${cam}`;
    item.innerHTML = `<div class="cam-legend-dot" style="background:${escapeHtml(color)}"></div><span>${escapeHtml(cam)}</span>`;
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
    const cell = document.createElement("div");
    cell.className = "thumb-cell" +
      (selectedIds.has(photo.id) ? " selected" : "") +
      (photo.lat != null ? " tagged" : "");
    cell.dataset.id = photo.id;
    cell.dataset.idx = idx;

    const strip = document.createElement("div");
    strip.className = "cam-strip";
    strip.style.background = camColor(photo.camera);

    const img = document.createElement("img");
    img.src = `/api/thumbnail/${photo.id}`;
    img.alt = photo.filename;
    img.loading = "lazy";

    const name = document.createElement("div");
    name.className = "thumb-name";
    name.textContent = photo.filename;

    cell.appendChild(strip);
    cell.appendChild(img);
    cell.appendChild(name);

    // Click to select
    cell.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) {
        selectedIds.has(photo.id) ? selectedIds.delete(photo.id) : selectedIds.add(photo.id);
      } else if (e.shiftKey && lastClickedIndex >= 0) {
        const start = Math.min(lastClickedIndex, idx);
        const end = Math.max(lastClickedIndex, idx);

        // Get the camera of the last clicked photo
        const lastPhoto = filteredPhotos[lastClickedIndex];
        const targetCamera = lastPhoto.camera || "Unknown";

        // Only select photos from the same camera
        for (let i = start; i <= end; i++) {
          const rangePhoto = filteredPhotos[i];
          if ((rangePhoto.camera || "Unknown") === targetCamera) {
            selectedIds.add(rangePhoto.id);
          }
        }
      } else {
        selectedIds.clear();
        selectedIds.add(photo.id);
        focusedPhotoId = photo.id;

        // Focus timeline on the selected photo
        timeline.focus(photo.id, { animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      }
      lastClickedIndex = idx;
      renderGrid();
      updateDetailPane();

      // Sync timeline selection
      timeline.setSelection([...selectedIds]);
    });

    grid.appendChild(cell);
  });
}

/* ── Detail pane ── */
function updateDetailPane() {
  const placeholder = document.getElementById("detail-placeholder");
  const content = document.getElementById("detail-content");

  if (!focusedPhotoId) {
    placeholder.style.display = "block";
    content.style.display = "none";
    return;
  }

  const photo = photos.find(p => p.id === focusedPhotoId);
  if (!photo) return;

  placeholder.style.display = "none";
  content.style.display = "flex";

  document.getElementById("detail-img").src = `/api/thumbnail/${photo.id}`;
  wireFullSizeButton(document.getElementById("view-fullsize-btn"), photo.filename, photo.id);

  const table = document.getElementById("detail-meta");
  const offset = appliedOffsets[photo.id] || 0;
  const originalTime = photo.photo_datetime ? new Date(photo.photo_datetime * 1000).toLocaleString() : "Unknown";
  const adjustedTime = offset !== 0 && photo.photo_datetime
    ? new Date((photo.photo_datetime + offset) * 1000).toLocaleString()
    : originalTime;

  table.innerHTML = `
    <tr><td>Filename</td><td>${escapeHtml(photo.filename)}</td></tr>
    <tr><td>Camera</td><td>${escapeHtml(photo.camera || "Unknown")}</td></tr>
    <tr><td>Original time</td><td>${originalTime}</td></tr>
    ${offset !== 0 ? `<tr><td>Adjusted time</td><td>${adjustedTime} (${offset > 0 ? '+' : ''}${offset}s)</td></tr>` : ''}
    <tr><td>Location</td><td>${photo.lat != null ? `${photo.lat.toFixed(6)}, ${photo.lng.toFixed(6)}` : "Not geotagged"}</td></tr>
  `;
}

/* ── Time offset operations ── */
function applyTimeOffset() {
  if (selectedIds.size === 0) {
    alert("No photos selected");
    return;
  }

  const minutes = parseInt(document.getElementById("offset-minutes").value) || 0;
  const seconds = parseInt(document.getElementById("offset-seconds").value) || 0;
  const totalOffset = (minutes * 60) + seconds;

  if (totalOffset === 0) {
    alert("Please enter a non-zero offset");
    return;
  }

  // Apply offset to selected photos (relative to original time, not cumulative)
  selectedIds.forEach(id => {
    appliedOffsets[id] = totalOffset;
  });

  hasUnsavedChanges = true;
  buildTimeline();
  applyFilters();
  updateDetailPane();

  setStatus(`Applied ${totalOffset > 0 ? '+' : ''}${totalOffset}s offset to ${selectedIds.size} photos (relative to original time)`);
}

function resetTimeOffsets() {
  if (selectedIds.size === 0) {
    // Reset all
    if (Object.keys(appliedOffsets).length === 0) {
      alert("No offsets to reset");
      return;
    }
    if (!confirm("Reset all time offsets?")) return;
    appliedOffsets = {};
    hasUnsavedChanges = false;
  } else {
    // Reset selected
    selectedIds.forEach(id => {
      delete appliedOffsets[id];
    });
    hasUnsavedChanges = Object.keys(appliedOffsets).length > 0;
  }

  buildTimeline();
  applyFilters();
  updateDetailPane();
  setStatus("Time offsets reset");
}

async function saveTimesToSidecars() {
  const photoIds = Object.keys(appliedOffsets).map(id => parseInt(id));

  if (photoIds.length === 0) {
    alert("No time offsets to save");
    return;
  }

  if (!confirm(`Save time adjustments for ${photoIds.length} photos to sidecar files?`)) {
    return;
  }

  try {
    setStatus("Saving time adjustments...");

    const res = await fetch("/api/photos/update-times", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: appliedOffsets })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const result = await res.json();
    setStatus(`Saved time adjustments for ${result.updated} photos`);
    hasUnsavedChanges = false;

    // Reload photos to get updated times
    await loadPhotos();
    appliedOffsets = {};
  } catch (err) {
    setStatus("Save error: " + err.message, true);
  }
}

/* ── Warn on navigation if unsaved changes ── */
window.addEventListener("beforeunload", (e) => {
  if (hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = "";
  }
});
