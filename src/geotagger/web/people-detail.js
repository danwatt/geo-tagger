/* people-detail.js — People page: the detail (preview) pane — its resizer,
 * the "Also in this photo" chips, and updateDetail(). */

/* ── Detail-pane resizer ──
 * The preview is the one pane whose useful width depends on the monitor and on
 * the photo: a wide desktop can spare far more than the 340px default, and a
 * face is much easier to judge large. The handle moves the grid/detail seam and
 * nothing else — the people list keeps its fixed column — and the width is
 * persisted, since this is a per-display preference, not a per-visit one. */
const DETAIL_W_LS_KEY = "geotagger.people.detailWidth";
const DETAIL_W_DEFAULT = 340;
const DETAIL_W_MIN = 240;

// The grid has to stay a grid, so the ceiling is "whatever is left after the
// people list, the handle, and room for a couple of columns of faces" rather
// than a flat percentage — a percentage that looks sane at 2560px starves the
// grid at 1280. DETAIL_W_MIN still wins on a window too narrow for even that.
// Re-clamped on resize so a width saved on a wide monitor doesn't swallow a
// narrow one. Returns the width actually applied.
const PEOPLE_LIST_W = 220;   // matches the fixed first column in people.css
const RESIZER_W = 6;
const GRID_MIN_W = 320;      // ~2 columns of face cells

function setDetailWidth(px, persist = true) {
  const max = Math.max(
    DETAIL_W_MIN,
    window.innerWidth - PEOPLE_LIST_W - RESIZER_W - GRID_MIN_W);
  const w = Math.round(Math.max(DETAIL_W_MIN, Math.min(max, px)));
  document.getElementById("people-main").style.setProperty("--detail-pane-w", `${w}px`);
  const handle = document.getElementById("detail-resizer");
  if (handle) handle.setAttribute("aria-valuenow", String(w));
  if (persist) localStorage.setItem(DETAIL_W_LS_KEY, String(w));
  return w;
}

function bindDetailResizer() {
  const handle = document.getElementById("detail-resizer");
  const pane = document.getElementById("detail-pane");
  const main = document.getElementById("people-main");
  if (!handle || !pane || !main) return;

  const saved = parseInt(localStorage.getItem(DETAIL_W_LS_KEY) || "", 10);
  setDetailWidth(Number.isFinite(saved) ? saved : DETAIL_W_DEFAULT, false);
  handle.setAttribute("aria-valuemin", String(DETAIL_W_MIN));

  // Pointer capture keeps the drag alive over the grid's cells and past the
  // window edge; without it the first cell the pointer crosses eats the moves.
  let dragging = false;
  handle.addEventListener("pointerdown", e => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    main.classList.add("pane-resizing");
    e.preventDefault();   // no text selection / native image drag mid-resize
  });
  handle.addEventListener("pointermove", e => {
    if (!dragging) return;
    // Width measured from the pointer to the window's right edge, so the seam
    // tracks the cursor exactly however far the drag has wandered.
    setDetailWidth(window.innerWidth - e.clientX);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    main.classList.remove("pane-resizing");
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("lostpointercapture", stop);

  handle.addEventListener("dblclick", () => setDetailWidth(DETAIL_W_DEFAULT));

  // Keyboard equivalent — the handle is a focusable separator, so arrows nudge
  // it and Home returns to the default.
  handle.addEventListener("keydown", e => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === "ArrowLeft")       setDetailWidth(pane.offsetWidth + step);
    else if (e.key === "ArrowRight") setDetailWidth(pane.offsetWidth - step);
    else if (e.key === "Home")       setDetailWidth(DETAIL_W_DEFAULT);
    else return;
    e.preventDefault();
  });

  // Re-clamp against the new viewport, but keep the stored preference: a width
  // that doesn't fit today's window should come back when the window grows.
  window.addEventListener("resize", () => {
    const stored = parseInt(localStorage.getItem(DETAIL_W_LS_KEY) || "", 10);
    setDetailWidth(Number.isFinite(stored) ? stored : DETAIL_W_DEFAULT, false);
  });
}

/* ── Detail pane ── */

/* ── "Also in this photo" chips ──
 * Committed (DB) person tags for the focused face's photo. Cached per photo so
 * arrowing through several faces of the same photo costs one request; cleared
 * by loadFaces(), which runs after every mutation/commit. */
const taggedPeopleCache = new Map();

async function fetchTaggedPeople(photoId) {
  if (taggedPeopleCache.has(photoId)) return taggedPeopleCache.get(photoId);
  const res = await fetch(`/api/photos/${photoId}/tagged-people`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const people = await res.json();
  taggedPeopleCache.set(photoId, people);
  return people;
}

async function updatePhotoPeople(face) {
  const box = document.getElementById("photo-people");
  const hl = document.getElementById("photo-people-box");
  hl.style.display = "none";
  let people;
  try {
    people = await fetchTaggedPeople(face.photo_id);
  } catch {
    box.style.display = "none";
    return;
  }
  // Focus may have moved on while the request was in flight.
  if (focusedFaceId !== face.id) return;
  if (!people.length) { box.style.display = "none"; return; }

  box.style.display = "flex";
  box.innerHTML = "";
  const label = document.createElement("div");
  label.className = "pp-label";
  label.textContent = `Already tagged in this photo (${people.length}):`;
  box.appendChild(label);

  people.forEach(p => {
    const chip = document.createElement("div");
    chip.className = p.id === face.id ? "pp-chip pp-self" : "pp-chip";
    chip.title = p.id === face.id
      ? `${p.person_name} — this face`
      : `${p.person_name} — hover to locate in the photo`;
    const img = document.createElement("img");
    img.src = `/api/faces/${p.id}/crop`;
    img.alt = p.person_name;
    chip.appendChild(img);
    const name = document.createElement("span");
    name.textContent = p.person_name;
    chip.appendChild(name);
    if (p.id !== face.id) {
      chip.addEventListener("mouseenter", () => {
        applyBbox(hl, p.bbox);
        hl.style.display = "block";
      });
      chip.addEventListener("mouseleave", () => { hl.style.display = "none"; });
    }
    box.appendChild(chip);
  });
}

function updateDetail() {
  const placeholder = document.getElementById("detail-placeholder");
  const content = document.getElementById("detail-content");

  const face = findFace(focusedFaceId);
  if (!face) {
    placeholder.style.display = "block";
    content.style.display = "none";
    document.getElementById("photo-people").style.display = "none";
    return;
  }
  placeholder.style.display = "none";
  content.style.display = "flex";

  document.getElementById("detail-img").src = `/api/preview/${face.photo_id}`;
  wireFullSizeButton(document.getElementById("detail-fullsize-btn"), face.filename, face.photo_id);

  // Position the bbox overlay (normalized coords map directly to percentages).
  applyBbox(document.getElementById("face-box"), face.bbox);

  updatePhotoPeople(face);   // async, fills in when the photo's tags arrive

  const when = face.photo_datetime
    ? new Date(face.photo_datetime * 1000).toLocaleString() : "Unknown";
  const personCell = face.ignored
    ? "<i style='color:#999'>Ignored</i>"
    : face.come_back
      ? "<i style='color:#dab35a'>Come back later</i>"
      : (face.person_name ? escapeHtml(face.person_name) : "<i style='color:#777'>Unassigned</i>");
  const loc = face.location;
  const placeStr = loc
    ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ")
    : null;
  const staged = pending.get(face.id);
  document.getElementById("detail-meta").innerHTML = `
    <tr><td>Photo</td><td>${escapeHtml(face.filename)}</td></tr>
    <tr><td>Taken</td><td>${escapeHtml(when)}</td></tr>
    ${placeStr ? `<tr><td>Location</td><td>${escapeHtml(placeStr)}</td></tr>` : ""}
    <tr><td>Person</td><td>${personCell}</td></tr>
    ${staged ? `<tr><td>Staged</td><td><b style='color:var(--warn)'>→ ${escapeHtml(pendingCellLabel(staged))}</b> (not saved)</td></tr>` : ""}
    <tr><td>Detection</td><td>${face.det_score.toFixed(3)}</td></tr>
  `;
  const detailIgnoreBtn = document.getElementById("detail-ignore-btn");
  detailIgnoreBtn.textContent = face.ignored ? "↩" : "🚫";
  detailIgnoreBtn.title = face.ignored ? "Restore" : "Ignore";
  detailIgnoreBtn.setAttribute("aria-label", detailIgnoreBtn.title);

  const detailComeBackBtn = document.getElementById("detail-come-back-btn");
  detailComeBackBtn.textContent = face.come_back ? "↩" : "🕒";
  detailComeBackBtn.title = face.come_back ? "Restore" : "Come back later";
  detailComeBackBtn.setAttribute("aria-label", detailComeBackBtn.title);

  const sug = document.getElementById("face-suggestion");
  const alts = face.alternatives || [];
  if (!face.person_name && face.suggestion) {
    sug.style.display = "flex";
    sug.innerHTML = "";

    const primary = document.createElement("div");
    primary.className = "sug-primary";
    primary.innerHTML =
      `<span class="sug-text">Looks like <b>${escapeHtml(face.suggestion.person_name)}</b> ` +
      `(${face.suggestion.score})</span>`;
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "primary";
    confirmBtn.textContent = "Confirm";
    confirmBtn.addEventListener("click", () => confirmFace(face.id, face.suggestion.person_id));
    primary.appendChild(confirmBtn);
    const notBtn = document.createElement("button");
    notBtn.className = "danger";
    notBtn.textContent = `Not ${face.suggestion.person_name}`;
    notBtn.title = `Mark this face as definitely not ${face.suggestion.person_name}`;
    notBtn.addEventListener("click", () =>
      rejectSuggestion(face.id, face.suggestion.person_id, face.suggestion.person_name));
    primary.appendChild(notBtn);
    sug.appendChild(primary);

    if (alts.length) {
      const altWrap = document.createElement("div");
      altWrap.className = "sug-alts";
      const label = document.createElement("span");
      label.className = "sug-alts-label";
      label.textContent = "…or maybe:";
      altWrap.appendChild(label);
      alts.forEach(alt => {
        const group = document.createElement("span");
        group.className = "sug-alt-group";
        const b = document.createElement("button");
        b.className = "alt-btn";
        b.textContent = `${alt.person_name} (${alt.score})`;
        b.title = `Tag this face as ${alt.person_name} instead`;
        b.addEventListener("click", () => confirmFace(face.id, alt.person_id));
        group.appendChild(b);
        const notB = document.createElement("button");
        notB.className = "alt-btn alt-not-btn";
        notB.textContent = "✕";
        notB.title = `Not ${alt.person_name}`;
        notB.addEventListener("click", () => rejectSuggestion(face.id, alt.person_id, alt.person_name));
        group.appendChild(notB);
        altWrap.appendChild(group);
      });
      sug.appendChild(altWrap);
    }
  } else {
    sug.style.display = "none";
  }

  // Faces already marked "not this person" — reversible.
  const negBox = document.getElementById("face-negatives");
  const negatives = face.negatives || [];
  if (negatives.length) {
    negBox.style.display = "flex";
    negBox.innerHTML = "";
    const title = document.createElement("div");
    title.className = "neg-title";
    title.textContent = "Marked as NOT this face:";
    negBox.appendChild(title);
    negatives.forEach(pid => {
      const name = persons.find(p => p.id === pid)?.name || "Unknown";
      const row = document.createElement("div");
      row.className = "neg-row";
      const label = document.createElement("span");
      label.textContent = name;
      row.appendChild(label);
      const undoBtn = document.createElement("button");
      undoBtn.className = "neg-undo-btn";
      undoBtn.textContent = "↩ Undo";
      undoBtn.title = `Allow ${name} to be suggested for this face again`;
      undoBtn.addEventListener("click", () => rejectSuggestion(face.id, pid, name, false));
      row.appendChild(undoBtn);
      negBox.appendChild(row);
    });
  } else {
    negBox.style.display = "none";
  }
}
