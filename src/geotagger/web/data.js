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
});
