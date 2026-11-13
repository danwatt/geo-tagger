/* ── State ── */
let faces = [];                 // faces for the current scope
let persons = [];               // full [{id, name, face_count}] — dropdowns, lookups
let navPersons = [];            // people shown in the left nav (windowed under Focus)
let selectedIds = new Set();    // selected face ids
let lastClickedIndex = -1;
let focusedFaceId = null;
// Faces in the order the grid last rendered them — grouping (month/place,
// person, batches) reorders relative to `faces` itself, so shift-click range
// select and arrow-key navigation must index off this, not `faces`. Rebuilt
// at the top of every renderGrid() call.
let renderOrder = [];

let scope = "unlabeled";        // "unlabeled" | "all" | "person"
let scopePersonId = null;       // when scope === "person"

let suggestedOnly = false;      // Unlabeled queue: hide faces with no guess
// Unlabeled queue: narrow the grid to faces whose *top* guess is one person.
// The filter is applied client-side over the loaded queue, so `unlabeledAll`
// keeps the full flattened list and `faces` is the filtered view actually shown.
let suggestFilterPersonId = null;               // person_id, or null for "all suggestions"
let unlabeledAll = [];                          // full loaded queue (master; drives the dropdown + filter)
let unlabeledMeta = { total: 0, returned: 0 };  // server counts for the loaded queue (status text)
// Frozen person-run ordering: "<bucket key>|<person id>" → the earliest photo
// timestamp that person had in that bucket *the first time we saw the bucket*.
// Staging/committing removes faces from the grid, which would otherwise raise a
// person's earliest timestamp and shuffle their run under the cursor mid-pass —
// so the rank is captured once per load and reused. Cleared on refetch.
let runOrderRank = new Map();
let clusters = [];              // discovered groups (Discover view)
let crowdGroups = [];           // crowd photo groups (Crowds view)
let hideCompletedCrowds = true; // hide crowd photos with no unlabeled faces

// Staged, not-yet-saved decisions: face id → { face, kind, personId, name }.
// Every non-destructive action on a flat grid (assign / unassign / ignore /
// come back / restore) parks the face here instead of POSTing, so a tagging
// pass can be reviewed — and re-targeted or thrown away — before it touches the
// database. See the "Staging area" section below. The nuclear option and the
// "not this person" negatives stay immediate: the first is explicitly
// destructive, the second is a recognition hint whose whole point is to
// re-rank the remaining guesses right away.
let pending = new Map();

let groupGapSeconds = 86400;    // event grouping gap in the guesses view (1 day)

// How the group-rendering grids (Discover / Crowds / Unlabeled / guesses) order
// their groups: "date" | "count" | "location" | "dir" — see sortGroups() in
// face-grid.js.
// Purely a render-time concern (no refetch), and persisted across reloads.
const GRID_SORT_LS_KEY = "geotagger.people.gridSort";
let gridSort = localStorage.getItem(GRID_SORT_LS_KEY) || "date";
if (!GROUP_SORT_MODES.includes(gridSort)) gridSort = "date";

// Unlabeled queue: which level nests inside which. "date" = month → location →
// person (computeMonthLocationGroups, default); "person" = suggested person →
// date-range chunks within that person (computeUnlabeledPersonGroups); "photo" =
// one group per source photo; "directory" = one group per containing folder
// (computeUnlabeledDirGroups — the only useful axis for scanned/undated batches,
// which have neither a timestamp nor GPS). Persisted so the choice survives a
// reload.
const UNLABELED_HIERARCHIES = ["date", "person", "photo", "directory"];
const UNLABELED_HIERARCHY_LS_KEY = "geotagger.people.unlabeledHierarchy";
let unlabeledHierarchy = localStorage.getItem(UNLABELED_HIERARCHY_LS_KEY) || "date";
if (!UNLABELED_HIERARCHIES.includes(unlabeledHierarchy)) unlabeledHierarchy = "date";

// Focus: narrows the tagging/discovery surfaces (people list, Unlabeled,
// suggestions, Discover, Crowds) to one Year's time window. null = all time.
// The per-person / All / Recently-tagged views and the recognition gallery are
// unaffected — only the *candidates* shown are windowed.
let focusStartTs = null;        // epoch secs, or null
let focusEndTs = null;          // epoch secs, or null
let focusLabel = null;          // active window's name (for status messages)
let focusYears = [];            // distinct years present in the library, descending
let jumpToUndated = false;      // one-shot: scroll to the Undated section once loaded (?month=undated)
const FOCUS_LS_KEY = "geotagger.people.focusYear";

// Max faces fetched per grid load. Loaded from the server's FACE_QUERY_LIMIT
// setting (see loadLiveSettings, which pulls both in one /api/settings
// call); this default is only used if that fetch hasn't resolved yet.
let FACE_LIMIT = 5000;
// Auto-select bar for the Unlabeled queue: a suggestion only exists at all above
// FACE_MATCH_THRESHOLD, so this higher cutoff pre-selects just the confident
// guesses and leaves weaker ones for manual triage. Loaded from the server's
// FACE_PRESELECT_MIN_SCORE setting (see loadLiveSettings); this default is
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
  bindDetailResizer();
  bindKeyboardShortcuts();
  await loadLiveSettings();  // before loadFaces, so the first render pre-selects correctly
  await loadFocusYears();      // restores any saved Focus before the first load
  await loadPersons();

  // Deep-link from the Search page: people.html?person=<id>&review=suggested
  // opens straight to that person's suggestion queue (from "find untagged
  // faces"); people.html?person=<id> alone (from "Open in People" on a
  // single-person search) opens their tagged-faces scope instead.
  const qp = new URLSearchParams(window.location.search);
  const linkPersonId = qp.get("person") ? parseInt(qp.get("person")) : null;
  if (linkPersonId && qp.get("review") === "suggested") {
    await selectScope("suggested", linkPersonId);
  } else if (linkPersonId) {
    await selectScope("person", linkPersonId);
  } else {
    await loadFaces();
  }
  setStatus("Select a person on the left, or scan for faces to begin.");
});

// Pulls live settings tunable on the Settings page — FACE_PRESELECT_MIN_SCORE
// (Unlabeled queue pre-select cutoff) and FACE_QUERY_LIMIT (grid page size) —
// so both stay in sync without a code change.
async function loadLiveSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = await res.json();
    const scoreSpec = data.settings.find(s => s.key === "FACE_PRESELECT_MIN_SCORE");
    if (scoreSpec) CONFIDENT_SCORE = scoreSpec.value;
    const limitSpec = data.settings.find(s => s.key === "FACE_QUERY_LIMIT");
    if (limitSpec) FACE_LIMIT = limitSpec.value;
  } catch (e) {
    // Keep the built-in defaults if settings can't be reached.
  }
}

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}

/* ── Detail-pane resizer ──
 * The preview is the one pane whose useful width depends on the monitor and on
 * the photo: a wide desktop can spare far more than the 340px default, and a
 * face is much easier to judge large. The handle moves the grid/detail seam and
 * nothing else — the people list keeps its fixed column — and the width is
 * persisted, since this is a per-display preference, not a per-visit one. */
const DETAIL_W_LS_KEY = "geotagger.people.detailWidth";
const DETAIL_W_DEFAULT = 340;
const DETAIL_W_MIN = 240;

// The grid has to stay a grid, so the ceiling is "whatever is left after the
// people list, the handle, and room for a couple of columns of faces" rather
// than a flat percentage — a percentage that looks sane at 2560px starves the
// grid at 1280. DETAIL_W_MIN still wins on a window too narrow for even that.
// Re-clamped on resize so a width saved on a wide monitor doesn't swallow a
// narrow one. Returns the width actually applied.
const PEOPLE_LIST_W = 220;   // matches the fixed first column in people.css
const RESIZER_W = 6;
const GRID_MIN_W = 320;      // ~2 columns of face cells

function setDetailWidth(px, persist = true) {
  const max = Math.max(
    DETAIL_W_MIN,
    window.innerWidth - PEOPLE_LIST_W - RESIZER_W - GRID_MIN_W);
  const w = Math.round(Math.max(DETAIL_W_MIN, Math.min(max, px)));
  document.getElementById("people-main").style.setProperty("--detail-pane-w", `${w}px`);
  const handle = document.getElementById("detail-resizer");
  if (handle) handle.setAttribute("aria-valuenow", String(w));
  if (persist) localStorage.setItem(DETAIL_W_LS_KEY, String(w));
  return w;
}

function bindDetailResizer() {
  const handle = document.getElementById("detail-resizer");
  const pane = document.getElementById("detail-pane");
  const main = document.getElementById("people-main");
  if (!handle || !pane || !main) return;

  const saved = parseInt(localStorage.getItem(DETAIL_W_LS_KEY) || "", 10);
  setDetailWidth(Number.isFinite(saved) ? saved : DETAIL_W_DEFAULT, false);
  handle.setAttribute("aria-valuemin", String(DETAIL_W_MIN));

  // Pointer capture keeps the drag alive over the grid's cells and past the
  // window edge; without it the first cell the pointer crosses eats the moves.
  let dragging = false;
  handle.addEventListener("pointerdown", e => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    main.classList.add("pane-resizing");
    e.preventDefault();   // no text selection / native image drag mid-resize
  });
  handle.addEventListener("pointermove", e => {
    if (!dragging) return;
    // Width measured from the pointer to the window's right edge, so the seam
    // tracks the cursor exactly however far the drag has wandered.
    setDetailWidth(window.innerWidth - e.clientX);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    main.classList.remove("pane-resizing");
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("lostpointercapture", stop);

  handle.addEventListener("dblclick", () => setDetailWidth(DETAIL_W_DEFAULT));

  // Keyboard equivalent — the handle is a focusable separator, so arrows nudge
  // it and Home returns to the default.
  handle.addEventListener("keydown", e => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === "ArrowLeft")       setDetailWidth(pane.offsetWidth + step);
    else if (e.key === "ArrowRight") setDetailWidth(pane.offsetWidth - step);
    else if (e.key === "Home")       setDetailWidth(DETAIL_W_DEFAULT);
    else return;
    e.preventDefault();
  });

  // Re-clamp against the new viewport, but keep the stored preference: a width
  // that doesn't fit today's window should come back when the window grows.
  window.addEventListener("resize", () => {
    const stored = parseInt(localStorage.getItem(DETAIL_W_LS_KEY) || "", 10);
    setDetailWidth(Number.isFinite(stored) ? stored : DETAIL_W_DEFAULT, false);
  });
}

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("quicktag-view-btn").addEventListener("click", () => {
    window.location.href = "/tag.html";
  });
  document.getElementById("manage-view-btn").addEventListener("click", () => {
    window.location.href = "/people-manage.html";
  });

  document.getElementById("focus-year-select").addEventListener("change", onFocusChange);

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
  const hierarchySel = document.getElementById("unlabeled-hierarchy-select");
  hierarchySel.value = unlabeledHierarchy;
  hierarchySel.addEventListener("change", (e) => {
    unlabeledHierarchy = e.target.value;
    localStorage.setItem(UNLABELED_HIERARCHY_LS_KEY, unlabeledHierarchy);
    // Person-first hierarchy has no sortable groups — refresh the nav bar too.
    updateGridNavVisibility();
    renderGrid();
    if (scope === "unlabeled") updateUnlabeledStatus();
  });

  document.getElementById("assign-btn").addEventListener("click", openAssignPickerForSelection);
  document.getElementById("unassign-btn").addEventListener("click", () => assignSelected(null, true));
  document.getElementById("confirm-suggested-btn").addEventListener("click", acceptSuggestionsForSelection);
  // In the Ignored scope this button restores; everywhere else it ignores.
  document.getElementById("ignore-btn").addEventListener("click", () => ignoreSelected(scope !== "ignored"));
  // In the Come Back scope this button restores; everywhere else it defers.
  document.getElementById("come-back-btn").addEventListener("click", () => comeBackSelected(scope !== "come_back"));
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

  const sortSelect = document.getElementById("grid-sort-select");
  sortSelect.value = gridSort;
  sortSelect.addEventListener("change", e => {
    gridSort = e.target.value;
    localStorage.setItem(GRID_SORT_LS_KEY, gridSort);
    // Sorting is render-only — no refetch, and the selection survives.
    if (scope === "discover")    renderClusters();
    else if (scope === "crowds") renderCrowds();
    else                         renderGrid();
  });

  document.getElementById("add-person-btn").addEventListener("click", addPerson);

  // Detail-pane assignment controls act on the ONE previewed face only — never the
  // grid selection (the toolbar's "Assign selection" is for that). Mirrors the
  // detail Ignore button below, which already scopes to the focused face.
  document.getElementById("detail-assign-btn").addEventListener("click", () => {
    if (!findFace(focusedFaceId)) { setStatus("Select a face first.", true); return; }
    openPersonPicker(persons, {
      title: "Assign to…",
      onPick: (who) => assignFocusedFace(who.person_id ? { personId: who.person_id } : { name: who.name }),
    });
  });
  document.getElementById("detail-unassign-btn").addEventListener("click", () => assignFocusedFace({ clear: true }));
  document.getElementById("detail-ignore-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (!f) { setStatus("Select a face first.", true); return; }
    // Act on the previewed face only — not the grid selection.
    ignoreSelected_ids([f.id], !f.ignored);
  });
  document.getElementById("detail-come-back-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (!f) { setStatus("Select a face first.", true); return; }
    // Act on the previewed face only — not the grid selection.
    comeBackSelected_ids([f.id], !f.come_back);
  });
  document.getElementById("detail-open-photo-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (f) window.open(`/api/preview/${f.photo_id}`, "_blank");
  });
  document.getElementById("detail-photo-faces-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (!f) { setStatus("Select a face first.", true); return; }
    window.location.href = `/photo-faces.html?photo_id=${f.photo_id}`;
  });

  document.getElementById("commit-all-btn").addEventListener("click",
    () => commitPending(groupPendingEntries()));
  document.getElementById("revert-all-btn").addEventListener("click",
    () => revertPending(groupPendingEntries()));
  // Staged changes live only in this tab — don't let a reload eat a tagging pass.
  window.addEventListener("beforeunload", (e) => {
    if (!pending.size) return;
    e.preventDefault();
    e.returnValue = "";
  });

  document.getElementById("shortcuts-help-btn").addEventListener("click", openShortcutsHelp);
  document.getElementById("shortcuts-help-close").addEventListener("click", closeShortcutsHelp);
  document.getElementById("shortcuts-help-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "shortcuts-help-backdrop") closeShortcutsHelp();
  });
}

// Opens the "Assign selection to…" picker — shared by the toolbar button and
// the `a`/Enter keyboard shortcut.
function openAssignPickerForSelection() {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  openPersonPicker(persons, {
    title: `Assign ${ids.length} face(s) to…`,
    onPick: (who, label) => assignSelectedTo(who, label),
  });
}

/* ── Time Focus ──
 * The Focus dropdown windows the tagging surfaces to one calendar Year (all
 * photos taken in it). Option values are prefixed "y:"; a "?month=YYYY-MM" URL
 * argument adds a one-shot "m:" option for a single month. */
async function loadFocusYears() {
  const sel = document.getElementById("focus-year-select");
  try {
    const res = await fetch("/api/stats/years");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    focusYears = data.years;
  } catch (err) {
    focusYears = [];   // non-fatal: Focus just stays at "All time"
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
  } else if (monthArg === "undated") {
    // "?month=undated" (from the homepage's Undated link) — leave Focus at "All
    // time" and skip restoring any saved Focus below: a saved time window would
    // hide undated faces entirely (no photo_datetime to fall inside any window).
    // loadFaces scrolls to the Undated section once the queue renders.
    jumpToUndated = true;
  } else {
    // Restore a previously chosen Focus so the window survives reloads.
    const saved = localStorage.getItem(FOCUS_LS_KEY);
    if (saved && focusYears.some(y => `y:${y}` === saved)) {
      sel.value = saved;
    }
  }
  applyFocusFromSelect();   // sets state + note; the initial load picks it up
}

// Read the dropdown, set the active window (state + localStorage + note). Does
// not reload — callers decide whether to refresh the views.
function applyFocusFromSelect() {
  const sel = document.getElementById("focus-year-select");
  const val = sel.value;

  if (val.startsWith("m:")) {
    // A calendar month (from a "?month=YYYY-MM" URL argument), computed as a
    // UTC range for the same reason the Year case is — matches photo_datetime
    // bucketing. Not persisted to localStorage: URL-driven, one-shot on arrival,
    // not a saved preference.
    const [year, month] = val.slice(2).split("-").map(Number);
    focusStartTs = Date.UTC(year, month - 1, 1) / 1000;
    focusEndTs = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) / 1000;
    focusLabel = `${MONTH_NAMES[month - 1]} ${year}`;
    updateFocusNote();
    return;
  }

  if (val.startsWith("y:")) {
    // A calendar year, computed as a UTC range to match how the backend buckets
    // photo_datetime (strftime(..., 'unixepoch') is UTC).
    const year = parseInt(val.slice(2), 10);
    focusStartTs = Date.UTC(year, 0, 1) / 1000;
    focusEndTs = Date.UTC(year + 1, 0, 1) / 1000;
    focusLabel = String(year);
    localStorage.setItem(FOCUS_LS_KEY, val);
    updateFocusNote();
    return;
  }

  // "All time"
  focusStartTs = null;
  focusEndTs = null;
  focusLabel = null;
  localStorage.removeItem(FOCUS_LS_KEY);
  updateFocusNote();
}

async function onFocusChange() {
  applyFocusFromSelect();
  // Re-render the left nav (windowed people list + Unlabeled count) and the grid.
  await loadPersons();
  await loadFaces();
}

function focusActive() {
  return focusStartTs != null || focusEndTs != null;
}

// Query fragment (no leading separator) for the active Focus, else "".
function focusQuery() {
  const parts = [];
  if (focusStartTs != null) parts.push(`start_ts=${focusStartTs}`);
  if (focusEndTs != null) parts.push(`end_ts=${focusEndTs}`);
  return parts.join("&");
}

// " · Focus: <name>" for windowed status lines, or "" when no Focus is active.
function focusStatusSuffix() {
  if (!focusActive()) return "";
  return ` · Focus: ${focusLabel || "time window"}`;
}

function updateFocusNote() {
  const note = document.getElementById("focus-note");
  document.getElementById("focus-year-select").classList.toggle("focus-active", focusActive());
  if (!focusActive()) { note.textContent = ""; note.title = ""; return; }
  note.textContent = "◦ windowing people, Unlabeled, suggestions, Discover & Crowds";
  note.title = focusLabel ? `Focused on ${focusLabel}` : "";
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
                     status.ignored_faces || 0, status.come_back_faces || 0,
                     status.tagged_faces || 0);
    populatePersonSelects();
  } catch (err) {
    setStatus("Failed to load people: " + err.message, true);
  }
}

function renderPeopleList(unlabeledCount, allCount, ignoredCount, comeBackCount, taggedCount) {
  const list = document.getElementById("people-list");
  list.innerHTML = "";

  list.appendChild(makeScopeItem("Unlabeled", unlabeledCount, "unlabeled", null));
  list.appendChild(makeScopeItem("Discover groups", null, "discover", null));
  list.appendChild(makeScopeItem("Crowds", null, "crowds", null));
  list.appendChild(makeScopeItem("Recently tagged", taggedCount, "recent", null));
  list.appendChild(makeScopeItem("All faces", allCount, "all", null));
  list.appendChild(makeScopeItem("Ignored", ignoredCount, "ignored", null));
  list.appendChild(makeScopeItem("Come Back", comeBackCount, "come_back", null));

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
  ["guess-person-select"].forEach(id => {
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
  // Sort applies to the group-rendering grids only. The Unlabeled queue's
  // person-first hierarchy orders its own groups by person name, so it opts out
  // (date, photo and directory hierarchies all sort their groups).
  const showSort = scope === "discover" || scope === "crowds" || scope === "suggested" ||
    (scope === "unlabeled" && unlabeledHierarchy !== "person");
  document.getElementById("grid-nav-person").style.display = showPerson ? "" : "none";
  document.getElementById("grid-nav-crowds").style.display = showCrowds ? "" : "none";
  document.getElementById("grid-nav-unlabeled").style.display = showUnlabeled ? "" : "none";
  // "Group by" only drives the Unlabeled queue's render — every other scope has
  // its own fixed grouping, so the dropdown would be a dead control there.
  document.getElementById("grid-nav-hierarchy").style.display = showUnlabeled ? "" : "none";
  document.getElementById("grid-nav-selection").style.display = showSelection ? "" : "none";
  if (showSelection) paintSelectionCount();
  document.getElementById("grid-nav-sort").style.display = showSort ? "" : "none";
  document.getElementById("grid-nav").style.display =
    (showPerson || showCrowds || showUnlabeled || showSelection || showSort) ? "" : "none";
}

/* ── Faces grid ── */
async function loadFaces() {
  taggedPeopleCache.clear();   // person tags may have changed since last fetch
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
      // then pre-select every guess (Accept suggestions confirms them in bulk).
      faces.sort((a, b) => (a.photo_datetime || Infinity) - (b.photo_datetime || Infinity));
      // Staged faces aren't in the grid, so they're neither selected nor focused.
      const visible = gridFaces();
      selectedIds = new Set(visible.map(f => f.id));
      focusedFaceId = visible.length ? visible[0].id : null;
    } else if (scope === "recent") {
      // Newest tag first (the server already orders this way; keep it explicit).
      faces.sort((a, b) => (b.assigned_at || 0) - (a.assigned_at || 0));
    } else if (scope === "unlabeled") {
      // Oldest first so each month's location buckets land in first-seen
      // (chronological) order, then flatten into that month → location order.
      // (Shift-range/arrow nav index off `renderOrder`, built fresh each
      // render, so this doesn't need to match the on-screen order itself —
      // but keeping it chronological is what makes the per-bucket ordering,
      // e.g. sortBucketBySuggestion, well-defined.) This is the master list;
      // the suggested-person filter narrows it into `faces` in applyUnlabeledView.
      faces.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
      // Fresh data → re-freeze run order, off the full queue (this call sees every
      // face, so the frozen ranks survive later staging/commits within this load).
      runOrderRank = new Map();
      unlabeledAll = computeMonthLocationGroups(faces).flatMap(g => g.faces);
      unlabeledMeta = { total: data.total, returned: data.returned };
      populateSuggestFilter();
      applyUnlabeledView();   // owns faces/selection/render/status for this scope
      if (jumpToUndated) { jumpToUndated = false; scrollToUndatedSection(); }
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
      const label = scope === "person" ? personName : scope === "come_back" ? "Come Back" : scope;
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
  // Staged faces aren't in the grid, so they're neither selected nor focused.
  const visible = gridFaces();
  selectedIds = new Set(
    visible.filter(f => f.suggestion && f.suggestion.score >= CONFIDENT_SCORE
                        && !f.person_name && !f.ignored)
           .map(f => f.id));
  focusedFaceId = visible.length ? visible[0].id : null;

  updateActionButtons();
  renderGrid();
  updateDetail();
  updateUnlabeledStatus();
}

// Status line for the Unlabeled queue. Split out of applyUnlabeledView because a
// hierarchy change re-renders without refetching or reselecting, and still has to
// restate how the queue is grouped.
function updateUnlabeledStatus() {
  const pid = suggestFilterPersonId;
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
  const groupedBy = unlabeledHierarchy === "person" ? "person then date"
    : unlabeledHierarchy === "photo" ? "photo"
    : unlabeledHierarchy === "directory" ? "folder"
    : "month then place";
  let msg = `${returned} of ${total} ${noun}, grouped by ${groupedBy}`;
  if (total > returned) msg += ` (showing first ${returned})`;
  setStatus(msg + preselNote + focusStatusSuffix());
}

// Scrolls the grid to the "Undated" year divider (arrival via "?month=undated").
// Undated faces always sort first, so this is normally already at the top —
// but scroll explicitly rather than assume, and give a clear status if there
// turn out to be none.
function scrollToUndatedSection() {
  const divider = [...document.querySelectorAll("#grid .grid-year-divider")]
    .find(el => el.textContent === "Undated");
  if (divider) {
    divider.scrollIntoView({ block: "start" });
  } else if (gridSort !== "date") {
    // The year/month dividers this jumps to only exist in the chronological sort.
    setStatus('Switch Sort back to "Date" to jump to the undated section.');
  } else {
    setStatus("No undated faces — every face here has a timestamp.");
  }
}

function makeGroupSection(groupIdx) {
  const sec = document.createElement("div");
  sec.className = `face-group-section group-tint-${groupIdx % 6}`;
  return sec;
}

// Distinct photos behind a set of faces — what the "Number of photos" sort ranks
// on, so the group headers spell it out (a group's face count says little about
// how many photos it spans).
function photoCountLabel(faceList) {
  const n = new Set(faceList.map(f => f.photo_id)).size;
  return `${n} photo${n === 1 ? "" : "s"}`;
}

// sortGroups() for a group whose faces live in `group.faces` — the shape both the
// guesses event groups and the Unlabeled month→location buckets use.
function sortFaceGroups(groups) {
  return sortGroups(groups, gridSort, g => ({
    date: Math.min(...g.faces.map(f => f.photo_datetime || Infinity)),
    count: new Set(g.faces.map(f => f.photo_id)).size,
    place: g.place ?? primaryLocationKey(g.faces),
    dir: g.dir ?? primaryDirKey(g.faces),
  }));
}

// The grid and the staging area below it are two views of the same face list —
// a staged face leaves one and appears in the other — so they always render
// together. renderGridInner owns the grid itself.
function renderGrid() {
  renderGridInner();
  renderPending();
  // Full rebuilds paint each cell's selected class as it's created, so they skip
  // paintSelection() — but the count in the selection bar still has to follow
  // (staging an assignment empties the selection without any click).
  paintSelectionCount();
}

// Repaint selection *in place*, for the actions that only move the selection or
// the focus (click, arrow keys, group select/deselect). Selection is one CSS
// class on the cell — nothing about the grid's contents or order changes — so
// going through renderGrid() here would tear down and rebuild every cell,
// dropping hundreds of <img> elements the browser then has to re-lay-out and
// re-decode. That reads as the whole grid blanking and reloading on each click,
// and it gets worse the more faces a group holds. Only call this when the face
// list itself is untouched; anything that adds, removes, stages or relabels a
// face still needs a full renderGrid().
function paintSelection() {
  document.querySelectorAll("#grid .thumb-cell").forEach(cell => {
    cell.classList.toggle("selected", selectedIds.has(parseInt(cell.dataset.id, 10)));
  });
  paintSelectionCount();
}

// Keep the selection bar honest about its scope: a live count, and every action
// disabled while nothing is selected (the group headers below have their own
// buttons, and an empty selection bar is exactly when the two get confused).
function paintSelectionCount() {
  const bar = document.getElementById("grid-nav-selection");
  if (!bar) return;
  const n = selectedIds.size;
  bar.classList.toggle("empty", n === 0);
  document.getElementById("selection-count").textContent =
    n === 0 ? "Nothing selected" : `${n} selected`;
  bar.querySelectorAll("button").forEach(b => { b.disabled = n === 0; });
}

function renderGridInner() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  renderOrder = [];
  // Faces with a staged decision have moved to the staging area.
  const list = gridFaces();

  // In the guesses view, lay faces out under event-group headers (date-range
  // title, location in the meta; the Ignore button acts on the selection).
  if (scope === "suggested") {
    let groupIdx = 0;
    sortFaceGroups(computeTimeGroups(list, groupGapSeconds)).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      const place = locationLabel(group.faces);
      sec.appendChild(makeGroupHeader(group, {
        title: formatGroupRange(group),
        meta: `· ${photoCountLabel(group.faces)}` + (place ? ` · 📍 ${place}` : ""),
      }));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Ignored: group by ignore-batch (shared ignored_at), newest first,
  // each batch header offering a one-click "Restore all".
  if (scope === "ignored") {
    let groupIdx = 0;
    computeIgnoreBatches(list).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeIgnoreBatchHeader(group));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Come Back: group by come-back batch (shared come_back_at), newest first,
  // each batch header offering a one-click "Restore all".
  if (scope === "come_back") {
    let groupIdx = 0;
    computeComeBackBatches(list).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeComeBackBatchHeader(group));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Recently tagged: group by tag-batch (shared assigned_at), newest first,
  // each batch header offering a one-click "Untag all".
  if (scope === "recent") {
    let groupIdx = 0;
    computeTagBatches(list).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeTagBatchHeader(group));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
    return;
  }

  // Unlabeled queue: same common group grid as the guesses view, grouped by
  // month then by location. Year/month dividers read top-to-bottom; each
  // location within a month is one group (location title, date range in the
  // meta) and its Ignore button acts on the whole group, not just the selection.
  if (scope === "unlabeled" && unlabeledHierarchy === "person") {
    renderUnlabeledPersonFirst(grid, list);
    return;
  }

  if (scope === "unlabeled" && unlabeledHierarchy === "photo") {
    renderUnlabeledPhotoFirst(grid, list);
    return;
  }

  if (scope === "unlabeled" && unlabeledHierarchy === "directory") {
    renderUnlabeledDirFirst(grid, list);
    return;
  }

  if (scope === "unlabeled") {
    let groupIdx = 0, curYear, curMonth;
    // Year/month dividers only read correctly while the buckets are chronological;
    // the count/location sorts interleave months, so they drop the dividers (each
    // bucket header still carries its own date range).
    const showDividers = gridSort === "date";
    sortFaceGroups(computeMonthLocationGroups(list)).forEach(group => {
      if (showDividers) {
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
      }
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeGroupHeader(group, {
        title: group.place ? `📍 ${group.place}` : group.dir ? `📁 ${group.dir}` : "No location",
        label: group.place || group.dir || "No location",
        meta: `· ${facesDateRange(group.faces)} · ${photoCountLabel(group.faces)}`,
        ignoreAll: true,
      }));
      sec.appendChild(makePersonRuns(group.faces));
      grid.appendChild(sec);
    });
    return;
  }

  // Per-person view: an action bar to hunt for more of this person, then
  // geocode-style year/month dividers (no per-month actions).
  if (scope === "person") {
    grid.appendChild(makePersonHeader(list.length));
    let curYear = null, curMonth = null;
    list.forEach((face) => {
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
      grid.appendChild(makeFaceCell(face));
    });
    return;
  }

  list.forEach((face) => grid.appendChild(makeFaceCell(face)));
}

// Action bar atop a person's photos: jump to recognition's untagged guesses for them.
function makePersonHeader(count) {
  const name = persons.find(p => p.id === scopePersonId)?.name || "this person";
  const bar = document.createElement("div");
  bar.className = "person-scope-header";

  const label = document.createElement("span");
  label.className = "person-scope-label";
  label.textContent = `${count} tagged photo(s) of ${name}`;

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
// no location collect into one "No location" bucket per month — except in the
// Undated month (no timestamp to group by either), where a lone "No location"
// bucket would dump every stranger photo in the library into one pile, so it's
// split further by containing directory (folder is often the only surviving
// hint of what a scanned/undated batch is). Each bucket's faces are then
// clustered by suggested person (see sortBucketBySuggestion) so the same person
// is contiguous — this is what makes `unlabeledAll` (the flat selection list)
// and the render agree, so the ordering must live here, in the shared choke point.
function computeMonthLocationGroups(list) {
  const out = [];
  computeMonthGroups(list).forEach(mg => {
    const undated = mg.year === null;
    const buckets = new Map();   // bucket key → group
    mg.faces.forEach(f => {
      const loc = locationKey(f);
      const dir = !loc && undated ? dirLabel(f) : null;
      const key = loc ? `loc:${loc}` : (dir ? `dir:${dir}` : "");
      let b = buckets.get(key);
      if (!b) {
        b = { year: mg.year, month: mg.month, place: loc || null, dir, faces: [] };
        buckets.set(key, b);
      }
      b.faces.push(f);
    });
    buckets.forEach((b, key) => {
      b.faces = sortBucketBySuggestion(b.faces, `ml:${mg.year}-${mg.month}:${key}`);
    });
    out.push(...buckets.values());
  });
  return out;
}

// Person-first hierarchy for the Unlabeled queue: suggested person (or "No
// suggestion") → date-range chunks within that person, chunks sorted
// chronologically inside. Mirrors computeMonthLocationGroups's nesting, just
// with the two outer levels swapped.
const UNLABELED_PERSON_GAP_SECONDS = 86400;   // new date-range chunk after this big a gap

function computeUnlabeledPersonGroups(list) {
  const buckets = new Map();   // person_id ("none" for unsuggested) → { name, faces }
  list.forEach(f => {
    const pid = f.suggestion ? f.suggestion.person_id : "none";
    let b = buckets.get(pid);
    if (!b) {
      b = { personId: pid, name: f.suggestion ? f.suggestion.person_name : null, faces: [] };
      buckets.set(pid, b);
    }
    b.faces.push(f);
  });
  const named = [...buckets.values()].filter(b => b.personId !== "none")
    .sort((a, b) => a.name.localeCompare(b.name));
  const none = buckets.get("none");
  const personGroups = none ? [...named, none] : named;
  personGroups.forEach(b => { b.chunks = computeTimeGroups(b.faces, UNLABELED_PERSON_GAP_SECONDS); });
  return personGroups;
}

// Photo hierarchy for the Unlabeled queue: one group per source photo, so a
// photo's unlabeled faces are reviewed (and ignored/accepted) together. Faces
// keep the shared bucket ordering within a photo (suggested people contiguous),
// and each group carries year/month so the date sort can still draw dividers.
function computeUnlabeledPhotoGroups(list) {
  const buckets = new Map();   // photo_id → group
  list.forEach(f => {
    let b = buckets.get(f.photo_id);
    if (!b) {
      const ts = f.photo_datetime;
      const d = ts ? new Date(ts * 1000) : null;
      b = {
        photoId: f.photo_id,
        filename: f.filename || dirLabel(f),
        year: d ? d.getFullYear() : null,
        month: d ? d.getMonth() : null,
        faces: [],
      };
      buckets.set(f.photo_id, b);
    }
    b.faces.push(f);
  });
  buckets.forEach(b => {
    b.faces = sortBucketBySuggestion(b.faces, `photo:${b.photoId}`);
  });
  return [...buckets.values()];
}

function renderUnlabeledPhotoFirst(grid, list) {
  let groupIdx = 0, curYear, curMonth;
  // Same rule as the month→location grid: dividers only read correctly while the
  // groups stay chronological, so the count/location sorts drop them.
  const showDividers = gridSort === "date";
  sortFaceGroups(computeUnlabeledPhotoGroups(list)).forEach(group => {
    if (showDividers) {
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
    }
    const sec = makeGroupSection(groupIdx++);
    const place = locationLabel(group.faces);
    const n = group.faces.length;
    sec.appendChild(makeGroupHeader(group, {
      title: `🖼 ${group.filename}`,
      label: group.filename,
      meta: `· ${facesDateRange(group.faces)} · ${n} face${n === 1 ? "" : "s"}` +
            (place ? ` · 📍 ${place}` : ""),
      ignoreAll: true,
      extraButtons: [
        { icon: "🔍", label: "Open photo",
          title: "Open this photo's full face-review page",
          onClick: () => {
            window.location.href = `/photo-faces.html?photo_id=${group.photoId}`;
          } },
      ],
    }));
    const cells = document.createElement("div");
    cells.className = "face-group-cells";
    group.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
    sec.appendChild(cells);
    grid.appendChild(sec);
  });
}

// Cells for one bucket, laid out as person runs. Faces are already clustered by
// suggested person (sortBucketBySuggestion); each run of same-suggestion faces
// gets its own wrapping flex row (.person-run) instead of being flattened into
// one grid, so the whole run can get a continuous hover background — same idea
// as search.js's .photo-row, just one row per suggested person instead of per
// photo. Shared by the month→location and directory grids.
function makePersonRuns(faceList) {
  const cells = document.createElement("div");
  cells.className = "person-runs";
  let prevSug, run;   // prevSug undefined before the first cell; null = "unknown" block
  faceList.forEach(face => {
    const sug = face.suggestion ? face.suggestion.person_id : null;
    if (prevSug === undefined || sug !== prevSug) {
      run = document.createElement("div");
      run.className = "person-run";
      cells.appendChild(run);
    }
    run.appendChild(makeFaceCell(face));
    prevSug = sug;
  });
  return cells;
}

// Directory hierarchy for the Unlabeled queue: one group per containing folder,
// keyed on the photo's full `dir` so sibling folders that share a leaf name
// (…/1985/Scans and …/1990/Scans) stay apart. This is the axis that works for
// scanned photos — no timestamp, no GPS, so the month→location grid piles them
// all into one "Undated / No location" heap, while the folder is usually the
// only surviving hint of what the batch is. Groups come out alphabetical by
// path; sortGroups is stable, so folders that tie on the active sort key (every
// one of them, when undated) keep that A→Z order.
function computeUnlabeledDirGroups(list) {
  const buckets = new Map();   // full dir path ("" when unknown) → group
  list.forEach(f => {
    const key = f.dir || "";
    let b = buckets.get(key);
    if (!b) {
      b = { dir: f.dir || null, name: dirLabel(f), faces: [] };
      buckets.set(key, b);
    }
    b.faces.push(f);
  });
  const groups = [...buckets.values()]
    .sort((a, b) => (a.dir || "").localeCompare(b.dir || ""));
  groups.forEach(g => { g.faces = sortBucketBySuggestion(g.faces, `dir:${g.dir}`); });
  return groups;
}

// "…/Scans/1985 Box" — the last two segments of a full path. Enough to tell
// sibling folders apart in a header without spilling an absolute path across it.
function shortDirPath(dir) {
  if (!dir) return "Unknown folder";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return "…/" + parts.slice(-2).join("/");
}

function renderUnlabeledDirFirst(grid, list) {
  let groupIdx = 0;
  // No year/month dividers here: a folder isn't a chronological unit — a scanned
  // batch routinely spans decades — so each header carries its own date range.
  sortFaceGroups(computeUnlabeledDirGroups(list)).forEach(group => {
    const sec = makeGroupSection(groupIdx++);
    const place = locationLabel(group.faces);
    const n = group.faces.length;
    sec.appendChild(makeGroupHeader(group, {
      title: `📁 ${shortDirPath(group.dir)}`,
      label: group.name,
      meta: `· ${facesDateRange(group.faces)} · ${photoCountLabel(group.faces)} · ` +
            `${n} face${n === 1 ? "" : "s"}` + (place ? ` · 📍 ${place}` : ""),
      ignoreAll: true,
    }));
    sec.appendChild(makePersonRuns(group.faces));
    grid.appendChild(sec);
  });
}

function renderUnlabeledPersonFirst(grid, list) {
  let groupIdx = 0;
  computeUnlabeledPersonGroups(list).forEach(person => {
    const pd = document.createElement("div");
    pd.className = "grid-year-divider";
    pd.textContent = person.name || `No suggestion (${person.faces.length})`;
    grid.appendChild(pd);

    person.chunks.forEach(chunk => {
      const sec = makeGroupSection(groupIdx++);
      const place = locationLabel(chunk.faces);
      const personLabel = person.name || "unlabeled faces";
      sec.appendChild(makeGroupHeader(chunk, {
        title: formatGroupRange(chunk),
        meta: place ? `· 📍 ${place}` : "",
        label: `${personLabel} · ${formatGroupRange(chunk)}`,
        ignoreAll: true,
      }));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      chunk.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
  });
}

// Order the faces within one location bucket so the same suggested person is
// adjacent (so you can rubber-band / confirm a person's faces as a run): guessed
// faces first, grouped by suggested person and ordered by that person's earliest
// photo in the bucket (chronological first-appearance), each person's faces in
// time order; faces with no suggestion ("unknown") sink to the bottom. The sort is
// a fixed point — re-running it on already-sorted faces is a no-op — because the
// per-person earliest timestamp is order-independent, so the flat list and the
// re-grouped render stay in sync.
// `cacheKey` identifies the bucket across renders: the per-person rank is frozen
// on first sight (see runOrderRank) so removing faces mid-pass can't reshuffle
// the runs. Omit it for one-off/unstable buckets.
function sortBucketBySuggestion(faceList, cacheKey) {
  const firstTs = new Map();   // person_id → earliest photo_datetime in this bucket
  faceList.forEach(f => {
    const pid = f.suggestion ? f.suggestion.person_id : null;
    if (pid == null) return;
    const ts = f.photo_datetime || 0;
    if (!firstTs.has(pid) || ts < firstTs.get(pid)) firstTs.set(pid, ts);
  });
  if (cacheKey) {
    firstTs.forEach((ts, pid) => {
      const k = `${cacheKey}|${pid}`;
      // Person seen here before → reuse their frozen rank; otherwise freeze now.
      if (runOrderRank.has(k)) firstTs.set(pid, runOrderRank.get(k));
      else runOrderRank.set(k, ts);
    });
  }
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

function makeFaceCell(face) {
  const idx = renderOrder.push(face) - 1;
  const cell = document.createElement("div");
  cell.className = "thumb-cell" +
    (selectedIds.has(face.id) ? " selected" : "") +
    (face.ignored ? " ignored" : "") +
    (face.come_back ? " come-back" : "");
  cell.dataset.id = face.id;

  // reuse: staging/committing rebuilds the whole grid, and rebuilding the <img>
  // nodes with it is what makes the faces visibly blank and reload.
  cell.appendChild(faceCropImg(face, { reuse: true }));

  const score = document.createElement("div");
  score.className = "face-score";
  score.textContent = face.det_score.toFixed(2);
  cell.appendChild(score);

  if (face.ignored) {
    const label = document.createElement("div");
    label.className = "face-label ignored-label";
    label.textContent = "Ignored";
    cell.appendChild(label);
  } else if (face.come_back) {
    const label = document.createElement("div");
    label.className = "face-label come-back-label";
    label.textContent = "Come back";
    cell.appendChild(label);
  } else if (face.person_name && scope === "recent") {
    // In the recently-tagged view the name is a one-click un-tag.
    const chip = document.createElement("div");
    chip.className = "face-untag";
    chip.title = `Click to un-tag ${face.person_name}`;
    chip.innerHTML =
      `<span class="sug-name">${escapeHtml(face.person_name)}</span>` +
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
    `<span class="sug-name">${escapeHtml(face.suggestion.person_name)}?</span>` +
    `<span class="sug-reject" title="Not ${escapeHtml(face.suggestion.person_name)}">✕</span>`;
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
    `<span class="sug-name">${escapeHtml(alt.person_name)}?</span>` +
    `<span class="sug-reject" title="Not ${escapeHtml(alt.person_name)}">✕</span>`;
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
    scopeLabel: "this batch:",
    buttons: [
      { label: "Select all",
        title: "Add every face in this batch to the current selection",
        onClick: () => { group.faces.forEach(f => selectedIds.add(f.id)); paintSelection(); updateDetail(); } },
      { label: `Restore all (${group.faces.length})`, kind: "primary",
        title: "Un-ignore every face in this batch (returns them to the Unlabeled queue)",
        onClick: () => ignoreSelected_ids(group.faces.map(f => f.id), false) },
    ],
  });
}

/* ── Come-back-batch grouping (Come Back view) ── */
function computeComeBackBatches(list) {
  // `list` is newest-first by come_back_at; faces deferred together share a value.
  const groups = [];
  let cur = null;
  list.forEach(f => {
    const key = f.come_back_at ?? null;
    if (!cur || cur.ts !== key) { cur = { ts: key, faces: [] }; groups.push(cur); }
    cur.faces.push(f);
  });
  return groups;
}

function makeComeBackBatchHeader(group) {
  const when = group.ts ? formatRelativeTime(group.ts) : "unknown time";
  return faceGroupHeader({
    title: `Come back ${when}`,
    meta: `· ${group.faces.length} face(s)`,
    scopeLabel: "this batch:",
    buttons: [
      { label: "Select all",
        title: "Add every face in this batch to the current selection",
        onClick: () => { group.faces.forEach(f => selectedIds.add(f.id)); paintSelection(); updateDetail(); } },
      { label: `Restore all (${group.faces.length})`, kind: "primary",
        title: "Move every face in this batch back to the Unlabeled queue",
        onClick: () => comeBackSelected_ids(group.faces.map(f => f.id), false) },
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
    scopeLabel: "this batch:",
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
  if (stagingEnabled()) { stageFaces(ids, { kind: "unassign" }, "Unassign"); return; }
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
function makeGroupHeader(group, { title, meta = "", label = title, ignoreAll = false,
                                  extraButtons = [] } = {}) {
  const acceptable = group.faces.filter(f => f.suggestion && !f.person_name && !f.ignored);
  const ignoreBtn = ignoreAll
    ? { icon: "🚫", label: "Ignore all", kind: "danger",
        title: "Ignore every face in this group, regardless of selection",
        onClick: () => {
          if (!stagingEnabled() &&
              !confirm(`Ignore all ${group.faces.length} face(s) in ${label}?`)) return;
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
    scopeLabel: "this group:",
    buttons: [
      ...extraButtons,
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
          paintSelection();
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
  paintSelection();
  updateDetail();
  const verb = additive ? "Added" : "Selected only";
  const where = label || facesDateRange(group.faces);
  setStatus(`${verb} ${group.faces.length} face(s) from ${where}. ` +
    `Assign to approve, or refine with click/Ctrl-click.`);
}

function deselectAll() {
  selectedIds.clear();
  lastClickedIndex = -1;
  paintSelection();
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
    for (let i = start; i <= end; i++) selectedIds.add(renderOrder[i].id);
  } else {
    selectedIds.clear();
    selectedIds.add(face.id);
  }
  focusedFaceId = face.id;
  lastClickedIndex = idx;
  paintSelection();
  updateDetail();
}

/* ── Keyboard shortcuts ──
 * Only active over the flat face grids (not Discover's clusters or Crowds'
 * photo cards, which have no single `faces` list to walk), and only when
 * focus isn't in a text field or the person-picker modal (which has its own
 * arrow/Enter handling — see face-grid.js). */
const FLAT_GRID_SCOPES = new Set(["unlabeled", "all", "person", "suggested", "ignored", "come_back", "recent"]);

function isFlatGridScope() {
  return FLAT_GRID_SCOPES.has(scope);
}

function scrollFaceIntoView(faceId) {
  document.querySelector(`.thumb-cell[data-id="${faceId}"]`)?.scrollIntoView({ block: "nearest" });
}

// Moves focus by `delta` faces and collapses the selection to just that face
// (mirrors a plain click on the destination cell).
function moveFocus(delta) {
  if (!renderOrder.length) return;
  let idx = renderOrder.findIndex(f => f.id === focusedFaceId);
  idx = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
  idx = Math.max(0, Math.min(renderOrder.length - 1, idx + delta));
  selectedIds.clear();
  selectedIds.add(renderOrder[idx].id);
  focusedFaceId = renderOrder[idx].id;
  lastClickedIndex = idx;
  paintSelection();
  updateDetail();
  scrollFaceIntoView(focusedFaceId);
}

// Extends the selection from the last click/nav anchor to `delta` faces past
// the current focus (mirrors shift-click's range select).
function extendFocus(delta) {
  if (!renderOrder.length) return;
  const anchor = lastClickedIndex >= 0 ? lastClickedIndex :
    Math.max(0, renderOrder.findIndex(f => f.id === focusedFaceId));
  let idx = renderOrder.findIndex(f => f.id === focusedFaceId);
  idx = idx === -1 ? anchor : idx;
  idx = Math.max(0, Math.min(renderOrder.length - 1, idx + delta));
  const start = Math.min(anchor, idx);
  const end = Math.max(anchor, idx);
  for (let i = start; i <= end; i++) selectedIds.add(renderOrder[i].id);
  focusedFaceId = renderOrder[idx].id;
  lastClickedIndex = idx;
  paintSelection();
  updateDetail();
  scrollFaceIntoView(focusedFaceId);
}

function toggleFocusedSelection() {
  if (!focusedFaceId) return;
  selectedIds.has(focusedFaceId) ? selectedIds.delete(focusedFaceId) : selectedIds.add(focusedFaceId);
  paintSelection();
  updateDetail();
}

function selectAllFaces() {
  const visible = gridFaces();
  if (!visible.length) return;
  selectedIds = new Set(visible.map(f => f.id));
  paintSelection();
  updateDetail();
  setStatus(`Selected all ${visible.length} face(s).`);
}

function openShortcutsHelp() {
  document.getElementById("shortcuts-help-backdrop").style.display = "flex";
}

function closeShortcutsHelp() {
  document.getElementById("shortcuts-help-backdrop").style.display = "none";
}

function isShortcutsHelpOpen() {
  return document.getElementById("shortcuts-help-backdrop").style.display !== "none";
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Let text inputs/selects and the person-picker modal handle their own keys.
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // Same for the focused pane divider: its arrows resize, they don't navigate.
    if (document.activeElement?.id === "detail-resizer") return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;

    if (isShortcutsHelpOpen()) {
      if (e.key === "Escape" || e.key === "?") { e.preventDefault(); closeShortcutsHelp(); }
      return;
    }

    if (e.key === "?") { e.preventDefault(); openShortcutsHelp(); return; }

    if (!isFlatGridScope()) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAllFaces();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;  // leave browser/OS chords alone

    switch (e.key) {
      case "ArrowDown": case "j":
        e.preventDefault();
        if (e.shiftKey) extendFocus(1); else moveFocus(1);
        break;
      case "ArrowUp": case "k":
        e.preventDefault();
        if (e.shiftKey) extendFocus(-1); else moveFocus(-1);
        break;
      case " ":
        e.preventDefault();
        toggleFocusedSelection();
        break;
      case "Escape":
        deselectAll();
        break;
      case "Enter": case "a":
        e.preventDefault();
        openAssignPickerForSelection();
        break;
      case "u": case "Backspace":
        e.preventDefault();
        assignSelected(null, true);
        break;
      case "x": case "i":
        e.preventDefault();
        ignoreSelected(scope !== "ignored");
        break;
      case "b":
        e.preventDefault();
        comeBackSelected(scope !== "come_back");
        break;
      case "c":
        e.preventDefault();
        acceptSuggestionsForSelection();
        break;
      case "o":
        if (findFace(focusedFaceId)) document.getElementById("detail-open-photo-btn").click();
        break;
      case "f":
        if (findFace(focusedFaceId)) document.getElementById("detail-fullsize-btn").click();
        break;
      case "N":
        if (e.shiftKey) { e.preventDefault(); nukeSelectedPhotos(); }
        break;
    }
  });
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
  // Photo count comes off the sample rather than cl.size: a cluster is one
  // person, so it's normally one face per photo, but a sample capped at 24 would
  // understate a big group — cl.size is the better count when it's truncated.
  sortGroups(clusters, gridSort, cl => ({
    date: Math.min(...cl.sample.map(f => f.photo_datetime || Infinity)),
    count: Math.max(cl.size, new Set(cl.sample.map(f => f.photo_id)).size),
    place: primaryLocationKey(cl.sample),
    dir: primaryDirKey(cl.sample),
  })).forEach(cl => grid.appendChild(makeClusterCard(cl)));
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

  sortGroups(visibleGroups, gridSort, g => ({
    date: Math.min(...g.photos.map(p => p.photo_datetime || Infinity)),
    count: g.photos.length,
    place: primaryLocationKey(g.photos),
    dir: primaryDirKey(g.photos),
  })).forEach(g => grid.appendChild(makeCrowdGroupCard(g)));
}

function makeCrowdGroupCard(g) {
  const card = document.createElement("div");
  card.className = "cluster-card crowd-group-card";

  let ignoreBtn;   // captured from the header so per-photo actions can update it
  let meta = `· ${g.photos.length} photo(s) · ${g.total_faces} face(s)`;
  if (g.unlabeled_faces > 0) meta += ` · ${g.unlabeled_faces} unlabeled`;
  // Place goes last so the "Location, then date" sort is readable here too.
  const place = locationLabel(g.photos);
  if (place) meta += ` · 📍 ${place}`;

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
      `/photo-faces.html?photo_id=${ph.id}&mode=crowd&min_faces=${minFaces}&group_gap=${gap}`;
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
  // Staged faces have left the grid but are still previewable / re-targetable.
  const staged = pending.get(id);
  if (staged) return staged.face;
  for (const cl of clusters) {
    const s = cl.sample.find(x => x.id === id);
    if (s) return s;
  }
  return null;
}

/* ── "Also in this photo" chips ──
 * Committed (DB) person tags for the focused face's photo. Cached per photo so
 * arrowing through several faces of the same photo costs one request; cleared
 * by loadFaces(), which runs after every mutation/commit. */
const taggedPeopleCache = new Map();

async function fetchTaggedPeople(photoId) {
  if (taggedPeopleCache.has(photoId)) return taggedPeopleCache.get(photoId);
  const res = await fetch(`/api/photos/${photoId}/tagged-people`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const people = await res.json();
  taggedPeopleCache.set(photoId, people);
  return people;
}

async function updatePhotoPeople(face) {
  const box = document.getElementById("photo-people");
  const hl = document.getElementById("photo-people-box");
  hl.style.display = "none";
  let people;
  try {
    people = await fetchTaggedPeople(face.photo_id);
  } catch {
    box.style.display = "none";
    return;
  }
  // Focus may have moved on while the request was in flight.
  if (focusedFaceId !== face.id) return;
  if (!people.length) { box.style.display = "none"; return; }

  box.style.display = "flex";
  box.innerHTML = "";
  const label = document.createElement("div");
  label.className = "pp-label";
  label.textContent = `Already tagged in this photo (${people.length}):`;
  box.appendChild(label);

  people.forEach(p => {
    const chip = document.createElement("div");
    chip.className = p.id === face.id ? "pp-chip pp-self" : "pp-chip";
    chip.title = p.id === face.id
      ? `${p.person_name} — this face`
      : `${p.person_name} — hover to locate in the photo`;
    const img = document.createElement("img");
    img.src = `/api/faces/${p.id}/crop`;
    img.alt = p.person_name;
    chip.appendChild(img);
    const name = document.createElement("span");
    name.textContent = p.person_name;
    chip.appendChild(name);
    if (p.id !== face.id) {
      chip.addEventListener("mouseenter", () => {
        applyBbox(hl, p.bbox);
        hl.style.display = "block";
      });
      chip.addEventListener("mouseleave", () => { hl.style.display = "none"; });
    }
    box.appendChild(chip);
  });
}

function updateDetail() {
  const placeholder = document.getElementById("detail-placeholder");
  const content = document.getElementById("detail-content");

  const face = findFace(focusedFaceId);
  if (!face) {
    placeholder.style.display = "block";
    content.style.display = "none";
    document.getElementById("photo-people").style.display = "none";
    return;
  }
  placeholder.style.display = "none";
  content.style.display = "flex";

  document.getElementById("detail-img").src = `/api/preview/${face.photo_id}`;
  wireFullSizeButton(document.getElementById("detail-fullsize-btn"), face.filename, face.photo_id);

  // Position the bbox overlay (normalized coords map directly to percentages).
  applyBbox(document.getElementById("face-box"), face.bbox);

  updatePhotoPeople(face);   // async, fills in when the photo's tags arrive

  const when = face.photo_datetime
    ? new Date(face.photo_datetime * 1000).toLocaleString() : "Unknown";
  const personCell = face.ignored
    ? "<i style='color:#999'>Ignored</i>"
    : face.come_back
      ? "<i style='color:#dab35a'>Come back later</i>"
      : (face.person_name ? escapeHtml(face.person_name) : "<i style='color:#777'>Unassigned</i>");
  const loc = face.location;
  const placeStr = loc
    ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ")
    : null;
  const staged = pending.get(face.id);
  document.getElementById("detail-meta").innerHTML = `
    <tr><td>Photo</td><td>${escapeHtml(face.filename)}</td></tr>
    <tr><td>Taken</td><td>${escapeHtml(when)}</td></tr>
    ${placeStr ? `<tr><td>Location</td><td>${escapeHtml(placeStr)}</td></tr>` : ""}
    <tr><td>Person</td><td>${personCell}</td></tr>
    ${staged ? `<tr><td>Staged</td><td><b style='color:var(--warn)'>→ ${escapeHtml(pendingCellLabel(staged))}</b> (not saved)</td></tr>` : ""}
    <tr><td>Detection</td><td>${face.det_score.toFixed(3)}</td></tr>
  `;
  const detailIgnoreBtn = document.getElementById("detail-ignore-btn");
  detailIgnoreBtn.textContent = face.ignored ? "↩" : "🚫";
  detailIgnoreBtn.title = face.ignored ? "Restore" : "Ignore";
  detailIgnoreBtn.setAttribute("aria-label", detailIgnoreBtn.title);

  const detailComeBackBtn = document.getElementById("detail-come-back-btn");
  detailComeBackBtn.textContent = face.come_back ? "↩" : "🕒";
  detailComeBackBtn.title = face.come_back ? "Restore" : "Come back later";
  detailComeBackBtn.setAttribute("aria-label", detailComeBackBtn.title);

  const sug = document.getElementById("face-suggestion");
  const alts = face.alternatives || [];
  if (!face.person_name && face.suggestion) {
    sug.style.display = "flex";
    sug.innerHTML = "";

    const primary = document.createElement("div");
    primary.className = "sug-primary";
    primary.innerHTML =
      `<span class="sug-text">Looks like <b>${escapeHtml(face.suggestion.person_name)}</b> ` +
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
  if (stagingEnabled()) {
    stageFaces(ids, clear ? { kind: "unassign" } : { kind: "assign", personId },
               clear ? "Unassign" : "a person");
    return;
  }
  if (!confirmSelection(ids.length, `Unassign ${ids.length} face(s)?`)) return;
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, person_id: personId, clear }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Unassigned ${ids.length} face(s).`);
    selectedIds.clear();
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

// Detail-pane assignment: act on the single previewed face (focusedFaceId) via the
// per-face endpoint, leaving the grid selection untouched. Handles both detail
// buttons — assign to a person (existing or newly created) or unassign (clear).
async function assignFocusedFace({ personId = null, name = null, clear = false } = {}) {
  const f = findFace(focusedFaceId);
  if (!f) { setStatus("Select a face first.", true); return; }
  if (stagingEnabled()) {
    const label = clear ? "Unassign"
                        : (name || persons.find(p => p.id === personId)?.name || "a person");
    stageFaces([f.id], clear ? { kind: "unassign" } : { kind: "assign", personId, name }, label);
    return;
  }
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
  // Staged decisions are reversible, so they skip the bulk-action confirm.
  if (!stagingEnabled() && !confirmSelection(ids.length, `${verb} ${ids.length} face(s)?`)) return;
  await ignoreSelected_ids(ids, ignored);
}

async function ignoreSelected_ids(ids, ignored) {
  if (stagingEnabled()) {
    stageFaces(ids, { kind: ignored ? "ignore" : "unignore" },
               ignored ? "Ignore" : "Un-ignore");
    return;
  }
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

async function comeBackSelected(comeBack) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  const verb = comeBack ? "Move to Come Back" : "Restore";
  if (!stagingEnabled() && !confirmSelection(ids.length, `${verb} ${ids.length} face(s)?`)) return;
  await comeBackSelected_ids(ids, comeBack);
}

async function comeBackSelected_ids(ids, comeBack) {
  if (stagingEnabled()) {
    stageFaces(ids, { kind: comeBack ? "come_back" : "uncome_back" },
               comeBack ? "Come Back" : "Back to Unlabeled");
    return;
  }
  try {
    const res = await fetch("/api/faces/come-back", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, come_back: comeBack }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(comeBack ? `Moved ${ids.length} face(s) to Come Back.` : `Restored ${ids.length} face(s).`);
    selectedIds.clear();
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Come back failed: " + err.message, true);
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
    // Those faces no longer exist — drop any staged decisions pointing at them.
    const gone = new Set(photoIds);
    [...pending].forEach(([id, e]) => { if (gone.has(e.face.photo_id)) pending.delete(id); });
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

  // Same toggle for the Come Back queue.
  const comeBackBtn = document.getElementById("come-back-btn");
  const restoringComeBack = scope === "come_back";
  comeBackBtn.textContent = restoringComeBack ? "↩" : "🕒";
  comeBackBtn.title = restoringComeBack
    ? "Restore selected faces to the Unlabeled queue"
    : "Move selected faces to the Come Back queue — people you know or suspect but aren't ready to assign yet";
  comeBackBtn.setAttribute("aria-label", restoringComeBack ? "Restore" : "Come back later");

  // "Only suggested" applies to the Unlabeled queue only.
  const chk = document.getElementById("suggested-only-chk");
  chk.checked = suggestedOnly;
  chk.disabled = scope !== "unlabeled";
  document.getElementById("suggested-only-label").style.opacity =
    scope === "unlabeled" ? "1" : "0.45";
}

// Assign the current selection to a person (existing or newly created) picked
// from the shared person-picker modal. `who` is {person_id} or {name}.
async function assignSelectedTo(who, label) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  if (stagingEnabled()) {
    stageFaces(ids, { kind: "assign", personId: who.person_id ?? null, name: who.name ?? label },
               label);
    return;
  }
  if (!confirmSelection(ids.length, `Assign ${ids.length} face(s) to ${label}?`)) return;
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, ...who }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Assigned ${ids.length} face(s) to ${label}.`);
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
      if (stagingEnabled()) {
        stageFaces([face.id], { kind: "assign", personId: null, name }, `${name} (new person)`);
        return;
      }
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
      if (stagingEnabled()) { ignoreSelected_ids([face.id], ignored); return; }
      try {
        const res = await fetch("/api/faces/ignore", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ face_ids: [face.id], ignored }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadFaces();
      } catch (err) { setStatus("Ignore failed: " + err.message, true); }
    },
    onComeBack: async (comeBack) => {
      if (stagingEnabled()) { comeBackSelected_ids([face.id], comeBack); return; }
      try {
        const res = await fetch("/api/faces/come-back", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ face_ids: [face.id], come_back: comeBack }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadFaces();
      } catch (err) { setStatus("Come back failed: " + err.message, true); }
    },
    onNotPerson: (personId, personName) => rejectSuggestion(face.id, personId, personName),
    onOpenPhoto: () => window.open(`/api/preview/${face.photo_id}`, "_blank"),
  });
}

async function confirmFace(faceId, personId) {
  if (stagingEnabled()) {
    const label = personId == null
      ? "Unassign" : (persons.find(p => p.id === personId)?.name || "a person");
    stageFaces([faceId], personId == null ? { kind: "unassign" } : { kind: "assign", personId },
               label);
    return;
  }
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
// Above this many loaded faces a full re-fetch is a noticeable stall (and resets
// scroll + focus), so a lone rejection patches the one face client-side instead.
const REJECT_LOCAL_THRESHOLD = 10;

async function rejectSuggestion(faceId, personId, personName, negative = true) {
  try {
    const res = await fetch("/api/faces/negatives", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: [faceId], person_id: personId, negative }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(negative ? `Marked as not ${personName}.`
                       : `Undid: ${personName} can be suggested again.`);
    // Big queue + a real rejection: patch in place (surface the next-best guess,
    // drop the face if it only lived here as a guess for the rejected person)
    // rather than round-tripping the whole list. Undo and small lists re-fetch
    // for the exact server-side re-ranking.
    if (negative && faces.length > REJECT_LOCAL_THRESHOLD) {
      applyRejectionLocally(faceId, personId);
    } else {
      await loadFaces();
    }
  } catch (err) {
    setStatus((negative ? "Reject" : "Undo") + " failed: " + err.message, true);
  }
}

// Patch a single face after a "not this person" rejection so its next-best guess
// surfaces immediately, without re-fetching the (possibly large) queue. Mirrors
// the server re-ranking: record the negative, drop the person, promote the next
// alternative into the primary slot. In views scoped to one person's guesses,
// a face rejected for that person no longer belongs, so it's removed.
function applyRejectionLocally(faceId, personId) {
  const face = faces.find(f => f.id === faceId);
  if (!face) return;

  face.negatives = [...(face.negatives || []), personId];
  const alts = (face.alternatives || []).filter(a => a.person_id !== personId);
  if (face.suggestion && face.suggestion.person_id === personId) {
    const next = alts.shift();   // best remaining guess becomes the primary
    face.suggestion = next
      ? { person_id: next.person_id, person_name: next.person_name, score: next.score }
      : null;
  }
  face.alternatives = alts;

  // The person this view is narrowed to (if any): suggested = guesses for that
  // person; unlabeled = the sticky "suggested person" filter.
  const viewPid = scope === "suggested" ? scopePersonId
                : scope === "unlabeled" ? suggestFilterPersonId : null;
  if (viewPid != null && personId === viewPid) {
    faces = faces.filter(f => f.id !== faceId);
    if (scope === "unlabeled") unlabeledAll = unlabeledAll.filter(f => f.id !== faceId);
    selectedIds.delete(faceId);
    if (focusedFaceId === faceId) focusedFaceId = null;
  }

  updateActionButtons();
  renderGrid();
  updateDetail();
}

async function acceptSuggestionsForSelection() {
  const ids = new Set(selectionOrFocused());
  const faceList = faces.filter(f => ids.has(f.id));
  // Count only the faces that would actually be accepted (guessed, not yet named
  // or ignored) — the same predicate acceptSuggestionsFor uses — and confirm past
  // the threshold so a large accidental batch isn't approved in one click.
  const targets = faceList.filter(f => f.suggestion && !f.person_name && !f.ignored);
  if (!stagingEnabled() &&
      !confirmSelection(targets.length, `Accept the suggested name for ${targets.length} face(s)?`)) {
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
  if (stagingEnabled()) {
    // One stage call per suggested person, so each lands in its own group; the
    // last call's status line covers the batch.
    Object.entries(byPerson).forEach(([pid, faceIds]) => {
      const personId = parseInt(pid);
      stageFaces(faceIds, { kind: "assign", personId },
                 persons.find(p => p.id === personId)?.name || "a person");
    });
    setStatus(`Staged ${targets.length} suggested face(s)${where} across ` +
              `${Object.keys(byPerson).length} person(s). Nothing saved yet — ` +
              `review at the bottom of the grid, then Commit.`);
    return;
  }
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

/* ── Staging area ──
 * Non-destructive decisions don't hit the server as you make them: the face is
 * pulled out of the main grid and parked in `pending` under the destination it
 * was sent to (a person, Ignored, Come Back, …). The staging area at the bottom
 * of the grid pane renders one section per destination, each with its own
 * Commit / Revert, plus a sticky bar that commits or reverts everything. Only
 * a Commit writes to the database — so a whole tagging pass can be re-targeted
 * or thrown away first.
 *
 * Entry shape: { face, kind, personId?, name? }, where kind is one of
 * assign | unassign | ignore | unignore | come_back | uncome_back. */

// Staging covers the flat face grids only. Discover's clusters and Crowds'
// photo cards act on face-id lists whose full face objects we don't hold (the
// samples are capped), so their group buttons still commit straight through.
function stagingEnabled() {
  return isFlatGridScope();
}

// What the main grid should still show: everything without a staged decision.
function gridFaces() {
  return pending.size ? faces.filter(f => !pending.has(f.id)) : faces;
}

// Park `ids` under one destination. Re-staging a face overwrites its previous
// decision, so "move it to a different group" is just another stage call.
function stageFaces(ids, change, dest) {
  let staged = 0;
  ids.forEach(id => {
    const face = findFace(id);
    if (!face) return;
    pending.set(id, { face, ...change });
    selectedIds.delete(id);
    if (focusedFaceId === id) focusedFaceId = null;
    staged++;
  });
  if (!staged) { setStatus("Nothing to stage.", true); return; }
  lastClickedIndex = -1;   // renderOrder shifts under the cells we just removed
  updateActionButtons();
  renderGrid();            // renders the staging area too
  updateDetail();
  setStatus(`Staged ${staged} face(s) → ${dest}. Nothing saved yet — ` +
            `review at the bottom of the grid, then Commit.`);
}

// Drop staged decisions, returning those faces to the grid unchanged.
function unstageFaces(ids, quiet = false) {
  let removed = 0;
  ids.forEach(id => { if (pending.delete(id)) removed++; });
  if (!removed) return;
  renderGrid();
  updateDetail();
  if (!quiet) setStatus(`Reverted ${removed} staged change(s).`);
}

const PENDING_KIND_ORDER =
  ["assign", "come_back", "unassign", "ignore", "unignore", "uncome_back"];

function pendingGroupKey(e) {
  if (e.kind !== "assign") return e.kind;
  return e.personId != null ? `person:${e.personId}` : `name:${e.name}`;
}

function pendingGroupLabel(e) {
  switch (e.kind) {
    case "assign":
      return e.personId != null
        ? (persons.find(p => p.id === e.personId)?.name || e.name || "Unknown person")
        : `${e.name} (new person)`;
    case "unassign":    return "Unassign";
    case "ignore":      return "Ignore";
    case "unignore":    return "Un-ignore";
    case "come_back":   return "Come Back";
    case "uncome_back": return "Back to Unlabeled";
    default:            return e.kind;
  }
}

// Short label for the chip on a staged face cell.
function pendingCellLabel(e) {
  return e.kind === "assign"
    ? (e.personId != null
        ? (persons.find(p => p.id === e.personId)?.name || e.name || "Unknown")
        : `＋ ${e.name}`)
    : pendingGroupLabel(e);
}

function groupPendingEntries() {
  const groups = new Map();
  pending.forEach(e => {
    const key = pendingGroupKey(e);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind: e.kind, personId: e.personId ?? null, name: e.name ?? null,
            label: pendingGroupLabel(e), entries: [] };
      groups.set(key, g);
    }
    g.entries.push(e);
  });
  return [...groups.values()].sort((a, b) => {
    const ka = PENDING_KIND_ORDER.indexOf(a.kind);
    const kb = PENDING_KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.label.localeCompare(b.label);   // people alphabetically within assigns
  });
}

function renderPending() {
  const pane = document.getElementById("pending-pane");
  const wrap = document.getElementById("pending-groups");
  wrap.innerHTML = "";
  if (!pending.size) { pane.style.display = "none"; return; }
  pane.style.display = "";

  const groups = groupPendingEntries();
  groups.forEach((g, i) => wrap.appendChild(makePendingGroupSection(g, i)));
  document.getElementById("pending-summary").textContent =
    `${pending.size} staged change(s) in ${groups.length} group(s) — not saved yet`;
}

function makePendingGroupSection(g, groupIdx) {
  const sec = document.createElement("div");
  sec.className = `face-group-section pending-group group-tint-${groupIdx % 6}`;
  sec.appendChild(faceGroupHeader({
    title: g.label,
    meta: `· ${g.entries.length} face(s) · ${photoCountLabel(g.entries.map(e => e.face))}`,
    extraClass: "amber",
    buttons: [
      { label: `✔ Commit (${g.entries.length})`, kind: "primary",
        title: `Save just this group's ${g.entries.length} change(s) to the database`,
        onClick: () => commitPending([g], g.label) },
      { label: "↩ Revert", kind: "danger",
        title: "Discard this group's staged changes and put the faces back in the grid",
        onClick: () => revertPending([g], g.label) },
    ],
  }));

  const cells = document.createElement("div");
  cells.className = "face-group-cells";
  g.entries.forEach(e => cells.appendChild(makePendingCell(e)));
  sec.appendChild(cells);
  return sec;
}

function makePendingCell(e) {
  const face = e.face;
  const cell = document.createElement("div");
  cell.className = "thumb-cell pending-cell" +
    (face.id === focusedFaceId ? " focused" : "");
  cell.dataset.id = face.id;
  // Same node the grid cell was using — a staged face moves from grid to
  // staging area without its thumbnail reloading.
  cell.appendChild(faceCropImg(face, { reuse: true }));

  const chip = document.createElement("div");
  chip.className = "face-label pending-label";
  chip.textContent = pendingCellLabel(e);
  cell.appendChild(chip);

  // Per-face revert — the fine-grained counterpart to the group/global buttons.
  const undo = document.createElement("button");
  undo.className = "pending-undo";
  undo.textContent = "✕";
  undo.title = "Revert this face (back to the grid, unchanged)";
  undo.addEventListener("click", (ev) => {
    ev.stopPropagation();
    unstageFaces([face.id]);
  });
  cell.appendChild(undo);

  // Left-click previews in the detail pane; right-click re-targets (which just
  // re-stages the face into another group).
  // Focus isn't drawn on a cell, so previewing one needs no repaint at all —
  // same as the contextmenu handler right below.
  cell.addEventListener("click", () => { focusedFaceId = face.id; updateDetail(); });
  cell.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    focusedFaceId = face.id;
    updateDetail();
    openFaceActions(cell, face);
  });
  return cell;
}

// Endpoint + body for one staged group. One request per group, so a person's
// whole batch lands in a single assign call (and one ignored_at/come_back_at
// batch stamp, which is what the Ignored/Come Back batch headers group on).
function pendingRequest(g, ids) {
  switch (g.kind) {
    case "assign":
      return ["/api/faces/assign", g.personId != null
        ? { face_ids: ids, person_id: g.personId }
        : { face_ids: ids, name: g.name }];
    case "unassign":    return ["/api/faces/assign",    { face_ids: ids, clear: true }];
    case "ignore":      return ["/api/faces/ignore",    { face_ids: ids, ignored: true }];
    case "unignore":    return ["/api/faces/ignore",    { face_ids: ids, ignored: false }];
    case "come_back":   return ["/api/faces/come-back", { face_ids: ids, come_back: true }];
    case "uncome_back": return ["/api/faces/come-back", { face_ids: ids, come_back: false }];
    default: throw new Error(`unknown staged action "${g.kind}"`);
  }
}

async function commitPending(groups, what) {
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  if (!total) { setStatus("Nothing staged to commit.", true); return; }
  if (!confirm(`Commit ${total} staged change(s)${what ? ` — ${what}` : ""}? ` +
               `This writes them to the database.`)) return;
  setStatus(`Committing ${total} change(s)…`);

  let saved = 0;
  const failures = [];
  for (const g of groups) {
    const ids = g.entries.map(e => e.face.id);
    try {
      const [url, body] = pendingRequest(g, ids);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Only clear what actually landed — a failed group stays staged so it can
      // be retried rather than silently lost.
      ids.forEach(id => pending.delete(id));
      saved += ids.length;
    } catch (err) {
      failures.push(`${g.label} (${err.message})`);
    }
  }

  await loadPersons();
  await loadFaces();
  if (failures.length) {
    setStatus(`Committed ${saved} of ${total} change(s). Still staged after failing: ` +
              failures.join(", ") + ".", true);
  } else {
    setStatus(`Committed ${saved} change(s).`);
  }
}

function revertPending(groups, what) {
  const ids = groups.flatMap(g => g.entries.map(e => e.face.id));
  if (!ids.length) { setStatus("Nothing staged to revert.", true); return; }
  if (ids.length > SELECTION_CONFIRM_THRESHOLD &&
      !confirm(`Discard ${ids.length} staged change(s)${what ? ` — ${what}` : ""}?`)) return;
  unstageFaces(ids);
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
    const res = await fetch(`/api/persons/${personId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Staged assignments to this person can no longer be committed (the server
    // 404s an unknown person) — put those faces back in the grid.
    const orphaned = [];
    pending.forEach((e, id) => {
      if (e.kind === "assign" && e.personId === personId) orphaned.push(id);
    });
    unstageFaces(orphaned, true);
    if (scope === "person" && scopePersonId === personId) {
      scope = "unlabeled"; scopePersonId = null;
    }
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Could not delete person: " + err.message, true);
  }
}

