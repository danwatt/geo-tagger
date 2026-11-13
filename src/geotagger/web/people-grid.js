/* people-grid.js — People page: loading faces for the current scope and
 * rendering the main face grid (incl. the Unlabeled-queue filter/status and
 * in-place selection repaint). */

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
  // Empty the staging area first: a face reverted out of it is rebuilt in the
  // grid below, and while its old staging cell is still in the document the
  // crop cache won't hand that <img> over (see faceCropImg) — so every revert
  // or undo would re-fetch and re-decode each returning face.
  document.getElementById("pending-groups").innerHTML = "";
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
