/* Quick Tag — mobile face triage. Walks the clustering endpoint one correlated
 * group at a time: Accept all (as the suggested person, or a name you type),
 * Ignore all, or Skip. Tap a face for a full-photo preview with the box. */

let queue = [];   // groups (clusters split by date window)
let pos = 0;      // index of the group currently shown
// Every group gets a stable id at split time. Completions find their group by
// id, never by a captured index: by the time a POST returns, Skip, an earlier
// completion or a reload may have shifted what sits at any index.
let nextGroupId = 1;
let persons = []; // existing people, for the picker
let pickerGroup = null;

// ── Settings (persisted) ──────────────────────────────────────────────────────
const SETTINGS_KEY = "quicktag_settings";
const DEFAULTS = { threshold: 0.65, windowDays: 30 };

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) }; }
  catch { return { ...DEFAULTS }; }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

let settings = loadSettings();

// Persisted across sessions so "Use previous" survives a page reload.
let prevPerson = (() => {
  try { return JSON.parse(localStorage.getItem("quicktag_prev_person")); } catch { return null; }
})();

function savePrevPerson(id, name) {
  prevPerson = { id, name };
  try { localStorage.setItem("quicktag_prev_person", JSON.stringify(prevPerson)); } catch {}
}

function renderPrevBtn() {
  const btn = el("prev-btn");
  if (prevPerson) {
    el("prev-name").textContent = prevPerson.name;
    btn.hidden = false;
  } else {
    btn.hidden = true;
  }
}

const windowSeconds = () => settings.windowDays * 86400;

const el = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  el("accept-btn").addEventListener("click", onAccept);
  el("ignore-btn").addEventListener("click", onIgnore);
  el("skip-btn").addEventListener("click", onSkip);
  el("hint").addEventListener("click", openPicker);
  el("choose-btn").addEventListener("click", openPicker);
  el("prev-btn").addEventListener("click", onUsePrevious);
  el("overlay").addEventListener("click", closePreview);
  el("picker-close").addEventListener("click", closePicker);
  el("picker").addEventListener("click", (e) => { if (e.target === el("picker")) closePicker(); });
  el("picker-search").addEventListener("input", (e) => renderPickerList(e.target.value));

  // Settings panel
  el("settings-btn").addEventListener("click", () => {
    el("settings-panel").hidden = !el("settings-panel").hidden;
  });

  const slider = el("threshold-slider");
  const valDisplay = el("threshold-val");
  slider.value = settings.threshold;
  valDisplay.textContent = settings.threshold;

  let reloadTimer;
  slider.addEventListener("input", () => {
    settings.threshold = parseFloat(slider.value);
    valDisplay.textContent = settings.threshold;
    saveSettings(settings);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadGroups, 600);
  });

  const windowSel = el("window-select");
  windowSel.value = settings.windowDays;
  windowSel.addEventListener("change", () => {
    settings.windowDays = parseInt(windowSel.value, 10);
    saveSettings(settings);
    loadGroups();
  });

  loadPersons();
  loadGroups();
});

async function loadPersons() {
  try {
    const res = await fetch("/api/persons");
    if (res.ok) persons = await res.json();
  } catch { /* picker just shows create-new */ }
}

// Latest-only (common.js): the strictness slider and window select can fire a
// reload while the previous one is still clustering; the older reply must not
// land last and replace the newer queue.
const loadGroups = latestOnly(async (signal) => {
  el("loading").hidden = false;
  el("loading").textContent = "Finding groups…";
  el("card").hidden = true;
  el("done").hidden = true;
  el("actions").hidden = true;
  el("progress").textContent = "";
  try {
    // full=true → every face per group, so the grid can show them all.
    const res = await fetch(`/api/faces/clusters?full=true&threshold=${settings.threshold}`,
                            { signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (signal.aborted) return;
    // Split each person-group into chunks that are tight in both time and place.
    queue = (data.clusters || []).flatMap(splitGroups);
    pos = 0;
    render();
  } catch (e) {
    if (signal.aborted) return;
    el("loading").textContent = "Could not load groups: " + e.message;
  }
});

// Break a cluster's faces into groups that are tight in BOTH time and place.
// Faces are sorted by time; a new chunk starts whenever a face falls more than
// the date window after the chunk's first face, or comes from a different
// resolved location. Undated faces (ts 0) and faces with no location don't force
// a split — they join the current chunk. So each presented group is one person,
// around one time, in one place.
function splitGroups(cluster) {
  const faces = (cluster.sample || []).slice()
    .sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
  const groups = [];
  let cur = null;
  for (const f of faces) {
    const ts = f.photo_datetime || 0;
    const place = locationKey(f);
    const newWindow = !cur || ts - cur.start > windowSeconds();
    // Split on place only when both the chunk and this face have a known,
    // differing location — missing locations join the current chunk.
    const newPlace = cur && cur.place && place && place !== cur.place;
    if (newWindow || newPlace) {
      cur = { id: nextGroupId++, suggestion: cluster.suggestion, faces: [], start: ts, place,
              busy: false };
      groups.push(cur);
    }
    cur.faces.push(f);
    if (!cur.place && place) cur.place = place;  // first located face sets the chunk's place
  }
  groups.forEach((g) => (g.face_ids = g.faces.map((x) => x.id)));
  return groups;
}

function render() {
  el("loading").hidden = true;
  if (pos >= queue.length) return showDone();

  const cl = queue[pos];
  const size = cl.faces.length;
  el("card").hidden = false;
  el("actions").hidden = false;
  el("done").hidden = true;

  const hint = el("hint");
  if (cl.suggestion) {
    hint.textContent = `Looks like ${cl.suggestion.person_name}`;
    hint.className = "known";
    el("accept-btn").textContent = `✓ Accept as ${cl.suggestion.person_name}`;
  } else {
    hint.textContent = "New person?";
    hint.className = "new";
    el("accept-btn").textContent = "✓ Name & accept";
  }

  el("meta").textContent = `${dateRange(cl)} · ${size} face${size > 1 ? "s" : ""}`;
  const place = locationLabel(cl.faces);
  el("place").textContent = place ? `📍 ${place}` : "";
  el("progress").textContent = `${pos + 1} / ${queue.length}`;
  renderPrevBtn();
  paintBusy();

  const grid = el("faces");
  grid.innerHTML = "";
  cl.faces.forEach((f) => {
    const img = faceCropImg(f);
    img.addEventListener("click", () => openPreview(f));            // tap: full-photo preview
    img.addEventListener("contextmenu", (e) => {                   // long-press / right-click: actions
      e.preventDefault();
      openFaceActions(img, f);
    });
    grid.appendChild(img);
  });
}

/* ── Per-face quick actions ──
 * Tapping a face opens the shared popup (a bottom sheet on phones). Acting on
 * one face splits it out of the current group so you can correct a misclustered
 * face without abandoning the whole group; the group's Accept/Ignore/Skip
 * footer still acts on whatever faces remain. */
function openFaceActions(anchor, f) {
  const cl = queue[pos];
  if (!cl || cl.busy) return;
  openQuickActions(anchor, f, {
    persons,
    onAssign: (pid) => faceAction(cl, f, "/api/faces/assign",
      pid === null ? { face_ids: [f.id], clear: true } : { face_ids: [f.id], person_id: pid }),
    onAssignNew: (name) => faceAction(cl, f, "/api/faces/assign", { face_ids: [f.id], name }),
    onIgnore: (ignored) => faceAction(cl, f, "/api/faces/ignore", { face_ids: [f.id], ignored }),
    onComeBack: (comeBack) => faceAction(cl, f, "/api/faces/come-back", { face_ids: [f.id], come_back: comeBack }),
    onOpenPhoto: () => openPreview(f),
  });
}

function faceAction(cl, f, url, body) {
  return withGroupBusy(cl, async () => {
    try {
      await postJson(url, body);
      removeFaceFromGroup(cl.id, f.id);
      if (url.includes("/assign")) loadPersons();   // pick up any newly-created person
      toast("Updated");
    } catch (e) {
      toast("Failed: " + e.message, true);
    }
  });
}

function removeFaceFromGroup(groupId, faceId) {
  const cl = queue.find((g) => g.id === groupId);
  if (!cl) return;   // group already gone (reloaded, or handled by another action)
  cl.faces = cl.faces.filter((x) => x.id !== faceId);
  cl.face_ids = cl.face_ids.filter((x) => x !== faceId);
  if (!cl.faces.length) dropGroup(groupId);   // group emptied → drop it
  render();
}

/* ── In-flight guard ──
 * One request per group at a time. While a group's POST is out, its whole card
 * and the footer are disabled: a second tap would otherwise post again and, on
 * return, splice a second group out of the queue. The flag lives on the group,
 * so a reload's fresh groups aren't blocked by an old group's request. */
function paintBusy() {
  const busy = !!queue[pos]?.busy;
  el("card").classList.toggle("busy", busy);
  el("card").setAttribute("aria-busy", String(busy));
  for (const id of ["accept-btn", "ignore-btn", "skip-btn", "choose-btn", "prev-btn"]) {
    el(id).disabled = busy;
  }
}

// Runs `send` for group `cl` unless that group already has a request in flight.
async function withGroupBusy(cl, send) {
  if (!cl || cl.busy) return;
  cl.busy = true;
  paintBusy();
  try {
    await send();
  } finally {
    cl.busy = false;
    paintBusy();
  }
}

// Remove a group by id (no-op if it's already gone). Keeps `pos` on the group
// the user is looking at when the removed one sat before it.
function dropGroup(groupId) {
  const i = queue.findIndex((g) => g.id === groupId);
  if (i < 0) return;
  queue.splice(i, 1);
  if (i < pos) pos--;
}

function dateRange(cl) {
  const ts = cl.faces.map((f) => f.photo_datetime).filter(Boolean);
  if (!ts.length) return "Undated";
  return formatDateRange(...minMaxOf(ts));
}

function showDone() {
  el("card").hidden = true;
  el("actions").hidden = true;
  el("progress").textContent = "";
  const done = el("done");
  done.hidden = false;
  if (queue.length === 0) {
    done.innerHTML = `<p>🎉 All caught up!</p>`;
  } else {
    done.innerHTML = `<p>Done for now — ${queue.length} group(s) skipped.</p>`;
    const review = document.createElement("button");
    review.className = "act";
    review.textContent = "Review skipped";
    review.addEventListener("click", () => { pos = 0; render(); });
    done.appendChild(review);
  }
  const reload = document.createElement("button");
  reload.className = "act primary";
  reload.textContent = "Reload";
  reload.addEventListener("click", loadGroups);
  done.appendChild(reload);
}

/* ── Actions ── */
function onAccept() {
  const cl = queue[pos];
  if (!cl || cl.busy) return;
  if (cl.suggestion) {
    savePrevPerson(cl.suggestion.person_id, cl.suggestion.person_name);
    act(cl, "/api/faces/assign",
        { face_ids: cl.face_ids, person_id: cl.suggestion.person_id },
        `Tagged ${cl.face_ids.length} as ${cl.suggestion.person_name}`);
  } else {
    openPicker();   // no guess → choose an existing person or create a new one
  }
}

function onUsePrevious() {
  const cl = queue[pos];
  if (!cl || cl.busy || !prevPerson) return;
  act(cl, "/api/faces/assign",
      { face_ids: cl.face_ids, person_id: prevPerson.id },
      `Tagged ${cl.face_ids.length} as ${prevPerson.name}`);
}

/* ── Person picker ── */
function openPicker() {
  if (!queue[pos] || queue[pos].busy) return;
  pickerGroup = queue[pos];
  el("picker-title").textContent = `Assign ${pickerGroup.face_ids.length} face(s) to…`;
  el("picker-search").value = "";
  renderPickerList("");
  el("picker").hidden = false;
  el("picker-search").focus();
}

function renderPickerList(q) {
  const list = el("picker-list");
  list.innerHTML = "";
  const ql = q.trim().toLowerCase();
  const matches = persons
    .filter((p) => p.name.toLowerCase().includes(ql))
    .sort((a, b) => a.name.localeCompare(b.name));

  matches.forEach((p) => {
    const row = document.createElement("button");
    row.className = "picker-item";
    row.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="picker-count">${escapeHtml(p.face_count ?? "")}</span>`;
    row.addEventListener("click", () => pickAssign({ person_id: p.id }, p.name));
    list.appendChild(row);
  });

  // Offer to create a new person when the typed text isn't an exact existing
  // name — last in the list, so existing matches are the first thing offered.
  if (ql && !persons.some((p) => p.name.toLowerCase() === ql)) {
    const row = document.createElement("button");
    row.className = "picker-item picker-new";
    row.textContent = `➕ Create “${q.trim()}”`;
    row.addEventListener("click", () => pickAssign({ name: q.trim() }, q.trim()));
    list.appendChild(row);
  }

  if (!matches.length && !ql) {
    const empty = document.createElement("div");
    empty.className = "picker-empty";
    empty.textContent = "No people yet — type a name to create one.";
    list.appendChild(empty);
  }
}

function pickAssign(who, label) {
  const cl = pickerGroup;
  if (!cl || cl.busy) return;
  closePicker();
  if (who.person_id) savePrevPerson(who.person_id, label);
  act(cl, "/api/faces/assign", { face_ids: cl.face_ids, ...who },
      `Tagged ${cl.face_ids.length} as ${label}`);
}

function closePicker() {
  el("picker").hidden = true;
  pickerGroup = null;
}

function onIgnore() {
  const cl = queue[pos];
  if (!cl || cl.busy) return;
  const n = cl.face_ids.length;
  act(cl, "/api/faces/ignore",
      { face_ids: cl.face_ids, ignored: true },
      `Ignored ${n} face${n > 1 ? "s" : ""}`);
}

function onSkip() {
  if (queue[pos]?.busy) return;
  if (pos < queue.length) { pos++; render(); }
}

// Whole-group action. The group is passed in (not read from `pos` at completion)
// and removed by id, so the group that was acted on is the one that leaves.
function act(cl, url, body, msg) {
  return withGroupBusy(cl, async () => {
    try {
      await postJson(url, body);
      dropGroup(cl.id);   // the next group shifts into pos
      toast(msg);
      render();
      if (url.includes("/assign")) loadPersons();   // pick up any newly-created person
    } catch (e) {
      toast("Failed: " + e.message, true);
    }
  });
}

/* ── Preview overlay ── */
function openPreview(f) {
  el("overlay-img").src = `/api/preview/${f.photo_id}`;
  applyBbox(el("overlay-box"), f.bbox);
  wireFullSizeButton(el("overlay-fullsize-btn"), f.filename, f.photo_id);
  el("overlay").hidden = false;
}

function closePreview() {
  el("overlay").hidden = true;
  el("overlay-img").src = "";
}

/* ── Toast ── */
let toastTimer;
function toast(msg, isErr = false) {
  const t = el("toast");
  t.textContent = msg;
  t.className = isErr ? "err" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}
