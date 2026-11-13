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
let selectedLocation = null;
let resetLocationPicker = () => {};

/* Date range control (date-range-picker.js). Applying a range only stages it —
 * the page keeps its explicit Search button, so nothing re-queries until the
 * user asks, matching every other filter in this form. */
let dateRangePicker = null;

function wireDateRangePicker() {
  dateRangePicker = createDateRangePicker({ root: document.getElementById("date-range") });
}

function wireUndatedOnlyCheckbox() {
  document.getElementById("undated-only-checkbox").addEventListener("change", (e) => {
    document.getElementById("date-range").classList.toggle("disabled", e.target.checked);
  });
}

function wireLocationPicker() {
  const help = document.getElementById("location-help");
  const picker = createLocationPicker({
    input: document.getElementById("location-input"),
    box: document.getElementById("location-suggest"),
    emptyMessage: "No saved or recorded locations match. Search will use your text.",
    errorMessage: "Could not load locations. Type to retry, or search photo location text.",
    onSelect(item) {
      selectedLocation = item;
      document.getElementById("nearby-field").hidden = item.kind !== "place";
      document.getElementById("nearby-select").value = "0";
      help.textContent = item.kind === "place"
        ? "Matches photo GPS coordinates within this saved area."
        : "Matches this location and its region in photo metadata.";
    },
    onEdit() { resetLocationPicker(); },
  });
  resetLocationPicker = () => {
    selectedLocation = null;
    document.getElementById("nearby-field").hidden = true;
    document.getElementById("nearby-select").value = "0";
    help.textContent = "Choose a place or search photo location text.";
    picker.close();
  };
}

let resultsMode = "photos";     // "photos" (plain grid) | "untagged" (candidate cards)
let untaggedCandidates = [];    // last /api/search/untagged-faces candidates

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

/* ── Camera / folder facets ── */

async function loadCameraFacet() {
  try {
    const res = await fetch("/api/search/cameras");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { cameras } = await res.json();
    const select = document.getElementById("camera-select");
    cameras.forEach((cam) => {
      const opt = document.createElement("option");
      opt.value = cam;
      opt.textContent = cam;
      select.appendChild(opt);
    });
  } catch (e) {
    // Facet is a convenience; leave it at "Any" if it can't load.
  }
}

async function loadFolderFacet() {
  try {
    const res = await fetch("/api/photos/dirs?limit=5000");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dirs = await res.json();
    const select = document.getElementById("folder-select");
    dirs.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.dir;
      opt.textContent = d.dir;
      select.appendChild(opt);
    });
  } catch (e) {
    // Same as above — the rest of the form still works without it.
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
  refreshHandoffUI();
  const untaggedField = document.getElementById("untagged-field");
  const untaggedBtn = document.getElementById("untagged-btn");
  if (selectedPersons.length === 0) {
    untaggedField.style.display = "none";
  } else if (selectedPersons.length === 1) {
    untaggedField.style.display = "";
    untaggedBtn.textContent = `🔎 Find untagged faces of ${selectedPersons[0].name}`;
  } else {
    untaggedField.style.display = "";
    untaggedBtn.textContent = "🔎 Find where they appear together (untagged)";
  }
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
  const undatedOnly = document.getElementById("undated-only-checkbox").checked;
  const { from: dateFrom, to: dateTo } = undatedOnly ? {} : dateRangePicker.getRange();
  const location = document.getElementById("location-input").value.trim();
  const geotagged = document.getElementById("geotagged-select").value;
  const personMode = document.getElementById("person-mode-select").value;
  const camera = document.getElementById("camera-select").value;
  const folder = document.getElementById("folder-select").value;
  const gpsAccuracy = document.getElementById("gps-accuracy-select").value;
  const hasFaces = document.getElementById("has-faces-select").value;
  const sort = document.getElementById("sort-select").value;
  const text = document.getElementById("text-input").value.trim();

  // A typed description wins over a pending "More like this" — they're two
  // different queries for the same ranking slot (the API rejects both at once).
  if (text) params.set("text", text);
  else if (similarTo) params.set("similar_to", similarTo.id);
  if (undatedOnly) {
    params.set("undated", "true");
  } else {
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (dateFrom && dateTo && dateFrom > dateTo) throw new Error("From date must be on or before To date.");
  }
  if (selectedLocation?.kind === "place") {
    params.set("place_id", selectedLocation.id);
    const nearbyMiles = Number(document.getElementById("nearby-select").value);
    params.set("nearby_m", nearbyMiles * 1609.34);
  } else if (selectedLocation?.kind === "metadata") {
    params.set("location_fields", JSON.stringify(selectedLocation.fields));
  } else if (location) params.set("location", location);
  if (geotagged !== "all") params.set("geotagged", geotagged);
  if (camera) params.set("camera", camera);
  if (folder) params.set("dir", folder);
  if (gpsAccuracy !== "all") params.set("gps_accuracy", gpsAccuracy);
  if (hasFaces !== "all") params.set("has_faces", hasFaces);
  // "Best match" only means something with a ranking query; without one, fall
  // back to the API's date default rather than sending a sort it would reject.
  if (sort === "relevance") {
    if (params.has("text") || params.has("similar_to")) params.set("sort", sort);
  } else if (sort !== "date_asc" || params.has("text") || params.has("similar_to")) {
    params.set("sort", sort);
  }
  if (selectedPersons.length > 0) {
    params.set("person_ids", selectedPersons.map((p) => p.id).join(","));
    params.set("person_mode", personMode);
  }
  return params;
}

async function runSearch() {
  const grid = document.getElementById("grid");
  const summary = document.getElementById("search-summary");
  resultsMode = "photos";
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
    if (!res.ok) {
      // 409/400 carry a human-readable reason (model not downloaded, photo not
      // indexed yet) — show it instead of a bare status code.
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    resultPhotos = data.photos;
    rankedResults = params.has("text") || params.has("similar_to");
    rankedBySort = rankedResults && (params.get("sort") || "relevance") === "relevance";
    buildHistogram();
    renderGrid();
    const what = params.has("similar_to") ? ` similar to ${similarTo.filename}` : "";
    summary.textContent = `${data.total.toLocaleString()} photo${data.total === 1 ? "" : "s"} found${what}`;
    refreshHandoffUI();
    setStatus("");
    if (rankedResults) await noteIndexCoverage();
  } catch (e) {
    setStatus(`Search failed: ${e.message}`, true);
  }
}

/* ── Text search ("describe the photo") + More like this ── */

// Photo picked via "More like this" — {id, filename} — until text is typed or Clear.
let similarTo = null;
let rankedResults = false;  // last results came from a text/similar query (have .score)
let rankedBySort = false;   // ...and are ordered by score, so don't month-group them

// Warn when results are partial because indexing hasn't finished; silent otherwise.
async function noteIndexCoverage() {
  try {
    const res = await fetch("/api/semantic/status");
    if (!res.ok) return;
    const s = await res.json();
    if (s.remaining > 0) {
      setStatus(`${s.remaining.toLocaleString()} photos aren't indexed for text search yet — results are partial. Index them from Data Management.`);
    }
  } catch { /* status is a hint only */ }
}

function onTextInput() {
  const text = document.getElementById("text-input").value.trim();
  const sortSel = document.getElementById("sort-select");
  if (text) {
    similarTo = null;
    if (sortSel.value === "date_asc") sortSel.value = "relevance";
  } else if (!similarTo && sortSel.value === "relevance") {
    sortSel.value = "date_asc";
  }
}

function searchSimilar() {
  const photo = resultPhotos.find((p) => p.id === focusedPhotoId);
  if (focusedPhotoId == null) return;
  similarTo = { id: focusedPhotoId, filename: photo?.filename || `photo ${focusedPhotoId}` };
  document.getElementById("text-input").value = "";
  document.getElementById("sort-select").value = "relevance";
  runSearch();
}

/* ── Handoff: send the current results into Geocode or People, so Search can
 * act as the selection tool for the rest of the app instead of a dead end. ── */

function refreshHandoffUI() {
  const group = document.getElementById("handoff-group");
  const peopleBtn = document.getElementById("open-people-btn");
  group.style.display = resultsMode === "photos" && resultPhotos.length > 0 ? "" : "none";
  peopleBtn.style.display = selectedPersons.length === 1 ? "" : "none";
}

function openInGeocode() {
  const ids = (selectedIds.size > 0 ? [...selectedIds] : filteredPhotos.map((p) => p.id));
  if (!ids.length) return;
  window.location.href = `/geocode.html?ids=${ids.join(",")}`;
}

function openInPeople() {
  if (selectedPersons.length !== 1) return;
  window.location.href = `/people.html?person=${selectedPersons[0].id}`;
}

/* ── Untagged-face search: candidates where the searched people appear via an
 * untagged near-match face, not yet a plain-search hit. ── */

async function runUntaggedSearch() {
  const grid = document.getElementById("grid");
  const summary = document.getElementById("search-summary");
  resultsMode = "untagged";
  setStatus("Scanning for untagged faces…");
  summary.textContent = "";
  grid.innerHTML = "";
  document.getElementById("timeline").style.display = "none";
  selectedIds.clear();
  lastClickedIndex = -1;
  refreshSelectionUI();
  showPlaceholder();
  try {
    const params = buildQuery();
    const res = await fetch(`/api/search/untagged-faces?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    untaggedCandidates = data.candidates;
    renderUntaggedGrid();
    summary.textContent = `${data.total.toLocaleString()} photo${data.total === 1 ? "" : "s"} found`;
    setStatus(data.warnings && data.warnings.length ? data.warnings.join(" ") : "", !!(data.warnings && data.warnings.length));
  } catch (e) {
    setStatus(`Search failed: ${e.message}`, true);
  }
}

// A face cell in the "normal" People-page style: crop + an overlaid chip —
// a green ✓ suggestion (click confirms, ✕ rejects) or a plain name label for
// an already-tagged face. Mirrors people.js's makeFaceCell/makeSuggestChip,
// trimmed to what this page needs (no multi-select, no ignored/come-back
// faces — the search never surfaces those).
function makeSearchFaceCell(face) {
  const cell = document.createElement("div");
  cell.className = "thumb-cell search-face-cell";
  cell.appendChild(faceCropImg(face));

  if (face.person_name) {
    const label = document.createElement("div");
    label.className = "face-label";
    label.textContent = face.person_name;
    cell.appendChild(label);
  } else if (face.suggestion) {
    cell.appendChild(makeSearchSuggestChip(face));
  }

  cell.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openSearchFaceActions(cell, face);
  });
  return cell;
}

function makeSearchSuggestChip(face) {
  const chip = document.createElement("div");
  chip.className = "face-suggest";
  chip.title = `Click to confirm: ${face.suggestion.person_name} (${face.suggestion.score.toFixed(2)})`;
  chip.innerHTML =
    `<span class="sug-check">✓</span>` +
    `<span class="sug-name">${escapeHtml(face.suggestion.person_name)}?</span>` +
    `<span class="sug-reject" title="Not ${escapeHtml(face.suggestion.person_name)}">✕</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest(".sug-reject")) {
      rejectSearchSuggestion(face.id, face.suggestion.person_id, face.suggestion.person_name);
      return;
    }
    assignSearchFace(face.id, face.suggestion.person_id);
  });
  return chip;
}

function makeSearchFaceWrap(face) {
  const wrap = document.createElement("div");
  wrap.className = "untagged-face-wrap";
  wrap.appendChild(makeSearchFaceCell(face));
  return wrap;
}

function makeUntaggedRow(candidate) {
  const { photo, tagged, proposed } = candidate;
  const row = document.createElement("div");
  row.className = "photo-row";

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "photo-row-thumb-wrap";

  const thumbCell = document.createElement("div");
  thumbCell.className = "thumb-cell photo-row-thumb" +
    (photo.lat != null ? " tagged" : "") +
    (photo.geocode_ignored ? " geo-ignored" : "");
  thumbCell.title = photo.filename;
  const img = document.createElement("img");
  img.src = `/api/thumbnail/${photo.id}`;
  img.loading = "lazy";
  img.alt = photo.filename;
  thumbCell.appendChild(img);
  thumbCell.addEventListener("click", () => showDetail(photo.id));
  thumbWrap.appendChild(thumbCell);

  const loc = locationKey(photo);
  if (loc) {
    const locEl = document.createElement("div");
    locEl.className = "photo-row-loc";
    locEl.textContent = loc;
    thumbWrap.appendChild(locEl);
  }
  row.appendChild(thumbWrap);

  const facesWrap = document.createElement("div");
  facesWrap.className = "photo-row-faces";
  tagged.forEach((t) => facesWrap.appendChild(makeSearchFaceWrap({
    id: t.face_id, photo_id: photo.id, person_name: t.person_name, suggestion: null,
  })));
  proposed.forEach((p) => facesWrap.appendChild(makeSearchFaceWrap({
    id: p.face_id, photo_id: photo.id, person_name: null,
    suggestion: { person_id: p.person_id, person_name: p.person_name, score: p.score },
  })));
  row.appendChild(facesWrap);

  return row;
}

// Group candidates by calendar year/month (undated last), mirroring renderGrid.
function groupCandidatesByMonth(candidates) {
  const sorted = candidates.slice().sort((a, b) =>
    (a.photo.photo_datetime || Infinity) - (b.photo.photo_datetime || Infinity));
  const groups = [];
  let cur = null;
  sorted.forEach((c) => {
    let year = null, month = null;
    if (c.photo.photo_datetime) {
      const d = new Date(c.photo.photo_datetime * 1000);
      year = d.getFullYear();
      month = d.getMonth();
    }
    if (!cur || cur.year !== year || cur.month !== month) {
      cur = { year, month, candidates: [] };
      groups.push(cur);
    }
    cur.candidates.push(c);
  });
  return groups;
}

function renderUntaggedGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  if (untaggedCandidates.length === 0) {
    grid.innerHTML = `<div class="person-suggest-empty" style="grid-column:1/-1;padding:24px;text-align:center">No untagged-face candidates found.</div>`;
    return;
  }
  const groups = groupCandidatesByMonth(untaggedCandidates);
  groups.forEach((group, groupIdx) => {
    const sec = document.createElement("div");
    sec.className = `face-group-section group-tint-${groupIdx % 6}`;

    const title = group.year != null
      ? `${MONTH_NAMES[group.month]} ${group.year}`
      : "Undated";
    const count = group.candidates.length;
    const proposedCount = group.candidates.reduce((n, c) => n + c.proposed.length, 0);
    sec.appendChild(faceGroupHeader({
      title,
      meta: `· ${count} photo${count !== 1 ? "s" : ""}`,
      buttons: proposedCount ? [
        { icon: "✓", label: `Confirm all (${proposedCount})`, kind: "primary",
          title: "Confirm every suggested face in this group",
          onClick: () => confirmGroupSuggestions(group) },
        { icon: "🚫", label: `Ignore all (${proposedCount})`, kind: "danger",
          title: "Ignore every suggested (untagged) face in this group",
          onClick: () => ignoreGroupSuggestions(group) },
      ] : [],
    }));

    const rows = document.createElement("div");
    rows.className = "untagged-rows";
    group.candidates.forEach((c) => rows.appendChild(makeUntaggedRow(c)));
    sec.appendChild(rows);
    grid.appendChild(sec);
  });
}

// Standard face quick-action menu (assign/reassign/ignore/come-back/reject),
// same popup used on People/Crowd Review/Quick Tag (face-grid.js). Actions
// patch `untaggedCandidates` locally and re-render (no re-fetch) so the
// visible groups don't reshuffle mid-tagging — re-run the search explicitly
// to pick up new candidates.
function openSearchFaceActions(anchor, face) {
  openQuickActions(anchor, face, {
    persons: allPersons,
    onAssign: (pid) => assignSearchFace(face.id, pid),
    onAssignNew: async (name) => {
      try {
        const res = await fetch(`/api/faces/${face.id}/assign`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        await loadPersons();
        markFaceAssigned(face.id, data.person_id, personNameById(data.person_id));
        renderUntaggedGrid();
      } catch (err) { setStatus("Assign failed: " + err.message, true); }
    },
    onIgnore: async (ignored) => {
      try {
        const res = await fetch("/api/faces/ignore", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ face_ids: [face.id], ignored }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (ignored) removeFaceFromCandidates(face.id);
        renderUntaggedGrid();
      } catch (err) { setStatus("Ignore failed: " + err.message, true); }
    },
    onComeBack: async (comeBack) => {
      try {
        const res = await fetch("/api/faces/come-back", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ face_ids: [face.id], come_back: comeBack }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (comeBack) removeFaceFromCandidates(face.id);
        renderUntaggedGrid();
      } catch (err) { setStatus("Come back failed: " + err.message, true); }
    },
    onNotPerson: (personId, personName) => rejectSearchSuggestion(face.id, personId, personName),
    onNotPersonAll: (personId, personName) => rejectSearchSuggestionAll(personId, personName),
    onOpenPhoto: () => window.open(`/api/preview/${face.photo_id}`, "_blank"),
  });
}

function personNameById(personId) {
  const p = allPersons.find((p) => p.id === personId);
  return p ? p.name : null;
}

// Local-only edits to `untaggedCandidates` after a tagging action, so the
// results list doesn't reshuffle/refetch mid-session — the user re-runs the
// search explicitly when ready for the next batch. `renderUntaggedGrid()`
// (no fetch) is called by the caller after these to reflect the change.

function markFaceAssigned(faceId, personId, personName) {
  for (const c of untaggedCandidates) {
    const already = c.tagged.find((t) => t.face_id === faceId);
    if (already) { already.person_name = personName; return; }
    const idx = c.proposed.findIndex((p) => p.face_id === faceId);
    if (idx !== -1) {
      c.proposed.splice(idx, 1);
      c.tagged.push({ face_id: faceId, person_name: personName, person_id: personId });
      return;
    }
  }
}

function removeFaceFromCandidates(faceId) {
  for (const c of untaggedCandidates) {
    c.tagged = c.tagged.filter((t) => t.face_id !== faceId);
    c.proposed = c.proposed.filter((p) => p.face_id !== faceId);
  }
}

async function assignSearchFace(faceId, personId) {
  try {
    const res = await fetch(`/api/faces/${faceId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: personId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPersons();
    markFaceAssigned(faceId, personId, personNameById(personId));
    renderUntaggedGrid();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

// ── Group-level actions (the face-group-header buttons) ──
// Same "confirm all / ignore all" pattern as the People page's batch headers:
// act on every *proposed* (untagged) face across the group's photos, then
// re-run the search since assign/ignore can change which candidates qualify.

function groupSuggestionCount(group) {
  return group.candidates.reduce((n, c) => n + c.proposed.length, 0);
}

async function confirmGroupSuggestions(group) {
  const total = groupSuggestionCount(group);
  if (total === 0) return;
  if (total > 3 && !confirm(`Confirm ${total} suggested face(s) in this group?`)) return;
  const byPerson = {};
  group.candidates.forEach((c) => c.proposed.forEach((p) => {
    (byPerson[p.person_id] ||= []).push(p.face_id);
  }));
  try {
    for (const [pid, faceIds] of Object.entries(byPerson)) {
      const res = await fetch("/api/faces/assign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ face_ids: faceIds, person_id: parseInt(pid) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const name = personNameById(parseInt(pid));
      faceIds.forEach((fid) => markFaceAssigned(fid, parseInt(pid), name));
    }
    await loadPersons();
    renderUntaggedGrid();
  } catch (err) {
    setStatus("Confirm all failed: " + err.message, true);
  }
}

async function ignoreGroupSuggestions(group) {
  const faceIds = group.candidates.flatMap((c) => c.proposed.map((p) => p.face_id));
  if (faceIds.length === 0) return;
  if (faceIds.length > 3 && !confirm(`Ignore ${faceIds.length} suggested face(s) in this group?`)) return;
  try {
    const res = await fetch("/api/faces/ignore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: faceIds, ignored: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    faceIds.forEach((fid) => removeFaceFromCandidates(fid));
    renderUntaggedGrid();
  } catch (err) {
    setStatus("Ignore all failed: " + err.message, true);
  }
}

// Mark a face as "definitely not this person" — same semantics as the People
// page's rejectSuggestion (drops the person from that face's ranking so the
// next-best guess surfaces instead of bouncing back to the same rejection).
async function rejectSearchSuggestion(faceId, personId, personName) {
  try {
    const res = await fetch("/api/faces/negatives", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: [faceId], person_id: personId, negative: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Marked as not ${personName}.`);
    removeFaceFromCandidates(faceId);
    renderUntaggedGrid();
  } catch (err) {
    setStatus("Reject failed: " + err.message, true);
  }
}

// Sweep the whole visible batch: every proposed (untagged) face across the
// rendered candidates that this person is suggested for gets the same negative.
// One /negatives call for the lot — the endpoint takes a face_ids list.
async function rejectSearchSuggestionAll(personId, personName) {
  const faceIds = [];
  for (const c of untaggedCandidates) {
    for (const p of c.proposed) {
      if (p.person_id === personId) faceIds.push(p.face_id);
    }
  }
  if (!faceIds.length) { setStatus(`No faces suggested as ${personName}.`, true); return; }
  if (!confirm(`Mark ${faceIds.length} face(s) as definitely NOT ${personName}? ` +
               `They will stop being suggested as ${personName} and fall through ` +
               `to their next-best match.`)) return;
  try {
    const res = await fetch("/api/faces/negatives", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: faceIds, person_id: personId, negative: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Marked ${faceIds.length} face(s) as not ${personName}.`);
    // One pass over the candidates rather than removeFaceFromCandidates() per
    // id — that's O(candidates) each, and this batch can be hundreds of faces.
    const gone = new Set(faceIds);
    for (const c of untaggedCandidates) {
      c.proposed = c.proposed.filter((p) => !gone.has(p.face_id));
    }
    renderUntaggedGrid();
  } catch (err) {
    setStatus("Reject failed: " + err.message, true);
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
  if (photo.score != null) {
    // Raw cosine, not a percentage: SigLIP text scores sit around 0.10–0.15 for
    // good matches, so a "%" would read as uniformly terrible.
    const badge = document.createElement("div");
    badge.className = "thumb-score";
    badge.textContent = photo.score.toFixed(3);
    badge.title = "Match score (higher = closer to the description)";
    cell.appendChild(badge);
  }

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

  if (rankedBySort) {
    // Score order is the point — month buckets would scatter the best matches.
    const sec = document.createElement("div");
    sec.className = "face-group-section group-tint-0";
    sec.appendChild(faceGroupHeader({
      title: similarTo && !document.getElementById("text-input").value.trim()
        ? "Most similar" : "Best matches",
      meta: `· ${photos.length} photo${photos.length !== 1 ? "s" : ""}, best first`,
    }));
    const cells = document.createElement("div");
    cells.className = "face-group-cells";
    photos.forEach((photo, idx) => cells.appendChild(makeThumbCell(photo, idx)));
    sec.appendChild(cells);
    grid.appendChild(sec);
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

/* ── Select all ── */

function selectAllResults() {
  const source = filteredPhotos.length > 0 ? filteredPhotos : resultPhotos;
  selectedIds = new Set(source.map((p) => p.id));
  refreshSelectionUI();
}

/* ── Assign approximate date ── */

function openAssignDateModal() {
  if (selectedIds.size === 0) return;
  document.getElementById("assign-date-summary").textContent =
    `Assigning an approximate date to ${selectedIds.size} selected photo${selectedIds.size === 1 ? "" : "s"}.`;
  document.getElementById("assign-date-year").value = "";
  document.getElementById("assign-date-month").value = "";
  document.getElementById("assign-date-modal").style.display = "flex";
}

function closeAssignDateModal() {
  document.getElementById("assign-date-modal").style.display = "none";
}

async function applyAssignDate() {
  const yearStr = document.getElementById("assign-date-year").value;
  const monthStr = document.getElementById("assign-date-month").value;
  const year = parseInt(yearStr);
  if (!yearStr || isNaN(year)) {
    alert("Please enter a year");
    return;
  }
  const month = monthStr ? parseInt(monthStr) : null;
  const ids = [...selectedIds];

  const precisionLabel = month
    ? `${MONTH_NAMES[month - 1]} ${year}`
    : `${year} (year only)`;
  if (!confirm(`Assign approximate date "${precisionLabel}" to ${ids.length} photo(s)? `
             + `This overwrites any existing date on these photos.`)) {
    return;
  }

  const btn = document.getElementById("assign-date-apply-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/photos/assign-date", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: ids, year, month }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${res.status}`);
    }
    const result = await res.json();
    closeAssignDateModal();
    setStatus(`Assigned approximate date to ${result.updated} photo(s).`);
    await runSearch();
  } catch (e) {
    setStatus(`Assign date failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/* ── Guess dates from filename/folder, staged for review before committing ── */

let stagedGuesses = [];       // [{photo_id, filename, guess}] from the last guess-dates fetch
let lastCommitPrevious = null; // opaque snapshot from the last commit, for Undo

function formatGuessLabel(guess) {
  if (!guess) return "No date found";
  if (guess.precision === "year") return `~${guess.year}`;
  if (guess.precision === "month") return `~${MONTH_NAMES[guess.month - 1]} ${guess.year}`;
  return `${MONTH_NAMES[guess.month - 1]} ${guess.day}, ${guess.year}`;
}

async function openGuessDatesModal() {
  if (selectedIds.size === 0) return;
  const modal = document.getElementById("guess-dates-modal");
  const tbody = document.getElementById("guess-dates-tbody");
  document.getElementById("guess-dates-summary").textContent =
    `Checking filenames and folder names for ${selectedIds.size} selected photo(s)…`;
  tbody.innerHTML = "";
  modal.style.display = "flex";

  try {
    const res = await fetch("/api/photos/guess-dates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: [...selectedIds] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    stagedGuesses = data.guesses;
    const found = stagedGuesses.filter((g) => g.guess).length;
    document.getElementById("guess-dates-summary").textContent =
      `Found a guess for ${found} of ${stagedGuesses.length} photo(s). Review, uncheck any you don't `
      + `want, then Commit. Photos with no guess are skipped.`;
    renderGuessDatesTable();
  } catch (e) {
    document.getElementById("guess-dates-summary").textContent = `Failed to guess dates: ${e.message}`;
  }
}

function renderGuessDatesTable() {
  const tbody = document.getElementById("guess-dates-tbody");
  tbody.innerHTML = stagedGuesses.map((row, i) => {
    const hasGuess = !!row.guess;
    return `
      <tr class="${hasGuess ? "" : "no-guess"}">
        <td><input type="checkbox" data-idx="${i}" ${hasGuess ? "checked" : "disabled"}/></td>
        <td>${escapeHtml(row.filename)}</td>
        <td>${escapeHtml(formatGuessLabel(row.guess))}</td>
        <td class="guess-source">${row.guess ? row.guess.source : ""}</td>
      </tr>`;
  }).join("");
}

function closeGuessDatesModal() {
  document.getElementById("guess-dates-modal").style.display = "none";
}

async function commitGuessDates() {
  const checked = [...document.querySelectorAll("#guess-dates-tbody input[type=checkbox]:checked")]
    .map((cb) => stagedGuesses[Number(cb.dataset.idx)]);
  if (checked.length === 0) {
    alert("No guesses selected to commit");
    return;
  }
  const entries = checked.map((row) => ({
    photo_id: row.photo_id, year: row.guess.year, month: row.guess.month,
    day: row.guess.day, precision: row.guess.precision,
  }));

  const btn = document.getElementById("guess-dates-commit-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/photos/commit-guessed-dates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    closeGuessDatesModal();
    lastCommitPrevious = result.previous;
    document.getElementById("date-undo-count").textContent =
      `Committed ${result.updated} guessed date(s).`;
    document.getElementById("date-undo-group").style.display = "";
    setStatus(`Committed ${result.updated} guessed date(s).`);
    await runSearch();
  } catch (e) {
    setStatus(`Commit failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function undoDateCommit() {
  if (!lastCommitPrevious) return;
  const btn = document.getElementById("date-undo-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/photos/undo-date-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previous: lastCommitPrevious }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    lastCommitPrevious = null;
    document.getElementById("date-undo-group").style.display = "none";
    setStatus(`Reverted ${result.reverted} date(s).`);
    await runSearch();
  } catch (e) {
    setStatus(`Undo failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
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
  dateRangePicker.clear();
  document.getElementById("undated-only-checkbox").checked = false;
  document.getElementById("date-range").classList.remove("disabled");
  document.getElementById("location-input").value = "";
  resetLocationPicker();
  document.getElementById("geotagged-select").value = "all";
  document.getElementById("person-mode-select").value = "all";
  document.getElementById("camera-select").value = "";
  document.getElementById("folder-select").value = "";
  document.getElementById("gps-accuracy-select").value = "all";
  document.getElementById("has-faces-select").value = "all";
  document.getElementById("sort-select").value = "date_asc";
  document.getElementById("text-input").value = "";
  similarTo = null;
  selectedPersons = [];
  renderPersonChips();
  updatePersonModeVisibility();
  resultsMode = "photos";
  resultPhotos = [];
  filteredPhotos = [];
  untaggedCandidates = [];
  histBuckets = [];
  document.getElementById("timeline").style.display = "none";
  document.getElementById("handoff-group").style.display = "none";
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
document.getElementById("text-input").addEventListener("input", onTextInput);
document.getElementById("text-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runSearch(); }
});
document.getElementById("similar-btn").addEventListener("click", searchSimilar);
document.getElementById("untagged-btn").addEventListener("click", runUntaggedSearch);
document.getElementById("clear-btn").addEventListener("click", clearForm);
document.getElementById("download-selected-btn").addEventListener("click", downloadSelected);
document.getElementById("clear-selection-btn").addEventListener("click", clearSelection);
document.getElementById("open-geocode-btn").addEventListener("click", openInGeocode);
document.getElementById("open-people-btn").addEventListener("click", openInPeople);
document.getElementById("select-all-btn").addEventListener("click", selectAllResults);
document.getElementById("assign-date-btn").addEventListener("click", openAssignDateModal);
document.getElementById("assign-date-close").addEventListener("click", closeAssignDateModal);
document.getElementById("assign-date-cancel-btn").addEventListener("click", closeAssignDateModal);
document.getElementById("assign-date-apply-btn").addEventListener("click", applyAssignDate);
document.getElementById("guess-dates-btn").addEventListener("click", openGuessDatesModal);
document.getElementById("guess-dates-close").addEventListener("click", closeGuessDatesModal);
document.getElementById("guess-dates-cancel-btn").addEventListener("click", closeGuessDatesModal);
document.getElementById("guess-dates-commit-btn").addEventListener("click", commitGuessDates);
document.getElementById("date-undo-btn").addEventListener("click", undoDateCommit);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement &&
      document.activeElement.id !== "person-picker-input") {
    runSearch();
  }
});

/* ── Deep link: ?place_id=N ──
 * The Custom Places page links here to answer "show me the photos this place
 * stands for". Filling the picker's state by hand rather than driving the
 * autocomplete: the place is already chosen, and typing into the box would just
 * reopen a suggestion list over the results. */
async function applyPlaceIdFromUrl() {
  const placeId = Number(new URLSearchParams(location.search).get("place_id"));
  if (!placeId) return;
  try {
    const res = await fetch("/api/places");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const place = (await res.json()).find(p => p.id === placeId);
    if (!place) { setStatus("That saved place no longer exists.", true); return; }
    selectedLocation = { kind: "place", id: place.id, label: place.name };
    document.getElementById("location-input").value = place.name;
    document.getElementById("nearby-field").hidden = false;
    document.getElementById("nearby-select").value = "0";
    document.getElementById("location-help").textContent =
      "Matches photo GPS coordinates within this saved area.";
    runSearch();
  } catch (e) {
    setStatus("Could not open that saved place: " + e.message, true);
  }
}

wirePersonPicker();
wireLocationPicker();
wireDateRangePicker();
wireUndatedOnlyCheckbox();
loadPersons();
loadCameraFacet();
loadFolderFacet();
bindTimeline();
applyPlaceIdFromUrl();
