/* people-crowds.js — People page: the Crowds view (crowd photo groups). */

/* ── Crowds view ── */
// Called only via loadFaces(), whose latest-only wrapper owns `signal`.
async function loadCrowds(signal) {
  selectedIds.clear();
  focusedFaceId = null;
  updateActionButtons();
  updateDetail();
  setStatus("Loading crowd photos…");
  const minFaces = parseInt(document.getElementById("crowd-min-faces").value) || 50;
  const gap = parseInt(document.getElementById("crowd-gap-select").value) || 86400;
  try {
    let url = `/api/crowds?min_faces=${minFaces}&group_gap=${gap}`;
    if (focusActive()) url += "&" + focusQuery();
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (signal.aborted) return;
    crowdGroups = data.groups || [];
    renderCrowds();
    if (!crowdGroups.length) {
      setStatus(`No crowd photos found with ≥ ${minFaces} faces. ` +
        `Try lowering the threshold or scan more photos.` +
        (focusActive() ? " (Focus is active — set “All time” to widen.)" : ""));
    } else {
      setStatus(`${crowdGroups.length} event group(s) across ${data.photo_count} crowd photo(s). ` +
        `Open a photo, tag the key people, then ignore the rest.`);
    }
  } catch (err) {
    if (signal.aborted) return;
    setStatus("Failed to load crowds: " + err.message, true);
  }
}

function renderCrowds() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  let visibleGroups = crowdGroups;
  if (hideCompletedCrowds) {
    visibleGroups = crowdGroups
      .map(g => ({ ...g, photos: g.photos.filter(p => p.unlabeled_faces > 0) }))
      .filter(g => g.photos.length > 0);
  }

  if (!visibleGroups.length && crowdGroups.length > 0) {
    const msg = document.createElement("div");
    msg.style.cssText = "color:#666;padding:16px;font-size:12px;grid-column:1/-1;";
    msg.textContent = 'All crowd photos are complete. Uncheck "Hide completed" to review them.';
    grid.appendChild(msg);
    return;
  }

  sortGroups(visibleGroups, gridSort, g => ({
    date: Math.min(...g.photos.map(p => p.photo_datetime || Infinity)),
    count: g.photos.length,
    place: primaryLocationKey(g.photos),
    dir: primaryDirKey(g.photos),
  })).forEach(g => grid.appendChild(makeCrowdGroupCard(g)));
}

function makeCrowdGroupCard(g) {
  const card = document.createElement("div");
  card.className = "cluster-card crowd-group-card";

  let ignoreBtn;   // captured from the header so per-photo actions can update it
  let meta = `· ${g.photos.length} photo(s) · ${g.total_faces} face(s)`;
  if (g.unlabeled_faces > 0) meta += ` · ${g.unlabeled_faces} unlabeled`;
  // Place goes last so the "Location, then date" sort is readable here too.
  const place = locationLabel(g.photos);
  if (place) meta += ` · 📍 ${place}`;

  card.appendChild(faceGroupHeader({
    title: g.label,
    meta,
    extraClass: "amber",
    buttons: [{
      icon: "🚫", label: `Ignore ${g.unlabeled_faces} unlabeled`, kind: "danger",
      disabled: g.unlabeled_faces === 0,
      ref: (el) => { ignoreBtn = el; },
      onClick: () => crowdIgnoreGroup(g, ignoreBtn),
    }],
  }));

  const photosWrap = document.createElement("div");
  photosWrap.className = "crowd-photos";
  g.photos.forEach(ph => photosWrap.appendChild(makeCrowdPhotoThumb(ph, g, ignoreBtn)));
  card.appendChild(photosWrap);
  return card;
}

function makeCrowdPhotoThumb(ph, group, groupIgnoreBtn) {
  const cell = document.createElement("div");
  cell.className = "crowd-photo-cell";

  const img = document.createElement("img");
  img.src = `/api/thumbnail/${ph.id}`;
  img.loading = "lazy";
  img.title = `${ph.filename} — click to open`;
  img.addEventListener("click", () => window.open(`/api/preview/${ph.id}`, "_blank"));
  cell.appendChild(img);

  const badge = document.createElement("div");
  badge.className = "crowd-badge";
  const parts = [`${ph.total_faces} faces`];
  if (ph.labeled_faces)   parts.push(`${ph.labeled_faces} labeled`);
  if (ph.unlabeled_faces) parts.push(`${ph.unlabeled_faces} unlabeled`);
  badge.textContent = parts.join(" · ");
  cell.appendChild(badge);

  const actions = document.createElement("div");
  actions.className = "crowd-photo-actions";

  const ignoreBtn = document.createElement("button");
  ignoreBtn.className = "danger";
  ignoreBtn.textContent = "Ignore unlabeled";
  ignoreBtn.disabled = ph.unlabeled_faces === 0;
  ignoreBtn.addEventListener("click", async () => {
    try {
      const prevUnlabeled = ph.unlabeled_faces;
      await crowdIgnorePhotos([ph.id], ignoreBtn);
      group.unlabeled_faces -= prevUnlabeled;
      ph.unlabeled_faces = 0;
      ignoreBtn.disabled = true;
      badge.textContent = parts.filter(p => !p.includes("unlabeled")).join(" · ");
      // The group button is now an icon (🚫); update its tooltip, not its glyph.
      const groupLbl = `Ignore ${group.unlabeled_faces} unlabeled`;
      groupIgnoreBtn.title = groupLbl;
      groupIgnoreBtn.setAttribute("aria-label", groupLbl);
      groupIgnoreBtn.disabled = group.unlabeled_faces === 0;
    } catch (_) { /* error already shown in status bar */ }
  });
  actions.appendChild(ignoreBtn);

  const reviewBtn = document.createElement("button");
  reviewBtn.textContent = "Review";
  const minFaces = parseInt(document.getElementById("crowd-min-faces").value) || 50;
  const gap = parseInt(document.getElementById("crowd-gap-select").value) || 86400;
  reviewBtn.addEventListener("click", () => {
    window.location.href =
      `/photo-faces.html?photo_id=${ph.id}&mode=crowd&min_faces=${minFaces}&group_gap=${gap}`;
  });
  actions.appendChild(reviewBtn);

  const openBtn = document.createElement("button");
  openBtn.textContent = "Photo ↗";
  openBtn.addEventListener("click", () => window.open(`/api/preview/${ph.id}`, "_blank"));
  actions.appendChild(openBtn);

  cell.appendChild(actions);
  return cell;
}

async function crowdIgnoreGroup(g, btn) {
  if (!confirm(`Ignore all ${g.unlabeled_faces} unlabeled face(s) across ${g.photos.length} photo(s) in this group?`)) return;
  const photoIds = g.photos.map(p => p.id);
  try {
    await crowdIgnorePhotos(photoIds, btn);
    g.unlabeled_faces = 0;
    g.photos.forEach(p => { p.unlabeled_faces = 0; });
    renderCrowds();
    await loadPersons();
  } catch (_) { /* error already shown in status bar */ }
}

async function crowdIgnorePhotos(photoIds, btn) {
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Ignoring…";
  try {
    const res = await fetch("/api/crowds/ignore-unlabeled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus(`Ignored ${data.ignored} face(s).`);
    await loadPersons();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevText;
    setStatus("Ignore failed: " + err.message, true);
    throw err;
  }
}
