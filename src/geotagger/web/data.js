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
    await renderSemantic(data.semantic_model);
  } catch (e) {
    document.getElementById("geonames-error").textContent = e.message;
  }
}

async function downloadBackup() {
  const btn = document.getElementById("backup-download-btn");
  const errEl = document.getElementById("backup-error");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const res = await fetch("/api/data/backup");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : "geotagger-backup.json";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Download backup";
  }
}

function renderFaceModel(m) {
  const el = document.getElementById("face-model-status");
  el.innerHTML = `
    <div class="data-file-row">
      <span>${escapeHtml(m.name)}</span>
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
      <span>${escapeHtml(f.name)}</span>
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
        <span>${escapeHtml(category)}</span>
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
    `<option value="${escapeHtml(g.group)}" ${g.group === osmActiveGroup ? "selected" : ""}>${escapeHtml(g.label)}</option>`
  ).join("");

  renderOsmCheckboxes();
}

function renderCensus(c) {
  if (!c) return;
  const kinds = Object.entries(c.by_kind || {});
  document.getElementById("census-status").innerHTML = `
    <div class="data-file-row">
      <span>Places DB${c.source ? ` <span class="data-file-note">(${escapeHtml(c.source)})</span>` : ""}</span>
      <span class="${c.available ? "present" : "missing"}">
        ${c.available ? `${c.places.toLocaleString()} total` : "not built yet"}
      </span>
    </div>
    ${kinds.map(([kind, n]) => `
      <div class="data-file-row data-file-subrow">
        <span>${escapeHtml(kind)}</span>
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
      <input type="checkbox" value="${escapeHtml(key)}" ${osmSelectedRegions.has(key) ? "checked" : ""}>
      ${escapeHtml(name)}${osmIngested.has(key) ? " ✓" : ""}
    </label>
  `).join("");
}

// ── Job polling ──
//
// Every download and the street search is start-a-job-then-poll-its-status. One
// loop for all of them, so each gets the same failure handling: a failed status
// fetch used to throw out of the loop with nothing shown, freezing the progress
// text. Network errors, 5xx and unreadable bodies are treated as transient (a
// server restart, a laptop waking up) — retried with a short backoff and a
// "Lost contact" note, which clears once a poll gets through — until
// POLL_MAX_FAILURES in a row, then it gives up with the error. 404 means the job
// (or its route) is gone and other 4xx won't change on retry, so those stop at once.
const POLL_MAX_FAILURES = 5;

/** Poll `statusUrl` (a job dict: {running, done, error, message, …}) until it
 *  finishes. onProgress(job) runs on every status; then onError(job.error),
 *  onDone(job) (awaited), or a silent stop when the job is no longer running.
 *  onError(msg) also gets fetch failures once retries are exhausted;
 *  onRetry(msg) reports a transient failure, onRetry(null) its recovery. Never
 *  throws — a throwing callback is reported through onError. */
async function pollJob({ statusUrl, intervalMs = 1500, onProgress, onDone, onError, onRetry }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let failures = 0;
  while (true) {
    let job;
    try {
      const res = await fetch(statusUrl);
      if (res.status === 404) { onError("The job is no longer on the server."); return; }
      if (!res.ok) {
        const msg = await httpErrorMessage(res);
        if (res.status < 500) { onError(msg); return; }
        throw new Error(msg);
      }
      job = await res.json();
    } catch (e) {
      failures++;
      if (failures >= POLL_MAX_FAILURES) {
        onError(`Lost contact with server: ${e.message}`);
        return;
      }
      onRetry?.(`Lost contact with server — retrying… (${e.message})`);
      // Back off a little each time (capped) so a restarting server isn't hammered.
      await wait(Math.max(intervalMs, 1000) * Math.min(failures + 1, 4));
      continue;
    }
    if (failures) { failures = 0; onRetry?.(null); }
    try {
      onProgress?.(job);
      if (job.error) { onError(job.error); return; }
      if (job.done) { await onDone?.(job); return; }
      if (!job.running) return;
    } catch (e) {
      onError(e.message);
      return;
    }
    await wait(intervalMs);
  }
}

// Cards whose job is being polled — guards against two loops for one job (the
// resume-on-load check and a click can both start one).
const activePolls = new Set();

/** pollJob wired to one Data-page card: job.message → #<prefix>-progress, errors →
 *  #<prefix>-error, and the card's button re-enabled when polling ends.
 *  `refreshAfter` re-reads /api/data/status afterwards (the download cards). */
async function pollCard(prefix, { statusUrl, intervalMs, btnId, onDone, refreshAfter = true }) {
  if (activePolls.has(prefix)) return;
  activePolls.add(prefix);
  const progress = document.getElementById(`${prefix}-progress`);
  const errorEl = document.getElementById(`${prefix}-error`);
  let retryMsg = null;
  try {
    await pollJob({
      statusUrl, intervalMs, onDone,
      onProgress: (job) => { progress.textContent = job.message || ""; },
      onError: (msg) => { errorEl.textContent = msg; },
      onRetry: (msg) => {
        // Only clear our own "Lost contact" note, never a real error.
        if (msg) errorEl.textContent = msg;
        else if (errorEl.textContent === retryMsg) errorEl.textContent = "";
        retryMsg = msg;
      },
    });
  } finally {
    activePolls.delete(prefix);
    document.getElementById(btnId).disabled = false;
    if (refreshAfter) await loadStatus();
  }
}

function pollGeonames() {
  return pollCard("geonames", {
    statusUrl: "/api/data/geonames/download/status", intervalMs: 1500,
    btnId: "geonames-download-btn",
  });
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

function pollOsm() {
  return pollCard("osm", {
    statusUrl: "/api/data/osm/download/status", intervalMs: 2000,
    btnId: "osm-download-btn", refreshAfter: false,
    onDone: async () => {
      await loadStatus();
      // The merge just cached a fresh .osm.pbf — that's a newly searchable region.
      await loadStreetsStatus();
    },
  });
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

function pollCensus() {
  return pollCard("census", {
    statusUrl: "/api/data/census/download/status", intervalMs: 1500,
    btnId: "census-download-btn",
  });
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

function pollFaceModel() {
  return pollCard("face-model", {
    statusUrl: "/api/data/face-model/download/status", intervalMs: 1500,
    btnId: "face-model-download-btn",
  });
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

// ── Text search model + indexing ──
//
// Download is the usual start-job-then-poll; indexing is the client batch loop
// (POST a batch, read `remaining`, repeat) used by face detection on Home.

let semanticIndexing = false;
let semanticStopRequested = false;

async function renderSemantic(m) {
  const el = document.getElementById("semantic-status");
  let idx = null;
  try {
    const res = await fetch("/api/semantic/status");
    if (res.ok) idx = await res.json();
  } catch { /* the model row below still renders */ }
  el.innerHTML = `
    <div class="data-file-row">
      <span>${escapeHtml(m.name)}</span>
      <span class="${m.available ? "present" : "missing"}">
        ${m.available ? fmtBytes(m.size_bytes) : "not downloaded"}
      </span>
    </div>
    ${idx ? `
    <div class="data-file-row">
      <span>Photos indexed</span>
      <span class="${idx.remaining === 0 ? "present" : "missing"}">
        ${idx.embedded.toLocaleString()} of ${idx.total.toLocaleString()}${idx.failed ? ` · ${idx.failed.toLocaleString()} unreadable` : ""}
      </span>
    </div>` : ""}
  `;
  document.getElementById("semantic-download-btn").textContent =
    m.available ? "Re-download text search model" : "Download text search model";
  const indexBtn = document.getElementById("semantic-index-btn");
  if (!semanticIndexing) {
    indexBtn.disabled = !m.available || !idx || idx.remaining === 0;
    indexBtn.textContent = idx && idx.remaining > 0
      ? `Index ${idx.remaining.toLocaleString()} photos` : "Index photos";
  }
  // Unreadable photos sit out of the queue until re-queued here.
  document.getElementById("semantic-retry-btn").style.display =
    idx && idx.failed && m.available && !semanticIndexing ? "" : "none";
}

function pollSemanticModel() {
  return pollCard("semantic", {
    statusUrl: "/api/data/semantic-model/download/status", intervalMs: 1000,
    btnId: "semantic-download-btn",
  });
}

async function startSemanticDownload() {
  const btn = document.getElementById("semantic-download-btn");
  const errorEl = document.getElementById("semantic-error");
  errorEl.textContent = "";
  btn.disabled = true;
  try {
    const res = await fetch("/api/data/semantic-model/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: document.getElementById("semantic-force").checked }),
    });
    if (res.status !== 409 && !res.ok) throw new Error(`HTTP ${res.status}`);
    pollSemanticModel();
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
  }
}

async function runSemanticIndex() {
  if (semanticIndexing) return;
  semanticIndexing = true;
  semanticStopRequested = false;
  const btn = document.getElementById("semantic-index-btn");
  const stopBtn = document.getElementById("semantic-stop-btn");
  const progress = document.getElementById("semantic-progress");
  const errorEl = document.getElementById("semantic-error");
  errorEl.textContent = "";
  btn.disabled = true;
  stopBtn.style.display = "";
  document.getElementById("semantic-retry-btn").style.display = "none";
  let failed = 0;
  try {
    let remaining = Infinity;
    let allowFailures = false;
    while (remaining > 0 && !semanticStopRequested) {
      const t0 = performance.now();
      const res = await fetch("/api/semantic/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 32, allow_failures: allowFailures }),
      });
      allowFailures = false;   // the override covers one batch only
      if (!res.ok) {
        // 409 detail is a string (model not downloaded). 503 detail is {code,
        // message, errors}: the batch aborted with nothing marked, so stop rather
        // than walk the library — or, for the consecutive-failure guard, ask.
        const body = await res.json().catch(() => null);
        const d = body?.detail;
        if (d && typeof d === "object") {
          if (d.code === "too_many_failures" &&
              confirm(`${d.message}\n\n${(d.errors || []).slice(0, 5).join("\n")}\n\n` +
                      "If these files really are unreadable, mark them as failed and keep indexing?")) {
            allowFailures = true;
            continue;
          }
          throw new Error(d.message);
        }
        throw new Error(d || `HTTP ${res.status}`);
      }
      const data = await res.json();
      remaining = data.remaining;
      failed += data.errors.length;
      const rate = data.processed / ((performance.now() - t0) / 1000);
      btn.textContent = remaining > 0 ? `Indexing… ${remaining.toLocaleString()} left` : "Index photos";
      progress.textContent = remaining > 0
        ? `~${rate.toFixed(1)} photos/s · about ${Math.ceil(remaining / Math.max(rate, 0.1) / 60).toLocaleString()} min left`
        : `Done.${failed ? ` ${failed} photo(s) couldn't be read.` : ""}`;
    }
    if (semanticStopRequested) progress.textContent = "Stopped — Index photos resumes where it left off.";
  } catch (e) {
    errorEl.textContent = e.message;
  } finally {
    semanticIndexing = false;
    stopBtn.style.display = "none";
    await loadStatus();
  }
}

document.getElementById("semantic-download-btn").addEventListener("click", startSemanticDownload);
document.getElementById("semantic-index-btn").addEventListener("click", runSemanticIndex);
document.getElementById("semantic-stop-btn").addEventListener("click", () => { semanticStopRequested = true; });
document.getElementById("semantic-retry-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("semantic-error");
  errorEl.textContent = "";
  try {
    const res = await fetch("/api/semantic/retry-failed", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    await runSemanticIndex();
  } catch (e) {
    errorEl.textContent = e.message;
  }
});
// Resume watching a download started before this page was (re)opened.
fetch("/api/data/semantic-model/download/status")
  .then((r) => (r.ok ? r.json() : null))
  .then((job) => { if (job?.running) pollSemanticModel(); })
  .catch(() => {});

// ── Street search ──
//
// Streets aren't in any database (see osm_streets.py) — a search streams the raw
// cached .osm.pbf extracts, which takes seconds to a minute, so this drives the
// same start-job-then-poll loop the downloads above use rather than one long fetch.

let streetsMap = null;
let streetsLayer = null;
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
    if (!res.ok) return;   // keep the default view
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
          <span>Expected in ${escapeHtml(status.cache_dir)}</span>
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
            <span>${escapeHtml(f.label)}</span>
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

function pollStreets() {
  return pollCard("streets", {
    statusUrl: "/api/data/streets/search/status", intervalMs: 800,
    btnId: "streets-search-btn", refreshAfter: false,
    onDone: (job) => renderStreets(job.result),
  });
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
      line.bindTooltip(`${escapeHtml(way.name)}${way.highway ? ` · ${escapeHtml(way.highway)}` : ""}`, { sticky: true });
      group.lines.push(line);
    });
  });

  listEl.innerHTML = streetGroups.map((group, i) => `
    <div class="street-row" data-i="${i}">
      <span>${escapeHtml(group.key)}</span>
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

document.getElementById("backup-download-btn").addEventListener("click", downloadBackup);
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

// Start polling a job that was already running on load. A failed check just
// leaves the card idle — the user can still start the job by hand.
function resumePoll(statusUrl, btnId, poll) {
  fetch(statusUrl)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j?.running) return;
      document.getElementById(btnId).disabled = true;
      poll();
    })
    .catch(() => {});
}

loadStatus().then(() => {
  loadStreetsStatus();
  // Resume polling if a job was already running when the page loaded (e.g. reload mid-download).
  resumePoll("/api/data/geonames/download/status", "geonames-download-btn", pollGeonames);
  resumePoll("/api/data/osm/download/status", "osm-download-btn", pollOsm);
  resumePoll("/api/data/census/download/status", "census-download-btn", pollCensus);
  resumePoll("/api/data/face-model/download/status", "face-model-download-btn", pollFaceModel);
  resumePoll("/api/data/streets/search/status", "streets-search-btn", pollStreets);
});
