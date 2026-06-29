/* ── State ── */
let faces = [];                 // faces for the current scope
let persons = [];               // [{id, name, face_count}]
let selectedIds = new Set();    // selected face ids
let lastClickedIndex = -1;
let focusedFaceId = null;

let scope = "unlabeled";        // "unlabeled" | "all" | "person"
let scopePersonId = null;       // when scope === "person"

let scanning = false;
let stopScanRequested = false;

let suggestedOnly = false;      // Unlabeled queue: hide faces with no guess
let clusters = [];              // discovered groups (Discover view)

let groupGapSeconds = 86400;    // event grouping gap in the guesses view (1 day)

const FACE_LIMIT = 1000;
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
  document.getElementById("quicktag-view-btn").addEventListener("click", () => {
    window.location.href = "/tag.html";
  });
  document.getElementById("manage-view-btn").addEventListener("click", () => {
    window.location.href = "/people-manage.html";
  });

  document.getElementById("scan-btn").addEventListener("click", toggleScan);
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
    ignoreSelected(!(f && f.ignored));  // toggle the focused face's ignored state
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
    updateScanStatus(status.remaining_photos, totalFaces);
  } catch (err) {
    setStatus("Failed to load people: " + err.message, true);
  }
}

function renderPeopleList(unlabeledCount, allCount, ignoredCount, taggedCount) {
  const list = document.getElementById("people-list");
  list.innerHTML = "";

  list.appendChild(makeScopeItem("Unlabeled", unlabeledCount, "unlabeled", null));
  list.appendChild(makeScopeItem("Discover groups", null, "discover", null));
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

function updateScanStatus(remainingPhotos, totalFaces) {
  const el = document.getElementById("scan-status");
  if (scanning) return;  // leave the live message during a scan
  const parts = [];
  if (remainingPhotos > 0) parts.push(`${remainingPhotos} photos pending`);
  parts.push(`${totalFaces} faces`);
  el.textContent = parts.join(" · ");
}

/* ── Scope selection ── */
async function selectScope(newScope, personId) {
  scope = newScope;
  scopePersonId = personId;
  selectedIds.clear();
  lastClickedIndex = -1;
  focusedFaceId = null;
  await loadFaces();
  await loadPersons();  // re-renders the list with the correct active highlight
}

/* ── Faces grid ── */
async function loadFaces() {
  if (scope === "discover") { await loadClusters(); return; }
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
      // Oldest first so the year/month dividers read top-to-bottom. In "Only
      // suggested" mode, cluster each month by suggested person (date secondary)
      // — month stays the primary key so the month grouping/range-select hold.
      faces.sort(suggestedOnly
        ? byMonthThenPersonThenDate
        : (a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
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
    } else {
      const label = scope === "person" ? personName : scope;
      const what = (scope === "unlabeled" && suggestedOnly)
        ? "suggested face(s) — Unlabeled" : `faces — ${label}`;
      let msg = `${data.returned} of ${data.total} ${what}`;
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

  // In the guesses view, lay faces out under event-group headers.
  if (scope === "suggested") {
    let idx = 0, groupIdx = 0;
    computeTimeGroups(faces, groupGapSeconds).forEach(group => {
      const sec = makeGroupSection(groupIdx++);
      sec.appendChild(makeGroupHeader(group));
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

  // Unlabeled queue: year dividers + a per-month header carrying an "Accept all"
  // button that confirms the suggestions for just that month's faces.
  if (scope === "unlabeled") {
    let idx = 0, curYear = null, groupIdx = 0;
    computeMonthGroups(faces).forEach(group => {
      if (group.year !== null && group.year !== curYear) {
        curYear = group.year;
        const yd = document.createElement("div");
        yd.className = "grid-year-divider";
        yd.textContent = group.year;
        grid.appendChild(yd);
      }
      grid.appendChild(makeMonthHeader(group));
      // In "Only suggested" mode the month is clustered by person; when more than
      // one person appears, give each a sub-header with its own "Accept all".
      const runs = suggestedOnly ? computePersonRuns(group.faces) : null;
      if (runs && runs.length > 1) {
        runs.forEach(run => {
          const sec = makeGroupSection(groupIdx++);
          sec.appendChild(makePersonRunHeader(run));
          const cells = document.createElement("div");
          cells.className = "face-group-cells";
          run.faces.forEach(face => { cells.appendChild(makeFaceCell(face, idx)); idx++; });
          sec.appendChild(cells);
          grid.appendChild(sec);
        });
      } else {
        group.faces.forEach(face => { grid.appendChild(makeFaceCell(face, idx)); idx++; });
        groupIdx++;
      }
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

// Sort key for a face's calendar month ("YYYY-MM"; undated sorts first), so the
// month grouping stays contiguous regardless of any secondary ordering.
function monthKey(f) {
  if (!f.photo_datetime) return "0000-00";
  const d = new Date(f.photo_datetime * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
}

// Month → suggested person (alphabetical) → date. Clusters each month's faces by
// who they're guessed to be while keeping months in chronological order.
function byMonthThenPersonThenDate(a, b) {
  const ma = monthKey(a), mb = monthKey(b);
  if (ma !== mb) return ma < mb ? -1 : 1;
  const an = ((a.suggestion && a.suggestion.person_name) || "￿").toLowerCase();
  const bn = ((b.suggestion && b.suggestion.person_name) || "￿").toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return (a.photo_datetime || 0) - (b.photo_datetime || 0);
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

function makeMonthHeader(group) {
  const header = document.createElement("div");
  header.className = "face-month-header";

  const labelText = group.year === null ? "Undated" : MONTH_NAMES[group.month];
  const label = document.createElement("span");
  label.textContent = labelText;
  header.appendChild(label);

  const acceptable = group.faces.filter(f => f.suggestion && !f.person_name && !f.ignored);
  if (acceptable.length > 0) {
    const btn = document.createElement("button");
    btn.className = "month-accept-btn";
    btn.textContent = `Accept all (${acceptable.length})`;
    btn.title = "Confirm the suggested name for every guessed face in this month";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      acceptSuggestionsFor(group.faces, labelText);
    });
    header.appendChild(btn);
  }
  return header;
}

// Runs of consecutive same-suggested-person faces within an already-clustered month.
function computePersonRuns(list) {
  const runs = [];
  let cur = null;
  list.forEach(f => {
    const pid = f.suggestion ? f.suggestion.person_id : null;
    if (!cur || cur.person_id !== pid) {
      cur = { person_id: pid, person_name: f.suggestion ? f.suggestion.person_name : null, faces: [] };
      runs.push(cur);
    }
    cur.faces.push(f);
  });
  return runs;
}

// Per-person sub-header inside a month, with an "Accept all" scoped to that person.
function makePersonRunHeader(run) {
  const header = document.createElement("div");
  header.className = "face-person-subhdr";

  const label = document.createElement("span");
  label.textContent = run.person_name || "No suggestion";
  header.appendChild(label);

  const acceptable = run.faces.filter(f => f.suggestion && !f.person_name && !f.ignored);
  if (acceptable.length > 0) {
    const btn = document.createElement("button");
    btn.className = "subhdr-accept-btn";
    btn.textContent = `Accept all (${acceptable.length})`;
    btn.title = `Confirm ${run.person_name} for these ${acceptable.length} face(s)`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      acceptSuggestionsFor(run.faces, run.person_name);
    });
    header.appendChild(btn);
  }
  return header;
}

function makeFaceCell(face, idx) {
  const cell = document.createElement("div");
  cell.className = "thumb-cell" +
    (selectedIds.has(face.id) ? " selected" : "") +
    (face.ignored ? " ignored" : "");
  cell.dataset.id = face.id;

  const img = document.createElement("img");
  img.src = `/api/faces/${face.id}/crop`;
  img.alt = face.filename;
  img.loading = "lazy";
  cell.appendChild(img);

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

  cell.addEventListener("click", (e) => handleCellClick(e, face, idx));
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
  const header = document.createElement("div");
  header.className = "face-group-header";

  const names = [...new Set(group.faces.map(f => f.person_name).filter(Boolean))];
  const who = names.length === 1 ? names[0]
            : names.length === 2 ? names.join(" & ")
            : `${names.length} people`;
  const label = document.createElement("span");
  label.className = "face-group-label";
  label.innerHTML = `${who} ` +
    `<span class="face-group-meta">· ${formatRelativeTime(group.ts)} · ` +
    `${group.faces.length} face(s)</span>`;

  const btns = document.createElement("div");
  btns.className = "face-group-btns";
  const untagAll = document.createElement("button");
  untagAll.className = "danger";
  untagAll.textContent = `Untag all (${group.faces.length})`;
  untagAll.title = "Un-tag every face tagged in this batch (returns them to Unlabeled)";
  untagAll.addEventListener("click", (e) => {
    e.stopPropagation();
    untagFaces(group.faces.map(f => f.id), who);
  });
  btns.appendChild(untagAll);

  header.appendChild(label);
  header.appendChild(btns);
  return header;
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
  if (group.undated) return "Undated";
  const opts = { year: "numeric", month: "short", day: "numeric" };
  const s = new Date(group.start * 1000);
  const e = new Date(group.end * 1000);
  const sStr = s.toLocaleDateString(undefined, opts);
  const eStr = e.toLocaleDateString(undefined, opts);
  if (sStr === eStr) return sStr;
  return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${eStr}`;
}

function makeGroupHeader(group) {
  const header = document.createElement("div");
  header.className = "face-group-header";

  const selectedInGroup = group.faces.filter(f => selectedIds.has(f.id)).length;
  const label = document.createElement("span");
  label.className = "face-group-label";
  label.innerHTML = `${formatGroupRange(group)} ` +
    `<span class="face-group-meta">· ${selectedInGroup}/${group.faces.length} selected</span>`;

  const btnAll = document.createElement("button");
  btnAll.textContent = "Select all";
  btnAll.title = "Add every face in this group to the current selection";
  btnAll.addEventListener("click", (e) => {
    e.stopPropagation();
    selectGroupFaces(group, true);
  });

  const btnOnly = document.createElement("button");
  btnOnly.textContent = "Select only";
  btnOnly.title = "Select every face in this group and deselect all others";
  btnOnly.addEventListener("click", (e) => {
    e.stopPropagation();
    selectGroupFaces(group, false);
  });

  const btns = document.createElement("div");
  btns.className = "face-group-btns";

  // Approve this event's guesses outright (confirm the suggested name).
  const acceptable = group.faces.filter(f => f.suggestion && !f.person_name && !f.ignored);
  if (acceptable.length > 0) {
    const btnAccept = document.createElement("button");
    btnAccept.className = "primary";
    btnAccept.textContent = `Accept all (${acceptable.length})`;
    btnAccept.title = "Confirm the suggested name for every face in this group";
    btnAccept.addEventListener("click", (e) => {
      e.stopPropagation();
      acceptSuggestionsFor(group.faces, formatGroupRange(group));
    });
    btns.appendChild(btnAccept);
  }

  btns.appendChild(btnAll);
  btns.appendChild(btnOnly);

  header.appendChild(label);
  header.appendChild(btns);
  return header;
}

function selectGroupFaces(group, additive) {
  if (!additive) selectedIds.clear();
  group.faces.forEach(f => selectedIds.add(f.id));
  focusedFaceId = group.faces[0] ? group.faces[0].id : focusedFaceId;
  renderGrid();
  updateDetail();
  const verb = additive ? "Added" : "Selected only";
  setStatus(`${verb} ${group.faces.length} face(s) from ${formatGroupRange(group)}. ` +
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

  const head = document.createElement("div");
  head.className = "cluster-head";

  const title = document.createElement("span");
  title.className = "cluster-title";
  title.textContent = cl.suggestion ? `Looks like ${cl.suggestion.person_name}` : "New group";
  const meta = document.createElement("span");
  meta.className = "cluster-meta";
  meta.textContent = ` · ${cl.size} face(s)` +
    (cl.suggestion ? ` · ${Math.round(cl.suggestion.score * 100)}% of group` : "");
  title.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "cluster-actions";
  if (cl.suggestion) {
    const assignBtn = document.createElement("button");
    assignBtn.className = "primary";
    assignBtn.textContent = `✓ Assign to ${cl.suggestion.person_name}`;
    assignBtn.addEventListener("click", () =>
      clusterAssign(cl, { person_id: cl.suggestion.person_id }, cl.suggestion.person_name));
    actions.appendChild(assignBtn);
  }
  const nameBtn = document.createElement("button");
  nameBtn.className = cl.suggestion ? "" : "primary";
  nameBtn.textContent = cl.suggestion ? "Name instead…" : "Name…";
  nameBtn.addEventListener("click", () => {
    const name = prompt(`Name this group of ${cl.size} face(s):`,
                        cl.suggestion ? cl.suggestion.person_name : "");
    if (name && name.trim()) clusterAssign(cl, { name: name.trim() }, name.trim());
  });
  actions.appendChild(nameBtn);

  const ignoreBtn = document.createElement("button");
  ignoreBtn.className = "danger";
  ignoreBtn.textContent = "Ignore all";
  ignoreBtn.addEventListener("click", () => clusterIgnore(cl));
  actions.appendChild(ignoreBtn);

  head.appendChild(title);
  head.appendChild(actions);
  card.appendChild(head);

  const facesWrap = document.createElement("div");
  facesWrap.className = "cluster-faces";
  cl.sample.forEach(f => {
    const img = document.createElement("img");
    img.src = `/api/faces/${f.id}/crop`;
    img.loading = "lazy";
    img.title = `${f.filename} — click to preview`;
    if (f.id === focusedFaceId) img.classList.add("focused");
    // Preview-only: focus the face (show detail + bbox) without changing selection.
    img.addEventListener("click", () => {
      document.querySelectorAll(".cluster-faces img.focused")
        .forEach(el => el.classList.remove("focused"));
      img.classList.add("focused");
      focusedFaceId = f.id;
      updateDetail();
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
  const [x1, y1, x2, y2] = face.bbox;
  const box = document.getElementById("face-box");
  box.style.left = (x1 * 100) + "%";
  box.style.top = (y1 * 100) + "%";
  box.style.width = ((x2 - x1) * 100) + "%";
  box.style.height = ((y2 - y1) * 100) + "%";

  const when = face.photo_datetime
    ? new Date(face.photo_datetime * 1000).toLocaleString() : "Unknown";
  const personCell = face.ignored
    ? "<i style='color:#999'>Ignored</i>"
    : (face.person_name || "<i style='color:#777'>Unassigned</i>");
  document.getElementById("detail-meta").innerHTML = `
    <tr><td>Photo</td><td>${face.filename}</td></tr>
    <tr><td>Taken</td><td>${when}</td></tr>
    <tr><td>Person</td><td>${personCell}</td></tr>
    <tr><td>Detection</td><td>${face.det_score.toFixed(3)}</td></tr>
  `;
  document.getElementById("detail-ignore-btn").textContent =
    face.ignored ? "↩ Restore" : "🚫 Ignore";

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

/* ── Scan ── */
async function toggleScan() {
  if (scanning) { stopScanRequested = true; return; }
  scanning = true;
  stopScanRequested = false;
  const btn = document.getElementById("scan-btn");
  btn.textContent = "Stop scanning";
  btn.classList.add("danger");

  let totalProcessed = 0;
  let totalFound = 0;
  try {
    while (!stopScanRequested) {
      const res = await fetch("/api/faces/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 25 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      totalProcessed += data.processed;
      totalFound += data.faces_found;
      document.getElementById("scan-status").textContent =
        `Scanning… ${data.remaining} left · ${totalFound} new faces`;
      if (data.errors && data.errors.length) console.warn("scan errors:", data.errors);
      if (data.processed === 0 || data.remaining <= 0) break;
    }
    setStatus(`Scan ${stopScanRequested ? "stopped" : "complete"}: ` +
      `${totalProcessed} photos processed, ${totalFound} faces found.`);
  } catch (err) {
    setStatus("Scan failed: " + err.message, true);
  } finally {
    scanning = false;
    btn.textContent = "Scan faces";
    btn.classList.remove("danger");
    await loadPersons();
    await loadFaces();
  }
}
