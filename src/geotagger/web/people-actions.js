/* people-actions.js — People page: face actions — assign / un-tag / ignore /
 * come back / nuke, the quick-action popup callbacks, and confirming or
 * rejecting suggestions. */

// Clear the person assignment on faces, returning them to the unlabeled queue.
async function untagFaces(ids, who) {
  if (!ids.length) return;
  if (stagingEnabled()) { stageFaces(ids, { kind: "unassign" }, "Unassign"); return; }
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

/* ── Assignment ── */
function selectionOrFocused() {
  if (selectedIds.size > 0) return [...selectedIds];
  return focusedFaceId ? [focusedFaceId] : [];
}

async function assignSelected(personId, clear = false) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  // Only reachable from the selection bar and the keyboard shortcuts, which
  // exist on the flat (staged) scopes alone — so this always stages.
  stageFaces(ids, clear ? { kind: "unassign" } : { kind: "assign", personId },
             clear ? "Unassign" : "a person");
}

// Detail-pane assignment: act on the single previewed face (focusedFaceId) via the
// per-face endpoint, leaving the grid selection untouched. Handles both detail
// buttons — assign to a person (existing or newly created) or unassign (clear).
async function assignFocusedFace({ personId = null, name = null, clear = false } = {}) {
  const f = findFace(focusedFaceId);
  if (!f) { setStatus("Select a face first.", true); return; }
  if (stagingEnabled()) {
    const label = clear ? "Unassign"
                        : (name || persons.find(p => p.id === personId)?.name || "a person");
    stageFaces([f.id], clear ? { kind: "unassign" } : { kind: "assign", personId, name }, label);
    return;
  }
  const body = clear ? { person_id: null } : name ? { name } : { person_id: personId };
  try {
    const res = await fetch(`/api/faces/${f.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const who = clear ? null : (name || persons.find(p => p.id === personId)?.name);
    setStatus(clear ? "Unassigned this face." : `Assigned this face${who ? ` to ${who}` : ""}.`);
    // Only this face changes — drop just it from the selection, keep the rest.
    selectedIds.delete(f.id);
    if (focusedFaceId === f.id) focusedFaceId = null;
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

async function ignoreSelected(ignored) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  // Selection-bar / shortcut only, so always staged — and staged decisions are
  // reversible, so there is no bulk-action confirm.
  await ignoreSelected_ids(ids, ignored);
}

async function ignoreSelected_ids(ids, ignored) {
  if (stagingEnabled()) {
    stageFaces(ids, { kind: ignored ? "ignore" : "unignore" },
               ignored ? "Ignore" : "Un-ignore");
    return;
  }
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

async function comeBackSelected(comeBack) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  await comeBackSelected_ids(ids, comeBack);
}

async function comeBackSelected_ids(ids, comeBack) {
  if (stagingEnabled()) {
    stageFaces(ids, { kind: comeBack ? "come_back" : "uncome_back" },
               comeBack ? "Come Back" : "Back to Unlabeled");
    return;
  }
  try {
    const res = await fetch("/api/faces/come-back", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: ids, come_back: comeBack }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(comeBack ? `Moved ${ids.length} face(s) to Come Back.` : `Restored ${ids.length} face(s).`);
    selectedIds.clear();
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Come back failed: " + err.message, true);
  }
}

// Nuclear option: wipe every face (detected/assigned/ignored) + every cached
// rendition (thumb/preview/face-crop) for the photo(s) behind the selected
// face(s), so a rescan re-detects those photos from scratch. Acts on the whole
// photo, not just the selected face — a bad detection pass usually needs the
// whole slate cleared, not one crop.
async function nukeSelectedPhotos() {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  const photoIds = [...new Set(ids.map(id => findFace(id)?.photo_id).filter(Boolean))];
  if (photoIds.length === 0) { setStatus("Could not resolve photos for the selected face(s).", true); return; }
  const plural = photoIds.length === 1 ? "photo" : "photos";
  if (!confirm(
    `Nuclear option: permanently delete ALL faces (detected, assigned, and ignored) ` +
    `for ${photoIds.length} ${plural}, and wipe their cached thumbnails/previews so ` +
    `detection starts completely from scratch. This cannot be undone. Continue?`
  )) return;
  try {
    const res = await fetch("/api/faces/nuke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus(`Nuked ${data.faces_deleted} face(s) across ${data.photos} ${plural}. Rescan to re-detect.`);
    // Those faces no longer exist — drop any staged decisions pointing at them.
    const gone = new Set(photoIds);
    [...pending].forEach(([id, e]) => { if (gone.has(e.face.photo_id)) pending.delete(id); });
    selectedIds.clear();
    focusedFaceId = null;
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Nuke failed: " + err.message, true);
  }
}

function updateActionButtons() {
  // The ignore button restores in the Ignored scope, ignores elsewhere. It's an
  // icon button now, so swap the glyph and keep the tooltip/aria-label in sync
  // (mirrors the detail-pane ignore/restore toggle).
  const ignoreBtn = document.getElementById("ignore-btn");
  const restoring = scope === "ignored";
  ignoreBtn.textContent = restoring ? "↩" : "🚫";
  ignoreBtn.title = restoring
    ? "Restore selected faces"
    : "Hide selected faces from the queue (background strangers, false detections)";
  ignoreBtn.setAttribute("aria-label", restoring ? "Restore" : "Ignore");

  // Same toggle for the Come Back queue.
  const comeBackBtn = document.getElementById("come-back-btn");
  const restoringComeBack = scope === "come_back";
  comeBackBtn.textContent = restoringComeBack ? "↩" : "🕒";
  comeBackBtn.title = restoringComeBack
    ? "Restore selected faces to the Unlabeled queue"
    : "Move selected faces to the Come Back queue — people you know or suspect but aren't ready to assign yet";
  comeBackBtn.setAttribute("aria-label", restoringComeBack ? "Restore" : "Come back later");

  // "Only suggested" applies to the Unlabeled queue only.
  const chk = document.getElementById("suggested-only-chk");
  chk.checked = suggestedOnly;
  chk.disabled = scope !== "unlabeled";
  document.getElementById("suggested-only-label").style.opacity =
    scope === "unlabeled" ? "1" : "0.45";
}

// Assign the current selection to a person (existing or newly created) picked
// from the shared person-picker modal. `who` is {person_id} or {name}.
async function assignSelectedTo(who, label) {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  // The picker only opens from the selection bar / shortcuts (flat, staged
  // scopes) and is modal, so the scope can't change before the pick lands.
  stageFaces(ids, { kind: "assign", personId: who.person_id ?? null, name: who.name ?? label },
             label);
}

/* ── Quick-action popup ──
 * The popup itself (DOM, positioning, toggle, outside-click close) lives in
 * face-grid.js; here we only supply this page's data and action callbacks. */
function openFaceActions(anchor, face) {
  openQuickActions(anchor, face, {
    persons,
    onAssign: (pid) => confirmFace(face.id, pid),   // pid null ⇒ unassign
    onAssignNew: async (name) => {
      if (stagingEnabled()) {
        stageFaces([face.id], { kind: "assign", personId: null, name }, `${name} (new person)`);
        return;
      }
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
      if (stagingEnabled()) { ignoreSelected_ids([face.id], ignored); return; }
      try {
        const res = await fetch("/api/faces/ignore", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ face_ids: [face.id], ignored }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadFaces();
      } catch (err) { setStatus("Ignore failed: " + err.message, true); }
    },
    onComeBack: async (comeBack) => {
      if (stagingEnabled()) { comeBackSelected_ids([face.id], comeBack); return; }
      try {
        const res = await fetch("/api/faces/come-back", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ face_ids: [face.id], come_back: comeBack }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadFaces();
      } catch (err) { setStatus("Come back failed: " + err.message, true); }
    },
    onNotPerson: (personId, personName) => rejectSuggestion(face.id, personId, personName),
    onOpenPhoto: () => window.open(`/api/preview/${face.photo_id}`, "_blank"),
  });
}

async function confirmFace(faceId, personId) {
  if (stagingEnabled()) {
    const label = personId == null
      ? "Unassign" : (persons.find(p => p.id === personId)?.name || "a person");
    stageFaces([faceId], personId == null ? { kind: "unassign" } : { kind: "assign", personId },
               label);
    return;
  }
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

// Mark (or undo marking) a face as "definitely not this person" — removes the
// person from that face's recognition ranking so its next-best guess surfaces
// instead of the face bouncing back to the same rejected suggestion on refetch.
// Above this many loaded faces a full re-fetch is a noticeable stall (and resets
// scroll + focus), so a lone rejection patches the one face client-side instead.
const REJECT_LOCAL_THRESHOLD = 10;

async function rejectSuggestion(faceId, personId, personName, negative = true) {
  try {
    const res = await fetch("/api/faces/negatives", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: [faceId], person_id: personId, negative }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(negative ? `Marked as not ${personName}.`
                       : `Undid: ${personName} can be suggested again.`);
    // Big queue + a real rejection: patch in place (surface the next-best guess,
    // drop the face if it only lived here as a guess for the rejected person)
    // rather than round-tripping the whole list. Undo and small lists re-fetch
    // for the exact server-side re-ranking.
    if (negative && faces.length > REJECT_LOCAL_THRESHOLD) {
      applyRejectionLocally(faceId, personId);
    } else {
      await loadFaces();
    }
  } catch (err) {
    setStatus((negative ? "Reject" : "Undo") + " failed: " + err.message, true);
  }
}

// Patch a single face after a "not this person" rejection so its next-best guess
// surfaces immediately, without re-fetching the (possibly large) queue. Mirrors
// the server re-ranking: record the negative, drop the person, promote the next
// alternative into the primary slot. In views scoped to one person's guesses,
// a face rejected for that person no longer belongs, so it's removed.
function applyRejectionLocally(faceId, personId) {
  const face = faces.find(f => f.id === faceId);
  if (!face) return;

  face.negatives = [...(face.negatives || []), personId];
  const alts = (face.alternatives || []).filter(a => a.person_id !== personId);
  if (face.suggestion && face.suggestion.person_id === personId) {
    const next = alts.shift();   // best remaining guess becomes the primary
    face.suggestion = next
      ? { person_id: next.person_id, person_name: next.person_name, score: next.score }
      : null;
  }
  face.alternatives = alts;

  // The person this view is narrowed to (if any): suggested = guesses for that
  // person; unlabeled = the sticky "suggested person" filter.
  const viewPid = scope === "suggested" ? scopePersonId
                : scope === "unlabeled" ? suggestFilterPersonId : null;
  if (viewPid != null && personId === viewPid) {
    faces = faces.filter(f => f.id !== faceId);
    if (scope === "unlabeled") unlabeledAll = unlabeledAll.filter(f => f.id !== faceId);
    selectedIds.delete(faceId);
    if (focusedFaceId === faceId) focusedFaceId = null;
  }

  updateActionButtons();
  renderGrid();
  updateDetail();
}

async function acceptSuggestionsForSelection() {
  const ids = new Set(selectionOrFocused());
  const faceList = faces.filter(f => ids.has(f.id));
  await acceptSuggestionsFor(faceList);
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
  if (stagingEnabled()) {
    // Stage each suggested person separately, so each lands in its own group,
    // but rebuild the grid once at the end — a full rebuild per person made a
    // many-person accept cost N rebuilds of the whole grid.
    Object.entries(byPerson).forEach(([pid, faceIds]) => {
      stageFacesNoRender(faceIds, { kind: "assign", personId: parseInt(pid) });
    });
    afterStaging();
    setStatus(`Staged ${targets.length} suggested face(s)${where} across ` +
              `${Object.keys(byPerson).length} person(s). Nothing saved yet — ` +
              `review at the bottom of the grid, then Commit.`);
    return;
  }
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
