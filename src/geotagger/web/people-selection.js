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
