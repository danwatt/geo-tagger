/* people-list.js — People page: the left-hand people list, scope selection,
 * and person CRUD (add / edit birth / delete). */

/* ── People list ── */
// Latest-only (common.js): it runs after every mutation and on each Focus change,
// often overlapping itself (e.g. Promise.all with loadFaces), and an older
// response must not repaint the list with stale counts or the wrong highlight.
const loadPersons = latestOnly(async (signal) => {
  try {
    const q = focusActive() ? "?" + focusQuery() : "";
    // `persons` stays the FULL list — it feeds the Assign dropdowns, quick-action
    // menu and name lookups, so you can still tag someone who has no faces in the
    // window yet. The left nav renders `navPersons`, which is windowed when a Focus
    // is active (only in-range people, with in-range counts).
    // Both must succeed before anything is assigned: on a 4xx/5xx the previous
    // `persons` / list stay as they were (an error body here would replace the
    // array with {detail} and break every .find/.map over it).
    const [allPersons, status] = await Promise.all([
      fetchJson("/api/persons", { signal }),
      fetchJson("/api/faces/scan/status" + q, { signal }),
    ]);
    if (!Array.isArray(allPersons)) throw new Error("unexpected /api/persons reply");
    let nav = allPersons;
    if (focusActive()) {
      const navRes = await fetch("/api/persons" + q, { signal });
      if (navRes.ok) nav = await navRes.json();
    }
    if (signal.aborted) return;
    persons = allPersons;
    navPersons = nav;

    const totalFaces = status.total_faces || 0;
    renderPeopleList(status.unlabeled_faces || 0, totalFaces,
                     status.ignored_faces || 0, status.come_back_faces || 0,
                     status.tagged_faces || 0);
    populatePersonSelects();
  } catch (err) {
    if (signal.aborted) return;
    setStatus("Failed to load people: " + err.message, true);
  }
});

function renderPeopleList(unlabeledCount, allCount, ignoredCount, comeBackCount, taggedCount) {
  const list = document.getElementById("people-list");
  list.innerHTML = "";

  list.appendChild(makeScopeItem("Unlabeled", unlabeledCount, "unlabeled", null));
  list.appendChild(makeScopeItem("Discover groups", null, "discover", null));
  list.appendChild(makeScopeItem("Crowds", null, "crowds", null));
  list.appendChild(makeScopeItem("Recently tagged", taggedCount, "recent", null));
  list.appendChild(makeScopeItem("All faces", allCount, "all", null));
  list.appendChild(makeScopeItem("Ignored", ignoredCount, "ignored", null));
  list.appendChild(makeScopeItem("Come Back", comeBackCount, "come_back", null));

  const sep = document.createElement("div");
  sep.className = "people-sep";
  list.appendChild(sep);

  if (navPersons.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:#666;padding:8px;font-size:11px;";
    empty.textContent = focusActive()
      ? "No tagged people in this time window. Widen the Focus, or tag faces in the Unlabeled queue."
      : "No people yet. Assign a face to create one.";
    list.appendChild(empty);
    return;
  }

  // Group by family; persons without a family go last.
  const familyMap = new Map(); // family_id -> { name, persons[] }
  const noFamily = [];
  navPersons.forEach((p) => {
    if (p.family_id) {
      if (!familyMap.has(p.family_id)) {
        familyMap.set(p.family_id, { name: p.family_name, persons: [] });
      }
      familyMap.get(p.family_id).persons.push(p);
    } else {
      noFamily.push(p);
    }
  });

  const sortedFamilies = [...familyMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const hasFamilies = sortedFamilies.length > 0;

  sortedFamilies.forEach((fam) => {
    list.appendChild(makeFamilyHeader(fam.name));
    fam.persons.forEach((p) => list.appendChild(makePersonItem(p)));
  });

  if (noFamily.length > 0) {
    // Only show the "Other" label when there are also family groups.
    if (hasFamilies) list.appendChild(makeFamilyHeader("Other"));
    noFamily.forEach((p) => list.appendChild(makePersonItem(p)));
  }
}

function makeFamilyHeader(name) {
  const hdr = document.createElement("div");
  hdr.className = "family-group-header";
  hdr.textContent = name;
  return hdr;
}

function makePersonItem(p) {
  const item = makeScopeItem(p.name, p.face_count, "person", p.id);
  if (p.birth_date) {
    const b = document.createElement("span");
    b.className = "person-birth";
    b.textContent = ` b.${p.birth_date.slice(0, 4)}`;
    item.querySelector(".person-name").appendChild(b);
  }
  const edit = document.createElement("span");
  edit.className = "person-edit";
  edit.textContent = "✎";
  edit.title = `Set birth date for ${p.name} (improves age-aware suggestions)`;
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    editPersonBirth(p.id, p.name, p.birth_date);
  });
  const del = document.createElement("span");
  del.className = "person-del";
  del.textContent = "×";
  del.title = `Delete ${p.name}`;
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deletePerson(p.id, p.name);
  });
  item.appendChild(edit);
  item.appendChild(del);
  return item;
}

function makeScopeItem(name, count, itemScope, personId) {
  const item = document.createElement("div");
  const isActive = itemScope === scope &&
    (itemScope !== "person" || personId === scopePersonId);
  item.className = "person-item" + (isActive ? " active" : "");

  const nameEl = document.createElement("span");
  nameEl.className = "person-name";
  nameEl.textContent = name;
  item.appendChild(nameEl);

  if (count !== null && count !== undefined && count !== "") {
    const countEl = document.createElement("span");
    countEl.className = "person-count";
    countEl.textContent = count;
    item.appendChild(countEl);
  }

  item.addEventListener("click", () => selectScope(itemScope, personId));
  return item;
}

function populatePersonSelects() {
  ["guess-person-select"].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">Choose person…</option>';
    persons.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.value = prev;
  });
}


/* ── Scope selection ── */
async function selectScope(newScope, personId) {
  scope = newScope;
  scopePersonId = personId;
  selectedIds.clear();
  resetPreselection();            // a new visit pre-selects afresh; reloads within it don't
  lastClickedIndex = -1;
  focusedFaceId = null;
  suggestFilterPersonId = null;   // the queue filter is per-visit to the Unlabeled scope
  await loadFaces();
  await loadPersons();  // re-renders the list with the correct active highlight
}

// Show the right sub-bar in the sticky #grid-nav for the current scope (and hide
// the whole bar for scopes that have no controls, e.g. Discover/All/Ignored).
function updateGridNavVisibility() {
  const showPerson = scope === "person" || scope === "suggested";
  const showCrowds = scope === "crowds";
  const showUnlabeled = scope === "unlabeled";
  // The selection-action bar applies to any grid of selectable faces — every scope
  // except Discover/Crowds, which render cluster/photo cards with their own buttons.
  const showSelection = scope !== "discover" && scope !== "crowds";
  // Sort applies to the group-rendering grids only. The Unlabeled queue's
  // person-first hierarchy orders its own groups by person name, so it opts out
  // (date, photo and directory hierarchies all sort their groups).
  const showSort = scope === "discover" || scope === "crowds" || scope === "suggested" ||
    (scope === "unlabeled" && unlabeledHierarchy !== "person");
  document.getElementById("grid-nav-person").style.display = showPerson ? "" : "none";
  document.getElementById("grid-nav-crowds").style.display = showCrowds ? "" : "none";
  document.getElementById("grid-nav-unlabeled").style.display = showUnlabeled ? "" : "none";
  // "Group by" only drives the Unlabeled queue's render — every other scope has
  // its own fixed grouping, so the dropdown would be a dead control there.
  document.getElementById("grid-nav-hierarchy").style.display = showUnlabeled ? "" : "none";
  document.getElementById("grid-nav-selection").style.display = showSelection ? "" : "none";
  if (showSelection) paintSelectionCount();
  document.getElementById("grid-nav-sort").style.display = showSort ? "" : "none";
  document.getElementById("grid-nav").style.display =
    (showPerson || showCrowds || showUnlabeled || showSelection || showSort) ? "" : "none";
}

/* ── Person CRUD ── */
async function addPerson() {
  const name = prompt("New person's name:");
  if (!name || !name.trim()) return;
  try {
    const res = await fetch("/api/persons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${res.status}`);
    }
    await loadPersons();
  } catch (err) {
    setStatus("Could not add person: " + err.message, true);
  }
}

async function editPersonBirth(personId, name, current) {
  const val = prompt(`Birth date for ${name} (YYYY-MM-DD), or blank to clear:`, current || "");
  if (val === null) return;  // cancelled
  const birth = val.trim() || null;
  try {
    const res = await fetch(`/api/persons/${personId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ birth_date: birth }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${res.status}`);
    }
    setStatus(birth ? `Set ${name}'s birth date to ${birth}.` : `Cleared ${name}'s birth date.`);
    await loadPersons();
    // Suggestions depend on birth dates, so refresh the current view.
    if (scope === "unlabeled" || scope === "suggested") await loadFaces();
  } catch (err) {
    setStatus("Could not set birth date: " + err.message, true);
  }
}

async function deletePerson(personId, name) {
  if (!confirm(`Delete "${name}"? Their faces will become unassigned.`)) return;
  try {
    const res = await fetch(`/api/persons/${personId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Staged assignments to this person can no longer be committed (the server
    // 404s an unknown person) — put those faces back in the grid.
    const orphaned = [];
    pending.forEach((e, id) => {
      if (e.kind === "assign" && e.personId === personId) orphaned.push(id);
    });
    unstageFaces(orphaned, true);
    if (scope === "person" && scopePersonId === personId) {
      scope = "unlabeled"; scopePersonId = null;
      selectedIds.clear();
      resetPreselection();
    }
    await loadPersons();
    await loadFaces();
  } catch (err) {
    setStatus("Could not delete person: " + err.message, true);
  }
}
