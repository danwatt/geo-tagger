/* People Manager — edit names, birth dates, and family groups in one list. */

let persons = [];
let families = [];

const el = (id) => document.getElementById(id);

let toastTimer;
function toast(msg, isErr = false) {
  const t = el("toast");
  t.textContent = msg;
  t.className = isErr ? "err" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ── Init ── */
document.addEventListener("DOMContentLoaded", async () => {
  el("person-search").addEventListener("input", renderPersons);
  el("family-filter-sel").addEventListener("change", renderPersons);
  el("add-family-btn").addEventListener("click", promptAddFamily);
  el("add-person-btn").addEventListener("click", promptAddPerson);
  await reload();
});

async function reload() {
  try {
    [persons, families] = await Promise.all([
      api("GET", "/api/persons"),
      api("GET", "/api/families"),
    ]);
  } catch (e) {
    toast("Failed to load: " + e.message, true);
    return;
  }
  renderFamilies();
  renderPersons();
  el("manage-counts").textContent =
    `${persons.length} people · ${families.length} families`;
}

/* ── Families ── */
function renderFamilies() {
  const container = el("family-chips");
  container.innerHTML = "";

  // Rebuild the family filter dropdown (keep first two options: All / No family)
  const sel = el("family-filter-sel");
  while (sel.options.length > 2) sel.remove(2);
  families.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    sel.appendChild(opt);
  });

  if (!families.length) {
    container.innerHTML = '<span class="no-families-hint">No families yet — add one to group people.</span>';
    return;
  }

  families.forEach((f) => {
    const chip = document.createElement("div");
    chip.className = "family-chip";

    const nameSpan = document.createElement("span");
    nameSpan.className = "family-name";
    nameSpan.textContent = f.name;
    nameSpan.title = "Click to rename";
    nameSpan.addEventListener("click", () => startRenameFamily(chip, f));

    const countSpan = document.createElement("span");
    countSpan.className = "family-count";
    countSpan.textContent = f.person_count;
    countSpan.title = `${f.person_count} people`;

    const delBtn = document.createElement("button");
    delBtn.className = "family-del";
    delBtn.textContent = "✕";
    delBtn.title = "Delete family";
    delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteFamily(f); });

    chip.appendChild(nameSpan);
    chip.appendChild(countSpan);
    chip.appendChild(delBtn);
    container.appendChild(chip);
  });
}

function startRenameFamily(chip, f) {
  const nameSpan = chip.querySelector(".family-name");
  const input = document.createElement("input");
  input.className = "family-rename-input";
  input.value = f.name;
  let saved = false;

  const save = async () => {
    if (saved) return;
    saved = true;
    const name = input.value.trim();
    if (name && name !== f.name) {
      try {
        await api("PATCH", `/api/families/${f.id}`, { name });
        toast(`Family renamed to "${name}"`);
      } catch (e) {
        toast("Rename failed: " + e.message, true);
      }
    }
    await reload();
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { saved = true; reload(); }
  });

  nameSpan.replaceWith(input);
  input.select();
}

async function deleteFamily(f) {
  const msg = f.person_count > 0
    ? `Delete family "${f.name}"? Its ${f.person_count} member(s) will become unassigned.`
    : `Delete family "${f.name}"?`;
  if (!confirm(msg)) return;
  try {
    await api("DELETE", `/api/families/${f.id}`);
    toast(`Deleted family "${f.name}"`);
    await reload();
  } catch (e) {
    toast("Delete failed: " + e.message, true);
  }
}

async function promptAddFamily() {
  const name = prompt("New family name:")?.trim();
  if (!name) return;
  try {
    await api("POST", "/api/families", { name });
    toast(`Family "${name}" created`);
    await reload();
  } catch (e) {
    toast("Create failed: " + e.message, true);
  }
}

/* ── Persons ── */
function filteredPersons() {
  const q = el("person-search").value.trim().toLowerCase();
  const fid = el("family-filter-sel").value;
  return persons.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (fid === "__none__") return !p.family_id;
    if (fid) return String(p.family_id) === fid;
    return true;
  });
}

function renderPersons() {
  const rows = filteredPersons();
  el("persons-count").textContent = `${rows.length} of ${persons.length}`;
  el("no-persons").hidden = rows.length > 0;

  const tbody = el("persons-body");
  tbody.innerHTML = "";
  rows.forEach((p) => tbody.appendChild(makePersonRow(p)));
}

function makePersonRow(p) {
  const tr = document.createElement("tr");

  // ── Name ──
  const nameTd = document.createElement("td");
  nameTd.className = "col-name";
  const nameInput = document.createElement("input");
  nameInput.className = "edit-input";
  nameInput.value = p.name;
  let origName = p.name;
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
    if (e.key === "Escape") { nameInput.value = origName; nameInput.blur(); }
  });
  nameInput.addEventListener("blur", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.value = origName; return; }
    if (name === origName) return;
    try {
      await api("PATCH", `/api/persons/${p.id}`, { name });
      origName = name;
      p.name = name;
      toast(`Renamed to "${name}"`);
    } catch (e) {
      nameInput.value = origName;
      toast("Rename failed: " + e.message, true);
    }
  });
  nameTd.appendChild(nameInput);

  // ── Birth date ──
  const birthTd = document.createElement("td");
  birthTd.className = "col-birth";
  const birthInput = document.createElement("input");
  birthInput.type = "date";
  birthInput.className = "edit-input";
  birthInput.value = p.birth_date || "";
  birthInput.title = "YYYY-MM-DD";
  birthInput.addEventListener("change", async () => {
    const birth_date = birthInput.value || null;
    try {
      await api("PATCH", `/api/persons/${p.id}`, { birth_date });
      p.birth_date = birth_date;
      toast(birth_date ? `Birth date set` : `Birth date cleared`);
    } catch (e) {
      birthInput.value = p.birth_date || "";
      toast("Save failed: " + e.message, true);
    }
  });
  birthTd.appendChild(birthInput);

  // ── Not before / Not after ──
  const notBeforeTd = document.createElement("td");
  notBeforeTd.className = "col-not-before";
  const notBeforeInput = document.createElement("input");
  notBeforeInput.type = "date";
  notBeforeInput.className = "edit-input";
  notBeforeInput.value = p.not_before || "";
  notBeforeInput.title = "No photos of this person before this date (YYYY-MM-DD)";
  notBeforeInput.addEventListener("change", async () => {
    const not_before = notBeforeInput.value || null;
    try {
      await api("PATCH", `/api/persons/${p.id}`, { not_before });
      p.not_before = not_before;
      toast(not_before ? `Not-before date set` : `Not-before date cleared`);
    } catch (e) {
      notBeforeInput.value = p.not_before || "";
      toast("Save failed: " + e.message, true);
    }
  });
  notBeforeTd.appendChild(notBeforeInput);

  const notAfterTd = document.createElement("td");
  notAfterTd.className = "col-not-after";
  const notAfterInput = document.createElement("input");
  notAfterInput.type = "date";
  notAfterInput.className = "edit-input";
  notAfterInput.value = p.not_after || "";
  notAfterInput.title = "No photos of this person after this date (YYYY-MM-DD)";
  notAfterInput.addEventListener("change", async () => {
    const not_after = notAfterInput.value || null;
    try {
      await api("PATCH", `/api/persons/${p.id}`, { not_after });
      p.not_after = not_after;
      toast(not_after ? `Not-after date set` : `Not-after date cleared`);
    } catch (e) {
      notAfterInput.value = p.not_after || "";
      toast("Save failed: " + e.message, true);
    }
  });
  notAfterTd.appendChild(notAfterInput);

  // ── Family ──
  const familyTd = document.createElement("td");
  familyTd.className = "col-family";
  const familySel = document.createElement("select");
  familySel.className = "family-sel";
  const noOpt = document.createElement("option");
  noOpt.value = "";
  noOpt.textContent = "— No family —";
  familySel.appendChild(noOpt);
  families.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    familySel.appendChild(opt);
  });
  familySel.value = p.family_id != null ? String(p.family_id) : "";
  familySel.addEventListener("change", async () => {
    const family_id = familySel.value ? parseInt(familySel.value, 10) : null;
    try {
      await api("PATCH", `/api/persons/${p.id}`, { family_id });
      p.family_id = family_id;
      // Refresh family member counts silently
      families = await api("GET", "/api/families");
      renderFamilies();
    } catch (e) {
      familySel.value = p.family_id != null ? String(p.family_id) : "";
      toast("Save failed: " + e.message, true);
    }
  });
  familyTd.appendChild(familySel);

  // ── Faces count ──
  const facesTd = document.createElement("td");
  facesTd.className = "col-faces";
  facesTd.textContent = p.face_count ?? "—";

  // ── Delete ──
  const actTd = document.createElement("td");
  actTd.className = "col-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "del-btn";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => deletePerson(p));
  actTd.appendChild(delBtn);

  tr.append(nameTd, birthTd, notBeforeTd, notAfterTd, familyTd, facesTd, actTd);
  return tr;
}

async function deletePerson(p) {
  const msg = p.face_count > 0
    ? `Delete "${p.name}"? Their ${p.face_count} tagged face(s) will be unassigned.`
    : `Delete "${p.name}"?`;
  if (!confirm(msg)) return;
  try {
    await api("DELETE", `/api/persons/${p.id}`);
    toast(`Deleted "${p.name}"`);
    await reload();
  } catch (e) {
    toast("Delete failed: " + e.message, true);
  }
}

async function promptAddPerson() {
  const name = prompt("New person name:")?.trim();
  if (!name) return;
  try {
    await api("POST", "/api/persons", { name });
    toast(`"${name}" added`);
    await reload();
  } catch (e) {
    toast("Create failed: " + e.message, true);
  }
}
