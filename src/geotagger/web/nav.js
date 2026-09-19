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
})();
