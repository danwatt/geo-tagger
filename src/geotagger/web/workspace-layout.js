/* Resizable panes with keyboard-accessible dividers; shared by both pages. */
document.addEventListener("DOMContentLoaded", () => {
  const main = document.getElementById("main");
  const mapPane = document.getElementById("map-pane");
  const grid = document.getElementById("grid-pane");
  const preview = document.getElementById("detail-pane");
  const toggle = document.getElementById("preview-toggle");
  const panes = mapPane ? [mapPane, grid, preview] : [grid, preview];
  const defaultWeights = mapPane ? [30, 44, 26] : [70, 30];
  let weights = defaultWeights.slice();
  let previewVisible = true;
  const dividers = [];

  // ── Persisted layout ──
  // Pane widths and the preview toggle are a per-viewer convenience, so they
  // live in this browser's localStorage, one key per page (Geocode has the map
  // pane, Search doesn't). Versioned: a change to the pane set bumps the key
  // rather than misreading an old layout. Anything that doesn't validate —
  // wrong pane count, a pane under the 15 % floor the dividers enforce, a total
  // nowhere near 100 — falls back to the defaults.
  const layoutKey = `geotagger.workspace.${mapPane ? "geocode" : "search"}.v1`;
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) || "null");
    if (saved && Array.isArray(saved.weights) && saved.weights.length === weights.length &&
        saved.weights.every(w => Number.isFinite(w) && w >= 15 && w <= 100 - 15 * (weights.length - 1))) {
      const sum = saved.weights.reduce((a, b) => a + b, 0);
      if (sum > 90 && sum < 110) weights = saved.weights.map(w => w * 100 / sum);
    }
    if (saved && typeof saved.previewVisible === "boolean") previewVisible = saved.previewVisible;
  } catch (e) { /* storage blocked or junk — keep the defaults */ }
  let saveTimer = null;
  function saveLayout() {
    // Debounced: a divider drag calls layout() per pointer move.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(layoutKey, JSON.stringify({ weights, previewVisible }));
      } catch (e) { /* storage full/blocked — the layout just won't stick */ }
    }, 250);
  }
  main.classList.add("workspace-panes");
  function layout(persist = true) {
    if (persist) saveLayout();
    preview.hidden = !previewVisible;
    const visible = previewVisible ? panes.length : panes.length - 1;
    const columns = [];
    for (let i = 0; i < visible; i++) {
      if (i) columns.push("6px");
      columns.push(`minmax(0, ${weights[i]}fr)`);
    }
    main.style.gridTemplateColumns = columns.join(" ");
    dividers.forEach((d, i) => { d.hidden = i >= visible - 1; d.setAttribute("aria-valuenow", Math.round(weights[i])); });
    toggle.textContent = previewVisible ? "Hide preview" : "Show preview";
    toggle.setAttribute("aria-expanded", String(previewVisible));
    window.dispatchEvent(new Event("resize"));
  }
  panes.slice(0, -1).forEach((pane, i) => {
    const divider = document.createElement("div");
    divider.className = "pane-divider";
    divider.tabIndex = 0;
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-orientation", "vertical");
    divider.setAttribute("aria-label", i === 0 && mapPane ? "Resize map and photos" : "Resize photos and preview");
    divider.setAttribute("aria-valuemin", "15");
    divider.setAttribute("aria-valuemax", "85");
    pane.after(divider);
    dividers.push(divider);
    function adjust(delta) {
      const sum = weights[i] + weights[i + 1];
      weights[i] = Math.max(15, Math.min(sum - 15, weights[i] + delta));
      weights[i + 1] = sum - weights[i];
      layout();
    }
    divider.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); adjust(e.key === "ArrowLeft" ? -2 : 2);
      }
    });
    let previousX = null;
    divider.addEventListener("pointerdown", e => { previousX = e.clientX; divider.setPointerCapture(e.pointerId); });
    divider.addEventListener("pointermove", e => {
      if (previousX === null) return;
      const total = weights.slice(0, previewVisible ? panes.length : panes.length - 1).reduce((a, b) => a + b, 0);
      adjust((e.clientX - previousX) / main.clientWidth * total); previousX = e.clientX;
    });
    divider.addEventListener("pointerup", () => { previousX = null; });
    divider.addEventListener("lostpointercapture", () => { previousX = null; });
  });
  toggle.addEventListener("click", () => { previewVisible = !previewVisible; layout(); });
  layout(false);   // the initial paint of a restored layout needn't re-save it

  if (mapPane) {
    const actions = document.createElement("div");
    actions.id = "photo-selection-actions";
    actions.hidden = true;
    const count = document.createElement("span"); count.id = "workspace-selection-count";
    const buttons = ["tag-as-btn", "mark-ignored-btn", "remove-location-btn"]
      .map(id => document.getElementById(id));
    const oldGroups = buttons.map(button => button.parentElement);
    actions.append(count, ...buttons);
    oldGroups.forEach(group => { if (!group.children.length) group.remove(); });
    document.getElementById("grid-nav").after(actions);
  }
  const scope = document.getElementById("workspace-scope-text");
  // Both pages render the active range in the date picker's trigger; reuse that
  // text rather than re-deriving it from the bounds.
  function dateScopeText() {
    const value = document.querySelector("#date-range .drp-value");
    return value && !value.classList.contains("placeholder") ? value.textContent : "All dates";
  }
  function updateScope() {
    if (mapPane) {
      const area = document.getElementById("selected-area-label").textContent;
      const month = document.getElementById("selected-month-label").textContent;
      const bounds = !document.getElementById("place-buffer-select").hidden && document.getElementById("place-buffer-select").value === "0" ? "Within bounds" : "";
      scope.textContent = [area || (month !== "No month selected" ? month : "Choose a location or month"), bounds, dateScopeText()].filter(Boolean).join(" · ");
    } else {
      const location = document.getElementById("location-input").value.trim() || "All locations";
      const bounds = document.getElementById("nearby-field").hidden ? "" : document.getElementById("nearby-select").selectedOptions[0].text;
      scope.textContent = [location, bounds, dateScopeText()].filter(Boolean).join(" · ");
    }
  }
  if (mapPane) {
    const observer = new MutationObserver(updateScope);
    ["selected-area-label", "selected-month-label"].forEach(id => observer.observe(document.getElementById(id), { childList: true, subtree: true }));
    // The picker rewrites its trigger in place, and toggles .placeholder on it,
    // so watch attributes as well as the text.
    const picker = document.getElementById("date-range");
    if (picker) observer.observe(picker, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  } else {
    document.getElementById("search-form").addEventListener("input", updateScope);
    document.getElementById("search-form").addEventListener("change", updateScope);
    document.getElementById("search-form").addEventListener("click", () => queueMicrotask(updateScope));
    document.getElementById("search-form").addEventListener("keydown", () => queueMicrotask(updateScope));
  }
  updateScope();
});
