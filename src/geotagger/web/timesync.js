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
let baseTimes = {};       // photo_id -> photo_datetime when the offset was applied (the save's "expected")
let hasUnsavedChanges = false;

/* ── Date range filter state ── */
let dateRangeMin = 0;   // Unix ts — absolute min across all photos
let dateRangeMax = 0;   // Unix ts — absolute max across all photos
let dateFilterLo = 0;   // current low handle value
let dateFilterHi = 0;   // current high handle value
let histBuckets = [];   // [{ts, count}] for drawing

/* ── Camera colors ── camColor / renderLegend / hiddenCameras live in camera-colors.js. */

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  initTimeline();
  bindToolbar();
  bindTimeline();
  bindKeyboardEvents();
  await checkStatus();
  setStatus("Click 'Select Month' to begin");
  await restoreStagedOffsets();   // offsets applied before a reload / crash (U7)
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
    const data = await fetchJson("/api/status");
    if (data.scan_needed) {
      setStatus("No scan data found. Please run a scan first.", true);
    }
  } catch (err) {
    setStatus("Connection error: " + err.message, true);
  }
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
    // photo_datetime is the camera's wall clock stored as a UTC epoch, so the
    // axis must render in UTC — the browser's zone would shift every label
    // (and the day boundaries) by the local offset.
    moment: (date) => vis.moment(date).utc(),
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
                   title="${escapeHtml(item.filename)}"
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
    const data = await fetchJson("/api/stats/months");

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
        const monthName = formatWallClockDate(wallClockTs(m.year, m.month), { month: 'long' });
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

  const monthName = formatWallClockDate(wallClockTs(year, month), { month: 'long' });
  document.getElementById("selected-month-label").textContent = `${monthName} ${year}`;

  await loadMonthHistogram(year, month);
  await loadPhotos(true);
}

// Latest-only (common.js), like loadPhotos below: pick month A then month B and
// only B's histogram and photos may land.
const loadMonthHistogram = latestOnly(async (signal, year, month) => {
  try {
    const data = await fetchJson(`/api/stats/dates?year=${year}&month=${month}`, { signal });
    if (signal.aborted) return;

    if (!data.dates || data.dates.length === 0) {
      clearMonthHistogram();
      return;
    }

    // d.date is a "YYYY-MM-DD" wall-clock day (SQLite DATE(...,'unixepoch'));
    // the endpoint reports it as `count`.
    histBuckets = data.dates.map(d => ({
      ts: parseWallClockDay(d.date),
      count: d.count
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
    if (signal.aborted) return;
    // Drop the previous month's range too: left in place, applyFilters would
    // filter this month's photos against last month's dates and hide them all.
    clearMonthHistogram();
    setStatus("Could not load the day histogram: " + err.message, true);
  }
});

// No histogram for the month: no buckets and no date range (applyFilters skips
// range filtering when dateRangeMin === dateRangeMax).
function clearMonthHistogram() {
  histBuckets = [];
  dateRangeMin = dateRangeMax = dateFilterLo = dateFilterHi = 0;
  updateHistLabels();
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
    return formatWallClockDate(ts, { month: 'short', day: 'numeric' });
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
const loadPhotos = latestOnly(async (signal, fitTimeline = false) => {
  if (!selectedYear || !selectedMonth) return;

  const filter = document.getElementById("filter-select").value;
  const dateFrom = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
  const lastDay = daysInMonth(selectedYear, selectedMonth);
  const dateTo = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${lastDay}`;

  try {
    let url = `/api/photos?geotagged=${filter}&date_from=${dateFrom}&date_to=${dateTo}`;
    const data = await fetchJson(url, { signal });
    if (signal.aborted) return;
    photos = data;

    // Pre-assign colors
    photos.forEach(p => camColor(p.camera));

    renderLegend();
    buildTimeline();
    applyFilters(fitTimeline);
  } catch (err) {
    if (signal.aborted) return;
    setStatus("Load error: " + err.message, true);
  }
});

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
      // Undated (0/null) stays visible; negative = pre-1970, still range-filtered.
      const ts = p.photo_datetime || 0;
      if (ts && (ts < dateFilterLo || ts > dateFilterHi)) return false;
    }
    return true;
  });

  renderGrid();
  drawHistogram();
  setStatus(`Showing ${filteredPhotos.length} of ${photos.length} photos`);

  if (fitTimeline && filteredPhotos.length > 0) {
    const times = filteredPhotos
      .filter(p => p.photo_datetime)   // truthy: keeps pre-1970 (negative)
      .map(p => {
        const offset = appliedOffsets[p.id] || 0;
        return (p.photo_datetime + offset) * 1000;
      });

    if (times.length > 0) {
      const [minTime, maxTime] = minMaxOf(times);
      timeline.setWindow(new Date(minTime), new Date(maxTime), { animation: true });
    }
  }
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
  // Wall clock stored as a UTC epoch: format in UTC, not the browser's zone.
  const originalTime = photo.photo_datetime ? formatWallClock(photo.photo_datetime) : "Unknown";
  const adjustedTime = offset !== 0 && photo.photo_datetime
    ? formatWallClock(photo.photo_datetime + offset)
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

  // Apply offset to selected photos (relative to original time, not cumulative).
  // Undated photos have nothing to shift (0 means "no date"), so they're skipped.
  // The base time is remembered so the save can send absolute times.
  let applied = 0;
  selectedIds.forEach(id => {
    const p = photos.find(x => x.id === id);
    if (!p || !p.photo_datetime) return;   // truthy: keeps pre-1970 (negative)
    appliedOffsets[id] = totalOffset;
    baseTimes[id] = p.photo_datetime;
    applied++;
  });
  const skipped = selectedIds.size - applied;

  hasUnsavedChanges = Object.keys(appliedOffsets).length > 0;
  persistOffsets();
  buildTimeline();
  applyFilters();
  updateDetailPane();

  setStatus(`Applied ${totalOffset > 0 ? '+' : ''}${totalOffset}s offset to ${applied} photos (relative to original time)` +
    (skipped ? `; ${skipped} undated photo(s) skipped` : ""));
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
    baseTimes = {};
    hasUnsavedChanges = false;
  } else {
    // Reset selected
    selectedIds.forEach(id => {
      delete appliedOffsets[id];
      delete baseTimes[id];
    });
    hasUnsavedChanges = Object.keys(appliedOffsets).length > 0;
  }
  persistOffsets();

  buildTimeline();
  applyFilters();
  updateDetailPane();
  setStatus("Time offsets reset");
}

// "2 failed: <first reason>" for the status line, or "" when everything landed
// (same wording as the Geocode page's batchProblems in app.js).
function batchProblems(out) {
  const bad = out.failed.length + out.not_found.length;
  if (!bad) return "";
  const first = out.failed.length ? out.failed[0].error : "photo not found";
  return `${bad} failed: ${first}`;
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

  // Absolute targets, not offsets: the request says "this photo is at X and
  // should be at Y", so re-sending it after a partial failure (or a lost reply)
  // can't shift a photo that already landed a second time.
  const updates = photoIds.map(id => ({
    id,
    expected: baseTimes[id],
    target: baseTimes[id] + appliedOffsets[id],
  }));

  try {
    setStatus("Saving time adjustments...");

    const res = await fetch("/api/photos/update-times", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates })
    });

    // 200 carries a {results, written, failed, not_found} breakdown; 502/404/409
    // carry the same body when nothing was written, so !res.ok alone isn't a
    // request-level failure here. Anything else (400/422/500) has no `written`.
    // Parse a clone so httpErrorMessage can still read the original body.
    const out = await res.clone().json().catch(() => null);
    if (!out || !Array.isArray(out.written)) throw new Error(await httpErrorMessage(res));

    // Order matters (audit W8): an offset is a delta on the photo's *loaded*
    // time, so it must be gone before (or together with) that photo's new time
    // arriving — otherwise the reload's already-shifted time gets the offset
    // added again and the photo shows double-shifted.
    // Clear only what landed; failed photos keep their offset so Save can be
    // pressed again (safe: the request is idempotent). A conflict can't be
    // retried as-is (the photo's date moved), nor can a photo that no longer
    // exists, so those offsets are dropped too.
    const settled = [...out.written, ...out.not_found,
                     ...out.failed.filter(f => f.conflict).map(f => f.id)];
    settled.forEach(id => { delete appliedOffsets[id]; delete baseTimes[id]; });
    const retryable = out.failed.filter(f => !f.conflict).map(f => f.id);
    hasUnsavedChanges = Object.keys(appliedOffsets).length > 0;
    persistOffsets();   // only what settled leaves the backup

    // Patch the saved times in locally first, so the view is right even if the
    // reload below fails (it would otherwise show the old time, offset gone).
    const savedTimes = new Map((out.results || []).map(r => [r.id, r.photo_datetime]));
    photos.forEach(p => { if (savedTimes.has(p.id)) p.photo_datetime = savedTimes.get(p.id); });
    buildTimeline();
    applyFilters();
    updateDetailPane();

    // Reload photos to pick up the server's view (sidecar-backed times).
    await loadPhotos();

    const problems = batchProblems(out);
    if (problems) {
      selectedIds = new Set(retryable);   // leave the retryable ones selected
      buildTimeline();
      applyFilters();
      updateDetailPane();
      const hint = retryable.length ? " — press Save again to retry" : "";
      setStatus(`Updated ${out.written.length} of ${updates.length}; ${problems}${hint}`, true);
    } else {
      setStatus(`Saved time adjustments for ${out.written.length} photos`);
    }
  } catch (err) {
    // Request-level failure: the server may or may not have applied part of it.
    // Offsets stay, so Save can be pressed again — it only applies what's left.
    setStatus("Save error: " + err.message, true);
  }
}

/* ── Staged offsets survive a reload or crash (U7) ──
 * appliedOffsets/baseTimes are mirrored to this tab's sessionStorage (common.js
 * stagedWorkStore — see there for why sessionStorage) after every apply, reset
 * and save: {id, offset, base} per photo, nothing else. On load they're
 * re-checked against the server before being offered back: a photo deleted
 * since, or already at base+offset, is dropped; one whose time moved since
 * (base no longer matches) is dropped too, because Save would reject it as a
 * conflict anyway. Restored offsets apply to their photos whichever month is
 * open — like any applied offset — and nothing is written until Save. */
const offsetStore = stagedWorkStore("timesync", 1);
let offsetSaveWarned = false;
let offsetCarry = [];       // records kept unvalidated after a failed restore check
let offsetBanner = null;

function persistOffsets() {
  const records = Object.keys(appliedOffsets).map(k => ({
    id: Number(k), offset: appliedOffsets[k], base: baseTimes[k],
  }));
  offsetCarry.forEach(r => { if (!(r.id in appliedOffsets)) records.push(r); });
  if (!offsetStore.save(records) && !offsetSaveWarned) {
    offsetSaveWarned = true;
    setStatus(STAGED_SAVE_FAILED_MSG, true);
  }
  offsetBanner?.refresh();
}

async function restoreStagedOffsets() {
  const records = offsetStore.load().filter(r =>
    Number.isFinite(r.offset) && r.offset !== 0 && Number.isFinite(r.base));
  if (!records.length) return;
  let current;
  try {
    current = new Map((await fetchPhotosByIds(records.map(r => r.id))).map(p => [p.id, p]));
  } catch (err) {
    offsetCarry = records;   // keep them in the backup for the next load
    setStatus(`Couldn't check the ${records.length} time offset(s) kept from your last visit ` +
              `(${err.message}). They're kept for the next reload.`, true);
    return;
  }

  let gone = 0, applied = 0, moved = 0;
  const restored = [];
  records.forEach(r => {
    if (r.id in appliedOffsets) return;   // applied again during the check: newer wins
    const photo = current.get(r.id);
    if (!photo) { gone++; return; }
    if (photo.photo_datetime === r.base + r.offset) { applied++; return; }
    if (photo.photo_datetime !== r.base) { moved++; return; }
    appliedOffsets[r.id] = r.offset;
    baseTimes[r.id] = r.base;
    restored.push(r.id);
  });
  hasUnsavedChanges = Object.keys(appliedOffsets).length > 0;
  persistOffsets();   // the backup now matches what was restored

  const dropped = [];
  if (gone) dropped.push(`${gone} photo(s) no longer exist`);
  if (applied) dropped.push(`${applied} already saved`);
  if (moved) dropped.push(`${moved} whose time was changed elsewhere since`);
  const droppedNote = dropped.length ? `Dropped: ${dropped.join(", ")}.` : "";
  if (!restored.length) {
    setStatus(`Nothing left to restore from your last visit. ${droppedNote}`);
    return;
  }
  buildTimeline();
  applyFilters();
  updateDetailPane();

  const restoredIds = new Set(restored);
  const stillRestored = () => [...restoredIds].filter(id => id in appliedOffsets);
  offsetBanner = showStagedRestoreBanner({
    remaining: () => stillRestored().length,
    noun: "time offset",
    detail: [`Offsets show on their photos once that month is open.`, droppedNote].join(" ").trim(),
    onReview: async () => {
      // Open the month of the earliest restored photo.
      const ids = stillRestored();
      if (!ids.length) return;
      const first = ids.reduce((a, b) => (baseTimes[a] <= baseTimes[b] ? a : b));
      const parts = wallClockParts(baseTimes[first]);
      if (parts) await selectMonth(parts.year, parts.month + 1);
    },
    onCommit: async () => {
      // Save writes every applied offset (it has its own confirm).
      await saveTimesToSidecars();
      return stillRestored().length === 0;
    },
    onDiscard: () => {
      const ids = stillRestored();
      if (ids.length > 3 && !confirm(`Discard ${ids.length} restored time offset(s)?`)) return false;
      ids.forEach(id => { delete appliedOffsets[id]; delete baseTimes[id]; });
      hasUnsavedChanges = Object.keys(appliedOffsets).length > 0;
      persistOffsets();
      buildTimeline();
      applyFilters();
      updateDetailPane();
      setStatus(`Discarded ${ids.length} restored time offset(s).`);
    },
  });
  setStatus(`Restored ${restored.length} unsaved time offset(s) from your last visit. ` +
            `Nothing is written until you Save.`);
}

/* ── Warn on navigation if unsaved changes ──
 * The sessionStorage backup above is gone once the tab is closed for good. */
window.addEventListener("beforeunload", (e) => {
  if (hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = "";
  }
});
