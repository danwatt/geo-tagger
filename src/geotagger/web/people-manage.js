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
    // FastAPI errors are {"detail": "..."} — show just the message.
    const e = await res.json().catch(() => ({}));
    throw new Error(typeof e.detail === "string" ? e.detail : `HTTP ${res.status}`);
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
      // face_counts is opt-in on the server (the People page skips it for speed).
      api("GET", "/api/persons?face_counts=true"),
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

// <input type="date"> fires `change` on every keystroke that leaves a complete
// date, so typing the year 2019 saved 0002, 0020 and 0201 on the way — and
// blanking one segment mid-edit fires it with value "", which saved a clear.
// Save once typing pauses (or at once on blur), and only a plausible complete
// date or a deliberately emptied field; a half-typed one reverts on blur.
const DATE_SAVE_DEBOUNCE_MS = 1000;

function wireDateSave(input, p, field, label) {
  let timer = null;
  const saved = () => p[field] || "";

  async function flush(final) {
    clearTimeout(timer);
    timer = null;
    const v = input.value;
    // badInput: some segments filled, some not (value reads "").
    // A year below 1000 is a 4-digit year still being typed.
    const incomplete = input.validity.badInput || (v && Number(v.slice(0, 4)) < 1000);
    if (incomplete) {
      if (final) {
        input.value = saved();
        toast(`${label} not saved — enter a full date (YYYY-MM-DD).`, true);
      }
      return;
    }
    if (v === saved()) return;
    const value = v || null;
    try {
      await api("PATCH", `/api/persons/${p.id}`, { [field]: value });
      p[field] = value;
      toast(value ? `${label} set` : `${label} cleared`);
    } catch (e) {
      input.value = saved();
      toast("Save failed: " + e.message, true);
    }
  }

  input.addEventListener("change", () => {
    clearTimeout(timer);
    timer = setTimeout(() => flush(false), DATE_SAVE_DEBOUNCE_MS);
  });
  input.addEventListener("blur", () => flush(true));
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
  wireDateSave(birthInput, p, "birth_date", "Birth date");
  birthTd.appendChild(birthInput);

  // ── Not before / Not after ──
  const notBeforeTd = document.createElement("td");
  notBeforeTd.className = "col-not-before";
  const notBeforeInput = document.createElement("input");
  notBeforeInput.type = "date";
  notBeforeInput.className = "edit-input";
  notBeforeInput.value = p.not_before || "";
  notBeforeInput.title = "No photos of this person before this date (YYYY-MM-DD)";
  wireDateSave(notBeforeInput, p, "not_before", "Not-before date");
  notBeforeTd.appendChild(notBeforeInput);

  const notAfterTd = document.createElement("td");
  notAfterTd.className = "col-not-after";
  const notAfterInput = document.createElement("input");
  notAfterInput.type = "date";
  notAfterInput.className = "edit-input";
  notAfterInput.value = p.not_after || "";
  notAfterInput.title = "No photos of this person after this date (YYYY-MM-DD)";
  wireDateSave(notAfterInput, p, "not_after", "Not-after date");
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
  // Re-read the count at click time: the list may have been loaded long before
  // faces were tagged on the People page in another tab, and understating how
  // many labels a delete throws away is the one thing this confirm must not do.
  let count = p.face_count;
  try {
    const fresh = (await api("GET", "/api/persons?face_counts=true")).find((q) => q.id === p.id);
    if (!fresh) {
      toast(`"${p.name}" no longer exists`, true);
      await reload();
      return;
    }
    count = fresh.face_count;
    // Keep the Faces column honest if the user cancels.
    if (count !== p.face_count) { p.face_count = count; renderPersons(); }
  } catch (e) {
    toast("Could not check face count: " + e.message, true);
    return;
  }
  const msg = count > 0
    ? `Delete "${p.name}"? ${count} tagged face${count === 1 ? "" : "s"} will become unlabeled.`
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
