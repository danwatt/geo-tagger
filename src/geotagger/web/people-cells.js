/* people-cells.js — People page: grid building blocks — the Unlabeled
 * hierarchy renderers, person runs, face cells, suggestion chips, and the
 * batch/group section headers. */

function renderUnlabeledPhotoFirst(grid, list) {
  let groupIdx = 0, curYear, curMonth;
  // Same rule as the month→location grid: dividers only read correctly while the
  // groups stay chronological, so the count/location sorts drop them.
  const showDividers = gridSort === "date";
  sortFaceGroups(computeUnlabeledPhotoGroups(list)).forEach(group => {
    if (showDividers) {
      if (group.year !== curYear) {
        curYear = group.year; curMonth = undefined;
        const yd = document.createElement("div");
        yd.className = "grid-year-divider";
        yd.textContent = group.year === null ? "Undated" : group.year;
        grid.appendChild(yd);
      }
      if (group.month !== curMonth) {
        curMonth = group.month;
        if (group.month !== null) {
          const md = document.createElement("div");
          md.className = "grid-month-divider";
          md.textContent = MONTH_NAMES[group.month];
          grid.appendChild(md);
        }
      }
    }
    const sec = makeGroupSection(groupIdx++);
    const place = locationLabel(group.faces);
    const n = group.faces.length;
    sec.appendChild(makeGroupHeader(group, {
      title: `🖼 ${group.filename}`,
      label: group.filename,
      meta: `· ${facesDateRange(group.faces)} · ${n} face${n === 1 ? "" : "s"}` +
            (place ? ` · 📍 ${place}` : ""),
      ignoreAll: true,
      extraButtons: [
        { icon: "🔍", label: "Open photo",
          title: "Open this photo's full face-review page",
          onClick: () => {
            window.location.href = `/photo-faces.html?photo_id=${group.photoId}`;
          } },
      ],
    }));
    const cells = document.createElement("div");
    cells.className = "face-group-cells";
    group.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
    sec.appendChild(cells);
    grid.appendChild(sec);
  });
}

// Cells for one bucket, laid out as person runs. Faces are already clustered by
// suggested person (sortBucketBySuggestion); each run of same-suggestion faces
// gets its own wrapping flex row (.person-run) instead of being flattened into
// one grid, so the whole run can get a continuous hover background — same idea
// as search.js's .photo-row, just one row per suggested person instead of per
// photo. Shared by the month→location and directory grids.
function makePersonRuns(faceList) {
  const cells = document.createElement("div");
  cells.className = "person-runs";
  let prevSug, run;   // prevSug undefined before the first cell; null = "unknown" block
  faceList.forEach(face => {
    const sug = face.suggestion ? face.suggestion.person_id : null;
    if (prevSug === undefined || sug !== prevSug) {
      run = document.createElement("div");
      run.className = "person-run";
      cells.appendChild(run);
    }
    run.appendChild(makeFaceCell(face));
    prevSug = sug;
  });
  return cells;
}

function renderUnlabeledDirFirst(grid, list) {
  let groupIdx = 0;
  // No year/month dividers here: a folder isn't a chronological unit — a scanned
  // batch routinely spans decades — so each header carries its own date range.
  sortFaceGroups(computeUnlabeledDirGroups(list)).forEach(group => {
    const sec = makeGroupSection(groupIdx++);
    const place = locationLabel(group.faces);
    const n = group.faces.length;
    sec.appendChild(makeGroupHeader(group, {
      title: `📁 ${shortDirPath(group.dir)}`,
      label: group.name,
      meta: `· ${facesDateRange(group.faces)} · ${photoCountLabel(group.faces)} · ` +
            `${n} face${n === 1 ? "" : "s"}` + (place ? ` · 📍 ${place}` : ""),
      ignoreAll: true,
    }));
    sec.appendChild(makePersonRuns(group.faces));
    grid.appendChild(sec);
  });
}

function renderUnlabeledPersonFirst(grid, list) {
  let groupIdx = 0;
  computeUnlabeledPersonGroups(list).forEach(person => {
    const pd = document.createElement("div");
    pd.className = "grid-year-divider";
    pd.textContent = person.name || `No suggestion (${person.faces.length})`;
    grid.appendChild(pd);

    person.chunks.forEach(chunk => {
      const sec = makeGroupSection(groupIdx++);
      const place = locationLabel(chunk.faces);
      const personLabel = person.name || "unlabeled faces";
      sec.appendChild(makeGroupHeader(chunk, {
        title: formatGroupRange(chunk),
        meta: place ? `· 📍 ${place}` : "",
        label: `${personLabel} · ${formatGroupRange(chunk)}`,
        ignoreAll: true,
      }));
      const cells = document.createElement("div");
      cells.className = "face-group-cells";
      chunk.faces.forEach(face => { cells.appendChild(makeFaceCell(face)); });
      sec.appendChild(cells);
      grid.appendChild(sec);
    });
  });
}

function makeFaceCell(face) {
  const idx = renderOrder.push(face) - 1;
  const cell = document.createElement("div");
  cell.className = "thumb-cell" +
    (selectedIds.has(face.id) ? " selected" : "") +
    (face.ignored ? " ignored" : "") +
    (face.come_back ? " come-back" : "");
  cell.dataset.id = face.id;

  // reuse: staging/committing rebuilds the whole grid, and rebuilding the <img>
  // nodes with it is what makes the faces visibly blank and reload.
  cell.appendChild(faceCropImg(face, { reuse: true }));

  const score = document.createElement("div");
  score.className = "face-score";
  score.textContent = face.det_score.toFixed(2);
  cell.appendChild(score);

  if (face.ignored) {
    const label = document.createElement("div");
    label.className = "face-label ignored-label";
    label.textContent = "Ignored";
    cell.appendChild(label);
  } else if (face.come_back) {
    const label = document.createElement("div");
    label.className = "face-label come-back-label";
    label.textContent = "Come back";
    cell.appendChild(label);
  } else if (face.person_name && scope === "recent") {
    // In the recently-tagged view the name is a one-click un-tag.
    const chip = document.createElement("div");
    chip.className = "face-untag";
    chip.title = `Click to un-tag ${face.person_name}`;
    chip.innerHTML =
      `<span class="sug-name">${escapeHtml(face.person_name)}</span>` +
      `<span class="untag-x">✕</span>`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      untagFaces([face.id]);
    });
    cell.appendChild(chip);
  } else if (face.person_name) {
    const label = document.createElement("div");
    label.className = "face-label";
    label.textContent = face.person_name;
    cell.appendChild(label);
  } else if (face.suggestion) {
    const alts = face.alternatives || [];
    if (alts.length) {
      // Near-tie with another person — flag it and offer a one-click reassign.
      cell.classList.add("ambiguous");
      const wrap = document.createElement("div");
      wrap.className = "face-chips";
      wrap.appendChild(makeSuggestChip(face));
      alts.slice(0, 2).forEach(alt => wrap.appendChild(makeAltChip(face, alt)));
      cell.appendChild(wrap);
    } else {
      cell.appendChild(makeSuggestChip(face));
    }
  }

  // Left-click selects/deselects (plain, Ctrl/⌘ toggle, Shift range);
  // right-click opens the quick-action menu for this face.
  cell.addEventListener("click", (e) => handleCellClick(e, face, idx));
  cell.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openFaceActions(cell, face);
  });
  return cell;
}

// Green chip confirming the face as its top-suggested person; the ✕ rejects it
// instead ("not this person") so recognition falls through to the next-best guess.
function makeSuggestChip(face) {
  const chip = document.createElement("div");
  chip.className = "face-suggest";
  chip.title = `Click to confirm: ${face.suggestion.person_name} (${face.suggestion.score})`;
  chip.innerHTML =
    `<span class="sug-check">✓</span>` +
    `<span class="sug-name">${escapeHtml(face.suggestion.person_name)}?</span>` +
    `<span class="sug-reject" title="Not ${escapeHtml(face.suggestion.person_name)}">✕</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest(".sug-reject")) {
      rejectSuggestion(face.id, face.suggestion.person_id, face.suggestion.person_name);
      return;
    }
    confirmFace(face.id, face.suggestion.person_id);
  });
  return chip;
}

// Amber chip tagging the face as a runner-up person instead of the suggestion;
// the ✕ rejects that alternative ("not this person either").
function makeAltChip(face, alt) {
  const chip = document.createElement("div");
  chip.className = "face-alt";
  chip.title = `Click to tag as ${alt.person_name} instead (${alt.score})`;
  chip.innerHTML =
    `<span class="alt-arrow">→</span>` +
    `<span class="sug-name">${escapeHtml(alt.person_name)}?</span>` +
    `<span class="sug-reject" title="Not ${escapeHtml(alt.person_name)}">✕</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest(".sug-reject")) {
      rejectSuggestion(face.id, alt.person_id, alt.person_name);
      return;
    }
    confirmFace(face.id, alt.person_id);
  });
  return chip;
}

function makeIgnoreBatchHeader(group) {
  const when = group.ts ? formatRelativeTime(group.ts) : "before tracking";
  return faceGroupHeader({
    title: `Ignored ${when}`,
    meta: `· ${group.faces.length} face(s)`,
    scopeLabel: "this batch:",
    buttons: [
      { label: "Select all",
        title: "Add every face in this batch to the current selection",
        onClick: () => { group.faces.forEach(f => selectedIds.add(f.id)); paintSelection(); updateDetail(); } },
      { label: `Restore all (${group.faces.length})`, kind: "primary",
        title: "Un-ignore every face in this batch (returns them to the Unlabeled queue)",
        onClick: () => ignoreSelected_ids(group.faces.map(f => f.id), false) },
    ],
  });
}

function makeComeBackBatchHeader(group) {
  const when = group.ts ? formatRelativeTime(group.ts) : "unknown time";
  return faceGroupHeader({
    title: `Come back ${when}`,
    meta: `· ${group.faces.length} face(s)`,
    scopeLabel: "this batch:",
    buttons: [
      { label: "Select all",
        title: "Add every face in this batch to the current selection",
        onClick: () => { group.faces.forEach(f => selectedIds.add(f.id)); paintSelection(); updateDetail(); } },
      { label: `Restore all (${group.faces.length})`, kind: "primary",
        title: "Move every face in this batch back to the Unlabeled queue",
        onClick: () => comeBackSelected_ids(group.faces.map(f => f.id), false) },
    ],
  });
}

function makeTagBatchHeader(group) {
  const names = [...new Set(group.faces.map(f => f.person_name).filter(Boolean))];
  const who = names.length === 1 ? names[0]
            : names.length === 2 ? names.join(" & ")
            : `${names.length} people`;
  return faceGroupHeader({
    title: who,
    meta: `· ${formatRelativeTime(group.ts)} · ${group.faces.length} face(s)`,
    scopeLabel: "this batch:",
    buttons: [
      { label: `Untag all (${group.faces.length})`, kind: "danger",
        title: "Un-tag every face tagged in this batch (returns them to Unlabeled)",
        onClick: () => untagFaces(group.faces.map(f => f.id), who) },
    ],
  });
}

// Shared header for a section of faces (guesses view and Unlabeled queue).
// `title`/`meta` are display text; `label` (default `title`) is the plain name
// used in status messages. `ignoreAll` switches the Ignore button between
// "ignore the selected faces" (guesses view) and "ignore the whole group
// regardless of selection" (Unlabeled queue).
function makeGroupHeader(group, { title, meta = "", label = title, ignoreAll = false,
                                  extraButtons = [] } = {}) {
  const acceptable = group.faces.filter(f => f.suggestion && !f.person_name && !f.ignored);
  const ignoreBtn = ignoreAll
    ? { icon: "🚫", label: "Ignore all", kind: "danger",
        title: "Ignore every face in this group, regardless of selection",
        onClick: () => {
          if (!stagingEnabled() &&
              !confirm(`Ignore all ${group.faces.length} face(s) in ${label}?`)) return;
          ignoreSelected_ids(group.faces.map(f => f.id), true);
        } }
    : { icon: "🚫", label: "Ignore selected", kind: "danger",
        title: "Ignore the selected faces in this group",
        onClick: () => {
          const ids = group.faces.filter(f => selectedIds.has(f.id)).map(f => f.id);
          if (!ids.length) {
            setStatus(`No selected faces in ${label} to ignore.`, true);
            return;
          }
          ignoreSelected_ids(ids, true);
        } };
  return faceGroupHeader({
    title,
    meta,
    scopeLabel: "this group:",
    buttons: [
      ...extraButtons,
      acceptable.length > 0 && {
        icon: "✓", label: `Accept all (${acceptable.length})`, kind: "primary",
        title: `Accept all ${acceptable.length} suggestion(s) in this group`,
        onClick: () => acceptSuggestionsFor(group.faces, label),
      },
      { icon: "☑", label: "Select all",
        title: "Add every face in this group to the current selection",
        onClick: () => selectGroupFaces(group, true, label) },
      { icon: "◉", label: "Select only",
        title: "Select every face in this group and deselect all others",
        onClick: () => selectGroupFaces(group, false, label) },
      { icon: "☐", label: "Deselect all",
        title: "Remove every face in this group from the current selection",
        onClick: () => {
          group.faces.forEach(f => selectedIds.delete(f.id));
          paintSelection();
          updateDetail();
          setStatus(`Deselected ${group.faces.length} face(s) from ${label}.`);
        } },
      ignoreBtn,
    ],
  });
}
