/* ── State ──
 * Two modes share this page:
 *   "crowd"  — walk the /api/crowds photo list with Prev/Next (entered from People ▸ Crowds).
 *   "single" — review the faces of one photo, no playlist (entered from any photo preview).
 * Everything below the toolbar is identical; only navigation differs. */
let crowdPhotos  = [];   // the photo playlist; exactly one entry in single mode
let currentIdx   = 0;
let persons      = [];
let photoFaces   = [];
let minFaces     = 50;
let groupGap     = 86400;
let hideCompleted = true;
let mode         = "crowd";
let backHref     = "/people.html";
let drawMode     = false;   // "Add face": drag a box over the photo (see setDrawMode)

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  const params  = new URLSearchParams(location.search);
  minFaces      = parseInt(params.get("min_faces")  || "50");
  groupGap      = parseInt(params.get("group_gap")  || "86400");
  const startId = parseInt(params.get("photo_id")   || "0");
  // Crowd mode is opt-in: any bare ?photo_id= link lands in single-photo mode.
  mode          = params.get("mode") === "crowd" ? "crowd" : "single";
  // ?back= is untrusted (navigated to on Back) — same-origin paths only.
  backHref      = safeSameOriginPath(params.get("back"), mode === "crowd" ? "/people.html" : "");

  applyMode();
  bindToolbar();
  bindDrawHandlers();
  setStatus("Loading…");

  if (mode === "single" && !startId) {
    setStatus("No photo_id given.", true);
    return;
  }

  try {
    await Promise.all([
      mode === "crowd" ? loadCrowdPhotos() : loadSinglePhoto(startId),
      loadPersons(),
    ]);
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

/* Hide the playlist-only controls when reviewing a single photo. */
function applyMode() {
  if (mode === "crowd") return;
  document.getElementById("nav-group").style.display   = "none";
  document.getElementById("skip-group").style.display  = "none";
  document.getElementById("done-next-btn").style.display = "none";
  document.getElementById("back-btn").textContent = backHref ? "← Back" : "✕ Close";
}

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("back-btn").addEventListener("click", () => {
    // Prefer an explicit ?back= target, else return the way we came.
    if (backHref) window.location.href = backHref;
    else if (history.length > 1) history.back();
    else window.location.href = "/";
  });
  document.getElementById("prev-btn").addEventListener("click", () => {
    const i = prevAvailableIdx();
    if (i >= 0) navigateTo(i);
  });
  document.getElementById("next-btn").addEventListener("click", () => {
    const i = nextAvailableIdx();
    if (i >= 0) navigateTo(i);
  });
  document.getElementById("add-face-btn").addEventListener("click", () => setDrawMode(!drawMode));
  document.getElementById("rescan-faces-btn").addEventListener("click", rescanFaces);
  // Wrapped, not passed directly: the click event would land in `silent` (truthy)
  // and suppress the "Ignored N" status. The failure is already in the status bar.
  document.getElementById("ignore-unlabeled-btn").addEventListener("click",
    () => ignoreAllUnlabeled().catch(() => {}));
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

/* Single-photo mode: build a one-entry playlist from /api/photo. unlabeled_faces
 * is a placeholder — renderFaces() recomputes it from the real face list. */
async function loadSinglePhoto(photoId) {
  const res = await fetch(`/api/photo/${photoId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  crowdPhotos = [{ id: photoId, filename: d.filename, unlabeled_faces: 0 }];
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
  if (drawMode) setDrawMode(false);   // a half-drawn box doesn't survive the photo

  document.getElementById("photo-filename").textContent = photo.filename;
  wireFullSizeButton(document.getElementById("view-fullsize-btn"), photo.filename, photo.id);
  updateNavButtons();

  // Load full-resolution preview into the right pane
  const photoFull = document.getElementById("photo-full");
  photoFull.src = `/api/preview/${photo.id}`;
  document.getElementById("bbox-overlay").innerHTML = "";

  if (mode === "crowd") {
    history.replaceState(null, "",
      `?photo_id=${photo.id}&mode=crowd&min_faces=${minFaces}&group_gap=${groupGap}`);
  }

  document.getElementById("photo-meta").innerHTML = "";
  // The face panel still shows the previous photo until this one's faces land;
  // keep its photo-wide actions from firing against the new photo meanwhile
  // (renderFaces re-enables them).
  document.getElementById("ignore-unlabeled-btn").disabled = true;
  document.getElementById("done-next-btn").disabled = true;
  setStatus("Loading faces…");
  await Promise.all([loadPhotoFaces(photo.id), loadPhotoMeta(photo.id)]);
}

/* The photo on screen, or undefined before the playlist loads. */
function currentPhotoId() {
  return crowdPhotos[currentIdx]?.id;
}

/* Refresh the face panel after an action on `photoId` — but only if that photo
 * is still the one on screen. If the user has already moved on, the new photo's
 * own load owns the panel, and reloading here would abort it (both go through
 * loadPhotoFaces' latest-only guard) only to be dropped as off-screen. */
async function reloadFacesFor(photoId) {
  if (photoId === currentPhotoId()) await loadPhotoFaces(photoId);
}

// Latest-only (common.js) with an on-screen check on top: fast Prev/Next must
// never paint one photo's faces or metadata beside another photo.
const loadPhotoMeta = latestOnly(async (signal, photoId) => {
  try {
    const res = await fetch(`/api/photo/${photoId}`, { signal });
    if (!res.ok) return;
    const d = await res.json();
    if (signal.aborted || photoId !== currentPhotoId()) return;
    const rows = [
      ["File",       d.filename],
      ["Date",       d.datetime  || "—"],
      ["Camera",     d.camera    || "—"],
      ["Dimensions", d.dimensions || "—"],
    ];
    document.getElementById("photo-meta").innerHTML =
      rows.map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`).join("");
  } catch (_) { /* non-fatal */ }
});

const loadPhotoFaces = latestOnly(async (signal, photoId) => {
  try {
    const res = await fetch(`/api/photos/${photoId}/faces`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const faces = await res.json();
    if (signal.aborted || photoId !== currentPhotoId()) return;
    photoFaces = faces;
    renderFaces();
  } catch (err) {
    if (signal.aborted || photoId !== currentPhotoId()) return;
    setStatus("Failed to load faces: " + err.message, true);
  }
});

/* ── Bbox overlay ── */
function renderBboxes() {
  const overlay = document.getElementById("bbox-overlay");
  overlay.innerHTML = "";

  photoFaces.forEach(f => {
    if (!f.bbox) return;

    const box = document.createElement("div");
    box.className = "face-bbox";
    box.dataset.faceId = String(f.id);
    applyBbox(box, f.bbox);

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
    } else if (f.come_back) {
      box.style.borderColor = "#c99a3a";
      box.style.opacity = "0.6";
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

/* ── Add face: draw a box ──
 * For faces detection missed entirely. Drag a rectangle over the photo, then pick
 * a person (or skip, leaving it unlabeled). Coordinates go to the server as
 * fractions of the displayed image — i.e. DISPLAY space, matching what the stored
 * boxes are converted to for rendering; the server maps back to sensor space. */
function setDrawMode(on) {
  drawMode = on;
  const btn = document.getElementById("add-face-btn");
  btn.classList.toggle("primary", on);
  btn.textContent = on ? "✕ Cancel add" : "➕ Add face";
  document.getElementById("photo-container").classList.toggle("draw-mode", on);
  if (!on) removeDraftBox();
  setStatus(on ? "Drag a box around the face, then pick who it is (Esc to cancel)." : "");
}

function removeDraftBox() {
  document.querySelectorAll("#bbox-overlay .draft-bbox").forEach(b => b.remove());
}

/* Fractions of the overlay (== the displayed image) for a pointer event. */
function overlayPoint(e, rect) {
  return [
    Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
  ];
}

function bindDrawHandlers() {
  const overlay = document.getElementById("bbox-overlay");

  overlay.addEventListener("mousedown", (e) => {
    if (!drawMode || e.button !== 0) return;
    e.preventDefault();
    removeDraftBox();
    const rect = overlay.getBoundingClientRect();
    const [sx, sy] = overlayPoint(e, rect);
    const draft = document.createElement("div");
    draft.className = "face-bbox draft-bbox";
    overlay.appendChild(draft);

    const onMove = (ev) => {
      const [cx, cy] = overlayPoint(ev, rect);
      applyBbox(draft, [Math.min(sx, cx), Math.min(sy, cy),
                        Math.max(sx, cx), Math.max(sy, cy)]);
    };
    const onUp = async (ev) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const [cx, cy] = overlayPoint(ev, rect);
      const bbox = [Math.min(sx, cx), Math.min(sy, cy),
                    Math.max(sx, cx), Math.max(sy, cy)];
      // A click rather than a drag — treat as "never mind", not a 1px face.
      if (bbox[2] - bbox[0] < 0.01 || bbox[3] - bbox[1] < 0.01) {
        removeDraftBox();
        return;
      }
      applyBbox(draft, bbox);
      openPersonPicker(persons, {
        title: "Who is this?",
        allowCreate: true,
        onPick: (who) => submitManualFace(bbox, who.person_id || null, who.name || null),
        onClose: () => { removeDraftBox(); setDrawMode(false); },
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawMode) setDrawMode(false);
  });
}

async function submitManualFace(bbox, personId, name) {
  const photo = crowdPhotos[currentIdx];
  setStatus("Adding face…");
  try {
    const res = await fetch(`/api/photos/${photo.id}/faces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox, person_id: personId, name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setDrawMode(false);
    await Promise.all([loadPersons(), reloadFacesFor(photo.id)]);
    if (photo.id !== currentPhotoId()) return;   // moved on; not this photo's status line
    // Without an embedding the box is still a valid tag, but it can't take part in
    // recognition — worth saying out loud, since that's the usual reason to add one.
    setStatus(data.embedded
      ? "Face added."
      : "Face added, but no face was recognizable inside the box — it won't be used for matching.");
  } catch (err) {
    setDrawMode(false);
    setStatus("Add face failed: " + err.message, true);
  }
}

async function deleteManualFace(faceId) {
  const photoId = currentPhotoId();   // the photo this click was for
  if (!confirm("Delete this hand-drawn face box?")) return;
  try {
    const res = await fetch(`/api/faces/${faceId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await reloadFacesFor(photoId);
    setStatus("Face box deleted.");
  } catch (err) {
    setStatus("Delete failed: " + err.message, true);
  }
}

/* ── Face rendering ── */
function renderFaces() {
  closeQuickActions();

  const labeled   = photoFaces.filter(f => f.person_id !== null);
  const ignored   = photoFaces.filter(f => f.ignored);
  const comeBack  = photoFaces.filter(f => f.come_back);
  const active    = photoFaces.filter(f => f.person_id === null && !f.ignored && !f.come_back);

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
  renderComeBackSection(comeBack);
  renderIgnoredSection(ignored);
  renderBboxes();

  setStatus(unlabeledCount === 0
    ? `✓ Done — ${labeled.length} tagged, ${ignored.length} ignored.`
    : `${labeled.length} tagged · ${unlabeledCount} unlabeled · ${comeBack.length} come back · ${ignored.length} ignored`);
}

/* ── Section renderers ── */
function renderTaggedSection(labeled) {
  const sec = document.getElementById("section-tagged");
  sec.innerHTML = "";
  if (!labeled.length) return;
  sec.appendChild(makeSectionHeader("Tagged people", labeled.length, "faces tagged",
    { variant: "green" }));
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
    `face(s) across ${entries.length} person(s)`, { variant: "blue" }));
  entries.sort((a, b) => b[1].faces.length - a[1].faces.length);
  entries.forEach(([pid, group]) =>
    sec.appendChild(makeSuggestedGroup(parseInt(pid), group)));
}

function renderUnknownSection(unknown) {
  const sec = document.getElementById("section-unknown");
  sec.innerHTML = "";
  if (!unknown.length) return;
  sec.appendChild(makeSectionHeader("Unrecognized", unknown.length, "face(s) — no match found", {
    buttons: unknown.length > 1 ? [{
      icon: "🚫", label: `Ignore all ${unknown.length}`, kind: "danger",
      title: `Ignore all ${unknown.length} unrecognized face(s)`,
      onClick: () => ignoreFaces(unknown.map(f => f.id)),
    }] : [],
  }));
  const strip = document.createElement("div");
  strip.className = "face-strip";
  unknown.forEach(f => strip.appendChild(makeAssignableCard(f)));
  sec.appendChild(strip);
}

function renderComeBackSection(comeBack) {
  const sec = document.getElementById("section-comeback");
  sec.innerHTML = "";
  if (!comeBack.length) return;
  sec.appendChild(makeSectionHeader("Come Back", comeBack.length,
    "face(s) — known/suspected, deferred — click to restore", { variant: "amber" }));
  const strip = document.createElement("div");
  strip.className = "face-strip";
  comeBack.forEach(f => strip.appendChild(makeComeBackCard(f)));
  sec.appendChild(strip);
}

function renderIgnoredSection(ignored) {
  const sec = document.getElementById("section-ignored");
  sec.innerHTML = "";
  if (!ignored.length) return;
  sec.appendChild(makeSectionHeader("Ignored", ignored.length, "face(s) — click to restore",
    { variant: "grey" }));
  const strip = document.createElement("div");
  strip.className = "face-strip";
  ignored.forEach(f => strip.appendChild(makeIgnoredCard(f)));
  sec.appendChild(strip);
}

/* ── Section header helper ──
 * Thin wrapper over the shared faceGroupHeader(); opts = { variant, buttons }. */
function makeSectionHeader(title, count, suffix, opts = {}) {
  return faceGroupHeader({
    title,
    meta: `— ${count} ${suffix}`,
    extraClass: opts.variant || "",
    buttons: opts.buttons || [],
  });
}

/* ── Face card builders ── */
function makeLabeledCard(f) {
  const card = document.createElement("div");
  card.className = "face-card labeled-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(faceCropImg(f));
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
  // Left-click highlights the bbox on the photo; right-click opens the menu
  // (which offers Unassign / reassign for an already-tagged face).
  card.addEventListener("click", () => highlightBbox(f.id));
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); openFaceActions(card, f); });
  return card;
}

function makeSuggestedFaceCard(f) {
  const card = document.createElement("div");
  card.className = "face-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(faceCropImg(f));
  if (f.suggestion) {
    const score = document.createElement("div");
    score.className = "face-score-chip";
    score.textContent = `${Math.round(f.suggestion.score * 100)}%`;
    card.appendChild(score);
  }
  card.addEventListener("click", () => highlightBbox(f.id));   // left: highlight on photo
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); openFaceActions(card, f); });
  return card;
}

function makeAssignableCard(f) {
  const card = document.createElement("div");
  card.className = "face-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(faceCropImg(f));
  card.addEventListener("click", () => highlightBbox(f.id));   // left: highlight on photo
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); openFaceActions(card, f); });
  return card;
}

function makeIgnoredCard(f) {
  const card = document.createElement("div");
  card.className = "face-card ignored-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(faceCropImg(f));
  const lbl = document.createElement("div");
  lbl.className = "face-ignored-chip";
  lbl.textContent = "ignored";
  card.appendChild(lbl);
  // Left-click highlights the bbox; right-click opens the menu (which offers
  // Restore for an ignored face).
  card.addEventListener("click", () => highlightBbox(f.id));
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); openFaceActions(card, f); });
  return card;
}

function makeComeBackCard(f) {
  const card = document.createElement("div");
  card.className = "face-card come-back-card";
  card.dataset.faceId = String(f.id);
  card.appendChild(faceCropImg(f));
  const lbl = document.createElement("div");
  lbl.className = "face-come-back-chip";
  lbl.textContent = "come back";
  card.appendChild(lbl);
  // Left-click highlights the bbox; right-click opens the menu (which offers
  // Restore for a come-back face).
  card.addEventListener("click", () => highlightBbox(f.id));
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); openFaceActions(card, f); });
  return card;
}

/* ── Suggested group card ── */
function makeSuggestedGroup(pid, group) {
  const card = document.createElement("div");
  card.className = "suggested-group";

  card.appendChild(faceGroupHeader({
    title: group.name,
    meta: `— ${group.faces.length} face(s)`,
    extraClass: "blue",
    buttons: [
      { icon: "✓", label: "Accept all", kind: "primary",
        title: `Accept all ${group.faces.length} suggestion(s)`,
        onClick: () => doAcceptAll(pid, group.faces) },
      { icon: "🚫", label: "Ignore group", kind: "danger",
        title: "Ignore every face in this group",
        onClick: () => ignoreFaces(group.faces.map(f => f.id)) },
    ],
  }));

  const strip = document.createElement("div");
  strip.className = "face-strip";
  group.faces.forEach(f => strip.appendChild(makeSuggestedFaceCard(f)));
  card.appendChild(strip);

  return card;
}

/* ── Quick-action popup ──
 * Shared popup (face-grid.js); we supply this page's data + callbacks.
 * Labeled/ignored cards don't open it (they highlight / restore directly), so
 * the popup only ever shows for suggested + unrecognized faces. */
function openFaceActions(anchor, f) {
  openQuickActions(anchor, f, {
    persons,
    onAssign: (pid) => doAssign(f.id, pid),          // pid null ⇒ unassign
    onAssignNew: (name) => doAssignByName(f.id, name),
    onIgnore: (ignored) => ignored ? ignoreFaces([f.id]) : restoreFace(f.id),
    onComeBack: (comeBack) => comeBackFace(f.id, comeBack),
    onDelete: () => deleteManualFace(f.id),   // shown only for source === "manual"
    onOpenPhoto: () => window.open(`/api/preview/${crowdPhotos[currentIdx].id}`, "_blank"),
  });
}

/* ── Actions ──
 * Every one-click write here acts at once and offers an Undo toast (U3): the
 * server's reply carries an `undo` token that POST /api/faces/undo puts back
 * exactly (common.js undoFaceToken). */
const faceWord = (n) => `${n} face${n === 1 ? "" : "s"}`;
const personName = (pid) => persons.find(p => p.id === pid)?.name;

/* POST one face write for the photo on screen, refresh its panel, then offer
 * undo. `message` is the toast text; `failLabel` prefixes a failure. Rethrows
 * so callers that chain (Done & next) can stop. */
async function faceWrite(url, body, { message, failLabel, reloadPersons = false, onUndone } = {}) {
  const photoId = currentPhotoId();   // the photo this click was for
  try {
    const data = await postJson(url, body);
    await Promise.all([reloadPersons ? loadPersons() : null, reloadFacesFor(photoId)]);
    offerFaceUndo(message, data.undo, photoId, onUndone);
    return data;
  } catch (err) {
    setStatus(`${failLabel} failed: ` + err.message, true);
    throw err;
  }
}

function offerFaceUndo(message, token, photoId, onUndone) {
  if (!faceUndoable(token)) return;
  showUndoToast(message, async () => {
    const r = await undoFaceToken(token);
    onUndone?.(r.out);
    // A name-created person may have been removed again by the undo.
    await Promise.all([token.created_person_id != null ? loadPersons() : null,
                       reloadFacesFor(photoId)]);
    return r;
  });
}

function doAssign(faceId, personId) {
  const f = photoFaces.find(x => x.id === faceId);
  const message = personId == null
    ? `Unassigned ${f?.person_name ? `“${f.person_name}”` : "the face"}.`
    : `Tagged the face as ${personName(personId) ?? "that person"}.`;
  return faceWrite(`/api/faces/${faceId}/assign`,
    personId == null ? { clear: true } : { person_id: personId },
    { message, failLabel: "Assign" }).catch(() => {});
}

function doAssignByName(faceId, name) {
  return faceWrite(`/api/faces/${faceId}/assign`, { name },
    { message: `Tagged the face as ${name}.`, failLabel: "Assign", reloadPersons: true })
    .catch(() => {});
}

function doAcceptAll(personId, facesArr) {
  return faceWrite("/api/faces/assign",
    { face_ids: facesArr.map(f => f.id), person_id: personId },
    { message: `Tagged ${faceWord(facesArr.length)} as ${personName(personId) ?? "that person"}.`,
      failLabel: "Accept" }).catch(() => {});
}

function ignoreFaces(faceIds) {
  if (!faceIds.length) return;
  return faceWrite("/api/faces/ignore", { face_ids: faceIds, ignored: true },
    { message: `Ignored ${faceWord(faceIds.length)}.`, failLabel: "Ignore" }).catch(() => {});
}

function restoreFace(faceId) {
  return faceWrite("/api/faces/ignore", { face_ids: [faceId], ignored: false },
    { message: "Restored the face to the unlabeled queue.", failLabel: "Restore" })
    .catch(() => {});
}

function comeBackFace(faceId, comeBack) {
  return faceWrite("/api/faces/come-back", { face_ids: [faceId], come_back: comeBack },
    { message: comeBack ? "Moved the face to Come back." : "Restored the face to the unlabeled queue.",
      failLabel: "Come back" }).catch(() => {});
}

/* Nuclear rescan for the photo on screen: wipe every face (detected, assigned,
 * ignored) plus the cached thumbnail/preview/crops, re-run detection server-side,
 * then re-render from the fresh faces. Same wipe as the People page's nuclear
 * option, but immediately followed by detection so the user sees the new result. */
async function rescanFaces() {
  const photo = crowdPhotos[currentIdx];
  if (!photo) return;
  if (!confirm(
    `Rescan faces for ${photo.filename}: permanently delete ALL existing faces ` +
    `(tagged, unlabeled, and ignored) and their cached crops, then re-run face ` +
    `detection from scratch. This cannot be undone. Continue?`
  )) return;
  const btn = document.getElementById("rescan-faces-btn");
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = "Rescanning…";
  setStatus("Rescanning faces…");
  try {
    const res = await fetch("/api/faces/rescan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: [photo.id] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Moved on mid-rescan: the new photo owns the preview, panel and status line.
    if (photo.id !== currentPhotoId()) return;
    // The preview rendition was deleted and regenerated — bust the browser cache
    // so the overlay lines up with a freshly decoded image.
    document.getElementById("photo-full").src = `/api/preview/${photo.id}?t=${Date.now()}`;
    await loadPhotoFaces(photo.id);   // this resets the status line
    if (photo.id !== currentPhotoId()) return;
    const errs = (data.errors || []).length ? ` (${data.errors.length} error(s))` : "";
    const rot  = data.orientations_updated ? " · orientation corrected" : "";
    setStatus(`Rescanned: ${data.faces_deleted} face(s) removed, ` +
              `${data.faces_found} re-detected${rot}${errs}.`,
              (data.errors || []).length > 0);
  } catch (err) {
    setStatus("Rescan failed: " + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

async function ignoreAllUnlabeled(silent = false) {
  const photo = crowdPhotos[currentIdx];
  const unlabeledBefore = photo.unlabeled_faces;
  const n = photoFaces.filter(f => f.person_id === null && !f.ignored && !f.come_back).length;
  const data = await faceWrite("/api/crowds/ignore-unlabeled", { photo_ids: [photo.id] }, {
    message: `Ignored ${faceWord(n)} unlabeled on ${photo.filename}.`,
    failLabel: "Ignore",
    // Done & next has moved on by the time Undo is clicked: put the photo's
    // count back so Prev/Next and "Skip completed" see it as unfinished again.
    // (If it's still on screen, the reload recomputes the count anyway.)
    onUndone: (out) => {
      if (out.restored.length) photo.unlabeled_faces = unlabeledBefore;
      updateNavButtons();
    },
  });
  // After the reload, not before: renderFaces ends by writing its own
  // "✓ Done — …" summary, which would replace this at once.
  if (!silent && photo.id === currentPhotoId()) {
    setStatus(`Ignored ${data.ignored} unlabeled face(s) — this photo is done.`);
  }
}
