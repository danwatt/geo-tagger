let geonamesPolling = false;
let osmPolling = false;
let censusPolling = false;
let faceModelPolling = false;
let osmGroups = [];         // [{group, label, items: [{key, name}]}]
let osmIngested = new Set();
let osmSelectedRegions = new Set();
let osmActiveGroup = "us";

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/data/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderGeonames(data.geonames);
    renderOsm(data.osm);
    renderCensus(data.census);
    renderFaceModel(data.face_model);
  } catch (e) {
    document.getElementById("geonames-error").textContent = e.message;
  }
}

function renderFaceModel(m) {
  const el = document.getElementById("face-model-status");
  el.innerHTML = `
    <div class="data-file-row">
      <span>${m.name}</span>
      <span class="${m.available ? "present" : "missing"}">
        ${m.available ? "installed" : "not downloaded"}
      </span>
    </div>
  `;
  const btn = document.getElementById("face-model-download-btn");
  btn.textContent = m.available ? "Re-download face model" : "Download face model";
}

function renderGeonames(g) {
  const el = document.getElementById("geonames-files");
  el.innerHTML = g.files.map((f) => `
    <div class="data-file-row">
      <span>${f.name}</span>
      <span class="${f.present ? "present" : "missing"}">
        ${f.present ? fmtBytes(f.size) : "missing"}
      </span>
    </div>
  `).join("");
  document.getElementById("geonames-download-btn").textContent =
    g.available ? "Re-download GeoNames data" : "Download GeoNames data";
}

function renderOsm(o) {
  const el = document.getElementById("osm-status");
  const categories = Object.entries(o.by_category || {});
  el.innerHTML = `
    <div class="data-file-row">
      <span>Places DB</span>
      <span class="${o.available ? "present" : "missing"}">
        ${o.available ? `${o.places.toLocaleString()} total` : "not built yet"}
      </span>
    </div>
    ${categories.map(([category, n]) => `
      <div class="data-file-row data-file-subrow">
        <span>${category}</span>
        <span>${n.toLocaleString()}</span>
      </div>
    `).join("")}
  `;

  osmGroups = o.groups || [];
  osmIngested = new Set(o.ingested_keys || []);
  if (!osmGroups.some((g) => g.group === osmActiveGroup)) {
    osmActiveGroup = osmGroups[0]?.group;
  }

  const groupSelect = document.getElementById("osm-group-select");
  groupSelect.innerHTML = osmGroups.map((g) =>
    `<option value="${g.group}" ${g.group === osmActiveGroup ? "selected" : ""}>${g.label}</option>`
  ).join("");

  renderOsmCheckboxes();
}

function renderCensus(c) {
  if (!c) return;
  const kinds = Object.entries(c.by_kind || {});
  document.getElementById("census-status").innerHTML = `
    <div class="data-file-row">
      <span>Places DB${c.source ? ` <span class="data-file-note">(${c.source})</span>` : ""}</span>
      <span class="${c.available ? "present" : "missing"}">
        ${c.available ? `${c.places.toLocaleString()} total` : "not built yet"}
      </span>
    </div>
    ${kinds.map(([kind, n]) => `
      <div class="data-file-row data-file-subrow">
        <span>${kind}</span>
        <span>${n.toLocaleString()}</span>
      </div>
    `).join("")}
    <div class="data-file-row">
      <span>ZIP areas (ZCTA)</span>
      <span class="${c.zctas ? "present" : "missing"}">
        ${c.zctas ? `${c.zctas.toLocaleString()} total` : "not loaded"}
      </span>
    </div>
    ${c.zctas ? `
      <div class="data-file-row data-file-subrow">
        <span>with a city name</span>
        <span>${(c.zip_names || 0).toLocaleString()}</span>
      </div>` : ""}
  `;
  document.getElementById("census-download-btn").textContent =
    c.available ? "Re-download Census data" : "Download Census data";
}

function renderOsmCheckboxes() {
  const picker = document.getElementById("osm-state-picker");
  const group = osmGroups.find((g) => g.group === osmActiveGroup);
  if (!group) { picker.innerHTML = ""; return; }
  picker.innerHTML = group.items.map(({ key, name }) => `
    <label class="${osmIngested.has(key) ? "state-loaded" : ""}" title="${osmIngested.has(key) ? "Already merged" : ""}">
      <input type="checkbox" value="${key}" ${osmSelectedRegions.has(key) ? "checked" : ""}>
      ${name}${osmIngested.has(key) ? " ✓" : ""}
    </label>
  `).join("");
}

async function pollGeonames() {
  if (geonamesPolling) return;
  geonamesPolling = true;
  const btn = document.getElementById("geonames-download-btn");
  const progress = document.getElementById("geonames-progress");
  const errorEl = document.getElementById("geonames-error");
  try {
    while (true) {
      const res = await fetch("/api/data/geonames/download/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const job = await res.json();
      progress.textContent = job.message || "";
      if (job.error) {
        errorEl.textContent = job.error;
        break;
      }
      if (job.done) {
        progress.textContent = job.message;
        await loadStatus();
        break;
      }
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    geonamesPolling = false;
    btn.disabled = false;
    await loadStatus();
  }
}

async function startGeonamesDownload() {
  const btn = document.getElementById("geonames-download-btn");
  const errorEl = document.getElementById("geonames-error");
  errorEl.textContent = "";
  const force = document.getElementById("geonames-force").checked;
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/geonames/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (res.status === 409) { pollGeonames(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pollGeonames();
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
  }
}

async function pollOsm() {
  if (osmPolling) return;
  osmPolling = true;
  const btn = document.getElementById("osm-download-btn");
  const progress = document.getElementById("osm-progress");
  const errorEl = document.getElementById("osm-error");
  try {
    while (true) {
      const res = await fetch("/api/data/osm/download/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const job = await res.json();
      progress.textContent = job.message || "";
      if (job.error) {
        errorEl.textContent = job.error;
        break;
      }
      if (job.done) {
        progress.textContent = job.message;
        await loadStatus();
        // The merge just cached a fresh .osm.pbf — that's a newly searchable region.
        await loadStreetsStatus();
        break;
      }
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    osmPolling = false;
    btn.disabled = false;
  }
}

async function startOsmDownload() {
  const btn = document.getElementById("osm-download-btn");
  const errorEl = document.getElementById("osm-error");
  errorEl.textContent = "";
  const regions = Array.from(osmSelectedRegions);
  if (!regions.length) {
    errorEl.textContent = "Select at least one region.";
    return;
  }
  const force = document.getElementById("osm-force").checked;
  if (force) {
    const names = regions.map((key) => {
      for (const g of osmGroups) {
        const item = g.items.find((i) => i.key === key);
        if (item) return item.name;
      }
      return key;
    });
    const ok = confirm(
      `This discards the locally cached download for ${names.join(", ")} and ` +
      `re-fetches it from GeoFabrik. Continue?`
    );
    if (!ok) return;
  }
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/osm/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regions, force }),
    });
    if (res.status === 409) { pollOsm(); return; }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    pollOsm();
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
  }
}

async function pollCensus() {
  if (censusPolling) return;
  censusPolling = true;
  const btn = document.getElementById("census-download-btn");
  const progress = document.getElementById("census-progress");
  const errorEl = document.getElementById("census-error");
  try {
    while (true) {
      const res = await fetch("/api/data/census/download/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const job = await res.json();
      progress.textContent = job.message || "";
      if (job.error) {
        errorEl.textContent = job.error;
        break;
      }
      if (job.done) {
        progress.textContent = job.message;
        await loadStatus();
        break;
      }
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    censusPolling = false;
    btn.disabled = false;
    await loadStatus();
  }
}

async function startCensusDownload() {
  const btn = document.getElementById("census-download-btn");
  const errorEl = document.getElementById("census-error");
  errorEl.textContent = "";
  const force = document.getElementById("census-force").checked;
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/census/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (res.status === 409) { pollCensus(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pollCensus();
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
  }
}

async function pollFaceModel() {
  if (faceModelPolling) return;
  faceModelPolling = true;
  const btn = document.getElementById("face-model-download-btn");
  const progress = document.getElementById("face-model-progress");
  const errorEl = document.getElementById("face-model-error");
  try {
    while (true) {
      const res = await fetch("/api/data/face-model/download/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const job = await res.json();
      progress.textContent = job.message || "";
      if (job.error) {
        errorEl.textContent = job.error;
        break;
      }
      if (job.done) {
        progress.textContent = job.message;
        await loadStatus();
        break;
      }
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    faceModelPolling = false;
    btn.disabled = false;
    await loadStatus();
  }
}

async function startFaceModelDownload() {
  const btn = document.getElementById("face-model-download-btn");
  const errorEl = document.getElementById("face-model-error");
  errorEl.textContent = "";
  const force = document.getElementById("face-model-force").checked;
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/face-model/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (res.status === 409) { pollFaceModel(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pollFaceModel();
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
  }
}

// ── Street search ──
//
// Streets aren't in any database (see osm_streets.py) — a search streams the raw
// cached .osm.pbf extracts, which takes seconds to a minute, so this drives the
// same start-job-then-poll loop the downloads above use rather than one long fetch.

let streetsMap = null;
let streetsLayer = null;
let streetsPolling = false;
let streetGroups = [];      // [{name, ref, ways: [{coords, ...}], lines: [L.Polyline]}]

function initStreetsMap(status) {
  streetsMap = L.map("streets-map").setView([39, -96], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(streetsMap);
  streetsLayer = L.layerGroup().addTo(streetsMap);
  fitStreetsMap(status);
}

// Open on something searchable: the extents of whatever extracts are cached, since
// those are the only areas a search can return anything for. With none cached (or
// none carrying a header bbox), fall back to the library's own photo bounds.
async function fitStreetsMap(status) {
  const boxes = (status.files || []).map((f) => f.bbox).filter(Boolean);
  if (boxes.length) {
    streetsMap.fitBounds([
      [Math.min(...boxes.map((b) => b.min_lat)), Math.min(...boxes.map((b) => b.min_lng))],
      [Math.max(...boxes.map((b) => b.max_lat)), Math.max(...boxes.map((b) => b.max_lng))],
    ], { padding: [20, 20] });
    return;
  }
  try {
    const res = await fetch("/api/stats/bounds");
    const data = await res.json();
    if (data.has_data) {
      streetsMap.fitBounds([[data.min_lat, data.min_lng], [data.max_lat, data.max_lng]],
        { padding: [20, 20] });
    }
  } catch (e) {
    // keep the default view
  }
}

async function loadStreetsStatus() {
  const el = document.getElementById("streets-status");
  const btn = document.getElementById("streets-search-btn");
  try {
    const res = await fetch("/api/data/streets/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    if (!status.available) {
      el.innerHTML = `
        <div class="data-file-row">
          <span>Raw OSM extracts</span>
          <span class="missing">none cached — street search unavailable</span>
        </div>
        <div class="data-file-row data-file-subrow">
          <span>Expected in ${status.cache_dir}</span>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="data-file-row">
          <span>Raw OSM extracts</span>
          <span class="present">${status.files.length} cached, ${fmtBytes(status.total_size)}</span>
        </div>
        ${status.files.map((f) => `
          <div class="data-file-row data-file-subrow">
            <span>${f.label}</span>
            <span>${fmtBytes(f.size)}</span>
          </div>
        `).join("")}
      `;
    }
    btn.disabled = !status.available;
    if (!streetsMap) initStreetsMap(status);
    return status;
  } catch (e) {
    document.getElementById("streets-error").textContent = e.message;
    return null;
  }
}

async function startStreetSearch() {
  const btn = document.getElementById("streets-search-btn");
  const errorEl = document.getElementById("streets-error");
  const query = document.getElementById("streets-query").value.trim();
  errorEl.textContent = "";
  if (query.length < 2) {
    errorEl.textContent = "Type at least 2 characters to search.";
    return;
  }
  const b = streetsMap.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/streets/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bbox,
        query,
        include_paths: document.getElementById("streets-paths").checked,
      }),
    });
    if (res.status === 409) { pollStreets(); return; }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    pollStreets();
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
  }
}

async function pollStreets() {
  if (streetsPolling) return;
  streetsPolling = true;
  const btn = document.getElementById("streets-search-btn");
  const progress = document.getElementById("streets-progress");
  const errorEl = document.getElementById("streets-error");
  try {
    while (true) {
      const res = await fetch("/api/data/streets/search/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const job = await res.json();
      progress.textContent = job.message || "";
      if (job.error) { errorEl.textContent = job.error; break; }
      if (job.done) {
        renderStreets(job.result);
        break;
      }
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  } finally {
    streetsPolling = false;
    btn.disabled = false;
  }
}

// Segments, not streets: OSM splits a road at every junction and tag change, so a
// single named road comes back as dozens of ways. Group by name for the list, but
// keep each way its own polyline so gaps between segments stay honest.
function renderStreets(result) {
  streetsLayer.clearLayers();
  streetGroups = [];
  const listEl = document.getElementById("streets-results");
  const streets = (result && result.streets) || [];
  if (!streets.length) {
    listEl.innerHTML = "";
    return;
  }

  const byName = new Map();
  streets.forEach((s) => {
    const key = s.name + (s.ref && s.ref !== s.name ? ` (${s.ref})` : "");
    if (!byName.has(key)) byName.set(key, { key, ways: [], lines: [] });
    byName.get(key).ways.push(s);
  });
  streetGroups = Array.from(byName.values())
    .sort((a, b) => b.ways.length - a.ways.length || a.key.localeCompare(b.key));

  streetGroups.forEach((group) => {
    group.ways.forEach((way) => {
      const line = L.polyline(way.coords, {
        color: "#e0a040", weight: 4, opacity: 0.85,
      }).addTo(streetsLayer);
      line.bindTooltip(`${way.name}${way.highway ? ` · ${way.highway}` : ""}`, { sticky: true });
      group.lines.push(line);
    });
  });

  listEl.innerHTML = streetGroups.map((group, i) => `
    <div class="street-row" data-i="${i}">
      <span>${group.key}</span>
      <span class="street-meta">${group.ways.length} segment${group.ways.length === 1 ? "" : "s"}</span>
    </div>
  `).join("");

  const all = streetGroups.flatMap((g) => g.lines);
  if (all.length) {
    streetsMap.fitBounds(L.featureGroup(all).getBounds().pad(0.15));
  }
}

function focusStreetGroup(i) {
  const group = streetGroups[i];
  if (!group) return;
  document.querySelectorAll(".street-row").forEach((row) => {
    row.classList.toggle("active", Number(row.dataset.i) === i);
  });
  streetGroups.forEach((g) => g.lines.forEach((line) => {
    line.setStyle(g === group
      ? { color: "#7ab8f5", weight: 6, opacity: 1 }
      : { color: "#e0a040", weight: 4, opacity: 0.35 });
  }));
  streetsMap.fitBounds(L.featureGroup(group.lines).getBounds().pad(0.25));
}

document.getElementById("streets-search-btn").addEventListener("click", startStreetSearch);
document.getElementById("streets-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startStreetSearch();
});
document.getElementById("streets-results").addEventListener("click", (e) => {
  const row = e.target.closest(".street-row");
  if (row) focusStreetGroup(Number(row.dataset.i));
});

document.getElementById("geonames-download-btn").addEventListener("click", startGeonamesDownload);
document.getElementById("osm-download-btn").addEventListener("click", startOsmDownload);
document.getElementById("census-download-btn").addEventListener("click", startCensusDownload);
document.getElementById("face-model-download-btn").addEventListener("click", startFaceModelDownload);

document.getElementById("osm-group-select").addEventListener("change", (e) => {
  osmActiveGroup = e.target.value;
  renderOsmCheckboxes();
});
document.getElementById("osm-state-picker").addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  if (e.target.checked) osmSelectedRegions.add(e.target.value);
  else osmSelectedRegions.delete(e.target.value);
});

loadStatus().then(() => {
  loadStreetsStatus();
  // Resume polling if a job was already running when the page loaded (e.g. reload mid-download).
  fetch("/api/data/geonames/download/status").then((r) => r.json()).then((j) => {
    if (j.running) { document.getElementById("geonames-download-btn").disabled = true; pollGeonames(); }
  });
  fetch("/api/data/osm/download/status").then((r) => r.json()).then((j) => {
    if (j.running) { document.getElementById("osm-download-btn").disabled = true; pollOsm(); }
  });
  fetch("/api/data/census/download/status").then((r) => r.json()).then((j) => {
    if (j.running) { document.getElementById("census-download-btn").disabled = true; pollCensus(); }
  });
  fetch("/api/data/face-model/download/status").then((r) => r.json()).then((j) => {
    if (j.running) { document.getElementById("face-model-download-btn").disabled = true; pollFaceModel(); }
  });
  fetch("/api/data/streets/search/status").then((r) => r.json()).then((j) => {
    if (j.running) { document.getElementById("streets-search-btn").disabled = true; pollStreets(); }
  });
});
