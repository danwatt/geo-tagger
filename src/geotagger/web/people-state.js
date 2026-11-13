/* people-state.js — People page: shared state, tunables and lookup helpers
 * (findFace, gridFaces). Part of the people.js split; classic
 * scripts sharing one global scope. Must load first of the people-*.js files
 * (after face-grid.js, whose GROUP_SORT_MODES is read at load time). */

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
// Reverting more staged changes than this at once asks for confirmation
// (see revertPending).
const SELECTION_CONFIRM_THRESHOLD = 3;

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

// What the main grid should still show: everything without a staged decision.
function gridFaces() {
  return pending.size ? faces.filter(f => !pending.has(f.id)) : faces;
}
