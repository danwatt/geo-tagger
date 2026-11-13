/* people-focus.js — People page: the Time Focus window (year / month
 * dropdown, query fragment, status suffix). */

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
