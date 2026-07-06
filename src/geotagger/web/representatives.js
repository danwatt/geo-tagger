/* Representative Faces review page: pick a person, see each kept representative
 * face grouped with the other labeled faces closest to it (see
 * faces.get_representative_groups / the "Representative faces" settings group). */

let persons = [];
let selectedPersonId = null;

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.className = isError ? "error" : "";
}

async function loadPersons() {
  try {
    const res = await fetch("/api/faces/dedup/persons");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    persons = await res.json();
    renderPersonList();
  } catch (e) {
    setStatus("Failed to load people: " + e.message, true);
  }
}

function renderPersonList() {
  const list = document.getElementById("person-list");
  list.innerHTML = "";
  if (!persons.length) {
    const hint = document.createElement("div");
    hint.id = "no-persons-hint";
    hint.textContent = "No one has representative faces yet — click “Recompute representatives” above (only applies to people with enough labeled faces; see Settings).";
    list.appendChild(hint);
    return;
  }
  persons.forEach((p) => {
    const item = document.createElement("div");
    item.className = "person-item" + (p.person_id === selectedPersonId ? " selected" : "");
    const name = document.createElement("span");
    name.className = "person-item-name";
    name.textContent = p.name;
    const count = document.createElement("span");
    count.className = "person-item-count";
    count.textContent = `${p.representative} / ${p.total}`;
    item.appendChild(name);
    item.appendChild(count);
    item.addEventListener("click", () => selectPerson(p.person_id));
    list.appendChild(item);
  });
}

async function selectPerson(personId) {
  selectedPersonId = personId;
  renderPersonList();
  document.getElementById("groups-empty").style.display = "none";
  const grid = document.getElementById("groups-grid");
  grid.innerHTML = "";
  setStatus("Loading groups…");
  try {
    const res = await fetch(`/api/faces/dedup/groups?person_id=${personId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderGroups(data.groups, data.total);
  } catch (e) {
    setStatus("Failed to load groups: " + e.message, true);
  }
}

function renderGroups(groups, total) {
  const grid = document.getElementById("groups-grid");
  grid.innerHTML = "";
  if (!groups.length) {
    setStatus("No representative groups for this person yet — try Recompute.");
    return;
  }
  groups.forEach((g) => grid.appendChild(makeGroupCard(g)));
  const shown = groups.reduce((sum, g) => sum + 1 + g.others.length, 0);
  setStatus(`${groups.length} group(s), ${shown} of ${total} face(s) shown.`);
}

function makeGroupCard(g) {
  const card = document.createElement("div");
  card.className = "rep-group-card";

  card.appendChild(faceGroupHeader({
    title: `Group of ${g.size}`,
    meta: g.others.length < g.size - 1 ? `· showing ${g.others.length + 1}` : "",
  }));

  const wrap = document.createElement("div");
  wrap.className = "rep-group-faces";

  const repWrap = document.createElement("div");
  repWrap.className = "rep-face-wrap";
  repWrap.appendChild(faceCropImg(g.representative, { title: "Representative" }));
  const badge = document.createElement("span");
  badge.className = "rep-face-badge";
  badge.textContent = "★";
  repWrap.appendChild(badge);
  wrap.appendChild(repWrap);

  g.others.forEach((f) => wrap.appendChild(faceCropImg(f, { title: f.filename })));

  const shownCount = 1 + g.others.length;
  if (g.size > shownCount) {
    const more = document.createElement("span");
    more.className = "rep-group-more";
    more.textContent = `+${g.size - shownCount} more`;
    wrap.appendChild(more);
  }

  card.appendChild(wrap);
  return card;
}

async function runRecompute() {
  const btn = document.getElementById("recompute-btn");
  btn.disabled = true;
  btn.textContent = "Recomputing…";
  setStatus("Recomputing representative faces…");
  try {
    const res = await fetch("/api/faces/dedup/recompute", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const totalFaces = data.persons.reduce((sum, p) => sum + p.total, 0);
    const totalReps = data.persons.reduce((sum, p) => sum + p.representative, 0);
    setStatus(data.persons.length
      ? `${data.persons.length} people processed: ${totalFaces.toLocaleString()} labeled faces -> ${totalReps.toLocaleString()} representatives.`
      : "No one has enough labeled faces yet (see Settings for the threshold).");
    await loadPersons();
    if (selectedPersonId !== null) await selectPerson(selectedPersonId);
  } catch (e) {
    setStatus("Recompute failed: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Recompute representatives";
  }
}

document.getElementById("recompute-btn").addEventListener("click", runRecompute);
loadPersons();
