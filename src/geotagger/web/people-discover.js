/* people-discover.js — People page: the Discover view (clusters of
 * unlabeled faces). */

/* ── Discover view (unsupervised clusters of unlabeled faces) ──
 * Clustering is a full pass over the unlabeled queue (up to FACE_CLUSTER_CAP
 * faces: similarity graph + a suggestion matmul per face), so it only runs on
 * entering the scope or on "Refresh groups". Every face/group action after that
 * patches `clusters` in place (U6) — see dropFacesFromClusters. */

// True once a local patch may have left the groups different from what a fresh
// run would find: a face leaving a group can split it (groups are connected
// components, and the face may have been the bridge), and any assignment grows
// the gallery that the "Looks like …" votes are taken against. Shown as a note
// beside the Refresh button; cleared by the next successful load.
let clustersStale = false;
// The signal of the clustering request in flight, if any — a patch landing
// while it runs would be overwritten by a response computed before the action.
let clusterLoadSignal = null;

function setClustersStale(stale) {
  clustersStale = stale;
  document.getElementById("discover-stale-note").hidden = !stale;
}

// Called only via loadFaces(), whose latest-only wrapper owns `signal`.
async function loadClusters(signal) {
  selectedIds.clear();
  focusedFaceId = null;
  updateActionButtons();
  updateDetail();
  setStatus("Finding groups… this can take a few seconds on a large library.");
  clusterLoadSignal = signal;
  try {
    const data = await fetchJson(
      "/api/faces/clusters" + (focusActive() ? "?" + focusQuery() : ""), { signal });
    if (signal.aborted) return;
    clusters = data.clusters || [];
    setClustersStale(false);
    renderClusters();
    if (!clusters.length) {
      setStatus(`No groups found among ${data.scanned} clear unlabeled faces. ` +
        `Tag a few faces and use “Find more”, or rescan if many are still pending.` +
        (focusActive() ? " (Focus is active — set “All time” to widen.)" : ""));
    } else {
      setStatus(`${clusters.length} group(s) across ${data.grouped} of ${data.scanned} ` +
        `faces. Name or assign each group, or Ignore it.`);
    }
  } catch (err) {
    if (signal.aborted) return;
    setStatus("Clustering failed: " + err.message, true);
  } finally {
    if (clusterLoadSignal === signal) clusterLoadSignal = null;
  }
}

function renderClusters() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  // Photo count comes off the sample rather than cl.size: a cluster is one
  // person, so it's normally one face per photo, but a sample capped at 24 would
  // understate a big group — cl.size is the better count when it's truncated.
  sortGroups(clusters, gridSort, cl => ({
    date: minOf(cl.sample.map(f => f.photo_datetime || Infinity)),
    count: Math.max(cl.size, new Set(cl.sample.map(f => f.photo_id)).size),
    place: primaryLocationKey(cl.sample),
    dir: primaryDirKey(cl.sample),
  })).forEach(cl => grid.appendChild(makeClusterCard(cl)));
}

function makeClusterCard(cl) {
  const card = document.createElement("div");
  card.className = "cluster-card";

  const buttons = [];
  if (cl.suggestion) {
    buttons.push({
      icon: "✓", label: `Assign to ${cl.suggestion.person_name}`, kind: "primary",
      onClick: () =>
        clusterAssign(cl, { person_id: cl.suggestion.person_id }, cl.suggestion.person_name),
    });
  }
  buttons.push({
    icon: "✏️", label: cl.suggestion ? "Name instead…" : "Name…",
    kind: cl.suggestion ? "" : "primary",
    onClick: () => {
      const name = prompt(`Name this group of ${cl.size} face(s):`,
                          cl.suggestion ? cl.suggestion.person_name : "");
      if (name && name.trim()) clusterAssign(cl, { name: name.trim() }, name.trim());
    },
  });
  buttons.push({
    icon: "🚫", label: "Ignore all", kind: "danger",
    onClick: () => clusterIgnore(cl),
  });

  const place = locationLabel(cl.sample);
  card.appendChild(faceGroupHeader({
    title: cl.suggestion ? `Looks like ${cl.suggestion.person_name}` : "New group",
    meta: `· ${cl.size} face(s)` +
      (cl.suggestion ? ` · ${Math.round(cl.suggestion.score * 100)}% of group` : "") +
      (place ? ` · 📍 ${place}` : ""),
    buttons,
  }));

  const facesWrap = document.createElement("div");
  facesWrap.className = "cluster-faces";
  cl.sample.forEach(f => {
    const img = faceCropImg(f, { title: f.filename });
    if (f.id === focusedFaceId) img.classList.add("focused");
    const focus = () => {
      document.querySelectorAll(".cluster-faces img.focused")
        .forEach(el => el.classList.remove("focused"));
      img.classList.add("focused");
      focusedFaceId = f.id;
      updateDetail();
    };
    img.addEventListener("click", focus);          // left-click: show in detail
    img.addEventListener("contextmenu", (e) => {   // right-click: actions
      e.preventDefault();
      focus();
      openFaceActions(img, f);
    });
    facesWrap.appendChild(img);
  });
  if (cl.size > cl.sample.length) {
    const more = document.createElement("span");
    more.className = "cluster-more";
    more.textContent = `+${cl.size - cl.sample.length} more`;
    facesWrap.appendChild(more);
  }
  card.appendChild(facesWrap);
  return card;
}

// Re-render after a local patch without jumping the pane back to the top
// (renderClusters empties #grid first, which clamps the scroll to 0).
function rerenderClustersInPlace() {
  const pane = document.getElementById("grid-pane");
  const top = pane.scrollTop;
  renderClusters();
  pane.scrollTop = top;
}

// The faces in `ids` have left the unlabeled pool (assigned, ignored, moved to
// Come Back): drop them from their groups in place, as clusterAssign does for a
// whole group, instead of re-clustering the library (U6). Empty groups go; the
// rest keep their (now approximate) suggestion and the "+N more" count shrinks —
// the 24-face sample can't be refilled, we don't hold the faces past it.
// `assigned` marks the patch stale even when whole groups left (the gallery grew).
// If the focused face goes, focus moves to its neighbour in the same group so
// triage can carry on from the detail pane.
function dropFacesFromClusters(ids, { assigned = false } = {}) {
  const gone = new Set(ids);
  if (!gone.size) return;
  let nextFocus = null;
  if (gone.has(focusedFaceId)) {
    const cl = clusters.find(c => c.sample.some(f => f.id === focusedFaceId));
    if (cl) {
      const i = cl.sample.findIndex(f => f.id === focusedFaceId);
      const rest = cl.sample.filter(f => !gone.has(f.id));
      nextFocus = rest[Math.min(i, rest.length - 1)]?.id ?? null;
    }
  }
  let partial = false;
  clusters = clusters.filter(cl => {
    if (!cl.face_ids.some(id => gone.has(id))) return true;
    cl.face_ids = cl.face_ids.filter(id => !gone.has(id));
    cl.sample = cl.sample.filter(f => !gone.has(f.id));
    cl.size = cl.face_ids.length;
    if (cl.size > 0) partial = true;
    return cl.size > 0;
  });
  ids.forEach(id => selectedIds.delete(id));
  if (gone.has(focusedFaceId)) focusedFaceId = nextFocus;
  if (partial || assigned) setClustersStale(true);
  rerenderClustersInPlace();
  updateDetail();
  // A clustering request still in flight was computed before this action and
  // would put the faces back — restart it so the fresh result wins.
  if (clusterLoadSignal && !clusterLoadSignal.aborted) loadFaces();
}

// Undo toast (U3) for the People page's immediate (unstaged) group writes —
// Discover's Accept / Ignore group and Crowds' Ignore unlabeled. The faces go
// back server-side; the view on screen is reloaded rather than patched (a
// restored face may re-cluster anywhere).
function offerPeopleUndo(message, token) {
  if (!faceUndoable(token)) return;
  showUndoToast(message, async () => {
    const r = await undoFaceToken(token);
    await loadPersons();
    await loadFaces();
    return r;
  });
}

// For the shared face actions (people-actions.js): in Discover, patch the groups
// after a successful POST and report true; anywhere else report false so the
// caller reloads its grid as before.
function patchClustersAfter(ids, opts) {
  if (scope !== "discover") return false;
  dropFacesFromClusters(ids, opts);
  return true;
}

async function clusterAssign(cl, who, label) {
  try {
    const data = await postJson("/api/faces/assign", { face_ids: cl.face_ids, ...who });
    setStatus(`Assigned ${cl.face_ids.length} face(s) to ${label}.`);
    dropFacesFromClusters(cl.face_ids, { assigned: true });
    await loadPersons();
    offerPeopleUndo(`Assigned ${cl.face_ids.length} face(s) to ${label}.`, data.undo);
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

async function clusterIgnore(cl) {
  if (!confirm(`Ignore all ${cl.size} face(s) in this group?`)) return;
  try {
    const data = await postJson("/api/faces/ignore", { face_ids: cl.face_ids, ignored: true });
    setStatus(`Ignored ${cl.face_ids.length} face(s).`);
    dropFacesFromClusters(cl.face_ids);
    await loadPersons();
    offerPeopleUndo(`Ignored ${cl.face_ids.length} face(s).`, data.undo);
  } catch (err) {
    setStatus("Ignore failed: " + err.message, true);
  }
}
