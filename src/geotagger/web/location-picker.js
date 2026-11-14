/* Shared saved-place and photo-metadata autocomplete. */
function createLocationPicker({ input, box, onSelect, onEdit, emptyMessage, errorMessage }) {
  let matches = [], active = -1, timer;
  function close() {
    suggest.cancel();   // a reply still in flight must not reopen the box
    clearTimeout(timer);
    box.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function choose(i) {
    const item = matches[i];
    input.value = item.label;
    close();
    onSelect(item);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Latest-only (common.js): each keystroke's reply supersedes the last.
  const suggest = latestOnly(async (signal) => {
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
    matches = []; active = -1;
    box.textContent = "Loading locations…";
    try {
      const res = await fetch(`/api/search/locations?q=${encodeURIComponent(input.value.trim())}`,
                              { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (signal.aborted) return;
      matches = data.locations;
      box.innerHTML = "";
      if (!matches.length) box.textContent = emptyMessage;
      matches.forEach((item, i) => {
        const option = document.createElement("div");
        option.id = `${box.id}-option-${i}`;
        option.className = "location-option";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        const label = document.createElement("strong");
        label.textContent = item.label;
        const detail = document.createElement("span");
        detail.textContent = item.kind === "place" ? "Saved place · GPS boundary"
          : `Photo location · ${item.level} · ${item.count.toLocaleString()} photos`;
        option.append(label, detail);
        option.addEventListener("mousedown", e => e.preventDefault());
        option.addEventListener("click", () => choose(i));
        box.appendChild(option);
      });
    } catch (e) {
      if (signal.aborted) return;
      box.textContent = errorMessage;
    }
  });
  input.addEventListener("focus", () => suggest());
  input.addEventListener("input", () => {
    close();
    onEdit();
    timer = setTimeout(() => suggest(), 180);
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { close(); e.stopPropagation(); }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !box.hidden && matches.length) {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      [...box.children].forEach((el, i) => el.setAttribute("aria-selected", String(i === active)));
      input.setAttribute("aria-activedescendant", `${box.id}-option-${active}`);
      box.children[active].scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter" && !box.hidden && active >= 0) {
      e.preventDefault(); e.stopPropagation(); choose(active);
    }
  });
  return { close };
}
