/* people-staging.js — People page: the staging area — parking decisions in
 * `pending`, rendering the staged sections, and commit / revert. */

/* ── Staging area ──
 * Non-destructive decisions don't hit the server as you make them: the face is
 * pulled out of the main grid and parked in `pending` under the destination it
 * was sent to (a person, Ignored, Come Back, …). The staging area at the bottom
 * of the grid pane renders one section per destination, each with its own
 * Commit / Revert, plus a sticky bar that commits or reverts everything. Only
 * a Commit writes to the database — so a whole tagging pass can be re-targeted
 * or thrown away first.
 *
 * Entry shape: { face, kind, personId?, name? }, where kind is one of
 * assign | unassign | ignore | unignore | come_back | uncome_back. */

// Staging covers the flat face grids only. Discover's clusters and Crowds'
// photo cards act on face-id lists whose full face objects we don't hold (the
// samples are capped), so their group buttons still commit straight through.
function stagingEnabled() {
  return isFlatGridScope();
}

// Park `ids` under one destination. Re-staging a face overwrites its previous
// decision, so "move it to a different group" is just another stage call.
function stageFaces(ids, change, dest) {
  const staged = stageFacesNoRender(ids, change);
  if (!staged) { setStatus("Nothing to stage.", true); return; }
  afterStaging();
  setStatus(`Staged ${staged} face(s) → ${dest}. Nothing saved yet — ` +
            `review at the bottom of the grid, then Commit.`);
}

// The state half of stageFaces, for bulk callers that stage several
// destinations in one go (Accept suggestions: one per suggested person) and
// must then rebuild the grid once, via afterStaging(), not once per destination.
// Returns how many faces were staged.
function stageFacesNoRender(ids, change) {
  let staged = 0;
  ids.forEach(id => {
    const face = findFace(id);
    if (!face) return;
    pending.set(id, { face, ...change });
    selectedIds.delete(id);
    if (focusedFaceId === id) focusedFaceId = null;
    staged++;
  });
  return staged;
}

function afterStaging() {
  lastClickedIndex = -1;   // renderOrder shifts under the cells we just removed
  updateActionButtons();
  renderGrid();            // renders the staging area too
  updateDetail();
}

// Drop staged decisions, returning those faces to the grid unchanged.
function unstageFaces(ids, quiet = false) {
  let removed = 0;
  ids.forEach(id => { if (pending.delete(id)) removed++; });
  if (!removed) return;
  renderGrid();
  updateDetail();
  if (!quiet) setStatus(`Reverted ${removed} staged change(s).`);
}

const PENDING_KIND_ORDER =
  ["assign", "come_back", "unassign", "ignore", "unignore", "uncome_back"];

function pendingGroupKey(e) {
  if (e.kind !== "assign") return e.kind;
  return e.personId != null ? `person:${e.personId}` : `name:${e.name}`;
}

function pendingGroupLabel(e) {
  switch (e.kind) {
    case "assign":
      return e.personId != null
        ? (persons.find(p => p.id === e.personId)?.name || e.name || "Unknown person")
        : `${e.name} (new person)`;
    case "unassign":    return "Unassign";
    case "ignore":      return "Ignore";
    case "unignore":    return "Un-ignore";
    case "come_back":   return "Come Back";
    case "uncome_back": return "Back to Unlabeled";
    default:            return e.kind;
  }
}

// Short label for the chip on a staged face cell.
function pendingCellLabel(e) {
  return e.kind === "assign"
    ? (e.personId != null
        ? (persons.find(p => p.id === e.personId)?.name || e.name || "Unknown")
        : `＋ ${e.name}`)
    : pendingGroupLabel(e);
}

// `entries` defaults to everything staged; the restore banner passes just the
// restored subset so its Commit doesn't sweep up work staged since.
function groupPendingEntries(entries = pending.values()) {
  const groups = new Map();
  [...entries].forEach(e => {
    const key = pendingGroupKey(e);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind: e.kind, personId: e.personId ?? null, name: e.name ?? null,
            label: pendingGroupLabel(e), entries: [] };
      groups.set(key, g);
    }
    g.entries.push(e);
  });
  return [...groups.values()].sort((a, b) => {
    const ka = PENDING_KIND_ORDER.indexOf(a.kind);
    const kb = PENDING_KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.label.localeCompare(b.label);   // people alphabetically within assigns
  });
}

function renderPending() {
  const pane = document.getElementById("pending-pane");
  const wrap = document.getElementById("pending-groups");
  wrap.innerHTML = "";
  if (!pending.size) { pane.style.display = "none"; return; }
  pane.style.display = "";

  const groups = groupPendingEntries();
  groups.forEach((g, i) => wrap.appendChild(makePendingGroupSection(g, i)));
  document.getElementById("pending-summary").textContent =
    `${pending.size} staged change(s) in ${groups.length} group(s) — not saved yet`;
}

function makePendingGroupSection(g, groupIdx) {
  const sec = document.createElement("div");
  sec.className = `face-group-section pending-group group-tint-${groupIdx % 6}`;
  sec.appendChild(faceGroupHeader({
    title: g.label,
    meta: `· ${g.entries.length} face(s) · ${photoCountLabel(g.entries.map(e => e.face))}`,
    extraClass: "amber",
    buttons: [
      { label: `✔ Commit (${g.entries.length})`, kind: "primary",
        title: `Save just this group's ${g.entries.length} change(s) to the database`,
        onClick: () => commitPending([g], g.label) },
      { label: "↩ Revert", kind: "danger",
        title: "Discard this group's staged changes and put the faces back in the grid",
        onClick: () => revertPending([g], g.label) },
    ],
  }));

  const cells = document.createElement("div");
  cells.className = "face-group-cells";
  g.entries.forEach(e => cells.appendChild(makePendingCell(e)));
  sec.appendChild(cells);
  return sec;
}

function makePendingCell(e) {
  const face = e.face;
  const cell = document.createElement("div");
  cell.className = "thumb-cell pending-cell" +
    (face.id === focusedFaceId ? " focused" : "");
  cell.dataset.id = face.id;
  // Same node the grid cell was using — a staged face moves from grid to
  // staging area without its thumbnail reloading.
  cell.appendChild(faceCropImg(face, { reuse: true }));

  const chip = document.createElement("div");
  chip.className = "face-label pending-label";
  chip.textContent = pendingCellLabel(e);
  cell.appendChild(chip);

  // Per-face revert — the fine-grained counterpart to the group/global buttons.
  const undo = document.createElement("button");
  undo.className = "pending-undo";
  undo.textContent = "✕";
  undo.title = "Revert this face (back to the grid, unchanged)";
  undo.addEventListener("click", (ev) => {
    ev.stopPropagation();
    unstageFaces([face.id]);
  });
  cell.appendChild(undo);

  // Left-click previews in the detail pane; right-click re-targets (which just
  // re-stages the face into another group).
  // Focus isn't drawn on a cell, so previewing one needs no repaint at all —
  // same as the contextmenu handler right below.
  cell.addEventListener("click", () => { focusedFaceId = face.id; updateDetail(); });
  cell.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    focusedFaceId = face.id;
    updateDetail();
    openFaceActions(cell, face);
  });
  return cell;
}

// Endpoint + body for one staged group. One request per group, so a person's
// whole batch lands in a single assign call (and one ignored_at/come_back_at
// batch stamp, which is what the Ignored/Come Back batch headers group on).
function pendingRequest(g, ids) {
  switch (g.kind) {
    case "assign":
      return ["/api/faces/assign", g.personId != null
        ? { face_ids: ids, person_id: g.personId }
        : { face_ids: ids, name: g.name }];
    case "unassign":    return ["/api/faces/assign",    { face_ids: ids, clear: true }];
    case "ignore":      return ["/api/faces/ignore",    { face_ids: ids, ignored: true }];
    case "unignore":    return ["/api/faces/ignore",    { face_ids: ids, ignored: false }];
    case "come_back":   return ["/api/faces/come-back", { face_ids: ids, come_back: true }];
    case "uncome_back": return ["/api/faces/come-back", { face_ids: ids, come_back: false }];
    default: throw new Error(`unknown staged action "${g.kind}"`);
  }
}

// Set while a commit's requests are in flight: a second Commit click (or Ctrl+S)
// would otherwise re-send the same still-staged entries alongside the first and
// double-count them in the summary. Same guard as commitPendingGeo (app.js).
let commitInFlight = false;

async function commitPending(groups, what) {
  if (commitInFlight) { setStatus("A commit is already in progress…", true); return; }
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  if (!total) { setStatus("Nothing staged to commit.", true); return; }
  if (!confirm(`Commit ${total} staged change(s)${what ? ` — ${what}` : ""}? ` +
               `This writes them to the database.`)) return;
  commitInFlight = true;
  try {
    await commitGroups(groups, total);
  } finally {
    commitInFlight = false;
  }
}

async function commitGroups(groups, total) {
  setStatus(`Committing ${total} change(s)…`);

  let saved = 0;
  const failures = [];
  for (const g of groups) {
    const ids = g.entries.map(e => e.face.id);
    try {
      const [url, body] = pendingRequest(g, ids);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Only clear what actually landed — a failed group stays staged so it can
      // be retried rather than silently lost.
      ids.forEach(id => pending.delete(id));
      saved += ids.length;
    } catch (err) {
      failures.push(`${g.label} (${err.message})`);
    }
  }

  await loadPersons();
  await loadFaces();
  if (failures.length) {
    setStatus(`Committed ${saved} of ${total} change(s). Still staged after failing: ` +
              failures.join(", ") + ".", true);
  } else {
    setStatus(`Committed ${saved} change(s).`);
  }
}

function revertPending(groups, what) {
  const ids = groups.flatMap(g => g.entries.map(e => e.face.id));
  if (!ids.length) { setStatus("Nothing staged to revert.", true); return; }
  if (ids.length > SELECTION_CONFIRM_THRESHOLD &&
      !confirm(`Discard ${ids.length} staged change(s)${what ? ` — ${what}` : ""}?`)) return;
  unstageFaces(ids);
}

/* ── Restore after a reload or crash (U7) ──
 * `pending` is a StagedMap, so every stage / revert / successful commit is
 * already mirrored to sessionStorage (ids + intended values only — see
 * pendingRecord). On load, restoreStagedWork reads that back, re-checks each
 * face against the server (POST /api/faces/by-ids) and re-stages what still
 * makes sense: a face deleted since (nuked, rescanned) or already in its staged
 * state is dropped, an assign to a person deleted since is dropped (the server
 * would 404 it), and a face changed elsewhere is kept but called out, since
 * committing it overwrites that change. Nothing is written until the user
 * presses Commit — on the banner or in the staging area as usual. */
const PENDING_KINDS = new Set(PENDING_KIND_ORDER);
// /api/faces/by-ids caps one request at this many ids.
const FACES_BY_IDS_MAX = 5000;

// The stored form of a staged entry: the decision plus a snapshot of the face's
// server state when it was staged (to tell "changed elsewhere since" on restore).
function pendingRecord(e) {
  const f = e.face;
  return {
    id: f.id, kind: e.kind, personId: e.personId ?? null, name: e.name ?? null,
    was: { p: f.person_id ?? null, i: !!f.ignored, c: !!f.come_back },
  };
}

// Is `face` (current server state) already where record `r` would put it?
function stagedAlreadyApplied(r, face) {
  switch (r.kind) {
    case "assign":
      return r.personId != null
        ? face.person_id === r.personId
        : face.person_id != null && face.person_name === r.name;
    case "unassign":    return face.person_id == null;
    case "ignore":      return face.ignored;
    case "unignore":    return !face.ignored;
    case "come_back":   return face.come_back;
    case "uncome_back": return !face.come_back;
    default:            return false;
  }
}

let restoreBanner = null;

async function restoreStagedWork() {
  const records = pending.store.load().filter(r => PENDING_KINDS.has(r.kind));
  if (!records.length) return;
  // Until validated, the records ride along in every write, so anything staged
  // while the check below is in flight can't overwrite them.
  pending.holdCarry(records);
  const current = new Map();
  try {
    const ids = records.map(r => r.id);
    for (let i = 0; i < ids.length; i += FACES_BY_IDS_MAX) {
      const data = await postJson("/api/faces/by-ids", { face_ids: ids.slice(i, i + FACES_BY_IDS_MAX) });
      data.faces.forEach(f => current.set(f.id, f));
    }
  } catch (err) {
    // Can't tell what's still valid — keep the backup untouched (the carry stays
    // in every write) and offer it again on the next load.
    setStatus(`Couldn't check the ${records.length} staged change(s) kept from your last visit ` +
              `(${err.message}). They're kept for the next reload.`, true);
    return;
  }

  const personIds = new Set(persons.map(p => p.id));
  const loadedById = new Map(loadedFaces().map(f => [f.id, f]));
  let gone = 0, applied = 0, orphaned = 0, changed = 0;
  const restored = [];
  records.forEach(r => {
    if (pending.has(r.id)) return;   // re-staged during the check: the newer decision wins
    const face = current.get(r.id);
    if (!face) { gone++; return; }
    if (r.kind === "assign" && r.personId != null && !personIds.has(r.personId)) { orphaned++; return; }
    if (stagedAlreadyApplied(r, face)) { applied++; return; }
    const was = r.was || {};
    if ((was.p ?? null) !== face.person_id || !!was.i !== face.ignored || !!was.c !== face.come_back) changed++;
    // Prefer the grid's own object when the face is loaded (it carries the
    // suggestion, and its crop <img> is the one the cache will hand over).
    pending.set(r.id, { face: loadedById.get(r.id) || face, kind: r.kind,
                        personId: r.personId ?? null, name: r.name ?? null });
    selectedIds.delete(r.id);
    if (focusedFaceId === r.id) focusedFaceId = null;
    restored.push(r.id);
  });
  pending.dropCarry();   // what's left of the backup is now exactly `pending`

  const dropped = [];
  if (gone) dropped.push(`${gone} face(s) no longer exist`);
  if (applied) dropped.push(`${applied} already saved`);
  if (orphaned) dropped.push(`${orphaned} for a person who was deleted`);
  const droppedNote = dropped.length ? `Dropped: ${dropped.join(", ")}.` : "";
  if (!restored.length) {
    setStatus(`Nothing left to restore from your last visit. ${droppedNote}`);
    return;
  }

  if (stagingEnabled()) afterStaging();
  else updateActionButtons();
  const notes = [];
  if (changed) notes.push(`${changed} changed elsewhere since; committing overwrites that.`);
  if (droppedNote) notes.push(droppedNote);
  const restoredIds = new Set(restored);
  const stillRestored = () => [...restoredIds].filter(id => pending.has(id));
  const restoredGroups = () => groupPendingEntries(stillRestored().map(id => pending.get(id)));
  const what = "restored from your last visit";
  restoreBanner = showStagedRestoreBanner({
    remaining: () => stillRestored().length,
    detail: notes.join(" "),
    onReview: () => {
      document.getElementById("pending-pane")?.scrollIntoView({ behavior: "smooth", block: "start" });
      setStatus(`Restored ${stillRestored().length} staged change(s) — nothing is saved until you Commit.`);
    },
    onCommit: async () => {
      await commitPending(restoredGroups(), what);
      return stillRestored().length === 0;   // keep the banner up for failures / a cancel
    },
    onDiscard: () => {
      revertPending(restoredGroups(), what);
      return stillRestored().length === 0;
    },
  });
  pending.onChange = () => restoreBanner?.refresh();
  setStatus(`Restored ${restored.length} staged change(s) from your last visit — ` +
            `review them at the bottom of the grid. Nothing is saved until you Commit.`);
}
