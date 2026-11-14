/* people-discover.js — People page: the Discover view (clusters of
 * unlabeled faces). */

/* ── Discover view (unsupervised clusters of unlabeled faces) ── */
// Called only via loadFaces(), whose latest-only wrapper owns `signal`.
async function loadClusters(signal) {
  selectedIds.clear();
  focusedFaceId = null;
  updateActionButtons();
  updateDetail();
  setStatus("Finding groups… this can take a few seconds on a large library.");
  try {
    const res = await fetch("/api/faces/clusters" + (focusActive() ? "?" + focusQuery() : ""),
                            { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (signal.aborted) return;
    clusters = data.clusters || [];
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

async function clusterAssign(cl, who, label) {
  try {
    const res = await fetch("/api/faces/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: cl.face_ids, ...who }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Assigned ${cl.face_ids.length} face(s) to ${label}.`);
    clusters = clusters.filter(c => c !== cl);
    if (cl.face_ids.includes(focusedFaceId)) { focusedFaceId = null; updateDetail(); }
    renderClusters();
    await loadPersons();
  } catch (err) {
    setStatus("Assign failed: " + err.message, true);
  }
}

async function clusterIgnore(cl) {
  if (!confirm(`Ignore all ${cl.size} face(s) in this group?`)) return;
  try {
    const res = await fetch("/api/faces/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_ids: cl.face_ids, ignored: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Ignored ${cl.face_ids.length} face(s).`);
    clusters = clusters.filter(c => c !== cl);
    if (cl.face_ids.includes(focusedFaceId)) { focusedFaceId = null; updateDetail(); }
    renderClusters();
    await loadPersons();
  } catch (err) {
    setStatus("Ignore failed: " + err.message, true);
  }
}
