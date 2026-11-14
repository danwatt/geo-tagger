const GROUP_ORDER = ["RAW photos", "Face recognition", "Face clustering (Discover)", "Age-aware matching"];

async function loadSettings() {
  const container = document.getElementById("settings-groups");
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSettings(data.settings);
  } catch (e) {
    container.innerHTML = `<div class="setting-error">Error loading settings: ${escapeHtml(e.message)}</div>`;
  }
}

function renderSettings(settings) {
  const container = document.getElementById("settings-groups");
  container.innerHTML = "";
  const groups = {};
  settings.forEach((s) => {
    (groups[s.group] ||= []).push(s);
  });
  const groupNames = Object.keys(groups).sort(
    (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)
  );
  groupNames.forEach((groupName) => {
    const groupEl = document.createElement("div");
    groupEl.className = "settings-group";
    const h2 = document.createElement("h2");
    h2.textContent = groupName;
    groupEl.appendChild(h2);
    groups[groupName].forEach((spec) => groupEl.appendChild(renderRow(spec)));
    container.appendChild(groupEl);
  });
}

function renderRow(spec) {
  const row = document.createElement("div");
  row.className = "setting-row";
  row.dataset.key = spec.key;

  const labelWrap = document.createElement("div");
  labelWrap.className = "setting-label";
  const label = document.createElement("label");
  label.textContent = spec.label;
  label.htmlFor = `input-${spec.key}`;
  labelWrap.appendChild(label);

  const resetBtn = document.createElement("button");
  resetBtn.className = "reset-btn";
  resetBtn.textContent = "Reset to default";
  resetBtn.style.display = spec.overridden ? "" : "none";
  resetBtn.addEventListener("click", () => resetSetting(spec.key));
  labelWrap.appendChild(resetBtn);
  row.appendChild(labelWrap);

  const help = document.createElement("div");
  help.className = "setting-help";
  help.textContent = `${spec.help} (default: ${spec.default})`;
  row.appendChild(help);

  const controlWrap = document.createElement("div");
  controlWrap.className = "setting-control";
  const input = document.createElement("input");
  input.id = `input-${spec.key}`;
  if (spec.type === "bool") {
    input.type = "checkbox";
    input.checked = !!spec.value;
  } else {
    input.type = "number";
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;
    input.value = spec.value;
  }
  input.addEventListener("change", () => saveSetting(spec.key, input));
  controlWrap.appendChild(input);

  const flash = document.createElement("span");
  flash.className = "setting-saved-flash";
  flash.textContent = "Saved";
  controlWrap.appendChild(flash);

  row.appendChild(controlWrap);
  return row;
}

function rowError(row, message) {
  let errorEl = row.querySelector(".setting-error");
  if (!message) {
    if (errorEl) errorEl.remove();
    return;
  }
  if (!errorEl) {
    errorEl = document.createElement("div");
    errorEl.className = "setting-error";
    row.appendChild(errorEl);
  }
  errorEl.textContent = message;
}

async function saveSetting(key, input) {
  const row = input.closest(".setting-row");
  const flash = row.querySelector(".setting-saved-flash");
  const value =
    input.type === "checkbox" ? (input.checked ? 1 : 0) : parseFloat(input.value);
  try {
    // fetchJson checks res.ok before parsing: a non-JSON error body (500) or a
    // 422's list-shaped detail still becomes one readable line.
    const data = await fetchJson("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { [key]: value } }),
    });
    rowError(row, null);
    if (input.type === "checkbox") input.checked = !!data.updated[key];
    else input.value = data.updated[key];
    flash.classList.add("show");
    setTimeout(() => flash.classList.remove("show"), 1200);
    row.querySelector(".reset-btn").style.display = "";
  } catch (e) {
    rowError(row, e.message);
  }
}

async function resetSetting(key) {
  const row = document.querySelector(`.setting-row[data-key="${key}"]`);
  try {
    const res = await fetch("/api/settings/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: [key] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadSettings();
  } catch (e) {
    if (row) rowError(row, e.message);
  }
}

loadSettings();
