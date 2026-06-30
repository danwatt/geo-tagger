/* ── State ── */
let faces = [];                 // faces for the current scope
let persons = [];               // [{id, name, face_count}]
let selectedIds = new Set();    // selected face ids
let lastClickedIndex = -1;
let focusedFaceId = null;

let scope = "unlabeled";        // "unlabeled" | "all" | "person"
let scopePersonId = null;       // when scope === "person"

let suggestedOnly = false;      // Unlabeled queue: hide faces with no guess
let clusters = [];              // discovered groups (Discover view)
let crowdGroups = [];           // crowd photo groups (Crowds view)
let hideCompletedCrowds = true; // hide crowd photos with no unlabeled faces

let groupGapSeconds = 86400;    // event grouping gap in the guesses view (1 day)

const FACE_LIMIT = 1000;
// Auto-select bar for the Unlabeled queue: a suggestion only exists at all above
// FACE_MATCH_THRESHOLD (0.35), so this higher cutoff pre-selects just the
// confident guesses and leaves weaker ones for manual triage.
const CONFIDENT_SCORE = 0.5;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  bindToolbar();
  await loadPersons();
  await loadFaces();
  setStatus("Select a person on the left, or scan for faces to begin.");
});

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("geocode-view-btn").addEventListener("click", () => {
    window.location.href = "/";
  });
  document.getElementById("timesync-view-btn").addEventListener("click", () => {
    window.location.href = "/timesync.html";
  });
  document.getElementById("contexts-view-btn").addEventListener("click", () => {
    window.location.href = "/contexts.html";
  });
  document.getElementById("quicktag-view-btn").addEventListener("click", () => {
    window.location.href = "/tag.html";
  });
  document.getElementById("manage-view-btn").addEventListener("click", () => {
    window.location.href = "/people-manage.html";
  });

  document.getElementById("deselect-all-btn").addEventListener("click", deselectAll);
  document.getElementById("suggested-only-chk").addEventListener("change", (e) => {
    suggestedOnly = e.target.checked;
    if (scope === "unlabeled") loadFaces();
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

  // Detail-pane assignment controls act on the current selection too.
  document.getElementById("detail-assign-btn").addEventListener("click", () => {
    const pid = parseInt(document.getElementById("detail-person-select").value);
    if (!pid) { setStatus("Pick a person from the dropdown first.", true); return; }
    assignSelected(pid);
  });
  document.getElementById("detail-new-btn").addEventListener("click", assignSelectedToNewPerson);
  document.getElementById("detail-unassign-btn").addEventListener("click", () => assignSelected(null, true));
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

/* ── People list ── */
async function loadPersons() {
  try {
    const [pRes, sRes] = await Promise.all([
      fetch("/api/persons"),
      fetch("/api/faces/scan/status"),
    ]);
    persons = await pRes.json();
    const status = await sRes.json();

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

  if (persons.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:#666;padding:8px;font-size:11px;";
    empty.textContent = "No people yet. Assign a face to create one.";
    list.appendChild(empty);
    return;
  }

  // Group by family; persons without a family go last.
  const familyMap = new Map(); // family_id -> { name, persons[] }
  const noFamily = [];
  persons.forEach((p) => {
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
  document.getElementById("crowd-controls").style.display =
    scope === "crowds" ? "" : "none";
  await loadFaces();
  await loadPersons();  // re-renders the list with the correct active highlight
}

/* ── Faces grid ── */
async function loadFaces() {
  if (scope === "discover") { await loadClusters(); return; }
  if (scope === "crowds")   { await loadCrowds();   return; }
  try {
    let url = `/api/faces?scope=${scope}&limit=${FACE_LIMIT}`;
    if ((scope === "person" || scope === "suggested") && scopePersonId) {
      url += `&person_id=${scopePersonId}`;
    }
    if (scope === "unlabeled" && suggestedOnly) url += "&suggested_only=true";
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
      // the flat `faces` array matches the on-screen order — shift-range
      // selection relies on index ↔ faces[index] correspondence.
      faces.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
      faces = computeMonthLocationGroups(faces).flatMap(g => g.faces);
      // Pre-select only the confident guesses — accept those in bulk, then
      // triage the weaker/unguessed faces by hand.
      selectedIds = new Set(
        faces.filter(f => f.suggestion && f.suggestion.score >= CONFIDENT_SCORE
                          && !f.person_name && !f.ignored)
             .map(f => f.id));
      focusedFaceId = faces.length ? faces[0].id : null;
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
        setStatus(`No guesses for ${personName} yet — label a few of their faces ` +
                  `first so recognition has examples to match against.`);
      } else {
        const ambiguous = faces.filter(f => f.alternatives && f.alternatives.length).length;
        const ambigNote = ambiguous
          ? `${ambiguous} (amber) may be someone else — check those. ` : "";
        setStatus(`${data.returned} guesses for ${personName}, all selected. ${ambigNote}` +
                  `Click any wrong ones to deselect, then Assign to approve the rest.`);
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
    } else if (scope === "unlabeled" && suggestedOnly && data.total === 0) {
      setStatus("No unlabeled faces have a recognition guess yet — uncheck " +
                "“Only suggested” to see the rest, or label a few faces so " +
                "recognition has examples to match against.");
    } else if (scope === "unlabeled") {
      const noun = suggestedOnly ? "suggested face(s)" : "unlabeled face(s)";
      let msg = `${data.returned} of ${data.total} ${noun}, grouped by month then place`;
      if (data.total > data.returned) msg += ` (showing first ${data.returned})`;
      if (selectedIds.size) msg += `. ${selectedIds.size} confident guess(es) pre-selected.`;
      setStatus(msg);
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
      group.faces.forEach(face => { cells.appendChild(makeFaceCell(face, idx)); idx++; });
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
// no location collect into one "No location" bucket per month.
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
    out.push(...buckets.values());
  });
  return out;
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

// Green chip confirming the face as its top-suggested person.
function makeSuggestChip(face) {
  const chip = document.createElement("div");
  chip.className = "face-suggest";
  chip.title = `Click to confirm: ${face.suggestion.person_name} (${face.suggestion.score})`;
  chip.innerHTML =
    `<span class="sug-check">✓</span>` +
    `<span class="sug-name">${face.suggestion.person_name}?</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    confirmFace(face.id, face.suggestion.person_id);
  });
  return chip;
}

// Amber chip tagging the face as a runner-up person instead of the suggestion.
function makeAltChip(face, alt) {
  const chip = document.createElement("div");
  chip.className = "face-alt";
  chip.title = `Click to tag as ${alt.person_name} instead (${alt.score})`;
  chip.innerHTML =
    `<span class="alt-arrow">→</span>` +
    `<span class="sug-name">${alt.person_name}?</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
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
    const res = await fetch("/api/faces/clusters");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    clusters = data.clusters || [];
    renderClusters();
    if (!clusters.length) {
      setStatus(`No groups found among ${data.scanned} clear unlabeled faces. ` +
        `Tag a few faces and use “Find more”, or rescan if many are still pending.`);
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
    const res = await fetch(`/api/crowds?min_faces=${minFaces}&group_gap=${gap}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    crowdGroups = data.groups || [];
    renderCrowds();
    if (!crowdGroups.length) {
      setStatus(`No crowd photos found with ≥ ${minFaces} faces. ` +
        `Try lowering the threshold or scan more photos.`);
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
    sug.appendChild(primary);

    if (alts.length) {
      const altWrap = document.createElement("div");
      altWrap.className = "sug-alts";
      const label = document.createElement("span");
      label.className = "sug-alts-label";
      label.textContent = "…or maybe:";
      altWrap.appendChild(label);
      alts.forEach(alt => {
        const b = document.createElement("button");
        b.className = "alt-btn";
        b.textContent = `${alt.person_name} (${alt.score})`;
        b.title = `Tag this face as ${alt.person_name} instead`;
        b.addEventListener("click", () => confirmFace(face.id, alt.person_id));
        altWrap.appendChild(b);
      });
      sug.appendChild(altWrap);
    }
  } else {
    sug.style.display = "none";
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

async function ignoreSelected(ignored) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
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

function updateActionButtons() {
  // The ignore button restores in the Ignored scope, ignores elsewhere.
  document.getElementById("ignore-btn").textContent =
    scope === "ignored" ? "↩ Restore" : "🚫 Ignore";

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

async function acceptSuggestionsForSelection() {
  const ids = new Set(selectionOrFocused());
  await acceptSuggestionsFor(faces.filter(f => ids.has(f.id)));
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

