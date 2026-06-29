/* Quick Tag — mobile face triage. Walks the clustering endpoint one correlated
 * group at a time: Accept all (as the suggested person, or a name you type),
 * Ignore all, or Skip. Tap a face for a full-photo preview with the box. */

let queue = [];   // groups (clusters split by date window)
let pos = 0;      // index of the group currently shown
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

async function loadGroups() {
  el("loading").hidden = false;
  el("loading").textContent = "Finding groups…";
  el("card").hidden = true;
  el("done").hidden = true;
  el("actions").hidden = true;
  el("progress").textContent = "";
  try {
    // full=true → every face per group, so the grid can show them all.
    const res = await fetch(`/api/faces/clusters?full=true&threshold=${settings.threshold}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    // Split each person-group into chunks spanning at most one week.
    queue = (data.clusters || []).flatMap(splitByWeek);
    pos = 0;
    render();
  } catch (e) {
    el("loading").textContent = "Could not load groups: " + e.message;
  }
}

// Break a cluster's faces into groups that each span <= 1 week. Faces are sorted
// by time; a new chunk starts whenever a face falls more than a week after the
// chunk's first face. Undated faces (ts 0) collect into a leading chunk.
function splitByWeek(cluster) {
  const faces = (cluster.sample || []).slice()
    .sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
  const groups = [];
  let cur = null;
  for (const f of faces) {
    const ts = f.photo_datetime || 0;
    if (!cur || ts - cur.start > windowSeconds()) {
      cur = { suggestion: cluster.suggestion, faces: [], start: ts };
      groups.push(cur);
    }
    cur.faces.push(f);
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
  el("progress").textContent = `${pos + 1} / ${queue.length}`;
  renderPrevBtn();

  const grid = el("faces");
  grid.innerHTML = "";
  cl.faces.forEach((f) => {
    const img = document.createElement("img");
    img.src = `/api/faces/${f.id}/crop`;
    img.loading = "lazy";
    img.addEventListener("click", () => openPreview(f));
    grid.appendChild(img);
  });
}

function dateRange(cl) {
  const ts = cl.faces.map((f) => f.photo_datetime).filter(Boolean);
  if (!ts.length) return "Undated";
  const opt = { year: "numeric", month: "short", day: "numeric" };
  const a = new Date(Math.min(...ts) * 1000).toLocaleDateString(undefined, opt);
  const b = new Date(Math.max(...ts) * 1000).toLocaleDateString(undefined, opt);
  return a === b ? a : `${a} – ${b}`;
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
  if (!cl) return;
  if (cl.suggestion) {
    savePrevPerson(cl.suggestion.person_id, cl.suggestion.person_name);
    act("/api/faces/assign",
        { face_ids: cl.face_ids, person_id: cl.suggestion.person_id },
        `Tagged ${cl.face_ids.length} as ${cl.suggestion.person_name}`);
  } else {
    openPicker();   // no guess → choose an existing person or create a new one
  }
}

function onUsePrevious() {
  const cl = queue[pos];
  if (!cl || !prevPerson) return;
  act("/api/faces/assign",
      { face_ids: cl.face_ids, person_id: prevPerson.id },
      `Tagged ${cl.face_ids.length} as ${prevPerson.name}`);
}

/* ── Person picker ── */
function openPicker() {
  pickerGroup = queue[pos];
  if (!pickerGroup) return;
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

  // Offer to create a new person when the typed text isn't an exact existing name.
  if (ql && !persons.some((p) => p.name.toLowerCase() === ql)) {
    const row = document.createElement("button");
    row.className = "picker-item picker-new";
    row.textContent = `➕ Create “${q.trim()}”`;
    row.addEventListener("click", () => pickAssign({ name: q.trim() }, q.trim()));
    list.appendChild(row);
  }

  matches.forEach((p) => {
    const row = document.createElement("button");
    row.className = "picker-item";
    row.innerHTML = `<span>${p.name}</span><span class="picker-count">${p.face_count}</span>`;
    row.addEventListener("click", () => pickAssign({ person_id: p.id }, p.name));
    list.appendChild(row);
  });

  if (!matches.length && !ql) {
    const empty = document.createElement("div");
    empty.className = "picker-empty";
    empty.textContent = "No people yet — type a name to create one.";
    list.appendChild(empty);
  }
}

function pickAssign(who, label) {
  const cl = pickerGroup;
  if (!cl) return;
  closePicker();
  if (who.person_id) savePrevPerson(who.person_id, label);
  act("/api/faces/assign", { face_ids: cl.face_ids, ...who },
      `Tagged ${cl.face_ids.length} as ${label}`);
}

function closePicker() {
  el("picker").hidden = true;
  pickerGroup = null;
}

function onIgnore() {
  const cl = queue[pos];
  if (!cl) return;
  const n = cl.face_ids.length;
  act("/api/faces/ignore",
      { face_ids: cl.face_ids, ignored: true },
      `Ignored ${n} face${n > 1 ? "s" : ""}`);
}

function onSkip() {
  if (pos < queue.length) { pos++; render(); }
}

async function act(url, body, msg) {
  const btns = [el("accept-btn"), el("ignore-btn"), el("skip-btn")];
  btns.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    queue.splice(pos, 1);   // remove handled group; the next one shifts into pos
    toast(msg);
    render();
    if (url.includes("/assign")) loadPersons();   // pick up any newly-created person
  } catch (e) {
    toast("Failed: " + e.message, true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

/* ── Preview overlay ── */
function openPreview(f) {
  el("overlay-img").src = `/api/preview/${f.photo_id}`;
  const [x1, y1, x2, y2] = f.bbox;
  const box = el("overlay-box");
  box.style.left = x1 * 100 + "%";
  box.style.top = y1 * 100 + "%";
  box.style.width = (x2 - x1) * 100 + "%";
  box.style.height = (y2 - y1) * 100 + "%";
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
