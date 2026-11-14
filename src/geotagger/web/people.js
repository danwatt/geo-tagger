/* people.js — People page: init and toolbar wiring. The rest of the page
 * lives in the people-*.js files, all classic scripts sharing one global
 * scope. Load order (see people.html):
 *   people-state.js, people-grouping.js, people-grid.js, people-cells.js, people-selection.js,
 *   people-detail.js, people-actions.js, people-staging.js, people-discover.js,
 *   people-crowds.js, people-focus.js,
 *   people-list.js, people.js
 * people-state.js must come first and this file last; everything in between
 * only defines functions/constants that are first used after DOMContentLoaded. */

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  bindToolbar();
  bindDetailResizer();
  bindKeyboardShortcuts();
  await loadLiveSettings();  // before loadFaces, so the first render pre-selects correctly
  await loadFocusYears();      // restores any saved Focus before the first load
  await loadPersons();

  // Deep-link from the Search page: people.html?person=<id>&review=suggested
  // opens straight to that person's suggestion queue (from "find untagged
  // faces"); people.html?person=<id> alone (from "Open in People" on a
  // single-person search) opens their tagged-faces scope instead.
  const qp = new URLSearchParams(window.location.search);
  const linkPersonId = qp.get("person") ? parseInt(qp.get("person")) : null;
  if (linkPersonId && qp.get("review") === "suggested") {
    await selectScope("suggested", linkPersonId);
  } else if (linkPersonId) {
    await selectScope("person", linkPersonId);
  } else {
    await loadFaces();
  }
  // Don't paint the hint over a "Failed to load …" from the loads above.
  if (!statusIsError) setStatus("Select a person on the left, or scan for faces to begin.");
});

// Pulls live settings tunable on the Settings page — FACE_PRESELECT_MIN_SCORE
// (Unlabeled queue pre-select cutoff) and FACE_QUERY_LIMIT (grid page size) —
// so both stay in sync without a code change.
async function loadLiveSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = await res.json();
    const scoreSpec = data.settings.find(s => s.key === "FACE_PRESELECT_MIN_SCORE");
    if (scoreSpec) CONFIDENT_SCORE = scoreSpec.value;
    const limitSpec = data.settings.find(s => s.key === "FACE_QUERY_LIMIT");
    if (limitSpec) { FACE_LIMIT = limitSpec.value; sizeCropImgCache(FACE_LIMIT); }
  } catch (e) {
    // Keep the built-in defaults if settings can't be reached.
  }
}

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("quicktag-view-btn").addEventListener("click", () => {
    window.location.href = "/tag.html";
  });
  document.getElementById("manage-view-btn").addEventListener("click", () => {
    window.location.href = "/people-manage.html";
  });

  document.getElementById("focus-year-select").addEventListener("change", onFocusChange);

  document.getElementById("deselect-all-btn").addEventListener("click", deselectAll);
  document.getElementById("suggested-only-chk").addEventListener("change", (e) => {
    suggestedOnly = e.target.checked;
    if (scope === "unlabeled") loadFaces();
  });
  // Suggested-person filter (Unlabeled queue): filters the loaded queue in place,
  // no refetch needed since we hold the full list in `unlabeledAll`.
  document.getElementById("suggest-filter-select").addEventListener("change", (e) => {
    suggestFilterPersonId = e.target.value ? parseInt(e.target.value) : null;
    if (scope === "unlabeled") applyUnlabeledView();
  });
  const hierarchySel = document.getElementById("unlabeled-hierarchy-select");
  hierarchySel.value = unlabeledHierarchy;
  hierarchySel.addEventListener("change", (e) => {
    unlabeledHierarchy = e.target.value;
    localStorage.setItem(UNLABELED_HIERARCHY_LS_KEY, unlabeledHierarchy);
    // Person-first hierarchy has no sortable groups — refresh the nav bar too.
    updateGridNavVisibility();
    renderGrid();
    if (scope === "unlabeled") updateUnlabeledStatus();
  });

  document.getElementById("assign-btn").addEventListener("click", openAssignPickerForSelection);
  document.getElementById("unassign-btn").addEventListener("click", () => assignSelected(null, true));
  document.getElementById("confirm-suggested-btn").addEventListener("click", acceptSuggestionsForSelection);
  // In the Ignored scope this button restores; everywhere else it ignores.
  document.getElementById("ignore-btn").addEventListener("click", () => ignoreSelected(scope !== "ignored"));
  // In the Come Back scope this button restores; everywhere else it defers.
  document.getElementById("come-back-btn").addEventListener("click", () => comeBackSelected(scope !== "come_back"));
  document.getElementById("nuke-btn").addEventListener("click", nukeSelectedPhotos);

  document.getElementById("review-guesses-btn").addEventListener("click", () => {
    const pid = parseInt(document.getElementById("guess-person-select").value);
    if (!pid) { setStatus("Pick a person to review guesses for.", true); return; }
    selectScope("suggested", pid);
  });
  document.getElementById("group-gap-select").addEventListener("change", (e) => {
    groupGapSeconds = parseInt(e.target.value);
    if (scope === "suggested") renderGrid();
  });

  document.getElementById("crowd-reload-btn").addEventListener("click", () => {
    if (scope === "crowds") loadFaces();   // routes to loadCrowds under the grid's latest-only guard
  });
  document.getElementById("crowd-hide-done").addEventListener("change", e => {
    hideCompletedCrowds = e.target.checked;
    if (scope === "crowds") renderCrowds();
  });

  const sortSelect = document.getElementById("grid-sort-select");
  sortSelect.value = gridSort;
  sortSelect.addEventListener("change", e => {
    gridSort = e.target.value;
    localStorage.setItem(GRID_SORT_LS_KEY, gridSort);
    // Sorting is render-only — no refetch, and the selection survives.
    if (scope === "discover")    renderClusters();
    else if (scope === "crowds") renderCrowds();
    else                         renderGrid();
  });

  document.getElementById("add-person-btn").addEventListener("click", addPerson);

  // Detail-pane assignment controls act on the ONE previewed face only — never the
  // grid selection (the toolbar's "Assign selection" is for that). Mirrors the
  // detail Ignore button below, which already scopes to the focused face.
  document.getElementById("detail-assign-btn").addEventListener("click", () => {
    if (!findFace(focusedFaceId)) { setStatus("Select a face first.", true); return; }
    openPersonPicker(persons, {
      title: "Assign to…",
      onPick: (who) => assignFocusedFace(who.person_id ? { personId: who.person_id } : { name: who.name }),
    });
  });
  document.getElementById("detail-unassign-btn").addEventListener("click", () => assignFocusedFace({ clear: true }));
  document.getElementById("detail-ignore-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (!f) { setStatus("Select a face first.", true); return; }
    // Act on the previewed face only — not the grid selection.
    ignoreSelected_ids([f.id], !f.ignored);
  });
  document.getElementById("detail-come-back-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (!f) { setStatus("Select a face first.", true); return; }
    // Act on the previewed face only — not the grid selection.
    comeBackSelected_ids([f.id], !f.come_back);
  });
  document.getElementById("detail-open-photo-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (f) window.open(`/api/preview/${f.photo_id}`, "_blank");
  });
  document.getElementById("detail-photo-faces-btn").addEventListener("click", () => {
    const f = findFace(focusedFaceId);
    if (!f) { setStatus("Select a face first.", true); return; }
    window.location.href = `/photo-faces.html?photo_id=${f.photo_id}`;
  });

  document.getElementById("commit-all-btn").addEventListener("click",
    () => commitPending(groupPendingEntries()));
  document.getElementById("revert-all-btn").addEventListener("click",
    () => revertPending(groupPendingEntries()));
  // Staged changes live only in this tab — don't let a reload eat a tagging pass.
  window.addEventListener("beforeunload", (e) => {
    if (!pending.size) return;
    e.preventDefault();
    e.returnValue = "";
  });

  document.getElementById("shortcuts-help-btn").addEventListener("click", openShortcutsHelp);
  document.getElementById("shortcuts-help-close").addEventListener("click", closeShortcutsHelp);
  document.getElementById("shortcuts-help-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "shortcuts-help-backdrop") closeShortcutsHelp();
  });
}

// Opens the "Assign selection to…" picker — shared by the toolbar button and
// the `a`/Enter keyboard shortcut.
function openAssignPickerForSelection() {
  const ids = selectionOrFocused();
  if (ids.length === 0) { setStatus("Select one or more faces first.", true); return; }
  openPersonPicker(persons, {
    title: `Assign ${ids.length} face(s) to…`,
    onPick: (who, label) => assignSelectedTo(who, label),
  });
}
