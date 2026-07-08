const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function showError(cardId, msg) {
  const card = document.getElementById(cardId);
  let el = card.querySelector(".error-line");
  if (!el) {
    el = document.createElement("div");
    el.className = "error-line";
    card.appendChild(el);
  }
  el.textContent = `Error: ${msg}`;
}

function clearError(cardId) {
  const card = document.getElementById(cardId);
  const el = card.querySelector(".error-line");
  if (el) el.remove();
}

/* ── Summary card (photos / geotag / geocode / faces / people) ── */
async function loadSummary() {
  const cards = ["card-library", "card-geotag", "card-reverse-geocode", "card-faces", "card-people"];
  try {
    const res = await fetch("/api/stats/summary");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cards.forEach(clearError);
    renderLibrary(data.photos);
    renderGeotag(data.geotag, data.guessable, data.photos.total);
    renderReverseGeocode(data.geocode);
    renderFaces(data.faces);
    renderPeople(data.people, data.contexts);
  } catch (e) {
    cards.forEach((id) => showError(id, e.message));
  }
}

function renderLibrary(photos) {
  document.getElementById("library-total").textContent = photos.total.toLocaleString();
  document.getElementById("library-breakdown").textContent =
    `${photos.images.toLocaleString()} images · ${photos.videos.toLocaleString()} videos`;
}

function renderGeotag(geotag, guessable, total) {
  const done = geotag.tagged + geotag.ignored;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById("geotag-progress-fill").style.width = `${pct}%`;
  document.getElementById("geotag-progress-label").textContent = `${pct}%`;
  document.getElementById("geotag-stats").innerHTML =
    `${geotag.tagged.toLocaleString()} tagged · ${geotag.ignored.toLocaleString()} ignored · ` +
    `<strong>${geotag.untagged.toLocaleString()} remaining</strong>`;
  document.getElementById("geotag-guessable").textContent =
    guessable.count > 0
      ? `${guessable.count.toLocaleString()} photos have a nearby-in-time guess available`
      : "";
}

function renderReverseGeocode(geocode) {
  const btn = document.getElementById("backfill-btn");
  const hint = document.getElementById("reverse-geocode-hint");
  document.getElementById("reverse-geocode-stats").textContent =
    `${geocode.geocoded.toLocaleString()} geocoded · ${geocode.pending.toLocaleString()} pending`;
  if (!geocode.available) {
    hint.style.display = "";
    hint.textContent = "GeoNames data not installed — run scripts/get_geonames.py";
    btn.disabled = true;
  } else if (!backfillRunning) {
    hint.style.display = "none";
    btn.disabled = false;
  }
}

function renderFaces(faces) {
  const denom = faces.total - faces.ignored;
  const pct = denom > 0 ? Math.round((faces.labeled / denom) * 100) : 0;
  document.getElementById("faces-progress-fill").style.width = `${pct}%`;
  document.getElementById("faces-progress-label").textContent =
    `${faces.labeled.toLocaleString()} of ${denom.toLocaleString()} faces labeled`;
  document.getElementById("faces-unscanned").textContent =
    `${faces.unscanned_photos.toLocaleString()} photos not yet scanned for faces`;
}

function renderPeople(people, contexts) {
  document.getElementById("people-stats").textContent =
    `${people.persons.toLocaleString()} people · ${people.families.toLocaleString()} families`;
  document.getElementById("contexts-stats").textContent =
    `${contexts.count.toLocaleString()} life contexts`;
}

 /* ── Face-coverage card ── */
async function loadFaceCoverage() {
  try {
    const res = await fetch("/api/stats/face-coverage");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    clearError("card-face-coverage");
    renderFaceCoverage(data);
  } catch (e) {
    showError("card-face-coverage", e.message);
  }
}

function renderFaceCoverage(cov) {
  const segs = [
    { label: "Full", cls: "cov-full", n: cov.full },
    { label: "Partial", cls: "cov-partial", n: cov.partial },
    { label: "No coverage", cls: "cov-none", n: cov.none },
    { label: "No faces", cls: "cov-noface", n: cov.no_faces },
  ];
  const total = segs.reduce((sum, s) => sum + s.n, 0);

  const bar = document.getElementById("face-coverage-bar");
  bar.innerHTML = "";
  segs.forEach((s) => {
    if (s.n === 0) return;  // skip empty segments so tiny slivers don't show
    const seg = document.createElement("div");
    seg.className = s.cls;
    seg.style.width = `${(s.n / total) * 100}%`;
    seg.title = `${s.label}: ${s.n.toLocaleString()}`;
    bar.appendChild(seg);
  });

  document.getElementById("face-coverage-label").textContent = total > 0
    ? `${total.toLocaleString()} photos scanned for faces`
    : "No photos scanned for faces yet";

  document.getElementById("face-coverage-legend").innerHTML = segs.map((s) =>
    `<span class="lg"><span class="sw ${s.cls}"></span>${s.label} ${s.n.toLocaleString()}</span>`
  ).join("");
}

/* ── Shared stacked-bar-by-month renderer ──
   `segments` is bottom-to-top-last stacking order: [{key, cls, label}, ...],
   each `key` reading a count off the month object. In "pct" mode every bar
   fills the full container height, split by each segment's share of that
   month's total (segments are expected to fully partition the month, geo and
   faces both do). In "abs" mode bar height instead reflects the month's
   total relative to the tallest month, so spikes (e.g. a day with lots of
   faces) are visible rather than normalized away. `linkPage` is the page
   ("geocode.html" / "people.html") a click on a bar navigates to, with a
   `?month=YYYY-MM` argument for that bar's month. */
function renderMonthBars(containerId, months, segments, linkPage, mode) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  const totals = months.map((m) => segments.reduce((sum, s) => sum + m[s.key], 0));
  const maxTotal = Math.max(0, ...totals);
  let lastYear = null;
  months.forEach((m, i) => {
    const wrap = document.createElement("div");
    wrap.className = "month-bar";
    const total = totals[i];
    wrap.title = `${MONTH_NAMES[m.month - 1]} ${m.year} — ` +
      segments.map((s) => `${m[s.key].toLocaleString()} ${s.label}`).join(", ");
    const monthKey = `${m.year}-${String(m.month).padStart(2, "0")}`;
    wrap.addEventListener("click", () => {
      window.location.href = `${linkPage}?month=${monthKey}`;
    });

    if (mode === "abs") {
      wrap.style.height = maxTotal > 0 ? `${(total / maxTotal) * 100}%` : "0%";
    }

    segments.forEach((s) => {
      const pct = total > 0 ? (m[s.key] / total) * 100 : 0;
      const seg = document.createElement("div");
      seg.className = s.cls;
      seg.style.height = `${pct}%`;
      wrap.appendChild(seg);
    });

    if (m.year !== lastYear) {
      const label = document.createElement("span");
      label.className = "month-year-label";
      label.textContent = m.year;
      wrap.appendChild(label);
      lastYear = m.year;
    }
    container.appendChild(wrap);
  });
}

// Wires a card's %/Count toggle buttons; `onModeChange(mode)` re-renders
// with the newly selected mode.
function wireModeToggle(toggleId, onModeChange) {
  const toggle = document.getElementById(toggleId);
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      toggle.dataset.mode = btn.dataset.mode;
      onModeChange(btn.dataset.mode);
    });
  });
}

// Shows/hides the "N undated" link below a month-bar card, linking to
// `linkPage?month=undated`. `total` is the undated photo/face count for that
// page's queue; hidden entirely when there are none.
function renderUndatedLink(linkId, total, linkPage) {
  const link = document.getElementById(linkId);
  if (!total) { link.style.display = "none"; return; }
  link.style.display = "";
  link.href = `${linkPage}?month=undated`;
  link.textContent = `📁 ${total.toLocaleString()} undated photo${total === 1 ? "" : "s"} →`;
}

/* ── Coverage-by-month card ── */
const MONTHS_SEGMENTS = [
  { key: "not_geotagged", cls: "bar-untagged", label: "untagged" },
  { key: "geotagged", cls: "bar-tagged", label: "tagged" },
];
let monthsData = null;
let monthsMode = "pct";

async function loadMonths() {
  try {
    const res = await fetch("/api/stats/months");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    clearError("card-months");
    monthsData = data;
    renderMonthBars("months-bar-container", data.months.slice().reverse(), MONTHS_SEGMENTS, "geocode.html", monthsMode);
    renderUndatedLink("months-undated-link", data.undated.total, "geocode.html");
  } catch (e) {
    showError("card-months", e.message);
  }
}

wireModeToggle("months-mode-toggle", (mode) => {
  monthsMode = mode;
  if (monthsData) {
    renderMonthBars("months-bar-container", monthsData.months.slice().reverse(), MONTHS_SEGMENTS, "geocode.html", monthsMode);
  }
});

/* ── Face-coverage-by-month card ── */
const FACES_MONTHS_SEGMENTS = [
  { key: "no_faces", cls: "cov-noface", label: "no faces" },
  { key: "none", cls: "cov-none", label: "none labeled" },
  { key: "partial", cls: "cov-partial", label: "partial" },
  { key: "full", cls: "cov-full", label: "full" },
];
let facesMonthsData = null;
let facesMonthsMode = "pct";

async function loadFacesMonths() {
  try {
    const res = await fetch("/api/stats/faces-months");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    clearError("card-faces-months");
    facesMonthsData = data;
    renderMonthBars("faces-months-bar-container", data.months.slice().reverse(), FACES_MONTHS_SEGMENTS, "people.html", facesMonthsMode);
    const u = data.undated;
    renderUndatedLink("faces-months-undated-link", u.full + u.partial + u.none + u.no_faces, "people.html");
  } catch (e) {
    showError("card-faces-months", e.message);
  }
}

wireModeToggle("faces-months-mode-toggle", (mode) => {
  facesMonthsMode = mode;
  if (facesMonthsData) {
    renderMonthBars("faces-months-bar-container", facesMonthsData.months.slice().reverse(), FACES_MONTHS_SEGMENTS, "people.html", facesMonthsMode);
  }
});

/* ── Reverse-geocode backfill loop ── */
let backfillRunning = false;

async function runBackfill() {
  if (backfillRunning) return;
  backfillRunning = true;
  const btn = document.getElementById("backfill-btn");
  btn.disabled = true;
  try {
    let remaining = Infinity;
    while (remaining > 0) {
      const res = await fetch("/api/geocode/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 1000 }),
      });
      if (res.status === 503) {
        document.getElementById("reverse-geocode-hint").style.display = "";
        document.getElementById("reverse-geocode-hint").textContent =
          "GeoNames data not installed — run scripts/get_geonames.py";
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      remaining = data.remaining;
      btn.textContent = remaining > 0 ? `Backfilling… ${remaining.toLocaleString()} left` : "Run backfill";
    }
  } catch (e) {
    showError("card-reverse-geocode", e.message);
  } finally {
    backfillRunning = false;
    btn.textContent = "Run backfill";
    await loadSummary();
  }
}

/* ── Face-detection loop ── */
let facesScanRunning = false;
let facesScanStopRequested = false;

async function runFacesScan() {
  if (facesScanRunning) return;
  facesScanRunning = true;
  facesScanStopRequested = false;
  const btn = document.getElementById("detect-faces-btn");
  const stopBtn = document.getElementById("detect-faces-stop-btn");
  btn.disabled = true;
  stopBtn.style.display = "";
  try {
    let remaining = Infinity;
    while (remaining > 0 && !facesScanStopRequested) {
      const res = await fetch("/api/faces/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 50 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      remaining = data.remaining;
      btn.textContent = remaining > 0 ? `Scanning… ${remaining.toLocaleString()} left` : "Detect faces";
    }
  } catch (e) {
    showError("card-faces", e.message);
  } finally {
    facesScanRunning = false;
    stopBtn.style.display = "none";
    btn.disabled = false;
    btn.textContent = "Detect faces";
    await loadSummary();
    await loadFaceCoverage();
    await loadFacesMonths();
  }
}

document.getElementById("backfill-btn").addEventListener("click", runBackfill);
document.getElementById("detect-faces-btn").addEventListener("click", runFacesScan);

/* ── Representative-face recompute (one-shot, no batching needed) ── */
async function runDedupRecompute() {
  const btn = document.getElementById("dedup-recompute-btn");
  const stats = document.getElementById("dedup-stats");
  btn.disabled = true;
  btn.textContent = "Recomputing…";
  try {
    const res = await fetch("/api/faces/dedup/recompute", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const totalFaces = data.persons.reduce((sum, p) => sum + p.total, 0);
    const totalReps = data.persons.reduce((sum, p) => sum + p.representative, 0);
    stats.textContent = data.persons.length
      ? `${data.persons.length} people processed: ${totalFaces.toLocaleString()} labeled faces -> ${totalReps.toLocaleString()} representatives`
      : "No one has enough labeled faces yet (see Settings for the threshold).";
  } catch (e) {
    showError("card-faces", e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Recompute representative faces";
  }
}

document.getElementById("dedup-recompute-btn").addEventListener("click", runDedupRecompute);
document.getElementById("detect-faces-stop-btn").addEventListener("click", () => {
  facesScanStopRequested = true;
});

loadSummary();
loadFaceCoverage();
loadMonths();
loadFacesMonths();
