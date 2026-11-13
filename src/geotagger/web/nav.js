/* Shared top nav, rendered into <div id="app-nav" data-active="..."></div>.
   ITEMS entries are either a flat link ({key, label, href}) or a dropdown
   group ({key, label, children: [...]}). To add a page: add an ITEMS entry
   (top-level or inside a group's children) and set data-active on the new
   page's #app-nav div to its key. */
(function () {
  const ITEMS = [
    { key: "home", label: "🏠 Home", href: "/" },
    { key: "tag", label: "🏷 Tag", children: [
      { key: "geocode", label: "📍 Geocode", href: "/geocode.html" },
      { key: "people", label: "🙂 People", href: "/people.html" },
    ] },
    { key: "browse", label: "🔎 Browse", children: [
      { key: "search", label: "🔎 Search", href: "/search.html" },
      { key: "custom-places", label: "✏️ Named Places", href: "/custom-places.html" },
    ] },
    { key: "timesync", label: "🕐 Time Sync", href: "/timesync.html" },
    { key: "admin", label: "⚙ Admin", children: [
      { key: "data", label: "📦 Data", href: "/data.html" },
      { key: "map", label: "🌍 Geo Data", href: "/map.html" },
      { key: "representatives", label: "⭐ Representatives", href: "/representatives.html" },
      { key: "settings", label: "⚙ Settings", href: "/settings.html" },
    ] },
  ];

  const el = document.getElementById("app-nav");
  if (!el) return;
  const active = el.dataset.active;

  function linkHtml(item, extraCls) {
    const cls = ["button", extraCls, item.key === active ? "active" : ""].filter(Boolean).join(" ");
    return `<a class="${cls}" href="${item.href}">${item.label}</a>`;
  }

  el.innerHTML = ITEMS.map((item) => {
    if (!item.children) return linkHtml(item);
    const groupActive = item.children.some((c) => c.key === active);
    const toggleCls = ["button", "nav-group-toggle", groupActive ? "active" : ""].filter(Boolean).join(" ");
    const menu = item.children.map((c) => linkHtml(c, "nav-group-item")).join("");
    return `<div class="nav-group">
      <button type="button" class="${toggleCls}">${item.label} ▾</button>
      <div class="nav-group-menu">${menu}</div>
    </div>`;
  }).join("");

  el.querySelectorAll(".nav-group").forEach((group) => {
    const toggle = group.querySelector(".nav-group-toggle");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = group.classList.contains("open");
      el.querySelectorAll(".nav-group.open").forEach((g) => g.classList.remove("open"));
      if (!wasOpen) group.classList.add("open");
    });
  });
  document.addEventListener("click", () => {
    el.querySelectorAll(".nav-group.open").forEach((g) => g.classList.remove("open"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") el.querySelectorAll(".nav-group.open").forEach((g) => g.classList.remove("open"));
  });

  // ── Background-scan banner ──
  // The startup scan runs server-side after the app is already serving, so every
  // page shows its progress. One check on load; poll only while it's running.
  const POLL_MS = 2000;
  const banner = document.createElement("div");
  banner.id = "scan-banner";
  banner.hidden = true;
  const bannerText = document.createElement("span");
  const bannerClose = document.createElement("button");
  bannerClose.type = "button";
  bannerClose.className = "scan-banner-close";
  bannerClose.textContent = "✕";
  bannerClose.title = "Dismiss";
  banner.append(bannerText, bannerClose);
  // The nav lives inside the page's toolbar; sit the banner under the toolbar.
  const anchor = el.closest("#toolbar") || el;
  anchor.insertAdjacentElement("afterend", banner);

  let dismissedError = null;  // the error message the user already closed
  let sawRunning = false;     // this page watched a scan in progress
  let lastRunning = false;    // most recent successful poll said running
  bannerClose.addEventListener("click", () => {
    dismissedError = banner.dataset.error || null;
    sawRunning = false;
    banner.hidden = true;
  });

  function renderScan(s) {
    if (s.running) {
      sawRunning = true;
      banner.className = "scan-running";
      banner.dataset.error = "";
      bannerText.textContent = s.total > 0
        ? `Scanning library… ${s.processed.toLocaleString()} / ${s.total.toLocaleString()} files`
        : "Scanning library… counting files";
      bannerClose.hidden = true;
      banner.hidden = false;
    } else if (s.error && s.error !== dismissedError) {
      banner.className = "scan-error";
      banner.dataset.error = s.error;
      bannerText.textContent = `Library scan failed: ${s.error}`;  // textContent: server string
      bannerClose.hidden = false;
      banner.hidden = false;
    } else if (sawRunning) {
      // The page was loaded mid-scan, so what it shows predates the new photos.
      banner.className = "scan-running";
      banner.dataset.error = "";
      bannerText.textContent = s.warnings > 0
        ? `Library scan finished with ${s.warnings.toLocaleString()} warning(s) — see the server console. Reload to see new photos.`
        : "Library scan finished — reload to see new photos.";
      bannerClose.hidden = false;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  async function pollScan() {
    // Keep polling through a failed request while a scan was last seen running,
    // otherwise one dropped fetch would end the banner until the next page load.
    let running = lastRunning;
    try {
      const res = await fetch("/api/scan/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();
      renderScan(s);
      running = lastRunning = !!s.running;
    } catch (e) {
      // Transient (server restarting, etc.): leave the last progress showing.
    }
    if (running) setTimeout(pollScan, POLL_MS);
  }
  pollScan();
})();
