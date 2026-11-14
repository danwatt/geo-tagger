/* people-selection.js — People page: selection (group select, click /
 * shift-click) and keyboard navigation + shortcuts over the flat grids. */

function selectGroupFaces(group, additive, label) {
  if (!additive) selectedIds.clear();
  group.faces.forEach(f => selectedIds.add(f.id));
  focusedFaceId = group.faces[0] ? group.faces[0].id : focusedFaceId;
  paintSelection();
  updateDetail();
  const verb = additive ? "Added" : "Selected only";
  const where = label || facesDateRange(group.faces);
  setStatus(`${verb} ${group.faces.length} face(s) from ${where}. ` +
    `Assign to approve, or refine with click/Ctrl-click.`);
}

/* ── Auto-preselect (Review guesses, Unlabeled queue) ──
 * Those scopes pre-select faces on load, but the same load also runs after every
 * commit, "not this person", Focus change and filter switch. Re-selecting from
 * scratch each time used to undo the user's deselections, so the next Assign
 * staged exactly the faces they had rejected (W15). Instead the first load of a
 * scope visit pre-selects everything eligible; later loads keep the selection as
 * shown, re-derive what the user deselected since last time, and pre-select only
 * eligible faces they haven't deselected (new ones, or ones a filter had hidden). */

function resetPreselection() {
  preselectMemory = { key: null, shown: new Set(), deselected: new Set() };
}

// Set selectedIds for `visible` (the faces the grid will draw). `eligible(face)`
// decides which faces a fresh visit pre-selects.
function applyPreselection(visible, eligible) {
  const key = `${scope}:${scopePersonId ?? ""}`;
  if (preselectMemory.key !== key) {
    preselectMemory = { key, shown: new Set(), deselected: new Set() };
    selectedIds = new Set();
  }
  const mem = preselectMemory;
  // Anything that was on screen, eligible and isn't selected now was deselected
  // by the user (click, Space, Escape, arrow-collapse); re-selected ones come off
  // the list. Staged faces left the grid via staging, not a deselection — skip.
  for (const id of mem.shown) {
    if (pending.has(id)) continue;
    if (selectedIds.has(id)) mem.deselected.delete(id);
    else mem.deselected.add(id);
  }
  const present = new Set(visible.map(f => f.id));
  const next = new Set([...selectedIds].filter(id => present.has(id)));
  const shown = new Set();
  visible.forEach(f => {
    if (!eligible(f)) return;   // never pre-selected, so "unselected" says nothing
    shown.add(f.id);
    if (!mem.deselected.has(f.id)) next.add(f.id);
  });
  selectedIds = next;
  mem.shown = shown;
}

// Reloads of the scopes without auto-preselect: keep the user's selection, but
// only the faces still on screen — a selected face that the reload dropped (or
// that is now staged) must not ride along into the next bulk action.
function pruneSelectionToGrid() {
  const present = new Set(gridFaces().map(f => f.id));
  selectedIds = new Set([...selectedIds].filter(id => present.has(id)));
}

function deselectAll() {
  selectedIds.clear();
  lastClickedIndex = -1;
  paintSelection();
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
    for (let i = start; i <= end; i++) selectedIds.add(renderOrder[i].id);
  } else {
    selectedIds.clear();
    selectedIds.add(face.id);
  }
  focusedFaceId = face.id;
  lastClickedIndex = idx;
  paintSelection();
  updateDetail();
}

/* ── Keyboard shortcuts ──
 * Only active over the flat face grids (not Discover's clusters or Crowds'
 * photo cards, which have no single `faces` list to walk), and only when
 * focus isn't in a text field or the person-picker modal (which has its own
 * arrow/Enter handling — see face-grid.js). */
const FLAT_GRID_SCOPES = new Set(["unlabeled", "all", "person", "suggested", "ignored", "come_back", "recent"]);

function isFlatGridScope() {
  return FLAT_GRID_SCOPES.has(scope);
}

function scrollFaceIntoView(faceId) {
  document.querySelector(`.thumb-cell[data-id="${faceId}"]`)?.scrollIntoView({ block: "nearest" });
}

// Moves focus by `delta` faces and collapses the selection to just that face
// (mirrors a plain click on the destination cell).
function moveFocus(delta) {
  if (!renderOrder.length) return;
  let idx = renderOrder.findIndex(f => f.id === focusedFaceId);
  idx = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
  idx = Math.max(0, Math.min(renderOrder.length - 1, idx + delta));
  selectedIds.clear();
  selectedIds.add(renderOrder[idx].id);
  focusedFaceId = renderOrder[idx].id;
  lastClickedIndex = idx;
  paintSelection();
  updateDetail();
  scrollFaceIntoView(focusedFaceId);
}

// Extends the selection from the last click/nav anchor to `delta` faces past
// the current focus (mirrors shift-click's range select).
function extendFocus(delta) {
  if (!renderOrder.length) return;
  const anchor = lastClickedIndex >= 0 ? lastClickedIndex :
    Math.max(0, renderOrder.findIndex(f => f.id === focusedFaceId));
  let idx = renderOrder.findIndex(f => f.id === focusedFaceId);
  idx = idx === -1 ? anchor : idx;
  idx = Math.max(0, Math.min(renderOrder.length - 1, idx + delta));
  const start = Math.min(anchor, idx);
  const end = Math.max(anchor, idx);
  for (let i = start; i <= end; i++) selectedIds.add(renderOrder[i].id);
  focusedFaceId = renderOrder[idx].id;
  lastClickedIndex = idx;
  paintSelection();
  updateDetail();
  scrollFaceIntoView(focusedFaceId);
}

function toggleFocusedSelection() {
  if (!focusedFaceId) return;
  selectedIds.has(focusedFaceId) ? selectedIds.delete(focusedFaceId) : selectedIds.add(focusedFaceId);
  paintSelection();
  updateDetail();
}

function selectAllFaces() {
  const visible = gridFaces();
  if (!visible.length) return;
  selectedIds = new Set(visible.map(f => f.id));
  paintSelection();
  updateDetail();
  setStatus(`Selected all ${visible.length} face(s).`);
}

function openShortcutsHelp() {
  document.getElementById("shortcuts-help-backdrop").style.display = "flex";
}

function closeShortcutsHelp() {
  document.getElementById("shortcuts-help-backdrop").style.display = "none";
}

function isShortcutsHelpOpen() {
  return document.getElementById("shortcuts-help-backdrop").style.display !== "none";
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Let fields, dialogs (common.js) and the person-picker modal handle their own
    // keys — first, before "?" or any other shortcut.
    if (isTypingTarget(e)) return;
    // Same for the focused pane divider: its arrows resize, they don't navigate.
    if (document.activeElement?.id === "detail-resizer") return;
    if (typeof isPersonPickerOpen === "function" && isPersonPickerOpen()) return;

    if (isShortcutsHelpOpen()) {
      if (e.key === "Escape" || e.key === "?") { e.preventDefault(); closeShortcutsHelp(); }
      return;
    }

    if (e.key === "?") { e.preventDefault(); openShortcutsHelp(); return; }

    if (!isFlatGridScope()) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAllFaces();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;  // leave browser/OS chords alone

    switch (e.key) {
      case "ArrowDown": case "j":
        e.preventDefault();
        if (e.shiftKey) extendFocus(1); else moveFocus(1);
        break;
      case "ArrowUp": case "k":
        e.preventDefault();
        if (e.shiftKey) extendFocus(-1); else moveFocus(-1);
        break;
      case " ":
        e.preventDefault();
        toggleFocusedSelection();
        break;
      case "Escape":
        deselectAll();
        break;
      case "Enter": case "a":
        e.preventDefault();
        openAssignPickerForSelection();
        break;
      case "u": case "Backspace":
        e.preventDefault();
        assignSelected(null, true);
        break;
      case "x": case "i":
        e.preventDefault();
        ignoreSelected(scope !== "ignored");
        break;
      case "b":
        e.preventDefault();
        comeBackSelected(scope !== "come_back");
        break;
      case "c":
        e.preventDefault();
        acceptSuggestionsForSelection();
        break;
      case "o":
        if (findFace(focusedFaceId)) document.getElementById("detail-open-photo-btn").click();
        break;
      case "f":
        if (findFace(focusedFaceId)) document.getElementById("detail-fullsize-btn").click();
        break;
      case "N":
        if (e.shiftKey) { e.preventDefault(); nukeSelectedPhotos(); }
        break;
    }
  });
}
