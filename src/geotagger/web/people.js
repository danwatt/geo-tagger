/* ── State ── */
let faces = [];                 // faces for the current scope
let persons = [];               // full [{id, name, face_count}] — dropdowns, lookups
let navPersons = [];            // people shown in the left nav (windowed under Focus)
let selectedIds = new Set();    // selected face ids
let lastClickedIndex = -1;
let focusedFaceId = null;

let scope = "unlabeled";        // "unlabeled" | "all" | "person"
let scopePersonId = null;       // when scope === "person"

let suggestedOnly = false;      // Unlabeled queue: hide faces with no guess
// Unlabeled queue: narrow the grid to faces whose *top* guess is one person.
// The filter is applied client-side over the loaded queue, so `unlabeledAll`
// keeps the full flattened list and `faces` is the filtered view actually shown.
let suggestFilterPersonId = null;               // person_id, or null for "all suggestions"
let unlabeledAll = [];                          // full loaded queue (master; drives the dropdown + filter)
let unlabeledMeta = { total: 0, returned: 0 };  // server counts for the loaded queue (status text)
let clusters = [];              // discovered groups (Discover view)
let crowdGroups = [];           // crowd photo groups (Crowds view)
let hideCompletedCrowds = true; // hide crowd photos with no unlabeled faces

let groupGapSeconds = 86400;    // event grouping gap in the guesses view (1 day)

// Focus: narrows the tagging/discovery surfaces (people list, Unlabeled,
// suggestions, Discover, Crowds) to one Context's time window. null = all time.
// The per-person / All / Recently-tagged views and the recognition gallery are
// unaffected — only the *candidates* shown are windowed. The "＋ in its area"
// checkbox additionally limits to photos inside the Context's polygon (spatial),
// off by default; the backend resolves the polygon from focusContextId.
let focusStartTs = null;        // epoch secs, or null
let focusEndTs = null;          // epoch secs, or null
let focusLabel = null;          // active Context's name (for status messages)
let focusContextId = null;      // active Context's id (drives the spatial Focus)
let focusSpatial = false;       // also limit to the active Context's polygon
let focusContexts = [];         // contexts that have a time component
let focusYears = [];            // distinct years present in the library, descending
const FOCUS_LS_KEY = "geotagger.people.focusContextId";
const FOCUS_SPATIAL_LS_KEY = "geotagger.people.focusSpatial";

const FACE_LIMIT = 1000;
// Auto-select bar for the Unlabeled queue: a suggestion only exists at all above
// FACE_MATCH_THRESHOLD, so this higher cutoff pre-selects just the confident
// guesses and leaves weaker ones for manual triage. Loaded from the server's
// FACE_PRESELECT_MIN_SCORE setting (see loadConfidentScore); this default is
// only used if that fetch hasn't resolved yet.
let CONFIDENT_SCORE = 0.5;
// Every top-toolbar bulk action (assign/unassign/accept/ignore) is one click and
// has to be undone per-face, so each confirms once the selection exceeds this
// many. The nuclear option is the one exception — it always confirms.
const SELECTION_CONFIRM_THRESHOLD = 3;

function confirmSelection(count, message) {
  return count <= SELECTION_CONFIRM_THRESHOLD || confirm(message);
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  bindToolbar();
  await loadConfidentScore();  // before loadFaces, so the first render pre-selects correctly
  await loadFocusContexts();   // restores any saved Focus before the first load
  await loadPersons();
  await loadFaces();
  setStatus("Select a person on the left, or scan for faces to begin.");
});

// Pulls the live FACE_PRESELECT_MIN_SCORE setting (tunable on the Settings page)
// so the Unlabeled queue's pre-select cutoff stays in sync without a code change.
async function loadConfidentScore() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = await res.json();
    const spec = data.settings.find(s => s.key === "FACE_PRESELECT_MIN_SCORE");
    if (spec) CONFIDENT_SCORE = spec.value;
  } catch (e) {
    // Keep the built-in default if settings can't be reached.
  }
}

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("quicktag-view-btn").addEventListener("click", () => {
    window.location.href = "/tag.html";
  });
  document.getElementById("manage-view-btn").addEventListener("click", () => {
    window.location.href = "/people-manage.html";
  });

  document.getElementById("focus-context-select").addEventListener("change", onFocusChange);
  document.getElementById("focus-spatial-chk").addEventListener("change", () => {
    localStorage.setItem(FOCUS_SPATIAL_LS_KEY,
      document.getElementById("focus-spatial-chk").checked ? "1" : "0");
    onFocusChange();   // applyFocusFromSelect re-reads the checkbox, then reloads
  });

  document.getElementById("deselect-all-btn").addEventListener("click", deselectAll);
  document.getElementById("suggested-only-chk").addEventListener("change", (e) => {
    suggestedOnly = e.target.checked;
    if (scope === "unlabeled") loadFaces();
  });
  // Suggested-person filter (Unlabeled queue): filters the loaded queue in place,
  // no refetch needed since we hold the full list in `unlabeledAll`.
  document.getElementById("suggest-filter-select").addEventListener("change", (e) => {
    suggestFilterPersonId = e.target.value ? parseInt(e.target.value) : null;
    if (scope === "unlabeled") applyUnlabeledView();
  });

  document.getElementById("assign-btn").addEventListener("click", () => {
    const pid = parseInt(document.getElementById("assign-person-select").value);
    if (!pid) { setStatus("Pick a person from the dropdown first.", true); return; }
    assignSelected(pid);
  });
  document.getElementById("assign-new-btn").addEventListener("click", assignSelectedToNewPerson);
  document.getElementById("unassign-btn").addEventListener("click", () => assignSelected(null, true));
  document.getElementById("confirm-suggested-btn").addEventListener("click", acceptSuggestionsForSelection);
  // In the Ignored scope this button restores; everywhere else it ignores.
  document.getElementById("ignore-btn").addEventListener("click", () => ignoreSelected(scope !== "ignored"));
  document.getElementById("nuke-btn").addEventListener("click", nukeSelectedPhotos);

  document.getElementById("review-guesses-btn").addEventListener("click", () => {
    const pid = parseInt(document.getElementById("guess-person-select").value);
    if (!pid) { setStatus("Pick a person to review guesses for.", true); return; }
    selectScope("suggested", pid);
  });
  document.getElementById("group-gap-select").addEventListener("change", (e) => {
    groupGapSeconds = parseInt(e.target.value);
    if (scope === "suggested") renderGrid();
  });

  document.getElementById("crowd-reload-btn").addEventListener("click", () => {
    if (scope === "crowds") loadCrowds();
  });
  document.getElementById("crowd-hide-done").addEventListener("change", e => {
    hideCompletedCrowds = e.target.checked;
    if (scope === "crowds") renderCrowds();
  });

  document.getElementById("add-person-btn").addEventListener("click", addPerson);

  // Detail-pane assignment controls act on the ONE previewed face only — never the
  // grid selection (the toolbar's "Assign selection" is for that). Mirrors the
  // detail Ignore button below, which already scopes to the focused face.
  document.getElementById("detail-assign-btn").addEventListener("click", () => {
    const pid = parseInt(document.getElementById("detail-person-select").value);
    if (!pid) { setStatus("Pick a person from the dropdown first.", true); return; }
    assignFocusedFace({ personId: pid });
  });
  document.getElementById("detail-new-btn").addEventListener("click", () => {
    const name = prompt("Name for this person:");
    if (name && name.trim()) assignFocusedFace({ name: name.trim() });
  });
  document.getElementById("detail-unassign-btn").addEventListener("click", () => assignFocusedFace({ clear: true }));
  document.getElementById("detail-ignore-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (!f) { setStatus("Select a face first.", true); return; }
    // Act on the previewed face only — not the grid selection.
    ignoreSelected_ids([f.id], !f.ignored);
  });
  document.getElementById("detail-open-photo-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (f) window.open(`/api/preview/${f.photo_id}`, "_blank");
  });
}

/* ── Time Focus ──
 * The Focus dropdown offers two kinds of time window: a plain calendar Year
 * (all photos taken in it, no polygon — spatial narrowing doesn't apply), and
 * each Context that has a time component (start_ts/end_ts); a Context's place
 * polygon is only used when "＋ in its area" is also checked. Year option
 * values are prefixed "y:" to tell them apart from Context ids. */
async function loadFocusContexts() {
  const sel = document.getElementById("focus-context-select");
  try {
    const res = await fetch("/api/contexts");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();
    // Only Contexts with a time component can drive a time Focus.
    focusContexts = all.filter(c => c.start_ts != null || c.end_ts != null);
  } catch (err) {
    focusContexts = [];   // non-fatal: Focus just stays at "All time"
  }
  try {
    const res = await fetch("/api/stats/months");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    focusYears = [...new Set(data.months.map(m => m.year))].sort((a, b) => b - a);
  } catch (err) {
    focusYears = [];   // non-fatal: no Year options, Contexts still work
  }

  sel.innerHTML = '<option value="">All time</option>';
  if (focusYears.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Year";
    focusYears.forEach(y => {
      const opt = document.createElement("option");
      opt.value = `y:${y}`;
      opt.textContent = String(y);
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }
  if (focusContexts.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Context";
    focusContexts.forEach(c => {
      const opt = document.createElement("option");
      opt.value = String(c.id);
      opt.textContent = `${c.name} (${focusRangeLabel(c)})`;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  // A "?month=YYYY-MM" URL argument (e.g. from the homepage face-coverage
  // month chart) focuses on that month, same as picking a Year from the
  // dropdown — takes priority over any saved Focus.
  const monthArg = new URLSearchParams(window.location.search).get("month");
  const monthMatch = monthArg && monthArg.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10), month = parseInt(monthMatch[2], 10);
    const opt = document.createElement("option");
    opt.value = `m:${monthMatch[1]}-${monthMatch[2]}`;
    opt.textContent = `${MONTH_NAMES[month - 1]} ${year}`;
    sel.insertBefore(opt, sel.children[1] || null);
    sel.value = opt.value;
  } else {
    // Restore a previously chosen Focus so the window survives reloads.
    const saved = localStorage.getItem(FOCUS_LS_KEY);
    if (saved && (focusContexts.some(c => String(c.id) === saved) || focusYears.some(y => `y:${y}` === saved))) {
      sel.value = saved;
    }
  }
  document.getElementById("focus-spatial-chk").checked =
    localStorage.getItem(FOCUS_SPATIAL_LS_KEY) === "1";
  applyFocusFromSelect();   // sets state + note; the initial load picks it up
}

// Read the dropdown, set the active window (state + localStorage + note). Does
// not reload — callers decide whether to refresh the views.
function applyFocusFromSelect() {
  const sel = document.getElementById("focus-context-select");
  const chk = document.getElementById("focus-spatial-chk");
  const val = sel.value;

  if (val.startsWith("m:")) {
    // A calendar month (from a "?month=YYYY-MM" URL argument), computed as a
    // UTC range for the same reason the Year case is — matches photo_datetime
    // bucketing. No polygon, so spatial narrowing doesn't apply. Not persisted
    // to localStorage: URL-driven, one-shot on arrival, not a saved preference.
    const [year, month] = val.slice(2).split("-").map(Number);
    focusStartTs = Date.UTC(year, month - 1, 1) / 1000;
    focusEndTs = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) / 1000;
    focusLabel = `${MONTH_NAMES[month - 1]} ${year}`;
    focusContextId = null;
    chk.disabled = true;
    document.getElementById("focus-spatial-label").classList.toggle("disabled", true);
    focusSpatial = false;
    updateFocusNote();
    return;
  }

  if (val.startsWith("y:")) {
    // A calendar year, computed as a UTC range to match how the backend buckets
    // photo_datetime (strftime(..., 'unixepoch') is UTC) and Context date_to_ts_*.
    const year = parseInt(val.slice(2), 10);
    focusStartTs = Date.UTC(year, 0, 1) / 1000;
    focusEndTs = Date.UTC(year + 1, 0, 1) / 1000;
    focusLabel = String(year);
    focusContextId = null;
    chk.disabled = true;
    document.getElementById("focus-spatial-label").classList.toggle("disabled", true);
    focusSpatial = false;   // years have no polygon — spatial narrowing doesn't apply
    localStorage.setItem(FOCUS_LS_KEY, val);
    updateFocusNote();
    return;
  }

  const c = focusContexts.find(x => String(x.id) === val);
  focusStartTs = c ? c.start_ts : null;
  focusEndTs = c ? c.end_ts : null;
  focusLabel = c ? c.name : null;
  focusContextId = c ? c.id : null;
  // "＋ in its area" only means something with a Context picked; disable it under
  // "All time" so it's clear it needs one. focusSpatial follows the live checkbox.
  chk.disabled = !c;
  document.getElementById("focus-spatial-label").classList.toggle("disabled", !c);
  focusSpatial = chk.checked && !!c;
  if (c) localStorage.setItem(FOCUS_LS_KEY, String(c.id));
  else localStorage.removeItem(FOCUS_LS_KEY);
  updateFocusNote();
}

async function onFocusChange() {
  applyFocusFromSelect();
  // Re-render the left nav (windowed people list + Unlabeled count) and the grid.
  await loadPersons();
  await loadFaces();
}

function focusActive() {
  return focusStartTs != null || focusEndTs != null
      || (focusSpatial && focusContextId != null);
}

// Query fragment (no leading separator) for the active Focus, else "". Carries the
// time window and, when "＋ in its area" is on, the Context id so the backend can
// resolve its polygon and drop out-of-area photos.
function focusQuery() {
  const parts = [];
  if (focusStartTs != null) parts.push(`start_ts=${focusStartTs}`);
  if (focusEndTs != null) parts.push(`end_ts=${focusEndTs}`);
  if (focusSpatial && focusContextId != null) {
    parts.push(`spatial_context_id=${focusContextId}`);
  }
  return parts.join("&");
}

// Human label for a Context's window, matching the Contexts page convention
// (raw start_date/end_date; end_date is the app's exclusive end-of-day value).
function focusRangeLabel(c) {
  const s = c.start_date, e = c.end_date;
  if (s && e) return s === e ? s : `${s} → ${e}`;
  if (s) return `from ${s}`;
  if (e) return `until ${e}`;
  return "any time";
}

// " · Focus: <name>" for windowed status lines, or "" when no Focus is active.
function focusStatusSuffix() {
  if (!focusActive()) return "";
  return ` · Focus: ${focusLabel || "time window"}` + (focusSpatial ? " (in its area)" : "");
}

function updateFocusNote() {
  const note = document.getElementById("focus-note");
  document.getElementById("focus-context-select").classList.toggle("focus-active", focusActive());
  if (!focusActive()) { note.textContent = ""; note.title = ""; return; }
  note.textContent = focusSpatial
    ? "◦ windowing by time + area (people, Unlabeled, suggestions, Discover & Crowds)"
    : "◦ windowing people, Unlabeled, suggestions, Discover & Crowds";
  const c = focusContextId != null ? focusContexts.find(x => x.id === focusContextId) : null;
  note.title = c
    ? `Focused on “${c.name}” (${focusRangeLabel(c)})` +
      (focusSpatial ? " — limited to its map area" : "")
    : focusLabel
      ? `Focused on ${focusLabel}`
      : "";
}

/* ── People list ── */
async function loadPersons() {
  try {
    const q = focusActive() ? "?" + focusQuery() : "";
    // `persons` stays the FULL list — it feeds the Assign dropdowns, quick-action
    // menu and name lookups, so you can still tag someone who has no faces in the
    // window yet. The left nav renders `navPersons`, which is windowed when a Focus
    // is active (only in-range people, with in-range counts).
    const [pRes, sRes] = await Promise.all([
      fetch("/api/persons"),
      fetch("/api/faces/scan/status" + q),
    ]);
    persons = await pRes.json();
    const status = await sRes.json();

    navPersons = persons;
    if (focusActive()) {
      const navRes = await fetch("/api/persons" + q);
      if (navRes.ok) navPersons = await navRes.json();
    }

    const totalFaces = status.total_faces || 0;
    renderPeopleList(status.unlabeled_faces || 0, totalFaces,
                     status.ignored_faces || 0, status.tagged_faces || 0);
    populatePersonSelects();
  } catch (err) {
    setStatus("Failed to load people: " + err.message, true);
  }
}

function renderPeopleList(unlabeledCount, allCount, ignoredCount, taggedCount) {
  const list = document.getElementById("people-list");
  list.innerHTML = "";

  list.appendChild(makeScopeItem("Unlabeled", unlabeledCount, "unlabeled", null));
  list.appendChild(makeScopeItem("Discover groups", null, "discover", null));
  list.appendChild(makeScopeItem("Crowds", null, "crowds", null));
  list.appendChild(makeScopeItem("Recently tagged", taggedCount, "recent", null));
  list.appendChild(makeScopeItem("All faces", allCount, "all", null));
  list.appendChild(makeScopeItem("Ignored", ignoredCount, "ignored", null));

  const sep = document.createElement("div");
  sep.className = "people-sep";
  list.appendChild(sep);

  if (navPersons.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:#666;padding:8px;font-size:11px;";
    empty.textContent = focusActive()
      ? "No tagged people in this time window. Widen the Focus, or tag faces in the Unlabeled queue."
      : "No people yet. Assign a face to create one.";
    list.appendChild(empty);
    return;
  }

  // Group by family; persons without a family go last.
  const familyMap = new Map(); // family_id -> { name, persons[] }
  const noFamily = [];
  navPersons.forEach((p) => {
    if (p.family_id) {
      if (!familyMap.has(p.family_id)) {
        familyMap.set(p.family_id, { name: p.family_name, persons: [] });
      }
      familyMap.get(p.family_id).persons.push(p);
    } else {
      noFamily.push(p);
    }
  });

  const sortedFamilies = [...familyMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const hasFamilies = sortedFamilies.length > 0;

  sortedFamilies.forEach((fam) => {
    list.appendChild(makeFamilyHeader(fam.name));
    fam.persons.forEach((p) => list.appendChild(makePersonItem(p)));
  });

  if (noFamily.length > 0) {
    // Only show the "Other" label when there are also family groups.
    if (hasFamilies) list.appendChild(makeFamilyHeader("Other"));
    noFamily.forEach((p) => list.appendChild(makePersonItem(p)));
  }
}

function makeFamilyHeader(name) {
  const hdr = document.createElement("div");
  hdr.className = "family-group-header";
  hdr.textContent = name;
  return hdr;
}

function makePersonItem(p) {
  const item = makeScopeItem(p.name, p.face_count, "person", p.id);
  if (p.birth_date) {
    const b = document.createElement("span");
    b.className = "person-birth";
    b.textContent = ` b.${p.birth_date.slice(0, 4)}`;
    item.querySelector(".person-name").appendChild(b);
  }
  const edit = document.createElement("span");
  edit.className = "person-edit";
  edit.textContent = "✎";
  edit.title = `Set birth date for ${p.name} (improves age-aware suggestions)`;
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    editPersonBirth(p.id, p.name, p.birth_date);
  });
  const del = document.createElement("span");
  del.className = "person-del";
  del.textContent = "×";
  del.title = `Delete ${p.name}`;
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deletePerson(p.id, p.name);
  });
  item.appendChild(edit);
  item.appendChild(del);
  return item;
}

function makeScopeItem(name, count, itemScope, personId) {
  const item = document.createElement("div");
  const isActive = itemScope === scope &&
    (itemScope !== "person" || personId === scopePersonId);
  item.className = "person-item" + (isActive ? " active" : "");

  const nameEl = document.createElement("span");
  nameEl.className = "person-name";
  nameEl.textContent = name;
  item.appendChild(nameEl);

  if (count !== null && count !== undefined && count !== "") {
    const countEl = document.createElement("span");
    countEl.className = "person-count";
    countEl.textContent = count;
    item.appendChild(countEl);
  }

  item.addEventListener("click", () => selectScope(itemScope, personId));
  return item;
}

function populatePersonSelects() {
  ["assign-person-select", "detail-person-select", "guess-person-select"].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">Choose person…</option>';
    persons.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.value = prev;
  });
}


/* ── Scope selection ── */
async function selectScope(newScope, personId) {
  scope = newScope;
  scopePersonId = personId;
  selectedIds.clear();
  lastClickedIndex = -1;
  focusedFaceId = null;
  suggestFilterPersonId = null;   // the queue filter is per-visit to the Unlabeled scope
  await loadFaces();
  await loadPersons();  // re-renders the list with the correct active highlight
}

// Show the right sub-bar in the sticky #grid-nav for the current scope (and hide
// the whole bar for scopes that have no controls, e.g. Discover/All/Ignored).
function updateGridNavVisibility() {
  const showPerson = scope === "person" || scope === "suggested";
  const showCrowds = scope === "crowds";
  const showUnlabeled = scope === "unlabeled";
  // The selection-action bar applies to any grid of selectable faces — every scope
  // except Discover/Crowds, which render cluster/photo cards with their own buttons.
  const showSelection = scope !== "discover" && scope !== "crowds";
  document.getElementById("grid-nav-person").style.display = showPerson ? "" : "none";
  document.getElementById("grid-nav-crowds").style.display = showCrowds ? "" : "none";
  document.getElementById("grid-nav-unlabeled").style.display = showUnlabeled ? "" : "none";
  document.getElementById("grid-nav-selection").style.display = showSelection ? "" : "none";
  document.getElementById("grid-nav").style.display =
    (showPerson || showCrowds || showUnlabeled || showSelection) ? "" : "none";
}

/* ── Faces grid ── */
async function loadFaces() {
  updateGridNavVisibility();
  if (scope === "discover") { await loadClusters(); return; }
  if (scope === "crowds")   { await loadCrowds();   return; }
  try {
    let url = `/api/faces?scope=${scope}&limit=${FACE_LIMIT}`;
    if ((scope === "person" || scope === "suggested") && scopePersonId) {
      url += `&person_id=${scopePersonId}`;
    }
    if (scope === "unlabeled" && suggestedOnly) url += "&suggested_only=true";
    // Focus windows the candidate scopes only (unlabeled/suggested); the backend
    // ignores it for person/all/recent/ignored so nothing else needs gating here.
    if ((scope === "unlabeled" || scope === "suggested") && focusActive()) {
      url += "&" + focusQuery();
    }
    const res = await fetch(url);
    const data = await res.json();
    faces = data.faces;

    if (scope === "suggested") {
      // Order chronologically (undated last) so event groups are contiguous,
      // then pre-select every guess and aim the Assign dropdowns at the person.
      faces.sort((a, b) => (a.photo_datetime || Infinity) - (b.photo_datetime || Infinity));
      selectedIds = new Set(faces.map(f => f.id));
      focusedFaceId = faces.length ? faces[0].id : null;
      document.getElementById("assign-person-select").value = scopePersonId;
      document.getElementById("detail-person-select").value = scopePersonId;
    } else if (scope === "recent") {
      // Newest tag first (the server already orders this way; keep it explicit).
      faces.sort((a, b) => (b.assigned_at || 0) - (a.assigned_at || 0));
    } else if (scope === "unlabeled") {
      // Oldest first so each month's location buckets land in first-seen
      // (chronological) order, then flatten into that month → location order so
      // the flat array matches the on-screen order — shift-range selection
      // relies on index ↔ faces[index] correspondence. This is the master list;
      // the suggested-person filter narrows it into `faces` in applyUnlabeledView.
      faces.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
      unlabeledAll = computeMonthLocationGroups(faces).flatMap(g => g.faces);
      unlabeledMeta = { total: data.total, returned: data.returned };
      populateSuggestFilter();
      applyUnlabeledView();   // owns faces/selection/render/status for this scope
      return;
    } else if (scope === "person") {
      faces.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
    }

    // Keep the toolbar's "Review guesses for" aimed at whoever you're viewing.
    if ((scope === "person" || scope === "suggested") && scopePersonId) {
      document.getElementById("guess-person-select").value = scopePersonId;
    }

    updateActionButtons();
    renderGrid();
    updateDetail();

    const personName = persons.find(p => p.id === scopePersonId)?.name || "this person";
    if (scope === "suggested") {
      if (data.returned === 0) {
        setStatus(`No guesses for ${personName}${focusActive() ? " in this window" : ""} yet — ` +
                  `label a few of their faces first so recognition has examples to match against.` +
                  (focusActive() ? " (Focus is active — set “All time” to widen.)" : ""));
      } else {
        const ambiguous = faces.filter(f => f.alternatives && f.alternatives.length).length;
        const ambigNote = ambiguous
          ? `${ambiguous} (amber) may be someone else — check those. ` : "";
        setStatus(`${data.returned} guesses for ${personName}, all selected. ${ambigNote}` +
                  `Click any wrong ones to deselect, then Assign to approve the rest.` +
                  focusStatusSuffix());
      }
    } else if (scope === "recent") {
      if (data.returned === 0) {
        setStatus("Nothing tagged yet. Faces you assign to a person will show up here, newest first.");
      } else {
        let msg = `${data.returned} recently tagged face(s), newest first — ` +
                  `click a name to un-tag, or use “Untag all” on a batch.`;
        if (data.total > data.returned) msg += ` (showing first ${data.returned})`;
        setStatus(msg);
      }
    } else {
      const label = scope === "person" ? personName : scope;
      let msg = `${data.returned} of ${data.total} faces — ${label}`;
      if (data.total > data.returned) msg += ` (showing first ${data.returned})`;
      setStatus(msg);
    }
  } catch (err) {
    setStatus("Failed to load faces: " + err.message, true);
  }
}

/* ── Unlabeled queue: suggested-person filter ──
 * Fill the sticky-nav dropdown with the people who appear as a *top* suggestion
 * somewhere in the loaded queue, most-suggested first, each with its face count.
 * A stale selection (that person now has no suggested faces) falls back to "all". */
function populateSuggestFilter() {
  const sel = document.getElementById("suggest-filter-select");
  const counts = new Map();   // person_id → { name, count }
  unlabeledAll.forEach(f => {
    if (!f.suggestion) return;
    const e = counts.get(f.suggestion.person_id)
              || { name: f.suggestion.person_name, count: 0 };
    e.count++;
    counts.set(f.suggestion.person_id, e);
  });
  // Drop a filter whose person no longer has any suggested faces here.
  if (suggestFilterPersonId != null && !counts.has(suggestFilterPersonId)) {
    suggestFilterPersonId = null;
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  sel.innerHTML = '<option value="">All suggestions</option>';
  sorted.forEach(([pid, { name, count }]) => {
    const o = document.createElement("option");
    o.value = pid;
    o.textContent = `${name || "Unknown"} (${count})`;
    sel.appendChild(o);
  });
  sel.value = suggestFilterPersonId == null ? "" : String(suggestFilterPersonId);
  sel.disabled = counts.size === 0;
}

// Render the Unlabeled queue from the master list, narrowed to one suggested
// person when the nav filter is set. Owns the render/status tail for this scope
// so the dropdown can re-run it without a refetch.
function applyUnlabeledView() {
  const pid = suggestFilterPersonId;
  faces = pid == null
    ? unlabeledAll.slice()
    : unlabeledAll.filter(f => f.suggestion && f.suggestion.person_id === pid);

  // Pre-select only the confident guesses among the visible faces — accept those
  // in bulk, then triage the weaker/unguessed ones by hand.
  selectedIds = new Set(
    faces.filter(f => f.suggestion && f.suggestion.score >= CONFIDENT_SCORE
                      && !f.person_name && !f.ignored)
         .map(f => f.id));
  focusedFaceId = faces.length ? faces[0].id : null;

  updateActionButtons();
  renderGrid();
  updateDetail();

  const { total, returned } = unlabeledMeta;
  const preselNote = selectedIds.size
    ? `. ${selectedIds.size} confident guess(es) pre-selected.` : "";
  if (pid != null) {
    const name = persons.find(p => p.id === pid)?.name || "this person";
    let msg = `${faces.length} face(s) suggested to be ${name}`;
    if (returned < total) msg += `, within the first ${returned} loaded`;
    setStatus(msg + preselNote + focusStatusSuffix());
    return;
  }
  if (suggestedOnly && total === 0) {
    setStatus("No unlabeled faces have a recognition guess yet — uncheck " +
              "“Only suggested” to see the rest, or label a few faces so " +
              "recognition has examples to match against." +
              (focusActive() ? " (Focus is active — set “All time” to widen.)" : ""));
    return;
  }
  const noun = suggestedOnly ? "suggested face(s)" : "unlabeled face(s)";
  let msg = `${returned} of ${total} ${noun}, grouped by month then place`;
  if (total > returned) msg += ` (showing first ${returned})`;
  setStatus(msg + preselNote + focusStatusSuffix());
}

function makeGroupSection(groupIdx) {
  const sec = document.createElement("div");
  sec.className = `face-group-section group-tint-${groupIdx % 6}`;
  return sec;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  // In the guesses view, lay faces out under event-group headers (date-range
  // title, location in the meta; the Ignore button acts on the selection).
  if (scope === "suggested") {
    let idx = 0, groupIdx = 0;
    computeTimeGroups(faces, groupGapSeconds).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      const place = locationLabel(group.faces);
      sec.appendChild(makeGroupHeader(group, {
        title: formatGroupRange(group),
        meta: place ? `· 📍 ${place}` : "",
      }));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face, idx)); idx++; });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Ignored: group by ignore-batch (shared ignored_at), newest first,
  // each batch header offering a one-click "Restore all".
  if (scope === "ignored") {
    let idx = 0, groupIdx = 0;
    computeIgnoreBatches(faces).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeIgnoreBatchHeader(group));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face, idx)); idx++; });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Recently tagged: group by tag-batch (shared assigned_at), newest first,
  // each batch header offering a one-click "Untag all".
  if (scope === "recent") {
    let idx = 0, groupIdx = 0;
    computeTagBatches(faces).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeTagBatchHeader(group));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face, idx)); idx++; });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Unlabeled queue: same common group grid as the guesses view, grouped by
  // month then by location. Year/month dividers read top-to-bottom; each
  // location within a month is one group (location title, date range in the
  // meta) and its Ignore button acts on the whole group, not just the selection.
  if (scope === "unlabeled") {
    let idx = 0, groupIdx = 0, curYear, curMonth;
    computeMonthLocationGroups(faces).forEach(group => {
      if (group.year !== curYear) {
        curYear = group.year; curMonth = undefined;
        const yd = document.createElement("div");
        yd.className = "grid-year-divider";
        yd.textContent = group.year === null ? "Undated" : group.year;
        grid.appendChild(yd);
      }
      if (group.month !== curMonth) {
        curMonth = group.month;
        if (group.month !== null) {
          const md = document.createElement("div");
          md.className = "grid-month-divider";
          md.textContent = MONTH_NAMES[group.month];
          grid.appendChild(md);
        }
      }
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeGroupHeader(group, {
        title: group.place ? `📍 ${group.place}` : "No location",
        label: group.place || "No location",
        meta: `· ${facesDateRange(group.faces)}`,
        ignoreAll: true,
      }));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      // Faces are already clustered by suggested person (sortBucketBySuggestion);
      // break to a fresh grid row whenever the suggested person changes so each
      // person reads as its own run. `.row-break` forces grid-column-start:1, which
      // wraps the cell to a new line and leaves the prior row's tail empty.
      let prevSug;   // undefined before the first cell; null = the "unknown" block
      group.faces.forEach(face => {
        const sug = face.suggestion ? face.suggestion.person_id : null;
        const cell = makeFaceCell(face, idx);
        if (prevSug !== undefined && sug !== prevSug) cell.classList.add("row-break");
        cells.appendChild(cell);
        prevSug = sug;
        idx++;
      });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Per-person view: an action bar to hunt for more of this person, then
  // geocode-style year/month dividers (no per-month actions).
  if (scope === "person") {
    grid.appendChild(makePersonHeader());
    let curYear = null, curMonth = null;
    faces.forEach((face, idx) => {
      if (face.photo_datetime) {
        const d = new Date(face.photo_datetime * 1000);
        const year = d.getFullYear();
        const month = d.getMonth();  // 0-based
        if (year !== curYear) {
          curYear = year; curMonth = month;
          const div = document.createElement("div");
          div.className = "grid-year-divider";
          div.textContent = year;
          grid.appendChild(div);
        } else if (month !== curMonth) {
          curMonth = month;
          const div = document.createElement("div");
          div.className = "grid-month-divider";
          div.textContent = MONTH_NAMES[month];
          grid.appendChild(div);
        }
      }
      grid.appendChild(makeFaceCell(face, idx));
    });
    return;
  }

  faces.forEach((face, idx) => grid.appendChild(makeFaceCell(face, idx)));
}

// Action bar atop a person's photos: jump to recognition's untagged guesses for them.
function makePersonHeader() {
  const name = persons.find(p => p.id === scopePersonId)?.name || "this person";
  const bar = document.createElement("div");
  bar.className = "person-scope-header";

  const label = document.createElement("span");
  label.className = "person-scope-label";
  label.textContent = `${faces.length} tagged photo(s) of ${name}`;

  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = `🔍 Find more photos of ${name}`;
  btn.title = "Show untagged faces that recognition thinks are this person, " +
    "so you can confirm them in bulk";
  btn.addEventListener("click", () => selectScope("suggested", scopePersonId));

  bar.appendChild(label);
  bar.appendChild(btn);
  return bar;
}

/* ── Month grouping (unlabeled queue) ── */
function computeMonthGroups(list) {
  // `list` is chronological with undated faces first (see loadFaces).
  const groups = [];
  let cur = null;
  list.forEach(f => {
    let year = null, month = null;
    if (f.photo_datetime) {
      const d = new Date(f.photo_datetime * 1000);
      year = d.getFullYear();
      month = d.getMonth();
    }
    if (!cur || cur.year !== year || cur.month !== month) {
      cur = { year, month, faces: [] };
      groups.push(cur);
    }
    cur.faces.push(f);
  });
  return groups;
}

// Month → location grouping. Within each chronological month, faces are bucketed
// by resolved location; buckets keep first-seen order, which (because `list` is
// chronological) is the order each location first appears that month. Faces with
// no location collect into one "No location" bucket per month. Each bucket's faces
// are then clustered by suggested person (see sortBucketBySuggestion) so the same
// person is contiguous — this is what makes `unlabeledAll` (the flat selection list)
// and the render agree, so the ordering must live here, in the shared choke point.
function computeMonthLocationGroups(list) {
  const out = [];
  computeMonthGroups(list).forEach(mg => {
    const buckets = new Map();   // locationKey ("" = none) → group
    mg.faces.forEach(f => {
      const key = locationKey(f) || "";
      let b = buckets.get(key);
      if (!b) {
        b = { year: mg.year, month: mg.month, place: key || null, faces: [] };
        buckets.set(key, b);
      }
      b.faces.push(f);
    });
    buckets.forEach(b => { b.faces = sortBucketBySuggestion(b.faces); });
    out.push(...buckets.values());
  });
  return out;
}

// Order the faces within one location bucket so the same suggested person is
// adjacent (so you can rubber-band / confirm a person's faces as a run): guessed
// faces first, grouped by suggested person and ordered by that person's earliest
// photo in the bucket (chronological first-appearance), each person's faces in
// time order; faces with no suggestion ("unknown") sink to the bottom. The sort is
// a fixed point — re-running it on already-sorted faces is a no-op — because the
// per-person earliest timestamp is order-independent, so the flat list and the
// re-grouped render stay in sync.
function sortBucketBySuggestion(faceList) {
  const firstTs = new Map();   // person_id → earliest photo_datetime in this bucket
  faceList.forEach(f => {
    const pid = f.suggestion ? f.suggestion.person_id : null;
    if (pid == null) return;
    const ts = f.photo_datetime || 0;
    if (!firstTs.has(pid) || ts < firstTs.get(pid)) firstTs.set(pid, ts);
  });
  return faceList.slice().sort((a, b) => {
    const pa = a.suggestion ? a.suggestion.person_id : null;
    const pb = b.suggestion ? b.suggestion.person_id : null;
    if ((pa == null) !== (pb == null)) return pa == null ? 1 : -1;  // unknowns last
    if (pa !== pb) {
      const fa = firstTs.get(pa), fb = firstTs.get(pb);
      if (fa !== fb) return fa - fb;   // person blocks in first-appearance order
      return pa - pb;                  // same earliest ts: stable tiebreak by id
    }
    return (a.photo_datetime || 0) - (b.photo_datetime || 0);  // within a block: chronological
  });
}

// "Mar 3 – Mar 8" date span across a group's faces (undated faces ignored).
function facesDateRange(faceList) {
  const ts = faceList.map(f => f.photo_datetime).filter(Boolean);
  if (!ts.length) return "Undated";
  return formatDateRange(Math.min(...ts), Math.max(...ts));
}

function makeFaceCell(face, idx) {
  const cell = document.createElement("div");
  cell.className = "thumb-cell" +
    (selectedIds.has(face.id) ? " selected" : "") +
    (face.ignored ? " ignored" : "");
  cell.dataset.id = face.id;

  cell.appendChild(faceCropImg(face));

  const score = document.createElement("div");
  score.className = "face-score";
  score.textContent = face.det_score.toFixed(2);
  cell.appendChild(score);

  if (face.ignored) {
    const label = document.createElement("div");
    label.className = "face-label ignored-label";
    label.textContent = "Ignored";
    cell.appendChild(label);
  } else if (face.person_name && scope === "recent") {
    // In the recently-tagged view the name is a one-click un-tag.
    const chip = document.createElement("div");
    chip.className = "face-untag";
    chip.title = `Click to un-tag ${face.person_name}`;
    chip.innerHTML =
      `<span class="sug-name">${face.person_name}</span>` +
      `<span class="untag-x">✕</span>`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      untagFaces([face.id]);
    });
    cell.appendChild(chip);
  } else if (face.person_name) {
    const label = document.createElement("div");
    label.className = "face-label";
    label.textContent = face.person_name;
    cell.appendChild(label);
  } else if (face.suggestion) {
    const alts = face.alternatives || [];
    if (alts.length) {
      // Near-tie with another person — flag it and offer a one-click reassign.
      cell.classList.add("ambiguous");
      const wrap = document.createElement("div");
      wrap.className = "face-chips";
      wrap.appendChild(makeSuggestChip(face));
      alts.slice(0, 2).forEach(alt => wrap.appendChild(makeAltChip(face, alt)));
      cell.appendChild(wrap);
    } else {
      cell.appendChild(makeSuggestChip(face));
    }
  }

  // Left-click selects/deselects (plain, Ctrl/⌘ toggle, Shift range);
  // right-click opens the quick-action menu for this face.
  cell.addEventListener("click", (e) => handleCellClick(e, face, idx));
  cell.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openFaceActions(cell, face);
  });
  return cell;
}

// Green chip confirming the face as its top-suggested person; the ✕ rejects it
// instead ("not this person") so recognition falls through to the next-best guess.
function makeSuggestChip(face) {
  const chip = document.createElement("div");
  chip.className = "face-suggest";
  chip.title = `Click to confirm: ${face.suggestion.person_name} (${face.suggestion.score})`;
  chip.innerHTML =
    `<span class="sug-check">✓</span>` +
    `<span class="sug-name">${face.suggestion.person_name}?</span>` +
    `<span class="sug-reject" title="Not ${face.suggestion.person_name}">✕</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest(".sug-reject")) {
      rejectSuggestion(face.id, face.suggestion.person_id, face.suggestion.person_name);
      return;
    }
    confirmFace(face.id, face.suggestion.person_id);
  });
  return chip;
}

// Amber chip tagging the face as a runner-up person instead of the suggestion;
// the ✕ rejects that alternative ("not this person either").
function makeAltChip(face, alt) {
  const chip = document.createElement("div");
  chip.className = "face-alt";
  chip.title = `Click to tag as ${alt.person_name} instead (${alt.score})`;
  chip.innerHTML =
    `<span class="alt-arrow">→</span>` +
    `<span class="sug-name">${alt.person_name}?</span>` +
    `<span class="sug-reject" title="Not ${alt.person_name}">✕</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest(".sug-reject")) {
      rejectSuggestion(face.id, alt.person_id, alt.person_name);
      return;
    }
    confirmFace(face.id, alt.person_id);
  });
  return chip;
}

/* ── Ignore-batch grouping (ignored view) ── */
function computeIgnoreBatches(list) {
  // `list` is newest-first by ignored_at; faces ignored together share a value.
  // Faces with no ignored_at (ignored before this column existed) go in one trailing group.
  const groups = [];
  let cur = null;
  list.forEach(f => {
    const key = f.ignored_at ?? null;
    if (!cur || cur.ts !== key) { cur = { ts: key, faces: [] }; groups.push(cur); }
    cur.faces.push(f);
  });
  return groups;
}

function makeIgnoreBatchHeader(group) {
  const when = group.ts ? formatRelativeTime(group.ts) : "before tracking";
  return faceGroupHeader({
    title: `Ignored ${when}`,
    meta: `· ${group.faces.length} face(s)`,
    buttons: [
      { label: "Select all",
        title: "Add every face in this batch to the current selection",
        onClick: () => { group.faces.forEach(f => selectedIds.add(f.id)); renderGrid(); updateDetail(); } },
      { label: `Restore all (${group.faces.length})`, kind: "primary",
        title: "Un-ignore every face in this batch (returns them to the Unlabeled queue)",
        onClick: () => ignoreSelected_ids(group.faces.map(f => f.id), false) },
    ],
  });
}

/* ── Tag-batch grouping (recently tagged view) ── */
function computeTagBatches(list) {
  // `list` is newest-first by assigned_at; faces tagged together share a value.
  const groups = [];
  let cur = null;
  list.forEach(f => {
    if (!cur || cur.ts !== f.assigned_at) { cur = { ts: f.assigned_at, faces: [] }; groups.push(cur); }
    cur.faces.push(f);
  });
  return groups;
}

function formatRelativeTime(ts) {
  if (!ts) return "unknown time";
  const sec = Date.now() / 1000 - ts;
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  if (sec < 7 * 86400) return `${Math.round(sec / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleString();
}

function makeTagBatchHeader(group) {
  const names = [...new Set(group.faces.map(f => f.person_name).filter(Boolean))];
  const who = names.length === 1 ? names[0]
            : names.length === 2 ? names.join(" & ")
            : `${names.length} people`;
  return faceGroupHeader({
    title: who,
    meta: `· ${formatRelativeTime(group.ts)} · ${group.faces.length} face(s)`,
    buttons: [
      { label: `Untag all (${group.faces.length})`, kind: "danger",
        title: "Un-tag every face tagged in this batch (returns them to Unlabeled)",
        onClick: () => untagFaces(group.faces.map(f => f.id), who) },
    ],
  });
}

// Clear the person assignment on faces, returning them to the unlabeled queue.
async function untagFaces(ids, who) {
  if (!ids.length) return;
  if (ids.length > 1 && !confirm(`Un-tag ${ids.length} face(s)${who ? ` (${who})` : ""}?`)) return;
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, clear: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Un-tagged ${ids.length} face(s).`);
    selectedIds.clear();
    if (ids.includes(focusedFaceId)) focusedFaceId = null;
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Un-tag failed: " + err.message, true);
  }
}

/* ── Event grouping (guesses view) ── */
function computeTimeGroups(list, gapSeconds) {
  // `list` is already chronological with undated faces last (see loadFaces).
  const groups = [];
  let cur = null;
  list.forEach(f => {
    const ts = f.photo_datetime;
    if (!ts || ts <= 0) {                       // collect undated into one trailing group
      if (!cur || !cur.undated) { cur = { faces: [], undated: true }; groups.push(cur); }
      cur.faces.push(f);
      return;
    }
    if (!cur || cur.undated || ts - cur.end > gapSeconds) {
      cur = { faces: [], start: ts, end: ts, undated: false };
      groups.push(cur);
    }
    cur.faces.push(f);
    cur.end = ts;
  });
  return groups;
}

function formatGroupRange(group) {
  return group.undated ? "Undated" : formatDateRange(group.start, group.end);
}

// Shared header for a section of faces (guesses view and Unlabeled queue).
// `title`/`meta` are display text; `label` (default `title`) is the plain name
// used in status messages. `ignoreAll` switches the Ignore button between
// "ignore the selected faces" (guesses view) and "ignore the whole group
// regardless of selection" (Unlabeled queue).
function makeGroupHeader(group, { title, meta = "", label = title, ignoreAll = false } = {}) {
  const acceptable = group.faces.filter(f => f.suggestion && !f.person_name && !f.ignored);
  const ignoreBtn = ignoreAll
    ? { icon: "🚫", label: "Ignore all", kind: "danger",
        title: "Ignore every face in this group, regardless of selection",
        onClick: () => {
          if (!confirm(`Ignore all ${group.faces.length} face(s) in ${label}?`)) return;
          ignoreSelected_ids(group.faces.map(f => f.id), true);
        } }
    : { icon: "🚫", label: "Ignore selected", kind: "danger",
        title: "Ignore the selected faces in this group",
        onClick: () => {
          const ids = group.faces.filter(f => selectedIds.has(f.id)).map(f => f.id);
          if (!ids.length) {
            setStatus(`No selected faces in ${label} to ignore.`, true);
            return;
          }
          ignoreSelected_ids(ids, true);
        } };
  return faceGroupHeader({
    title,
    meta,
    buttons: [
      acceptable.length > 0 && {
        icon: "✓", label: `Accept all (${acceptable.length})`, kind: "primary",
        title: `Accept all ${acceptable.length} suggestion(s) in this group`,
        onClick: () => acceptSuggestionsFor(group.faces, label),
      },
      { icon: "☑", label: "Select all",
        title: "Add every face in this group to the current selection",
        onClick: () => selectGroupFaces(group, true, label) },
      { icon: "◉", label: "Select only",
        title: "Select every face in this group and deselect all others",
        onClick: () => selectGroupFaces(group, false, label) },
      { icon: "☐", label: "Deselect all",
        title: "Remove every face in this group from the current selection",
        onClick: () => {
          group.faces.forEach(f => selectedIds.delete(f.id));
          renderGrid();
          updateDetail();
          setStatus(`Deselected ${group.faces.length} face(s) from ${label}.`);
        } },
      ignoreBtn,
    ],
  });
}

function selectGroupFaces(group, additive, label) {
  if (!additive) selectedIds.clear();
  group.faces.forEach(f => selectedIds.add(f.id));
  focusedFaceId = group.faces[0] ? group.faces[0].id : focusedFaceId;
  renderGrid();
  updateDetail();
  const verb = additive ? "Added" : "Selected only";
  const where = label || facesDateRange(group.faces);
  setStatus(`${verb} ${group.faces.length} face(s) from ${where}. ` +
    `Assign to approve, or refine with click/Ctrl-click.`);
}

function deselectAll() {
  selectedIds.clear();
  lastClickedIndex = -1;
  renderGrid();
  updateDetail();
  setStatus("Deselected all faces.");
}

function handleCellClick(e, face, idx) {
  // In the guesses view every face starts selected, so a plain click toggles
  // (deselects a wrong guess) rather than collapsing to a single selection.
  const toggle = e.ctrlKey || e.metaKey || (scope === "suggested" && !e.shiftKey);
  if (toggle) {
    selectedIds.has(face.id) ? selectedIds.delete(face.id) : selectedIds.add(face.id);
  } else if (e.shiftKey && lastClickedIndex >= 0) {
    const start = Math.min(lastClickedIndex, idx);
    const end = Math.max(lastClickedIndex, idx);
    for (let i = start; i <= end; i++) selectedIds.add(faces[i].id);
  } else {
    selectedIds.clear();
    selectedIds.add(face.id);
  }
  focusedFaceId = face.id;
  lastClickedIndex = idx;
  renderGrid();
  updateDetail();
}

/* ── Discover view (unsupervised clusters of unlabeled faces) ── */
async function loadClusters() {
  selectedIds.clear();
  focusedFaceId = null;
  updateActionButtons();
  updateDetail();
  setStatus("Finding groups… this can take a few seconds on a large library.");
  try {
    const res = await fetch("/api/faces/clusters" + (focusActive() ? "?" + focusQuery() : ""));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    clusters = data.clusters || [];
    renderClusters();
    if (!clusters.length) {
      setStatus(`No groups found among ${data.scanned} clear unlabeled faces. ` +
        `Tag a few faces and use “Find more”, or rescan if many are still pending.` +
        (focusActive() ? " (Focus is active — set “All time” to widen.)" : ""));
    } else {
      setStatus(`${clusters.length} group(s) across ${data.grouped} of ${data.scanned} ` +
        `faces. Name or assign each group, or Ignore it.`);
    }
  } catch (err) {
    setStatus("Clustering failed: " + err.message, true);
  }
}

function renderClusters() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  clusters.forEach(cl => grid.appendChild(makeClusterCard(cl)));
}

function makeClusterCard(cl) {
  const card = document.createElement("div");
  card.className = "cluster-card";

  const buttons = [];
  if (cl.suggestion) {
    buttons.push({
      icon: "✓", label: `Assign to ${cl.suggestion.person_name}`, kind: "primary",
      onClick: () =>
        clusterAssign(cl, { person_id: cl.suggestion.person_id }, cl.suggestion.person_name),
    });
  }
  buttons.push({
    icon: "✏️", label: cl.suggestion ? "Name instead…" : "Name…",
    kind: cl.suggestion ? "" : "primary",
    onClick: () => {
      const name = prompt(`Name this group of ${cl.size} face(s):`,
                          cl.suggestion ? cl.suggestion.person_name : "");
      if (name && name.trim()) clusterAssign(cl, { name: name.trim() }, name.trim());
    },
  });
  buttons.push({
    icon: "🚫", label: "Ignore all", kind: "danger",
    onClick: () => clusterIgnore(cl),
  });

  const place = locationLabel(cl.sample);
  card.appendChild(faceGroupHeader({
    title: cl.suggestion ? `Looks like ${cl.suggestion.person_name}` : "New group",
    meta: `· ${cl.size} face(s)` +
      (cl.suggestion ? ` · ${Math.round(cl.suggestion.score * 100)}% of group` : "") +
      (place ? ` · 📍 ${place}` : ""),
    buttons,
  }));

  const facesWrap = document.createElement("div");
  facesWrap.className = "cluster-faces";
  cl.sample.forEach(f => {
    const img = faceCropImg(f, { title: f.filename });
    if (f.id === focusedFaceId) img.classList.add("focused");
    const focus = () => {
      document.querySelectorAll(".cluster-faces img.focused")
        .forEach(el => el.classList.remove("focused"));
      img.classList.add("focused");
      focusedFaceId = f.id;
      updateDetail();
    };
    img.addEventListener("click", focus);          // left-click: show in detail
    img.addEventListener("contextmenu", (e) => {   // right-click: actions
      e.preventDefault();
      focus();
      openFaceActions(img, f);
    });
    facesWrap.appendChild(img);
  });
  if (cl.size > cl.sample.length) {
    const more = document.createElement("span");
    more.className = "cluster-more";
    more.textContent = `+${cl.size - cl.sample.length} more`;
    facesWrap.appendChild(more);
  }
  card.appendChild(facesWrap);
  return card;
}

async function clusterAssign(cl, who, label) {
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: cl.face_ids, ...who }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Assigned ${cl.face_ids.length} face(s) to ${label}.`);
    clusters = clusters.filter(c => c !== cl);
    if (cl.face_ids.includes(focusedFaceId)) { focusedFaceId = null; updateDetail(); }
    renderClusters();
    await loadPersons();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

async function clusterIgnore(cl) {
  if (!confirm(`Ignore all ${cl.size} face(s) in this group?`)) return;
  try {
    const res = await fetch("/api/faces/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: cl.face_ids, ignored: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Ignored ${cl.face_ids.length} face(s).`);
    clusters = clusters.filter(c => c !== cl);
    if (cl.face_ids.includes(focusedFaceId)) { focusedFaceId = null; updateDetail(); }
    renderClusters();
    await loadPersons();
  } catch (err) {
    setStatus("Ignore failed: " + err.message, true);
  }
}

/* ── Crowds view ── */
async function loadCrowds() {
  selectedIds.clear();
  focusedFaceId = null;
  updateActionButtons();
  updateDetail();
  setStatus("Loading crowd photos…");
  const minFaces = parseInt(document.getElementById("crowd-min-faces").value) || 50;
  const gap = parseInt(document.getElementById("crowd-gap-select").value) || 86400;
  try {
    let url = `/api/crowds?min_faces=${minFaces}&group_gap=${gap}`;
    if (focusActive()) url += "&" + focusQuery();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    crowdGroups = data.groups || [];
    renderCrowds();
    if (!crowdGroups.length) {
      setStatus(`No crowd photos found with ≥ ${minFaces} faces. ` +
        `Try lowering the threshold or scan more photos.` +
        (focusActive() ? " (Focus is active — set “All time” to widen.)" : ""));
    } else {
      setStatus(`${crowdGroups.length} event group(s) across ${data.photo_count} crowd photo(s). ` +
        `Open a photo, tag the key people, then ignore the rest.`);
    }
  } catch (err) {
    setStatus("Failed to load crowds: " + err.message, true);
  }
}

function renderCrowds() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  let visibleGroups = crowdGroups;
  if (hideCompletedCrowds) {
    visibleGroups = crowdGroups
      .map(g => ({ ...g, photos: g.photos.filter(p => p.unlabeled_faces > 0) }))
      .filter(g => g.photos.length > 0);
  }

  if (!visibleGroups.length && crowdGroups.length > 0) {
    const msg = document.createElement("div");
    msg.style.cssText = "color:#666;padding:16px;font-size:12px;grid-column:1/-1;";
    msg.textContent = 'All crowd photos are complete. Uncheck "Hide completed" to review them.';
    grid.appendChild(msg);
    return;
  }

  visibleGroups.forEach(g => grid.appendChild(makeCrowdGroupCard(g)));
}

function makeCrowdGroupCard(g) {
  const card = document.createElement("div");
  card.className = "cluster-card crowd-group-card";

  let ignoreBtn;   // captured from the header so per-photo actions can update it
  let meta = `· ${g.photos.length} photo(s) · ${g.total_faces} face(s)`;
  if (g.unlabeled_faces > 0) meta += ` · ${g.unlabeled_faces} unlabeled`;

  card.appendChild(faceGroupHeader({
    title: g.label,
    meta,
    extraClass: "amber",
    buttons: [{
      icon: "🚫", label: `Ignore ${g.unlabeled_faces} unlabeled`, kind: "danger",
      disabled: g.unlabeled_faces === 0,
      ref: (el) => { ignoreBtn = el; },
      onClick: () => crowdIgnoreGroup(g, ignoreBtn),
    }],
  }));

  const photosWrap = document.createElement("div");
  photosWrap.className = "crowd-photos";
  g.photos.forEach(ph => photosWrap.appendChild(makeCrowdPhotoThumb(ph, g, ignoreBtn)));
  card.appendChild(photosWrap);
  return card;
}

function makeCrowdPhotoThumb(ph, group, groupIgnoreBtn) {
  const cell = document.createElement("div");
  cell.className = "crowd-photo-cell";

  const img = document.createElement("img");
  img.src = `/api/thumbnail/${ph.id}`;
  img.loading = "lazy";
  img.title = `${ph.filename} — click to open`;
  img.addEventListener("click", () => window.open(`/api/preview/${ph.id}`, "_blank"));
  cell.appendChild(img);

  const badge = document.createElement("div");
  badge.className = "crowd-badge";
  const parts = [`${ph.total_faces} faces`];
  if (ph.labeled_faces)   parts.push(`${ph.labeled_faces} labeled`);
  if (ph.unlabeled_faces) parts.push(`${ph.unlabeled_faces} unlabeled`);
  badge.textContent = parts.join(" · ");
  cell.appendChild(badge);

  const actions = document.createElement("div");
  actions.className = "crowd-photo-actions";

  const ignoreBtn = document.createElement("button");
  ignoreBtn.className = "danger";
  ignoreBtn.textContent = "Ignore unlabeled";
  ignoreBtn.disabled = ph.unlabeled_faces === 0;
  ignoreBtn.addEventListener("click", async () => {
    try {
      const prevUnlabeled = ph.unlabeled_faces;
      await crowdIgnorePhotos([ph.id], ignoreBtn);
      group.unlabeled_faces -= prevUnlabeled;
      ph.unlabeled_faces = 0;
      ignoreBtn.disabled = true;
      badge.textContent = parts.filter(p => !p.includes("unlabeled")).join(" · ");
      // The group button is now an icon (🚫); update its tooltip, not its glyph.
      const groupLbl = `Ignore ${group.unlabeled_faces} unlabeled`;
      groupIgnoreBtn.title = groupLbl;
      groupIgnoreBtn.setAttribute("aria-label", groupLbl);
      groupIgnoreBtn.disabled = group.unlabeled_faces === 0;
    } catch (_) { /* error already shown in status bar */ }
  });
  actions.appendChild(ignoreBtn);

  const reviewBtn = document.createElement("button");
  reviewBtn.textContent = "Review";
  const minFaces = parseInt(document.getElementById("crowd-min-faces").value) || 50;
  const gap = parseInt(document.getElementById("crowd-gap-select").value) || 86400;
  reviewBtn.addEventListener("click", () => {
    window.location.href =
      `/crowd-review.html?photo_id=${ph.id}&min_faces=${minFaces}&group_gap=${gap}`;
  });
  actions.appendChild(reviewBtn);

  const openBtn = document.createElement("button");
  openBtn.textContent = "Photo ↗";
  openBtn.addEventListener("click", () => window.open(`/api/preview/${ph.id}`, "_blank"));
  actions.appendChild(openBtn);

  cell.appendChild(actions);
  return cell;
}

async function crowdIgnoreGroup(g, btn) {
  if (!confirm(`Ignore all ${g.unlabeled_faces} unlabeled face(s) across ${g.photos.length} photo(s) in this group?`)) return;
  const photoIds = g.photos.map(p => p.id);
  try {
    await crowdIgnorePhotos(photoIds, btn);
    g.unlabeled_faces = 0;
    g.photos.forEach(p => { p.unlabeled_faces = 0; });
    renderCrowds();
    await loadPersons();
  } catch (_) { /* error already shown in status bar */ }
}

async function crowdIgnorePhotos(photoIds, btn) {
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Ignoring…";
  try {
    const res = await fetch("/api/crowds/ignore-unlabeled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus(`Ignored ${data.ignored} face(s).`);
    await loadPersons();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevText;
    setStatus("Ignore failed: " + err.message, true);
    throw err;
  }
}

/* ── Detail pane ── */
// Resolve the focused face from the current grid (faces[]) or, in the Discover
// view, from a cluster's sample — both hold full face items.
function findFace(id) {
  const f = faces.find(x => x.id === id);
  if (f) return f;
  for (const cl of clusters) {
    const s = cl.sample.find(x => x.id === id);
    if (s) return s;
  }
  return null;
}

function updateDetail() {
  const placeholder = document.getElementById("detail-placeholder");
  const content = document.getElementById("detail-content");

  const face = findFace(focusedFaceId);
  if (!face) {
    placeholder.style.display = "block";
    content.style.display = "none";
    return;
  }
  placeholder.style.display = "none";
  content.style.display = "flex";

  document.getElementById("detail-img").src = `/api/preview/${face.photo_id}`;
  wireFullSizeButton(document.getElementById("detail-fullsize-btn"), face.filename, face.photo_id);

  // Position the bbox overlay (normalized coords map directly to percentages).
  applyBbox(document.getElementById("face-box"), face.bbox);

  const when = face.photo_datetime
    ? new Date(face.photo_datetime * 1000).toLocaleString() : "Unknown";
  const personCell = face.ignored
    ? "<i style='color:#999'>Ignored</i>"
    : (face.person_name || "<i style='color:#777'>Unassigned</i>");
  const loc = face.location;
  const placeStr = loc
    ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ")
    : null;
  document.getElementById("detail-meta").innerHTML = `
    <tr><td>Photo</td><td>${face.filename}</td></tr>
    <tr><td>Taken</td><td>${when}</td></tr>
    ${placeStr ? `<tr><td>Location</td><td>${placeStr}</td></tr>` : ""}
    <tr><td>Person</td><td>${personCell}</td></tr>
    <tr><td>Detection</td><td>${face.det_score.toFixed(3)}</td></tr>
  `;
  const detailIgnoreBtn = document.getElementById("detail-ignore-btn");
  detailIgnoreBtn.textContent = face.ignored ? "↩" : "🚫";
  detailIgnoreBtn.title = face.ignored ? "Restore" : "Ignore";
  detailIgnoreBtn.setAttribute("aria-label", detailIgnoreBtn.title);

  const sug = document.getElementById("face-suggestion");
  const alts = face.alternatives || [];
  if (!face.person_name && face.suggestion) {
    sug.style.display = "flex";
    sug.innerHTML = "";

    const primary = document.createElement("div");
    primary.className = "sug-primary";
    primary.innerHTML =
      `<span class="sug-text">Looks like <b>${face.suggestion.person_name}</b> ` +
      `(${face.suggestion.score})</span>`;
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "primary";
    confirmBtn.textContent = "Confirm";
    confirmBtn.addEventListener("click", () => confirmFace(face.id, face.suggestion.person_id));
    primary.appendChild(confirmBtn);
    const notBtn = document.createElement("button");
    notBtn.className = "danger";
    notBtn.textContent = `Not ${face.suggestion.person_name}`;
    notBtn.title = `Mark this face as definitely not ${face.suggestion.person_name}`;
    notBtn.addEventListener("click", () =>
      rejectSuggestion(face.id, face.suggestion.person_id, face.suggestion.person_name));
    primary.appendChild(notBtn);
    sug.appendChild(primary);

    if (alts.length) {
      const altWrap = document.createElement("div");
      altWrap.className = "sug-alts";
      const label = document.createElement("span");
      label.className = "sug-alts-label";
      label.textContent = "…or maybe:";
      altWrap.appendChild(label);
      alts.forEach(alt => {
        const group = document.createElement("span");
        group.className = "sug-alt-group";
        const b = document.createElement("button");
        b.className = "alt-btn";
        b.textContent = `${alt.person_name} (${alt.score})`;
        b.title = `Tag this face as ${alt.person_name} instead`;
        b.addEventListener("click", () => confirmFace(face.id, alt.person_id));
        group.appendChild(b);
        const notB = document.createElement("button");
        notB.className = "alt-btn alt-not-btn";
        notB.textContent = "✕";
        notB.title = `Not ${alt.person_name}`;
        notB.addEventListener("click", () => rejectSuggestion(face.id, alt.person_id, alt.person_name));
        group.appendChild(notB);
        altWrap.appendChild(group);
      });
      sug.appendChild(altWrap);
    }
  } else {
    sug.style.display = "none";
  }

  // Faces already marked "not this person" — reversible.
  const negBox = document.getElementById("face-negatives");
  const negatives = face.negatives || [];
  if (negatives.length) {
    negBox.style.display = "flex";
    negBox.innerHTML = "";
    const title = document.createElement("div");
    title.className = "neg-title";
    title.textContent = "Marked as NOT this face:";
    negBox.appendChild(title);
    negatives.forEach(pid => {
      const name = persons.find(p => p.id === pid)?.name || "Unknown";
      const row = document.createElement("div");
      row.className = "neg-row";
      const label = document.createElement("span");
      label.textContent = name;
      row.appendChild(label);
      const undoBtn = document.createElement("button");
      undoBtn.className = "neg-undo-btn";
      undoBtn.textContent = "↩ Undo";
      undoBtn.title = `Allow ${name} to be suggested for this face again`;
      undoBtn.addEventListener("click", () => rejectSuggestion(face.id, pid, name, false));
      row.appendChild(undoBtn);
      negBox.appendChild(row);
    });
  } else {
    negBox.style.display = "none";
  }
}

/* ── Assignment ── */
function selectionOrFocused() {
  if (selectedIds.size > 0) return [...selectedIds];
  return focusedFaceId ? [focusedFaceId] : [];
}

async function assignSelected(personId, clear = false) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  const msg = clear
    ? `Unassign ${ids.length} face(s)?`
    : `Assign ${ids.length} face(s) to ${persons.find(p => p.id === personId)?.name || "this person"}?`;
  if (!confirmSelection(ids.length, msg)) return;
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, person_id: personId, clear }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(clear ? `Unassigned ${ids.length} face(s).` : `Assigned ${ids.length} face(s).`);
    selectedIds.clear();
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

// Detail-pane assignment: act on the single previewed face (focusedFaceId) via the
// per-face endpoint, leaving the grid selection untouched. Handles all three detail
// buttons — assign to a person, create a new person (name), or unassign (clear).
async function assignFocusedFace({ personId = null, name = null, clear = false } = {}) {
  const f = findFace(focusedFaceId);
  if (!f) { setStatus("Select a face first.", true); return; }
  const body = clear ? { person_id: null } : name ? { name } : { person_id: personId };
  try {
    const res = await fetch(`/api/faces/${f.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const who = clear ? null : (name || persons.find(p => p.id === personId)?.name);
    setStatus(clear ? "Unassigned this face." : `Assigned this face${who ? ` to ${who}` : ""}.`);
    // Only this face changes — drop just it from the selection, keep the rest.
    selectedIds.delete(f.id);
    if (focusedFaceId === f.id) focusedFaceId = null;
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

async function ignoreSelected(ignored) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  const verb = ignored ? "Ignore" : "Restore";
  if (!confirmSelection(ids.length, `${verb} ${ids.length} face(s)?`)) return;
  await ignoreSelected_ids(ids, ignored);
}

async function ignoreSelected_ids(ids, ignored) {
  try {
    const res = await fetch("/api/faces/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, ignored }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(ignored ? `Ignored ${ids.length} face(s).` : `Restored ${ids.length} face(s).`);
    selectedIds.clear();
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Ignore failed: " + err.message, true);
  }
}

// Nuclear option: wipe every face (detected/assigned/ignored) + every cached
// rendition (thumb/preview/face-crop) for the photo(s) behind the selected
// face(s), so a rescan re-detects those photos from scratch. Acts on the whole
// photo, not just the selected face — a bad detection pass usually needs the
// whole slate cleared, not one crop.
async function nukeSelectedPhotos() {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  const photoIds = [...new Set(ids.map(id => findFace(id)?.photo_id).filter(Boolean))];
  if (photoIds.length === 0) { setStatus("Could not resolve photos for the selected face(s).", true); return; }
  const plural = photoIds.length === 1 ? "photo" : "photos";
  if (!confirm(
    `Nuclear option: permanently delete ALL faces (detected, assigned, and ignored) ` +
    `for ${photoIds.length} ${plural}, and wipe their cached thumbnails/previews so ` +
    `detection starts completely from scratch. This cannot be undone. Continue?`
  )) return;
  try {
    const res = await fetch("/api/faces/nuke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus(`Nuked ${data.faces_deleted} face(s) across ${data.photos} ${plural}. Rescan to re-detect.`);
    selectedIds.clear();
    focusedFaceId = null;
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Nuke failed: " + err.message, true);
  }
}

function updateActionButtons() {
  // The ignore button restores in the Ignored scope, ignores elsewhere. It's an
  // icon button now, so swap the glyph and keep the tooltip/aria-label in sync
  // (mirrors the detail-pane ignore/restore toggle).
  const ignoreBtn = document.getElementById("ignore-btn");
  const restoring = scope === "ignored";
  ignoreBtn.textContent = restoring ? "↩" : "🚫";
  ignoreBtn.title = restoring
    ? "Restore selected faces"
    : "Hide selected faces from the queue (background strangers, false detections)";
  ignoreBtn.setAttribute("aria-label", restoring ? "Restore" : "Ignore");

  // "Only suggested" applies to the Unlabeled queue only.
  const chk = document.getElementById("suggested-only-chk");
  chk.checked = suggestedOnly;
  chk.disabled = scope !== "unlabeled";
  document.getElementById("suggested-only-label").style.opacity =
    scope === "unlabeled" ? "1" : "0.45";
}

async function assignSelectedToNewPerson() {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  const name = prompt("Name for this person:");
  if (!name || !name.trim()) return;
  if (!confirmSelection(ids.length, `Assign ${ids.length} face(s) to ${name.trim()}?`)) return;
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, name: name.trim() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Assigned ${ids.length} face(s) to ${name.trim()}.`);
    selectedIds.clear();
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

/* ── Quick-action popup ──
 * The popup itself (DOM, positioning, toggle, outside-click close) lives in
 * face-grid.js; here we only supply this page's data and action callbacks. */
function openFaceActions(anchor, face) {
  openQuickActions(anchor, face, {
    persons,
    onAssign: (pid) => confirmFace(face.id, pid),   // pid null ⇒ unassign
    onAssignNew: async (name) => {
      try {
        const res = await fetch(`/api/faces/${face.id}/assign`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await Promise.all([loadPersons(), loadFaces()]);
      } catch (err) { setStatus("Assign failed: " + err.message, true); }
    },
    onIgnore: async (ignored) => {
      try {
        const res = await fetch("/api/faces/ignore", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ face_ids: [face.id], ignored }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadFaces();
      } catch (err) { setStatus("Ignore failed: " + err.message, true); }
    },
    onNotPerson: (personId, personName) => rejectSuggestion(face.id, personId, personName),
    onOpenPhoto: () => window.open(`/api/preview/${face.photo_id}`, "_blank"),
  });
}

async function confirmFace(faceId, personId) {
  try {
    const res = await fetch(`/api/faces/${faceId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: personId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    selectedIds.delete(faceId);
    if (focusedFaceId === faceId) focusedFaceId = null;
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Confirm failed: " + err.message, true);
  }
}

// Mark (or undo marking) a face as "definitely not this person" — removes the
// person from that face's recognition ranking so its next-best guess surfaces
// instead of the face bouncing back to the same rejected suggestion on refetch.
async function rejectSuggestion(faceId, personId, personName, negative = true) {
  try {
    const res = await fetch("/api/faces/negatives", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: [faceId], person_id: personId, negative }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(negative ? `Marked as not ${personName}.`
                       : `Undid: ${personName} can be suggested again.`);
    await loadFaces();
  } catch (err) {
    setStatus((negative ? "Reject" : "Undo") + " failed: " + err.message, true);
  }
}

async function acceptSuggestionsForSelection() {
  const ids = new Set(selectionOrFocused());
  const faceList = faces.filter(f => ids.has(f.id));
  // Count only the faces that would actually be accepted (guessed, not yet named
  // or ignored) — the same predicate acceptSuggestionsFor uses — and confirm past
  // the threshold so a large accidental batch isn't approved in one click.
  const targets = faceList.filter(f => f.suggestion && !f.person_name && !f.ignored);
  if (!confirmSelection(targets.length, `Accept the suggested name for ${targets.length} face(s)?`)) {
    return;
  }
  await acceptSuggestionsFor(faceList);
}

async function acceptSuggestionsFor(faceList, label) {
  // Accept the suggested identity for each guessed, not-yet-decided face.
  const targets = faceList.filter(f => f.suggestion && !f.person_name && !f.ignored);
  const where = label ? ` in ${label}` : "";
  if (targets.length === 0) {
    setStatus(`No suggestions to accept${where}.`, true);
    return;
  }
  // Group by suggested person so we can bulk-assign each group.
  const byPerson = {};
  targets.forEach(f => {
    (byPerson[f.suggestion.person_id] ||= []).push(f.id);
  });
  try {
    for (const [pid, faceIds] of Object.entries(byPerson)) {
      await fetch("/api/faces/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ face_ids: faceIds, person_id: parseInt(pid) }),
      });
    }
    setStatus(`Accepted suggestions for ${targets.length} face(s)${where}.`);
    selectedIds.clear();
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Accept failed: " + err.message, true);
  }
}

/* ── Person CRUD ── */
async function addPerson() {
  const name = prompt("New person's name:");
  if (!name || !name.trim()) return;
  try {
    await fetch("/api/persons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    await loadPersons();
  } catch (err) {
    setStatus("Could not add person: " + err.message, true);
  }
}

async function editPersonBirth(personId, name, current) {
  const val = prompt(`Birth date for ${name} (YYYY-MM-DD), or blank to clear:`, current || "");
  if (val === null) return;  // cancelled
  const birth = val.trim() || null;
  try {
    const res = await fetch(`/api/persons/${personId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ birth_date: birth }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${res.status}`);
    }
    setStatus(birth ? `Set ${name}'s birth date to ${birth}.` : `Cleared ${name}'s birth date.`);
    await loadPersons();
    // Suggestions depend on birth dates, so refresh the current view.
    if (scope === "unlabeled" || scope === "suggested") await loadFaces();
  } catch (err) {
    setStatus("Could not set birth date: " + err.message, true);
  }
}

async function deletePerson(personId, name) {
  if (!confirm(`Delete "${name}"? Their faces will become unassigned.`)) return;
  try {
    await fetch(`/api/persons/${personId}`, { method: "DELETE" });
    if (scope === "person" && scopePersonId === personId) {
      scope = "unlabeled"; scopePersonId = null;
    }
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Could not delete person: " + err.message, true);
  }
}

