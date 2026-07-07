/* Flexible photo search: date range, location text, geotag status, and
 * one-or-more people (either "together in the same photo" or "any of them").
 * Results are grouped by year/month (like the other grids), the left column
 * is a selectable photo grid, and the right column previews the focused
 * photo with its metadata. One or more selected photos can be downloaded as
 * a ZIP of their original (full-quality / RAW) files. */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

let allPersons = [];      // {id, name} — loaded once for the picker
let selectedPersons = []; // {id, name}, in pick order
let resultPhotos = [];    // last search results (unfiltered by the timeline)
let filteredPhotos = [];  // resultPhotos narrowed by the timeline's date range
let selectedIds = new Set();
let lastClickedIndex = -1;
let focusedPhotoId = null;

/* ── Timeline histogram state (mirrors the geocode page) ── */
let dateRangeMin = 0;
let dateRangeMax = 0;
let dateFilterLo = 0;
let dateFilterHi = 0;
let histBuckets = [];
let histBucketSecs = 86400;

function setStatus(msg, isError) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg || "";
  bar.classList.toggle("error", !!isError);
}

/* ── People picker ── */

async function loadPersons() {
  try {
    const res = await fetch("/api/persons");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allPersons = await res.json();
  } catch (e) {
    setStatus(`Could not load people: ${e.message}`, true);
  }
}

function renderPersonChips() {
  const wrap = document.getElementById("person-chips");
  wrap.innerHTML = selectedPersons.map((p) => `
    <span class="person-chip" data-id="${p.id}">
      ${escapeHtml(p.name)}
      <button type="button" aria-label="Remove">✕</button>
    </span>
  `).join("");
  wrap.querySelectorAll(".person-chip button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.parentElement.dataset.id);
      selectedPersons = selectedPersons.filter((p) => p.id !== id);
      renderPersonChips();
      updatePersonModeVisibility();
    });
  });
}

function updatePersonModeVisibility() {
  document.getElementById("person-mode-field").style.display =
    selectedPersons.length >= 2 ? "" : "none";
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function wirePersonPicker() {
  const input = document.getElementById("person-picker-input");
  const suggestBox = document.getElementById("person-suggest");

  function showSuggestions() {
    const q = input.value.trim().toLowerCase();
    const chosen = new Set(selectedPersons.map((p) => p.id));
    const matches = allPersons
      .filter((p) => !chosen.has(p.id) && (!q || p.name.toLowerCase().includes(q)))
      .slice(0, 20);
    if (matches.length === 0) {
      suggestBox.innerHTML = `<div class="person-suggest-empty">No matching people</div>`;
    } else {
      suggestBox.innerHTML = matches.map((p) =>
        `<div class="person-suggest-item" data-id="${p.id}">${escapeHtml(p.name)}</div>`
      ).join("");
      suggestBox.querySelectorAll(".person-suggest-item").forEach((item) => {
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const id = Number(item.dataset.id);
          const person = allPersons.find((p) => p.id === id);
          if (person) {
            selectedPersons.push(person);
            renderPersonChips();
            updatePersonModeVisibility();
          }
          input.value = "";
          suggestBox.style.display = "none";
        });
      });
    }
    suggestBox.style.display = "";
  }

  input.addEventListener("focus", showSuggestions);
  input.addEventListener("input", showSuggestions);
  input.addEventListener("blur", () => {
    setTimeout(() => { suggestBox.style.display = "none"; }, 150);
  });
}

/* ── Search ── */

function buildQuery() {
  const params = new URLSearchParams();
  const dateFrom = document.getElementById("date-from").value;
  const dateTo = document.getElementById("date-to").value;
  const location = document.getElementById("location-input").value.trim();
  const geotagged = document.getElementById("geotagged-select").value;
  const personMode = document.getElementById("person-mode-select").value;

  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  if (location) params.set("location", location);
  if (geotagged !== "all") params.set("geotagged", geotagged);
  if (selectedPersons.length > 0) {
    params.set("person_ids", selectedPersons.map((p) => p.id).join(","));
    params.set("person_mode", personMode);
  }
  return params;
}

async function runSearch() {
  const grid = document.getElementById("grid");
  const summary = document.getElementById("search-summary");
  setStatus("Searching…");
  summary.textContent = "";
  grid.innerHTML = "";
  selectedIds.clear();
  lastClickedIndex = -1;
  refreshSelectionUI();
  showPlaceholder();
  try {
    const params = buildQuery();
    const res = await fetch(`/api/search?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    resultPhotos = data.photos;
    buildHistogram();
    renderGrid();
    summary.textContent = `${data.total.toLocaleString()} photo${data.total === 1 ? "" : "s"} found`;
    setStatus("");
  } catch (e) {
    setStatus(`Search failed: ${e.message}`, true);
  }
}

/* ── Grid: grouped by year/month ── */

function makeThumbCell(photo, idx) {
  const cell = document.createElement("div");
  cell.className = "thumb-cell" +
    (selectedIds.has(photo.id) ? " selected" : "") +
    (photo.lat != null ? " tagged" : "") +
    (photo.geocode_ignored ? " geo-ignored" : "");
  cell.dataset.id = photo.id;
  cell.dataset.idx = idx;

  const img = document.createElement("img");
  img.src = `/api/thumbnail/${photo.id}`;
  img.loading = "lazy";
  img.alt = photo.filename;

  const name = document.createElement("div");
  name.className = "thumb-name";
  name.textContent = photo.filename;

  cell.appendChild(img);
  cell.appendChild(name);

  cell.addEventListener("click", (e) => handleThumbClick(e, photo.id, idx));
  return cell;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  const photos = filteredPhotos;
  if (photos.length === 0) {
    grid.innerHTML = `<div class="person-suggest-empty" style="grid-column:1/-1;padding:24px;text-align:center">No photos match these filters.</div>`;
    return;
  }

  // Group into calendar year/month buckets (photos already come back sorted
  // by photo_datetime from the API), undated photos fall into one "Undated" group.
  const groups = [];
  let cur = null;
  photos.forEach((photo, idx) => {
    let year = null, month = null;
    if (photo.photo_datetime) {
      const d = new Date(photo.photo_datetime * 1000);
      year = d.getFullYear();
      month = d.getMonth();
    }
    if (!cur || cur.year !== year || cur.month !== month) {
      cur = { year, month, photos: [] };
      groups.push(cur);
    }
    cur.photos.push({ photo, idx });
  });

  groups.forEach((group, groupIdx) => {
    const sec = document.createElement("div");
    sec.className = `face-group-section group-tint-${groupIdx % 6}`;

    const title = group.year != null
      ? `${MONTH_NAMES[group.month]} ${group.year}`
      : "Undated";
    const count = group.photos.length;

    sec.appendChild(faceGroupHeader({
      title,
      meta: `· ${count} photo${count !== 1 ? "s" : ""}`,
    }));

    const cells = document.createElement("div");
    cells.className = "face-group-cells";
    group.photos.forEach(({ photo, idx }) => cells.appendChild(makeThumbCell(photo, idx)));
    sec.appendChild(cells);
    grid.appendChild(sec);
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
}

function refreshSelectionUI() {
  document.querySelectorAll(".thumb-cell").forEach((cell) => {
    const id = Number(cell.dataset.id);
    cell.classList.toggle("selected", selectedIds.has(id));
  });
  const group = document.getElementById("selection-group");
  const count = document.getElementById("selection-count");
  if (selectedIds.size > 0) {
    group.style.display = "";
    count.textContent = `${selectedIds.size} selected`;
  } else {
    group.style.display = "none";
  }
}

function clearSelection() {
  selectedIds.clear();
  refreshSelectionUI();
}

/* ── Detail pane ── */

function showPlaceholder() {
  focusedPhotoId = null;
  document.getElementById("detail-placeholder").style.display = "";
  document.getElementById("detail-content").style.display = "none";
}

async function showDetail(id) {
  focusedPhotoId = id;
  try {
    const res = await fetch(`/api/photo/${id}`);
    const data = await res.json();

    document.getElementById("detail-placeholder").style.display = "none";
    document.getElementById("detail-content").style.display = "";
    document.getElementById("detail-img").src = `/api/preview/${id}`;

    const isRaw = typeof isRawName === "function" && isRawName(data.filename);
    document.getElementById("detail-actions").style.display = isRaw ? "" : "none";
    document.getElementById("view-fullsize-btn").onclick = () => openFullSize(id);

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
    ];
    const table = document.getElementById("detail-meta");
    table.innerHTML = rows.map(([k, v]) =>
      `<tr><td>${k}</td><td>${escapeHtml(String(v ?? "—"))}</td></tr>`
    ).join("");
  } catch (err) {
    // ignore
  }
}

/* ── Download selected as ZIP ── */

async function downloadSelected() {
  if (selectedIds.size === 0) return;
  const btn = document.getElementById("download-selected-btn");
  const ids = [...selectedIds];
  btn.disabled = true;
  btn.textContent = "⬇ Preparing…";
  try {
    const res = await fetch("/api/photos/download-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: ids }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `photos-${ids.length}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded ${ids.length} photo(s).`);
  } catch (e) {
    setStatus(`Download failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download ZIP";
  }
}

function clearForm() {
  document.getElementById("date-from").value = "";
  document.getElementById("date-to").value = "";
  document.getElementById("location-input").value = "";
  document.getElementById("geotagged-select").value = "all";
  document.getElementById("person-mode-select").value = "all";
  selectedPersons = [];
  renderPersonChips();
  updatePersonModeVisibility();
  resultPhotos = [];
  filteredPhotos = [];
  histBuckets = [];
  document.getElementById("timeline").style.display = "none";
  selectedIds.clear();
  refreshSelectionUI();
  showPlaceholder();
  document.getElementById("grid").innerHTML = "";
  document.getElementById("search-summary").textContent = "";
  setStatus("");
}

/* ── Timeline histogram (simplified port of the geocode page's version:
 * single-color bars — the search results aren't camera-grouped — with a
 * draggable range that narrows which of the found photos are shown below). ── */

function bindTimeline() {
  const lo = document.getElementById("range-lo");
  const hi = document.getElementById("range-hi");

  function onInput() {
    if (Number(lo.value) > Number(hi.value)) {
      if (this === lo) lo.value = hi.value;
      else hi.value = lo.value;
    }
    updateDateFilter();
    applyTimelineFilter();
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
  const tsList = resultPhotos.map((p) => p.photo_datetime).filter((ts) => ts && ts > 0);
  filteredPhotos = resultPhotos;
  if (tsList.length < 2) {
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

  document.getElementById("range-lo").value = 0;
  document.getElementById("range-hi").value = 1000;

  const spanDays = (dateRangeMax - dateRangeMin) / 86400;
  let bucketSecs;
  if (spanDays <= 90) bucketSecs = 86400;
  else if (spanDays <= 365) bucketSecs = 86400 * 7;
  else bucketSecs = 86400 * 30;
  histBucketSecs = bucketSecs;

  const bucketCount = Math.ceil((dateRangeMax - dateRangeMin) / bucketSecs) + 1;
  const counts = new Array(bucketCount).fill(0);
  tsList.forEach((ts) => {
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

function applyTimelineFilter() {
  filteredPhotos = resultPhotos.filter((p) => {
    if (!p.photo_datetime) return true; // keep undated photos visible regardless of range
    return p.photo_datetime >= dateFilterLo && p.photo_datetime <= dateFilterHi;
  });
  selectedIds.clear();
  lastClickedIndex = -1;
  refreshSelectionUI();
  showPlaceholder();
  renderGrid();
  drawHistogram();
}

function drawHistogram() {
  const canvas = document.getElementById("hist-canvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

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
  const maxCount = Math.max(...histBuckets.map((b) => b.count), 1);
  const barW = cssW / n;
  const span = dateRangeMax - dateRangeMin;

  histBuckets.forEach((bucket, i) => {
    const x = i * barW;
    const inRange = bucket.ts >= dateFilterLo && bucket.ts <= dateFilterHi;
    const barH = (bucket.count / maxCount) * cssH * 0.92;
    ctx.fillStyle = inRange ? "#5b9bd5" : "#444";
    ctx.fillRect(x + 0.5, cssH - barH, barW - 1, barH);
  });

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

document.getElementById("search-btn").addEventListener("click", runSearch);
document.getElementById("clear-btn").addEventListener("click", clearForm);
document.getElementById("download-selected-btn").addEventListener("click", downloadSelected);
document.getElementById("clear-selection-btn").addEventListener("click", clearSelection);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement &&
      document.activeElement.id !== "person-picker-input") {
    runSearch();
  }
});

wirePersonPicker();
loadPersons();
bindTimeline();
