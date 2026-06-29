/* ── State ── */
let crowdPhotos  = [];
let currentIdx   = 0;
let persons      = [];
let photoFaces   = [];
let minFaces     = 50;
let groupGap     = 86400;
let hideCompleted = true;

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  const params  = new URLSearchParams(location.search);
  minFaces      = parseInt(params.get("min_faces")  || "50");
  groupGap      = parseInt(params.get("group_gap")  || "86400");
  const startId = parseInt(params.get("photo_id")   || "0");

  bindToolbar();
  setStatus("Loading…");

  try {
    await Promise.all([loadCrowdPhotos(), loadPersons()]);
  } catch (err) {
    setStatus("Failed to load: " + err.message, true);
    return;
  }

  if (!crowdPhotos.length) {
    setStatus(`No crowd photos with ≥ ${minFaces} faces found.`);
    return;
  }

  const idx = startId ? crowdPhotos.findIndex(p => p.id === startId) : -1;
  await navigateTo(idx >= 0 ? idx : 0);
});

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#f88" : "#888";
}

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("back-btn").addEventListener("click", () => {
    window.location.href = "/people.html";
  });
  document.getElementById("prev-btn").addEventListener("click", () => {
    const i = prevAvailableIdx();
    if (i >= 0) navigateTo(i);
  });
  document.getElementById("next-btn").addEventListener("click", () => {
    const i = nextAvailableIdx();
    if (i >= 0) navigateTo(i);
  });
  document.getElementById("ignore-unlabeled-btn").addEventListener("click", ignoreAllUnlabeled);
  document.getElementById("done-next-btn").addEventListener("click", async () => {
    await ignoreAllUnlabeled(true);
    const i = nextAvailableIdx();
    if (i >= 0) navigateTo(i);
  });
  document.getElementById("hide-done-chk").addEventListener("change", e => {
    hideCompleted = e.target.checked;
    updateNavButtons();
  });
}

/* ── Data loading ── */
async function loadCrowdPhotos() {
  const res = await fetch(`/api/crowds?min_faces=${minFaces}&group_gap=${groupGap}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  crowdPhotos = data.groups.flatMap(g => g.photos);
}

async function loadPersons() {
  const res = await fetch("/api/persons");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  persons = await res.json();
}

/* ── Navigation helpers ── */
function prevAvailableIdx() {
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (!hideCompleted || crowdPhotos[i].unlabeled_faces > 0) return i;
  }
  return -1;
}

function nextAvailableIdx() {
  for (let i = currentIdx + 1; i < crowdPhotos.length; i++) {
    if (!hideCompleted || crowdPhotos[i].unlabeled_faces > 0) return i;
  }
  return -1;
}

function updateNavButtons() {
  document.getElementById("prev-btn").disabled = prevAvailableIdx() < 0;
  document.getElementById("next-btn").disabled = nextAvailableIdx() < 0;
  const remaining = crowdPhotos.filter(p => p.unlabeled_faces > 0).length;
  const total     = crowdPhotos.length;
  document.getElementById("photo-counter").textContent =
    hideCompleted
      ? `${currentIdx + 1} / ${total} · ${remaining} remaining`
      : `${currentIdx + 1} / ${total}`;
}

/* ── Navigation ── */
async function navigateTo(idx) {
  currentIdx = idx;
  const photo = crowdPhotos[idx];

  document.getElementById("photo-filename").textContent = photo.filename;
  updateNavButtons();

  // Load full-resolution preview into the right pane
  const photoFull = document.getElementById("photo-full");
  photoFull.src = `/api/preview/${photo.id}`;
  document.getElementById("bbox-overlay").innerHTML = "";

  history.replaceState(null, "",
    `?photo_id=${photo.id}&min_faces=${minFaces}&group_gap=${groupGap}`);

  document.getElementById("photo-meta").innerHTML = "";
  setStatus("Loading faces…");
  await Promise.all([loadPhotoFaces(photo.id), loadPhotoMeta(photo.id)]);
}

async function loadPhotoMeta(photoId) {
  try {
    const res = await fetch(`/api/photo/${photoId}`);
    if (!res.ok) return;
    const d = await res.json();
    const rows = [
      ["File",       d.filename],
      ["Date",       d.datetime  || "—"],
      ["Camera",     d.camera    || "—"],
      ["Dimensions", d.dimensions || "—"],
    ];
    document.getElementById("photo-meta").innerHTML =
      rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  } catch (_) { /* non-fatal */ }
}

async function loadPhotoFaces(photoId) {
  try {
    const res = await fetch(`/api/photos/${photoId}/faces`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    photoFaces = await res.json();
    renderFaces();
  } catch (err) {
    setStatus("Failed to load faces: " + err.message, true);
  }
}

/* ── Bbox overlay ── */
function renderBboxes() {
  const overlay = document.getElementById("bbox-overlay");
  overlay.innerHTML = "";

  photoFaces.forEach(f => {
    if (!f.bbox) return;
    const [x1, y1, x2, y2] = f.bbox;

    const box = document.createElement("div");
    box.className = "face-bbox";
    box.dataset.faceId = String(f.id);
    box.style.left   = (x1 * 100) + "%";
    box.style.top    = (y1 * 100) + "%";
    box.style.width  = ((x2 - x1) * 100) + "%";
    box.style.height = ((y2 - y1) * 100) + "%";

    if (f.person_id) {
      box.style.borderColor = "#4caf50";
      // Small name label inside the bottom of the box
      const lbl = document.createElement("div");
      lbl.className = "bbox-label";
      lbl.textContent = f.person_name;
      box.appendChild(lbl);
    } else if (f.ignored) {
      box.style.borderColor = "#555";
      box.style.opacity = "0.35";
    } else if (f.suggestion) {
      box.style.borderColor = "#4a90d9";
    } else {
      box.style.borderColor = "#ff9800";
    }

    box.addEventListener("click", e => {
      e.stopPropagation();
      highlightBbox(f.id);   // mark the box yellow
      highlightCard(f.id);   // scroll + highlight the grid card
    });

    overlay.appendChild(box);
  });
}

function highlightBbox(faceId) {
  document.querySelectorAll(".face-bbox").forEach(b => {
    b.classList.toggle("bbox-highlighted", b.dataset.faceId === String(faceId));
  });
}

function highlightCard(faceId) {
  document.querySelectorAll(".face-card.card-highlighted").forEach(c => {
    c.classList.remove("card-highlighted");
  });
  const card = document.querySelector(`.face-card[data-face-id="${faceId}"]`);
  if (!card) return;
  card.classList.add("card-highlighted");
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ── Face rendering ── */
function closeExpandPanel() {
  const p = document.getElementById("cr-expand-panel");
  if (p) p.remove();
}

function renderFaces() {
  closeExpandPanel();

  const labeled  = photoFaces.filter(f => f.person_id !== null);
  const ignored  = photoFaces.filter(f => f.ignored);
  const active   = photoFaces.filter(f => f.person_id === null && !f.ignored);

  const byPerson = {};
  const unknown  = [];
  active.forEach(f => {
    if (f.suggestion) {
      const pid = f.suggestion.person_id;
      if (!byPerson[pid])
        byPerson[pid] = { name: f.suggestion.person_name, faces: [] };
      byPerson[pid].faces.push(f);
    } else {
      unknown.push(f);
    }
  });

  const unlabeledCount = active.length;
  crowdPhotos[currentIdx].unlabeled_faces = unlabeledCount;
  updateNavButtons();

  const ignBtn = document.getElementById("ignore-unlabeled-btn");
  ignBtn.textContent = `Ignore unlabeled (${unlabeledCount})`;
  ignBtn.disabled    = unlabeledCount === 0;
  document.getElementById("done-next-btn").disabled = false;

  document.getElementById("cr-empty").style.display =
    photoFaces.length === 0 ? "block" : "none";

  renderTaggedSection(labeled);
  renderSuggestedSection(byPerson);
  renderUnknownSection(unknown);
  renderIgnoredSection(ignored);
  renderBboxes();

  setStatus(unlabeledCount === 0
    ? `✓ Done — ${labeled.length} tagged, ${ignored.length} ignored.`
    : `${labeled.length} tagged · ${unlabeledCount} unlabeled · ${ignored.length} ignored`);
}

/* ── Section renderers ── */
function renderTaggedSection(labeled) {
  const sec = document.getElementById("section-tagged");
  sec.innerHTML = "";
  if (!labeled.length) return;
  sec.appendChild(makeSectionHeader("Tagged people", labeled.length, "faces tagged"));
  const strip = document.createElement("div");
  strip.className = "face-strip";
  labeled.forEach(f => strip.appendChild(makeLabeledCard(f)));
  sec.appendChild(strip);
}

function renderSuggestedSection(byPerson) {
  const sec = document.getElementById("section-suggested");
  sec.innerHTML = "";
  const entries = Object.entries(byPerson);
  if (!entries.length) return;
  const total = entries.reduce((n, [, g]) => n + g.faces.length, 0);
  sec.appendChild(makeSectionHeader(
    "Suggested matches", total,
    `face(s) across ${entries.length} person(s)`));
  entries.sort((a, b) => b[1].faces.length - a[1].faces.length);
  entries.forEach(([pid, group]) =>
    sec.appendChild(makeSuggestedGroup(parseInt(pid), group)));
}

function renderUnknownSection(unknown) {
  const sec = document.getElementById("section-unknown");
  sec.innerHTML = "";
  if (!unknown.length) return;
  const hdr = makeSectionHeader("Unrecognized", unknown.length, "face(s) — no match found");
  if (unknown.length > 1) {
    const btn = document.createElement("button");
    btn.className = "danger hdr-btn";
    btn.textContent = `Ignore all ${unknown.length}`;
    btn.addEventListener("click", () => ignoreFaces(unknown.map(f => f.id)));
    hdr.appendChild(btn);
  }
  sec.appendChild(hdr);
  const strip = document.createElement("div");
  strip.className = "face-strip";
  unknown.forEach(f => strip.appendChild(makeAssignableCard(f)));
  sec.appendChild(strip);
}

function renderIgnoredSection(ignored) {
  const sec = document.getElementById("section-ignored");
  sec.innerHTML = "";
  if (!ignored.length) return;
  sec.appendChild(makeSectionHeader("Ignored", ignored.length, "face(s) — click to restore"));
  const strip = document.createElement("div");
  strip.className = "face-strip";
  ignored.forEach(f => strip.appendChild(makeIgnoredCard(f)));
  sec.appendChild(strip);
}

/* ── Section header helper ── */
function makeSectionHeader(title, count, suffix) {
  const hdr = document.createElement("div");
  hdr.className = "cr-section-hdr";
  const txt = document.createElement("span");
  txt.className = "hdr-title";
  txt.textContent = title;
  const meta = document.createElement("span");
  meta.className = "hdr-meta";
  meta.textContent = ` — ${count} ${suffix}`;
  hdr.appendChild(txt);
  hdr.appendChild(meta);
  return hdr;
}

/* ── Face card builders ── */
function makeFaceImg(f) {
  const img = document.createElement("img");
  img.src     = `/api/faces/${f.id}/crop`;
  img.loading = "lazy";
  img.alt     = "face";
  return img;
}

function makeLabeledCard(f) {
  const card = document.createElement("div");
  card.className = "face-card labeled-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(makeFaceImg(f));
  const lbl = document.createElement("div");
  lbl.className = "face-name-chip";
  lbl.textContent = f.person_name;
  const unBtn = document.createElement("button");
  unBtn.className = "chip-unassign";
  unBtn.textContent = "×";
  unBtn.title = "Unassign";
  unBtn.addEventListener("click", e => { e.stopPropagation(); doAssign(f.id, null); });
  lbl.appendChild(unBtn);
  card.appendChild(lbl);
  // Clicking the card highlights the bbox on the photo
  card.addEventListener("click", () => highlightBbox(f.id));
  return card;
}

function makeSuggestedFaceCard(f) {
  const card = document.createElement("div");
  card.className = "face-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(makeFaceImg(f));
  if (f.suggestion) {
    const score = document.createElement("div");
    score.className = "face-score-chip";
    score.textContent = `${Math.round(f.suggestion.score * 100)}%`;
    card.appendChild(score);
  }
  card.addEventListener("click", () => { highlightBbox(f.id); toggleExpand(card, f); });
  return card;
}

function makeAssignableCard(f) {
  const card = document.createElement("div");
  card.className = "face-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(makeFaceImg(f));
  card.addEventListener("click", () => { highlightBbox(f.id); toggleExpand(card, f); });
  return card;
}

function makeIgnoredCard(f) {
  const card = document.createElement("div");
  card.className = "face-card ignored-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(makeFaceImg(f));
  const lbl = document.createElement("div");
  lbl.className = "face-ignored-chip";
  lbl.textContent = "ignored";
  card.appendChild(lbl);
  card.addEventListener("click", () => restoreFace(f.id));
  return card;
}

/* ── Suggested group card ── */
function makeSuggestedGroup(pid, group) {
  const card = document.createElement("div");
  card.className = "suggested-group";

  const head = document.createElement("div");
  head.className = "suggested-head";

  const title = document.createElement("span");
  title.className = "suggested-title";
  title.textContent = group.name;
  const cnt = document.createElement("span");
  cnt.className = "suggested-count";
  cnt.textContent = ` — ${group.faces.length} face(s)`;
  title.appendChild(cnt);

  const acceptBtn = document.createElement("button");
  acceptBtn.className = "primary";
  acceptBtn.textContent = "✓ Accept all";
  acceptBtn.addEventListener("click", () => doAcceptAll(pid, group.faces));

  const ignoreBtn = document.createElement("button");
  ignoreBtn.className = "danger";
  ignoreBtn.textContent = "Ignore group";
  ignoreBtn.addEventListener("click", () => ignoreFaces(group.faces.map(f => f.id)));

  head.appendChild(title);
  head.appendChild(acceptBtn);
  head.appendChild(ignoreBtn);
  card.appendChild(head);

  const strip = document.createElement("div");
  strip.className = "face-strip";
  group.faces.forEach(f => strip.appendChild(makeSuggestedFaceCard(f)));
  card.appendChild(strip);

  return card;
}

/* ── Expand panel (attached to body with fixed positioning) ── */
function toggleExpand(card, f) {
  const existing = document.getElementById("cr-expand-panel");
  if (existing && existing.dataset.faceId === String(f.id)) {
    existing.remove();
    return;
  }
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "cr-expand-panel";
  panel.dataset.faceId = String(f.id);
  panel.className = "face-expand";

  if (f.suggestion) {
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "primary expand-btn";
    acceptBtn.textContent = `✓ ${f.suggestion.person_name}`;
    acceptBtn.addEventListener("click", e => {
      e.stopPropagation();
      doAssign(f.id, f.suggestion.person_id);
    });
    panel.appendChild(acceptBtn);
  }

  const row = document.createElement("div");
  row.className = "expand-row";

  const sel = document.createElement("select");
  sel.className = "expand-select";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Assign to…";
  sel.appendChild(blank);
  persons.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  row.appendChild(sel);

  const assignBtn = document.createElement("button");
  assignBtn.className = "expand-btn";
  assignBtn.textContent = "✓";
  assignBtn.title = "Assign to selected person";
  assignBtn.addEventListener("click", e => {
    e.stopPropagation();
    const pid = parseInt(sel.value);
    if (pid) doAssign(f.id, pid);
  });
  row.appendChild(assignBtn);
  panel.appendChild(row);

  const newBtn = document.createElement("button");
  newBtn.className = "expand-btn";
  newBtn.textContent = "+ New person";
  newBtn.addEventListener("click", e => {
    e.stopPropagation();
    const name = prompt("New person name:");
    if (name && name.trim()) doAssignByName(f.id, name.trim());
  });
  panel.appendChild(newBtn);

  const ignBtn = document.createElement("button");
  ignBtn.className = "danger expand-btn";
  ignBtn.textContent = "Ignore";
  ignBtn.addEventListener("click", e => {
    e.stopPropagation();
    ignoreFaces([f.id]);
  });
  panel.appendChild(ignBtn);

  // Attach to body so it escapes all overflow containers
  panel.style.visibility = "hidden";
  document.body.appendChild(panel);

  const cr = card.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top  = cr.bottom + 6;
  if (top + pr.height > vh - 10) top = cr.top - pr.height - 6;
  top = Math.max(6, top);

  let left = cr.left;
  if (left + pr.width > vw - 10) left = vw - pr.width - 10;
  left = Math.max(6, left);

  panel.style.position   = "fixed";
  panel.style.top        = top  + "px";
  panel.style.left       = left + "px";
  panel.style.visibility = "";
}

document.addEventListener("click", e => {
  if (!e.target.closest(".face-card") && !e.target.closest("#cr-expand-panel")) {
    closeExpandPanel();
  }
});

/* ── Actions ── */
async function doAssign(faceId, personId) {
  try {
    const res = await fetch(`/api/faces/${faceId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: personId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPhotoFaces(crowdPhotos[currentIdx].id);
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

async function doAssignByName(faceId, name) {
  try {
    const res = await fetch(`/api/faces/${faceId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await Promise.all([loadPersons(), loadPhotoFaces(crowdPhotos[currentIdx].id)]);
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

async function doAcceptAll(personId, facesArr) {
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: facesArr.map(f => f.id), person_id: personId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPhotoFaces(crowdPhotos[currentIdx].id);
  } catch (err) {
    setStatus("Accept failed: " + err.message, true);
  }
}

async function ignoreFaces(faceIds) {
  if (!faceIds.length) return;
  try {
    const res = await fetch("/api/faces/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: faceIds, ignored: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPhotoFaces(crowdPhotos[currentIdx].id);
  } catch (err) {
    setStatus("Ignore failed: " + err.message, true);
  }
}

async function restoreFace(faceId) {
  try {
    const res = await fetch("/api/faces/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: [faceId], ignored: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPhotoFaces(crowdPhotos[currentIdx].id);
  } catch (err) {
    setStatus("Restore failed: " + err.message, true);
  }
}

async function ignoreAllUnlabeled(silent = false) {
  const photo = crowdPhotos[currentIdx];
  try {
    const res = await fetch("/api/crowds/ignore-unlabeled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: [photo.id] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!silent) setStatus(`Ignored ${data.ignored} unlabeled face(s).`);
    await loadPhotoFaces(photo.id);
  } catch (err) {
    setStatus("Ignore failed: " + err.message, true);
    throw err;
  }
}
