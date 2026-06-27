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

  document.getElementById("scan-btn").addEventListener("click", toggleScan);
  document.getElementById("deselect-all-btn").addEventListener("click", deselectAll);

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
    const f = faces.find(x => x.id === focusedFaceId);
    ignoreSelected(!(f && f.ignored));  // toggle the focused face's ignored state
  });
  document.getElementById("detail-open-photo-btn").addEventListener("click", () => {
    const f = faces.find(x => x.id === focusedFaceId);
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
    renderPeopleList(status.unlabeled_faces || 0, totalFaces, status.ignored_faces || 0);
    populatePersonSelects();
    updateScanStatus(status.remaining_photos, totalFaces);
  } catch (err) {
    setStatus("Failed to load people: " + err.message, true);
  }
}

function renderPeopleList(unlabeledCount, allCount, ignoredCount) {
  const list = document.getElementById("people-list");
  list.innerHTML = "";

  list.appendChild(makeScopeItem("Unlabeled", unlabeledCount, "unlabeled", null));
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

  persons.forEach(p => {
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
    list.appendChild(item);
  });
}

function makeScopeItem(name, count, itemScope, personId) {
  const item = document.createElement("div");
  const isActive = itemScope === scope &&
    (itemScope !== "person" || personId === scopePersonId);
  item.className = "person-item" + (isActive ? " active" : "");

  const nameEl = document.createElement("span");
  nameEl.className = "person-name";
  nameEl.textContent = name;

  const countEl = document.createElement("span");
  countEl.className = "person-count";
  countEl.textContent = count;

  item.appendChild(nameEl);
  item.appendChild(countEl);
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
  try {
    let url = `/api/faces?scope=${scope}&limit=${FACE_LIMIT}`;
    if ((scope === "person" || scope === "suggested") && scopePersonId) {
      url += `&person_id=${scopePersonId}`;
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
    } else if (scope === "unlabeled" || scope === "person") {
      // Oldest first so the year/month dividers read top-to-bottom like the
      // geocode grid; undated faces (0) sort to the top with no divider.
      faces.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
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
        setStatus(`${data.returned} guesses for ${personName}, all selected. ` +
                  `Click any wrong ones to deselect, then Assign to approve the rest.`);
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

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  // In the guesses view, lay faces out under event-group headers.
  if (scope === "suggested") {
    let idx = 0;
    computeTimeGroups(faces, groupGapSeconds).forEach(group => {
      grid.appendChild(makeGroupHeader(group));
      group.faces.forEach(face => {
        grid.appendChild(makeFaceCell(face, idx));
        idx++;
      });
    });
    return;
  }

  // Unlabeled queue: year dividers + a per-month header carrying an "Accept all"
  // button that confirms the suggestions for just that month's faces.
  if (scope === "unlabeled") {
    let idx = 0, curYear = null;
    computeMonthGroups(faces).forEach(group => {
      if (group.year !== null && group.year !== curYear) {
        curYear = group.year;
        const yd = document.createElement("div");
        yd.className = "grid-year-divider";
        yd.textContent = group.year;
        grid.appendChild(yd);
      }
      grid.appendChild(makeMonthHeader(group));
      group.faces.forEach(face => { grid.appendChild(makeFaceCell(face, idx)); idx++; });
    });
    return;
  }

  // Per-person view: geocode-style year/month dividers (no per-month actions).
  if (scope === "person") {
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
  } else if (face.person_name) {
    const label = document.createElement("div");
    label.className = "face-label";
    label.textContent = face.person_name;
    cell.appendChild(label);
  } else if (face.suggestion) {
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
    cell.appendChild(chip);
  }

  cell.addEventListener("click", (e) => handleCellClick(e, face, idx));
  return cell;
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

/* ── Detail pane ── */
function updateDetail() {
  const placeholder = document.getElementById("detail-placeholder");
  const content = document.getElementById("detail-content");

  const face = faces.find(f => f.id === focusedFaceId);
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
  if (!face.person_name && face.suggestion) {
    sug.style.display = "flex";
    sug.innerHTML =
      `<span class="sug-text">Looks like <b>${face.suggestion.person_name}</b> ` +
      `(${face.suggestion.score})</span>` +
      `<button class="primary" id="sug-confirm-btn">Confirm</button>`;
    document.getElementById("sug-confirm-btn").addEventListener("click", () => {
      confirmFace(face.id, face.suggestion.person_id);
    });
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
