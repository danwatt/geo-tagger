/* Flexible photo search: date range, location text, geotag status, and
 * one-or-more people (either "together in the same photo" or "any of them").
 * Results are grouped by year/month (like the other grids), the left column
 * is a selectable photo grid, and the right column previews the focused
 * photo with its metadata. One or more selected photos can be downloaded as
 * a ZIP of their original (full-quality / RAW) files. */

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

// The plain and untagged-face searches both fill the one results grid, so they
// share one latest-only guard (common.js): a second search started before the
// first returns supersedes it, whichever kind either is. "Load more" pages (A3)
// go through the same guard, so a new search discards a page still in flight,
// and a Load more can't land on top of a newer search.
const runResultsLoad = latestOnly((signal, body, ...args) => body(signal, ...args));
function runSearch() { return runResultsLoad(searchPhotos); }
function runUntaggedSearch() { return runResultsLoad(searchUntaggedFaces); }

// True from the moment a results load starts until the latest one settles.
// Bulk actions (Select all, Open in Geocode, the selection toolbar) refuse to
// run meanwhile: there is no result set on screen for them to act on. (A Load
// more append doesn't set it — the loaded results stay on screen and actionable.)
let resultsLoading = false;

// Bumped by every resetResults. A request that isn't part of the results
// loader (Select all matches, Open in Geocode's id fetch) captures it first and
// drops its answer if a newer search or Clear has replaced the results since.
let resultsGeneration = 0;

/* ── Paging (A3) ──
 * /api/search returns one page (config SEARCH_PAGE_SIZE, 2000 by default) plus
 * the true `total`; the rest is reachable through the "Load more" banner, same
 * UX as People's (U5). `key` is the query string the results came from (minus
 * paging) — Load more / Select all matches continue *that* search even if the
 * form has been edited since; `loaded` counts server rows consumed (the next
 * page's offset); `pageSize` is the server's default page, learned from the
 * first response. */
const SEARCH_REQUEST_MAX = 20000;     // /api/search caps `limit` here
const UNTAGGED_REQUEST_MAX = 5000;    // /api/search/untagged-faces' cap
let resultPaging = emptyPaging();

function emptyPaging() {
  return { key: null, total: 0, loaded: 0, nextOffset: null, pageSize: null,
           busy: false, what: "" };
}

function resultsTruncated() {
  return resultPaging.nextOffset != null;
}

// The whole-result-set timeline from the server ({min, max, bucket_secs,
// counts} or null) — every match, not just the loaded page.
let searchHistogram = null;

// Drop every piece of result state at once — both modes' results, the
// timeline's narrowing, the selection and the focused photo — and enter `mode`.
// Both loaders call this before fetching (W12): previously the untagged search
// left resultPhotos/filteredPhotos and the handoff toolbar in place, so
// "Select all" / "Open in Geocode" acted on the invisible previous search.
// The grid's loading state (U4, common.js setBusy) — a spinner pill over the
// emptied grid while a search runs. Taken here, released by the load that still
// owns the grid (finishResultsLoad), and force-cleared by a non-loading reset
// (Clear), so a superseded search can never clear the newer one's.
let releaseResultsBusy = () => {};

function resetResults(mode, loading) {
  resultsMode = mode;
  resultsLoading = loading;
  resultsGeneration++;
  const grid = document.getElementById("grid");
  if (loading) releaseResultsBusy = setBusy(grid, true, mode === "untagged" ? "Scanning faces…" : "Searching…");
  else setBusy(grid, false);
  resultPhotos = [];
  filteredPhotos = [];
  untaggedCandidates = [];
  histBuckets = [];
  searchHistogram = null;
  resultPaging = emptyPaging();
  rankedResults = rankedBySort = false;
  selectedIds.clear();
  lastClickedIndex = -1;
  document.getElementById("timeline").style.display = "none";
  document.getElementById("grid").innerHTML = "";
  document.getElementById("search-summary").textContent = "";
  renderResultsPaging();
  refreshSelectionUI();
  refreshHandoffUI();
  showPlaceholder();
}

// Settle the loading flag — only for the load that still owns the grid (a
// superseded one returns early on its aborted signal and must not clear the
// newer load's flag).
function finishResultsLoad(signal) {
  if (signal.aborted) return;
  resultsLoading = false;
  releaseResultsBusy();
  refreshSelectionUI();
  refreshHandoffUI();
  renderResultsPaging();
}

// Fetch `want` results of `base` (an endpoint URL with its query) starting at
// `offset`, in requests of at most `max` (the endpoint's cap). `want` null means
// one request at the server's default page size. Returns the items (`field` of
// each response), the server's total, where the following page starts (null
// once exhausted), and the first response (for its histogram/limit/warnings).
async function fetchResultPages(base, field, offset, want, max, signal) {
  const items = [];
  let first = null, total = 0, next = offset;
  do {
    const n = want == null ? null : Math.max(1, Math.min(want - items.length, max));
    const data = await fetchJson(`${base}&offset=${next}` + (n ? `&limit=${n}` : ""), { signal });
    first ||= data;
    items.push(...(Array.isArray(data[field]) ? data[field] : []));
    total = data.total;
    next = data.next_offset ?? null;
  } while (want != null && next != null && items.length < want && !signal.aborted);
  return { items, total, nextOffset: next, first };
}

// How many results a (re)load should fetch: a reload of the search already on
// screen (after Assign date, Guess dates, Undo, or Search pressed again with
// the same filters) keeps as many loaded as before, otherwise every action
// after a "Load more" would snap the grid back to the first page.
function reloadWant(key, prev) {
  return prev.key === key && prev.loaded > (prev.pageSize || 0) ? prev.loaded : null;
}

async function searchPhotos(signal, more = null) {
  if (more) return appendSearchPage(signal, more);
  const prev = resultPaging;
  resetResults("photos", true);
  setStatus("Searching…");
  try {
    const params = buildQuery();
    const key = params.toString();
    const want = reloadWant(key, prev);
    // 409/400 carry a human-readable reason (model not downloaded, photo not
    // indexed yet) — fetchJson shows it instead of a bare status code, and
    // flattens a 422's detail list, which `body.detail` would print as
    // "[object Object]".
    const page = await fetchResultPages(`/api/search?${key}`, "photos", 0, want,
                                        SEARCH_REQUEST_MAX, signal);
    if (signal.aborted) return;
    resultPhotos = page.items;
    rankedResults = params.has("text") || params.has("similar_to");
    rankedBySort = rankedResults && (params.get("sort") || "relevance") === "relevance";
    searchHistogram = page.first.histogram || null;
    resultPaging = {
      ...emptyPaging(), key, total: page.total, loaded: page.items.length,
      nextOffset: page.nextOffset,
      pageSize: want == null ? page.first.limit : prev.pageSize,
      what: params.has("similar_to") ? ` similar to ${similarTo.filename}` : "",
    };
    buildHistogram();
    renderGrid();
    updateResultsSummary();
    setStatus("");
    finishResultsLoad(signal);
    if (rankedResults) await noteIndexCoverage(signal);
  } catch (e) {
    if (signal.aborted) return;
    setStatus(`Search failed: ${e.message}`, true);
  } finally {
    finishResultsLoad(signal);
  }
}

// Load more / Load all for the plain results: append the next page(s) of the
// search on screen, keeping selection, focus, the timeline range and the scroll
// position. Runs inside runResultsLoad, so a new search started meanwhile
// aborts it (and a stale page never lands).
async function appendSearchPage(signal, more) {
  const p = resultPaging;
  if (resultsMode !== "photos" || !resultsTruncated()) return;
  const offset = p.nextOffset;
  const want = more === "all" ? p.total - offset : p.pageSize;
  p.busy = true;
  renderResultsPaging();
  try {
    const page = await fetchResultPages(`/api/search?${p.key}`, "photos", offset, want,
                                        SEARCH_REQUEST_MAX, signal);
    if (signal.aborted) return;
    // Offsets are positional, so a photo that moved between requests (a date
    // edit in another tab, a scan) could come back twice — drop repeats rather
    // than draw (and count) the same cell twice.
    const seen = new Set(resultPhotos.map((ph) => ph.id));
    const added = page.items.filter((ph) => !seen.has(ph.id));
    resultPhotos = resultPhotos.concat(added);
    Object.assign(p, { total: page.total, loaded: offset + page.items.length,
                       nextOffset: page.nextOffset });
    // Same timeline narrowing as before; the selection stays as it was.
    filteredPhotos = photosInTimelineRange(resultPhotos);
    const pane = document.getElementById("grid-pane");
    const scrollTop = pane.scrollTop;
    renderGrid();
    pane.scrollTop = scrollTop;   // the grid is rebuilt; new cells only go below
    refreshSelectionUI();
    refreshHandoffUI();
    updateResultsSummary();
    setStatus(`Loaded ${added.length.toLocaleString()} more — ` +
              `${resultPhotos.length.toLocaleString()} of ${p.total.toLocaleString()} now shown.`);
  } catch (e) {
    if (signal.aborted) return;
    setStatus(`Failed to load more results: ${e.message}`, true);
  } finally {
    if (!signal.aborted) { p.busy = false; renderResultsPaging(); }
  }
}

// "Showing first 2,000 of 12,345 photos found" while truncated — never a bare
// page count passed off as the total (A3).
function updateResultsSummary() {
  const p = resultPaging;
  const n = resultsMode === "untagged" ? untaggedCandidates.length : resultPhotos.length;
  const noun = p.total === 1 ? "photo" : "photos";
  document.getElementById("search-summary").textContent = resultsTruncated()
    ? `Showing ${rankedBySort ? "top" : "first"} ${n.toLocaleString()} of ` +
      `${p.total.toLocaleString()} ${noun} found${p.what}`
    : `${p.total.toLocaleString()} ${noun} found${p.what}`;
}

// The "Showing N of M" strip under the results nav, shown only while the
// results on screen are truncated. Spells out that Select all and the
// selection actions see the loaded photos only, and offers "Select all M".
function renderResultsPaging() {
  const bar = document.getElementById("search-paging");
  const p = resultPaging;
  const show = resultsTruncated() && !resultsLoading;
  bar.hidden = !show;
  if (!show) return;
  const untagged = resultsMode === "untagged";
  const loadedN = untagged ? untaggedCandidates.length : resultPhotos.length;
  const remaining = Math.max(0, p.total - p.loaded);
  const nextN = Math.min(p.pageSize || remaining, remaining);
  document.getElementById("search-paging-text").textContent =
    `Showing ${loadedN.toLocaleString()} of ${p.total.toLocaleString()} ` +
    (untagged
      ? "photos. Group buttons only cover the loaded photos."
      : `${rankedBySort ? "best matches" : "photos"}. Select all and the timeline range ` +
        "only cover the loaded photos; the timeline's bars count every match.");
  const moreBtn = document.getElementById("search-paging-more-btn");
  if (p.busy) moreBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span> Loading…`;
  else moreBtn.textContent = `Load ${nextN.toLocaleString()} more`;
  moreBtn.disabled = p.busy;
  const allBtn = document.getElementById("search-paging-all-btn");
  allBtn.hidden = remaining <= nextN;   // one more page is all there is
  allBtn.textContent = `Load all (${remaining.toLocaleString()})`;
  allBtn.disabled = p.busy;
  const selBtn = document.getElementById("search-paging-select-btn");
  selBtn.hidden = untagged;
  selBtn.textContent = `Select all ${p.total.toLocaleString()}`;
  selBtn.title = "Select every match, loaded or not (within the timeline range) — " +
                 "Open in Geocode, Download ZIP and the date tools then act on all of them";
  selBtn.disabled = p.busy;
}

function loadMoreResults() {
  if (resultPaging.busy || !resultsTruncated() || resultsLoading) return;
  runResultsLoad(resultsMode === "untagged" ? searchUntaggedFaces : searchPhotos, "page");
}

// confirm() before a load-all that would put a very large grid on screen
// (every cell is a live <img>), like People's Load all.
function loadAllResults() {
  if (resultPaging.busy || !resultsTruncated() || resultsLoading) return;
  const remaining = resultPaging.total - resultPaging.loaded;
  if (resultPaging.total > SEARCH_REQUEST_MAX &&
      !confirm(`Load all ${remaining.toLocaleString()} remaining photo(s)? ` +
               `${resultPaging.total.toLocaleString()} photos in one grid can make ` +
               `the page slow to scroll and select.`)) return;
  runResultsLoad(resultsMode === "untagged" ? searchUntaggedFaces : searchPhotos, "all");
}

// Every match of the search on screen (loaded or not), narrowed by the timeline
// range the same way the grid is (undated photos always pass). One ids-only
// request: ids plus timestamps, no photo rows.
async function fetchAllMatchIds() {
  const data = await fetchJson(`/api/search?${resultPaging.key}&ids_only=true`);
  if (!timelineNarrowed()) return data.ids;
  return data.ids.filter((_, i) => {
    const ts = data.datetimes[i];
    return !ts || (ts >= dateFilterLo && ts <= dateFilterHi);
  });
}

// "Select all 12,345": the whole result set, not just the loaded pages. The
// selection actions all take id lists in a POST body (Download ZIP keeps its
// own size cap and says so), and Open in Geocode hands large sets over through
// sessionStorage — so nothing downstream needs the photos to be loaded.
async function selectAllMatches() {
  // Not photoResultsActionable(): a timeline range can hold matches even when
  // none of the *loaded* photos fall in it, and this is how to reach them.
  if (resultsMode !== "photos" || resultsLoading || !resultsTruncated() || resultPaging.busy) return;
  const gen = resultsGeneration;
  const btn = document.getElementById("search-paging-select-btn");
  btn.disabled = true;
  setStatus(`Selecting all ${resultPaging.total.toLocaleString()} matches…`);
  try {
    const ids = await fetchAllMatchIds();
    if (gen !== resultsGeneration) return;
    selectedIds = new Set(ids);
    lastClickedIndex = -1;
    refreshSelectionUI();
    const unloaded = ids.length - resultPhotos.filter((p) => selectedIds.has(p.id)).length;
    setStatus(`Selected all ${ids.length.toLocaleString()} matches` +
              (timelineNarrowed() ? " in the timeline range" : "") +
              (unloaded ? ` — ${unloaded.toLocaleString()} of them aren't loaded in the grid, ` +
                          "but the selection actions include them." : "."));
  } catch (e) {
    if (gen === resultsGeneration) setStatus(`Select all failed: ${e.message}`, true);
  } finally {
    if (gen === resultsGeneration) renderResultsPaging();
  }
}

/* ── Text search ("describe the photo") + More like this ── */

// Photo picked via "More like this" — {id, filename} — until text is typed or Clear.
let similarTo = null;
let rankedResults = false;  // last results came from a text/similar query (have .score)
let rankedBySort = false;   // ...and are ordered by score, so don't month-group them

// Warn when results are partial because indexing hasn't finished; silent otherwise.
// `signal` is the calling search's: a newer search owns the status line.
async function noteIndexCoverage(signal) {
  try {
    const res = await fetch("/api/semantic/status", { signal });
    if (!res.ok) return;
    const s = await res.json();
    if (signal.aborted) return;
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

// Select all / Open in Geocode only have a meaning over a settled plain-photo
// result set that is on screen.
function photoResultsActionable() {
  return resultsMode === "photos" && !resultsLoading && filteredPhotos.length > 0;
}

function refreshHandoffUI() {
  const group = document.getElementById("handoff-group");
  const peopleBtn = document.getElementById("open-people-btn");
  group.style.display = photoResultsActionable() ? "" : "none";
  peopleBtn.style.display = selectedPersons.length === 1 ? "" : "none";
}

// The selection, or — with nothing selected — every result in the timeline
// range: the loaded ones when that's all there is, else every match (fetched as
// ids only, A3). Up to SEARCH_HANDOFF_URL_MAX ids ride in the URL as before
// (?ids=, and the Geocode page POSTs them on to /api/photos/by-ids); a bigger
// set goes through a sessionStorage hand-off (common.js stashSearchHandoff),
// since tens of thousands of ids don't fit in a request line.
async function openInGeocode() {
  if (!photoResultsActionable()) return;
  let ids;
  if (selectedIds.size > 0) {
    ids = [...selectedIds];
  } else if (resultsTruncated()) {
    const gen = resultsGeneration;
    setStatus(`Collecting all ${resultPaging.total.toLocaleString()} matches for Geocode…`);
    try {
      ids = await fetchAllMatchIds();
    } catch (e) {
      if (gen === resultsGeneration) setStatus(`Open in Geocode failed: ${e.message}`, true);
      return;
    }
    if (gen !== resultsGeneration) return;
  } else {
    ids = filteredPhotos.map((p) => p.id);
  }
  if (!ids.length) return;
  if (ids.length <= SEARCH_HANDOFF_URL_MAX) {
    window.location.href = `/geocode.html?ids=${ids.join(",")}`;
    return;
  }
  const token = stashSearchHandoff(ids);
  if (!token) {
    setStatus(`Can't hand ${ids.length.toLocaleString()} photos to Geocode: this browser's ` +
              `session storage is unavailable or full. Select ${SEARCH_HANDOFF_URL_MAX.toLocaleString()} ` +
              "or fewer and try again.", true);
    return;
  }
  window.location.href = `/geocode.html?handoff=${token}`;
}

function openInPeople() {
  if (selectedPersons.length !== 1) return;
  window.location.href = `/people.html?person=${selectedPersons[0].id}`;
}

/* ── Untagged-face search: candidates where the searched people appear via an
 * untagged near-match face, not yet a plain-search hit. ── */

async function searchUntaggedFaces(signal, more = null) {
  if (more) return appendUntaggedPage(signal, more);
  const prev = resultPaging;
  resetResults("untagged", true);
  setStatus("Scanning for untagged faces…");
  try {
    const key = buildQuery().toString();
    const want = reloadWant(key, prev);
    const page = await fetchResultPages(`/api/search/untagged-faces?${key}`, "candidates", 0,
                                        want, UNTAGGED_REQUEST_MAX, signal);
    if (signal.aborted) return;
    untaggedCandidates = page.items;
    resultPaging = {
      ...emptyPaging(), key, total: page.total, loaded: page.items.length,
      nextOffset: page.nextOffset,
      pageSize: want == null ? page.first.limit : prev.pageSize,
    };
    renderUntaggedGrid();
    updateResultsSummary();
    const warnings = page.first.warnings || [];
    setStatus(warnings.join(" "), warnings.length > 0);
  } catch (e) {
    if (signal.aborted) return;
    setStatus(`Search failed: ${e.message}`, true);
  } finally {
    finishResultsLoad(signal);
  }
}

// Load more for the untagged-face candidates. Tagging here edits the loaded
// candidates locally (no refetch), and a candidate whose last proposed face was
// confirmed/ignored/rejected no longer qualifies server-side — so the server's
// list is that many rows shorter and the next page starts that much earlier.
// `loaded`/`total` stay in local-list terms (emptied candidates included), so
// the server offset is always `loaded` minus the candidates emptied so far.
// Repeats that slip through anyway are dropped by photo id.
async function appendUntaggedPage(signal, more) {
  const p = resultPaging;
  if (resultsMode !== "untagged" || !resultsTruncated()) return;
  const dropped = untaggedCandidates.filter((c) => c.proposed.length === 0).length;
  const offset = Math.max(0, p.loaded - dropped);
  const want = more === "all" ? Math.max(1, p.total - p.loaded) : p.pageSize;
  p.busy = true;
  renderResultsPaging();
  try {
    const page = await fetchResultPages(`/api/search/untagged-faces?${p.key}`, "candidates",
                                        offset, want, UNTAGGED_REQUEST_MAX, signal);
    if (signal.aborted) return;
    const seen = new Set(untaggedCandidates.map((c) => c.photo.id));
    const added = page.items.filter((c) => !seen.has(c.photo.id));
    untaggedCandidates = untaggedCandidates.concat(added);
    Object.assign(p, { total: page.total + dropped, loaded: offset + page.items.length + dropped,
                       nextOffset: page.nextOffset });
    const pane = document.getElementById("grid-pane");
    const scrollTop = pane.scrollTop;
    renderUntaggedGrid();
    pane.scrollTop = scrollTop;
    updateResultsSummary();
    setStatus(`Loaded ${added.length.toLocaleString()} more — ` +
              `${untaggedCandidates.length.toLocaleString()} of ${p.total.toLocaleString()} now shown.`);
  } catch (e) {
    if (signal.aborted) return;
    setStatus(`Failed to load more results: ${e.message}`, true);
  } finally {
    if (!signal.aborted) { p.busy = false; renderResultsPaging(); }
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
    const p = wallClockParts(c.photo.photo_datetime);   // UTC getters — see common.js
    const year = p ? p.year : null, month = p ? p.month : null;
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
      body: JSON.stringify(personId == null ? { clear: true } : { person_id: personId }),
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
    // Truncated + an empty timeline range: matches may exist in the range, just
    // not among the loaded pages (the timeline's bars count every match).
    const msg = resultsTruncated() && resultPhotos.length
      ? "None of the loaded photos fall in this timeline range. Load more, or search with this date range."
      : "No photos match these filters.";
    grid.innerHTML = `<div class="person-suggest-empty" style="grid-column:1/-1;padding:24px;text-align:center">${msg}</div>`;
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
    const p = wallClockParts(photo.photo_datetime);   // UTC getters — see common.js
    const year = p ? p.year : null, month = p ? p.month : null;
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
  if (selectionActionable()) {
    group.style.display = "";
    count.textContent = selectionCountText();
  } else {
    group.style.display = "none";
  }
}

// While the results are truncated (A3) the count says which part of the result
// set the selection covers: all of it (Select all N), some photos that aren't
// loaded, or loaded photos only.
function selectionCountText() {
  const n = selectedIds.size;
  if (!resultsTruncated()) return `${n.toLocaleString()} selected`;
  if (n === resultPaging.total) return `All ${n.toLocaleString()} matches selected`;
  const loadedSel = resultPhotos.reduce((k, p) => k + (selectedIds.has(p.id) ? 1 : 0), 0);
  return loadedSel < n
    ? `${n.toLocaleString()} selected (${(n - loadedSel).toLocaleString()} not loaded)`
    : `${n.toLocaleString()} selected (of ${resultPhotos.length.toLocaleString()} loaded)`;
}

function clearSelection() {
  selectedIds.clear();
  refreshSelectionUI();
}

/* ── Detail pane ── */

function showPlaceholder() {
  focusedPhotoId = null;
  const ph = document.getElementById("detail-placeholder");
  ph.textContent = "Select a photo to view details";   // showDetail may have left an error here
  ph.style.display = "";
  document.getElementById("detail-content").style.display = "none";
}

// Latest-only (common.js): arrowing through results fires one per photo, and
// only the photo focused last may fill the pane.
const showDetail = latestOnly(async (signal, id) => {
  focusedPhotoId = id;
  try {
    const data = await fetchJson(`/api/photo/${id}`, { signal });
    if (signal.aborted) return;

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
    if (signal.aborted) return;
    // Don't leave the previous photo's details up under this one's selection.
    showPlaceholder();
    focusedPhotoId = id;
    document.getElementById("detail-placeholder").textContent =
      `Could not load photo details: ${err.message}`;
  }
});

/* ── Select all ── */

// The visible photos only: filteredPhotos is what renderGrid draws. (It used to
// fall back to resultPhotos when the timeline narrowed to nothing, selecting
// photos that weren't on screen.) With a truncated result (A3) that is the
// loaded pages only — say so, and point at the banner's "Select all N".
function selectAllResults() {
  if (!photoResultsActionable()) return;
  selectedIds = new Set(filteredPhotos.map((p) => p.id));
  refreshSelectionUI();
  if (resultsTruncated()) {
    const notLoaded = resultPaging.total - resultPaging.loaded;
    setStatus(`Selected the ${filteredPhotos.length.toLocaleString()} loaded photo(s) — ` +
              `${notLoaded.toLocaleString()} more matches aren't loaded. Use ` +
              `"Select all ${resultPaging.total.toLocaleString()}" above the grid to include them.`);
  }
}

// The selection toolbar's actions act on selectedIds; refuse while a load is
// replacing the results under it.
function selectionActionable() {
  return resultsMode === "photos" && !resultsLoading && selectedIds.size > 0;
}

/* ── Assign approximate date ── */

// The photos the open Assign-date modal acts on, captured when it opens. Apply
// posts these, not whatever selectedIds holds by then: a search or Clear
// selection behind the modal must not turn Apply into an empty (or different)
// photo_ids list.
let assignDateIds = [];

function openAssignDateModal() {
  if (!selectionActionable()) return;
  assignDateIds = [...selectedIds];
  const n = assignDateIds.length;
  document.getElementById("assign-date-summary").textContent =
    `Assigning an approximate date to ${n} selected photo${n === 1 ? "" : "s"}.`;
  document.getElementById("assign-date-year").value = "";
  document.getElementById("assign-date-month").value = "";
  document.getElementById("assign-date-modal").style.display = "flex";
}

function closeAssignDateModal() {
  document.getElementById("assign-date-modal").style.display = "none";
  assignDateIds = [];
}

async function applyAssignDate() {
  // Already posting (Enter in a field can fire while Apply is disabled).
  if (document.getElementById("assign-date-apply-btn").disabled) return;
  const yearStr = document.getElementById("assign-date-year").value;
  const monthStr = document.getElementById("assign-date-month").value;
  const year = parseInt(yearStr);
  if (!yearStr || isNaN(year)) {
    alert("Please enter a year");
    return;
  }
  const month = monthStr ? parseInt(monthStr) : null;
  const ids = assignDateIds.slice();
  if (!ids.length) {
    closeAssignDateModal();
    setStatus("Assign date: no photos selected — select photos, then try again.", true);
    return;
  }

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
    if (!res.ok) throw new Error(await httpErrorMessage(res));
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
  if (!selectionActionable()) return;
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
        <td class="guess-source">${row.guess ? escapeHtml(row.guess.source) : ""}</td>
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
  if (!selectionActionable()) return;
  const btn = document.getElementById("download-selected-btn");
  const ids = [...selectedIds];
  btn.disabled = true;
  btn.textContent = "⬇ Preparing…";
  try {
    // Preflight: the server validates the selection (files exist, under the size
    // cap) without building anything. A navigation download can't report errors —
    // a 404/413 would replace this page with raw JSON — so only submit once it passes.
    const res = await fetch("/api/photos/download-zip?check=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: ids }),
    });
    if (!res.ok) throw new Error(await httpErrorMessage(res));
    const info = await res.json();
    // A plain form POST (navigation download): the response is an
    // attachment, so the browser streams it to disk and the page stays put. The
    // archive never passes through JS memory (it used to be a res.blob()).
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/photos/download-zip";
    form.style.display = "none";
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "photo_ids";
    field.value = ids.join(",");
    form.appendChild(field);
    document.body.appendChild(form);
    form.submit();
    form.remove();
    const mb = (info.total_bytes / (1024 * 1024)).toFixed(1);
    const skipped = info.skipped ? ` (${info.skipped} missing file(s) skipped)` : "";
    setStatus(`Downloading ${info.count} photo(s), ${mb} MB${skipped}…`);
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
  // Supersede any in-flight search (its results must not land after Clear),
  // then drop the result state the same way a new search does.
  runResultsLoad(async () => {});
  resetResults("photos", false);
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

    // Bucket ts are photo_datetime values (wall clock as UTC) — format in UTC.
    let label;
    if (histBucketSecs <= 86400) {
      label = formatWallClockDate(bucket.ts, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    } else if (histBucketSecs <= 86400 * 7) {
      label = formatWallClockDate(bucket.ts, { month: "short", day: "numeric" }) + " – " +
              formatWallClockDate(bucket.ts + histBucketSecs - 86400, { month: "short", day: "numeric", year: "numeric" });
    } else {
      label = formatWallClockDate(bucket.ts, { month: "long", year: "numeric" });
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

// The timeline describes the whole result set (A3): /api/search buckets every
// match's date server-side (search_service.timeline_histogram — a day per bucket
// up to 90 days, a week up to a year, else 30 days), so a truncated search's
// bars don't stop at the last loaded photo. The range still narrows the loaded
// photos client-side (applyTimelineFilter).
function buildHistogram() {
  filteredPhotos = resultPhotos;
  const h = searchHistogram;
  if (!h) {
    document.getElementById("timeline").style.display = "none";
    dateRangeMin = dateRangeMax = 0;
    dateFilterLo = dateFilterHi = 0;
    histBuckets = [];
    return;
  }
  document.getElementById("timeline").style.display = "";
  dateRangeMin = h.min;
  dateRangeMax = h.max;
  dateFilterLo = dateRangeMin;
  dateFilterHi = dateRangeMax;
  document.getElementById("range-lo").value = 0;
  document.getElementById("range-hi").value = 1000;
  histBucketSecs = h.bucket_secs;
  histBuckets = h.counts.map((count, i) => ({ ts: h.min + i * h.bucket_secs, count }));
  updateDateLabels();
  drawHistogram();
}

// True while the timeline's range excludes part of the result span.
function timelineNarrowed() {
  return histBuckets.length > 0 && (dateFilterLo > dateRangeMin || dateFilterHi < dateRangeMax);
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
  return formatWallClockDate(ts, { year: "numeric", month: "short", day: "numeric" });
}

function photosInTimelineRange(photos) {
  if (!timelineNarrowed()) return photos;
  return photos.filter((p) => {
    if (!p.photo_datetime) return true; // keep undated photos visible regardless of range
    return p.photo_datetime >= dateFilterLo && p.photo_datetime <= dateFilterHi;
  });
}

function applyTimelineFilter() {
  filteredPhotos = photosInTimelineRange(resultPhotos);
  selectedIds.clear();
  lastClickedIndex = -1;
  refreshSelectionUI();
  refreshHandoffUI();   // nothing visible → nothing for Select all / Geocode to act on
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
document.getElementById("similar-btn").addEventListener("click", searchSimilar);
document.getElementById("untagged-btn").addEventListener("click", runUntaggedSearch);
document.getElementById("clear-btn").addEventListener("click", clearForm);
document.getElementById("download-selected-btn").addEventListener("click", downloadSelected);
document.getElementById("clear-selection-btn").addEventListener("click", clearSelection);
document.getElementById("open-geocode-btn").addEventListener("click", openInGeocode);
document.getElementById("open-people-btn").addEventListener("click", openInPeople);
document.getElementById("select-all-btn").addEventListener("click", selectAllResults);
document.getElementById("search-paging-more-btn").addEventListener("click", loadMoreResults);
document.getElementById("search-paging-all-btn").addEventListener("click", loadAllResults);
document.getElementById("search-paging-select-btn").addEventListener("click", selectAllMatches);
document.getElementById("assign-date-btn").addEventListener("click", openAssignDateModal);
document.getElementById("assign-date-close").addEventListener("click", closeAssignDateModal);
document.getElementById("assign-date-cancel-btn").addEventListener("click", closeAssignDateModal);
document.getElementById("assign-date-apply-btn").addEventListener("click", applyAssignDate);
document.getElementById("guess-dates-btn").addEventListener("click", openGuessDatesModal);
document.getElementById("guess-dates-close").addEventListener("click", closeGuessDatesModal);
document.getElementById("guess-dates-cancel-btn").addEventListener("click", closeGuessDatesModal);
document.getElementById("guess-dates-commit-btn").addEventListener("click", commitGuessDates);
document.getElementById("date-undo-btn").addEventListener("click", undoDateCommit);
// Enter in a filter field runs the search — one listener on the form, so one
// search per press (W4). Scoped to #search-form, not document: Enter in the
// Assign-date / Guess-dates modals must never start a search behind them (it
// would replace the results and clear the selection the modal acts on).
// Skipped: keys a field already handled (location suggestion picked, date range
// applied — both preventDefault), the people picker (Enter there is its own),
// the date-range panel, and buttons (Enter on a button is that button's click).
document.getElementById("search-form").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.defaultPrevented || e.isComposing) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.id === "person-picker-input" || t.closest("#date-range")) return;
  if (t.tagName !== "INPUT" && t.tagName !== "SELECT") return;
  e.preventDefault();
  runSearch();
});
// Enter in the Assign-date fields applies, like pressing Apply.
for (const id of ["assign-date-year", "assign-date-month"]) {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    applyAssignDate();
  });
}

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
