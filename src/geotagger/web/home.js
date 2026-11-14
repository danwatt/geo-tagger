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
    renderPeople(data.people);
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

const NO_GEOCODE_DATA_HINT =
  "No place data installed — add GeoNames, US Census places or OSM places on the Data page";

function renderReverseGeocode(geocode) {
  const btn = document.getElementById("backfill-btn");
  const hint = document.getElementById("reverse-geocode-hint");
  document.getElementById("reverse-geocode-stats").textContent =
    `${geocode.geocoded.toLocaleString()} geocoded · ${geocode.pending.toLocaleString()} pending`;
  // any_available, not available: the latter is GeoNames alone, and an OSM- or
  // Census-only install geocodes too.
  if (!geocode.any_available) {
    hint.style.display = "";
    hint.textContent = NO_GEOCODE_DATA_HINT;
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
  // Photos whose file couldn't be read sit out of the queue until "Retry failed".
  const failed = faces.failed_photos || 0;
  const failedEl = document.getElementById("faces-failed");
  failedEl.style.display = failed ? "" : "none";
  failedEl.textContent = failed ? `${failed.toLocaleString()} photos couldn't be read for face detection` : "";
  document.getElementById("faces-retry-failed-btn").style.display =
    failed && !facesScanRunning ? "" : "none";
}

function renderPeople(people) {
  document.getElementById("people-stats").textContent =
    `${people.persons.toLocaleString()} people · ${people.families.toLocaleString()} families`;
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
  let errorMsg = null;
  try {
    let remaining = Infinity;
    const checkProgress = stallGuard("Backfill");
    while (remaining > 0) {
      const res = await fetch("/api/geocode/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 1000 }),
      });
      if (res.status === 503) {
        document.getElementById("reverse-geocode-hint").style.display = "";
        document.getElementById("reverse-geocode-hint").textContent = NO_GEOCODE_DATA_HINT;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      remaining = data.remaining;
      checkProgress(remaining);
      btn.textContent = remaining > 0 ? `Backfilling… ${remaining.toLocaleString()} left` : "Run backfill";
    }
  } catch (e) {
    errorMsg = e.message;
  } finally {
    backfillRunning = false;
    btn.textContent = "Run backfill";
    await loadSummary();
    // Shown after loadSummary, which clears the card's error when it succeeds —
    // shown before it, the failure flashed and vanished.
    if (errorMsg) showError("card-reverse-geocode", errorMsg);
  }
}

/* ── Face-detection loop ── */
let facesScanRunning = false;
let facesScanStopRequested = false;

// A 503 from the scan means the server aborted the batch with nothing marked (the
// model failed, or a long run of unreadable files): detail is {code, message,
// errors}. The loop stops on it — or, for the consecutive-failure guard
// ("too_many_failures"), asks whether those files really are bad.
async function scanError(res) {
  const body = await res.json().catch(() => null);
  const d = body?.detail;
  if (d && typeof d === "object") {
    return { code: d.code, message: d.message, sample: (d.errors || []).slice(0, 5).join("\n") };
  }
  return { code: null, message: d || `HTTP ${res.status}`, sample: "" };
}

async function runFacesScan() {
  if (facesScanRunning) return;
  facesScanRunning = true;
  facesScanStopRequested = false;
  const btn = document.getElementById("detect-faces-btn");
  const stopBtn = document.getElementById("detect-faces-stop-btn");
  btn.disabled = true;
  stopBtn.style.display = "";
  document.getElementById("faces-retry-failed-btn").style.display = "none";
  clearError("card-faces");
  let errorMsg = null;
  try {
    let remaining = Infinity;
    let allowFailures = false;
    const checkProgress = stallGuard("Face detection");
    while (remaining > 0 && !facesScanStopRequested) {
      const res = await fetch("/api/faces/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 50, allow_failures: allowFailures }),
      });
      allowFailures = false;   // the override covers one batch, never the rest of the walk
      if (!res.ok) {
        const err = await scanError(res);
        if (err.code === "too_many_failures" &&
            confirm(`${err.message}\n\n${err.sample}\n\n` +
                    "If these files really are unreadable, mark them as failed and keep scanning?")) {
          allowFailures = true;
          continue;
        }
        throw new Error(err.message);
      }
      const data = await res.json();
      remaining = data.remaining;
      checkProgress(remaining);
      btn.textContent = remaining > 0 ? `Scanning… ${remaining.toLocaleString()} left` : "Detect faces";
    }
  } catch (e) {
    errorMsg = e.message;
  } finally {
    facesScanRunning = false;
    stopBtn.style.display = "none";
    btn.disabled = false;
    btn.textContent = "Detect faces";
    await loadSummary();
    await loadFaceCoverage();
    await loadFacesMonths();
    // Shown after loadSummary, which clears the card's error when it succeeds.
    if (errorMsg) showError("card-faces", errorMsg);
  }
}

async function retryFailedFaces() {
  const btn = document.getElementById("faces-retry-failed-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/faces/scan/retry-failed", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    await runFacesScan();
  } catch (e) {
    showError("card-faces", e.message);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("backfill-btn").addEventListener("click", runBackfill);
document.getElementById("detect-faces-btn").addEventListener("click", runFacesScan);
document.getElementById("faces-retry-failed-btn").addEventListener("click", retryFailedFaces);

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

/* ── Work queue ──
   "33,109 remaining" is not a task; a batch is. Read-only card: every row links
   into Geocode with the batch preloaded, nothing here writes. */
const WQ_PAGE = 20;
let wqKind = "all";
let wqOffset = 0;
let wqTotal = 0;

// Green when nearly every member has a time-neighbour vote, amber when it's a
// coin flip — the chip is what tells the user whether to expect one click or a
// map drag.
function confClass(confidence) {
  if (confidence >= 0.8) return "wq-conf good";
  if (confidence >= 0.4) return "wq-conf fair";
  return "wq-conf weak";
}

function makeBatchRow(b) {
  const row = document.createElement("div");
  row.className = "wq-row";

  const thumbs = b.sample_photo_ids
    .map((id) => `<img src="/api/thumbnail/${id}" loading="lazy" alt="">`)
    .join("");

  // A batch with votes promises a place; folders and undated runs say so plainly
  // rather than pretending the map step isn't coming.
  const meta = b.proposal
    ? `📍 ${escapeHtml(b.proposal.label)}` +
      `<span class="${confClass(b.confidence)}">● ${Math.round(b.confidence * 100)}% have a guess</span>`
    : `<span class="wq-noguess">${b.start_ts ? "no guess" : "no date · no guess"}</span>`;

  row.innerHTML =
    `<div class="wq-thumbs">${thumbs}</div>` +
    `<div class="wq-body">` +
      `<div class="wq-row-title">${escapeHtml(b.title)}</div>` +
      `<div class="wq-row-meta">${meta}</div>` +
    `</div>` +
    `<div class="wq-count">${b.count.toLocaleString()} photo${b.count === 1 ? "" : "s"}</div>` +
    `<a class="button primary" href="/geocode.html?batch=${encodeURIComponent(b.id)}">Open in Geocode</a>`;
  return row;
}

function renderWorkQueueTotals(data) {
  // batched_photos counts what the *listed* batches cover (a union, so a photo in
  // both a session and a folder isn't double-counted); the tail is called out so
  // this and "N remaining" above still add up.
  const tail = data.tail_photos
    ? `  (${data.tail_photos.toLocaleString()} more not worth batching)`
    : "";
  document.getElementById("wq-totals").textContent =
    `${data.total_batches.toLocaleString()} batch${data.total_batches === 1 ? "" : "es"} · ` +
    `${data.batched_photos.toLocaleString()} photos${tail}`;
}

// Latest-only (common.js): switching the kind tab mid-load (or Show more racing a
// tab switch) must not append the old kind's batches to the new list.
const loadWorkQueue = latestOnly(async (signal, append = false) => {
  const list = document.getElementById("wq-list");
  const more = document.getElementById("wq-more");
  if (!append) {
    wqOffset = 0;
    // The first build on a cold cache sweeps the whole library, so say so.
    // (U4) The old kind's rows go at once, so nothing stale stays clickable.
    list.innerHTML = '<div class="wq-status"><span class="spinner" aria-hidden="true"></span> Building the queue…</div>';
    more.style.display = "none";   // no "more" of a list that isn't loaded yet
  } else {
    // An append keeps the rows live; the button is the footer spinner (U4).
    more.disabled = true;
    more.innerHTML = '<span class="spinner" aria-hidden="true"></span> Loading…';
  }
  try {
    const res = await fetch(`/api/work-queue?limit=${WQ_PAGE}&offset=${wqOffset}&kind=${wqKind}`,
                            { signal });
    if (!res.ok) throw new Error(await httpErrorMessage(res));
    const data = await res.json();
    if (signal.aborted) return;
    clearError("card-geotag");
    if (!append) list.innerHTML = "";
    wqTotal = data.total_batches;
    data.batches.forEach((b) => list.appendChild(makeBatchRow(b)));
    wqOffset += data.batches.length;

    if (!wqOffset) {
      list.innerHTML = `<div class="wq-status">${
        data.total_photos ? "Nothing big enough to batch — use the month bars below."
                          : "Everything is tagged. 🎉"}</div>`;
    }
    renderWorkQueueTotals(data);
    more.style.display = wqOffset < wqTotal ? "" : "none";
    more.textContent = `Show ${Math.min(WQ_PAGE, wqTotal - wqOffset)} more`;
  } catch (e) {
    if (signal.aborted) return;
    if (!append) list.innerHTML = "";
    else more.textContent = `Show ${Math.min(WQ_PAGE, wqTotal - wqOffset)} more`;
    showError("card-geotag", e.message);
  } finally {
    // Every path re-enables it — a superseding full load hides it anyway.
    more.disabled = false;
  }
});

document.getElementById("wq-kinds").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.classList.contains("active")) return;
  document.getElementById("wq-kinds").querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b === btn));
  wqKind = btn.dataset.kind;
  loadWorkQueue();
});

document.getElementById("wq-more").addEventListener("click", () => loadWorkQueue(true));

/* Skipped batches — the list Geocode's Skip button writes. It lives in this
   browser's localStorage, so Home is the only place that can show how big it has
   grown and offer to forget it. */
function skippedBatchCount() {
  try {
    const raw = JSON.parse(localStorage.getItem(SKIPPED_BATCHES_KEY) || "[]");
    return Array.isArray(raw) ? raw.length : 0;
  } catch (e) {
    return 0;
  }
}

function renderClearSkipped() {
  const btn = document.getElementById("wq-clear-skipped");
  const n = skippedBatchCount();
  btn.style.display = n ? "" : "none";
  btn.textContent = `Clear skipped (${n})`;
}

document.getElementById("wq-clear-skipped").addEventListener("click", () => {
  try {
    localStorage.removeItem(SKIPPED_BATCHES_KEY);
  } catch (e) {
    // Nothing to do — the list is a convenience, not state anything depends on.
  }
  renderClearSkipped();
});

renderClearSkipped();

loadSummary();
loadWorkQueue();
loadFaceCoverage();
loadMonths();
loadFacesMonths();
