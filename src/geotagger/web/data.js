let geonamesPolling = false;
let osmPolling = false;

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
  } catch (e) {
    document.getElementById("geonames-error").textContent = e.message;
  }
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
  document.getElementById("geonames-download-btn").disabled = g.available;
  if (g.available) {
    document.getElementById("geonames-download-btn").textContent = "GeoNames data installed";
  }
}

function renderOsm(o) {
  const el = document.getElementById("osm-status");
  el.innerHTML = `
    <div class="data-file-row">
      <span>Places DB</span>
      <span class="${o.available ? "present" : "missing"}">
        ${o.available ? `${o.places.toLocaleString()} places` : "not built yet"}
      </span>
    </div>
  `;

  const picker = document.getElementById("osm-state-picker");
  const ingested = new Set(o.ingested_slugs || []);
  picker.innerHTML = o.states.map(([slug, name]) => `
    <label class="${ingested.has(slug) ? "state-loaded" : ""}" title="${ingested.has(slug) ? "Already merged" : ""}">
      <input type="checkbox" value="${slug}">
      ${name}${ingested.has(slug) ? " ✓" : ""}
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
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/geonames/download", { method: "POST" });
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
  const states = Array.from(
    document.querySelectorAll("#osm-state-picker input[type=checkbox]:checked")
  ).map((cb) => cb.value);
  if (!states.length) {
    errorEl.textContent = "Select at least one state.";
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/osm/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states }),
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

document.getElementById("geonames-download-btn").addEventListener("click", startGeonamesDownload);
document.getElementById("osm-download-btn").addEventListener("click", startOsmDownload);

loadStatus().then(() => {
  // Resume polling if a job was already running when the page loaded (e.g. reload mid-download).
  fetch("/api/data/geonames/download/status").then((r) => r.json()).then((j) => {
    if (j.running) { document.getElementById("geonames-download-btn").disabled = true; pollGeonames(); }
  });
  fetch("/api/data/osm/download/status").then((r) => r.json()).then((j) => {
    if (j.running) { document.getElementById("osm-download-btn").disabled = true; pollOsm(); }
  });
});
