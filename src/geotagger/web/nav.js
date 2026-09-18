/* Shared top nav, rendered into <div id="app-nav" data-active="..."></div>. */
(function () {
  // Quick Geocode (/quick-geocode.html) is deliberately absent: the Home work
  // queue plus Geocode's batch mode replace it. The page still answers by URL
  // for one release — see docs/work-queue.md §6.3 for what goes when it drops.
  const ITEMS = [
    { key: "home", label: "🏠 Home", href: "/" },
    { key: "search", label: "🔎 Search", href: "/search.html" },
    { key: "geocode", label: "📍 Geocode", href: "/geocode.html" },
    { key: "custom-places", label: "✏️ Named Places", href: "/custom-places.html" },
    { key: "timesync", label: "🕐 Time Sync", href: "/timesync.html" },
    { key: "people", label: "🙂 People", href: "/people.html" },
    { key: "representatives", label: "⭐ Representatives", href: "/representatives.html" },
    { key: "map", label: "🌍 Geo Data", href: "/map.html" },
    { key: "data", label: "📦 Data", href: "/data.html" },
    { key: "settings", label: "⚙ Settings", href: "/settings.html" },
  ];

  const el = document.getElementById("app-nav");
  if (!el) return;
  const active = el.dataset.active;
  el.innerHTML = ITEMS.map((item) => {
    const cls = item.key === active ? "button active" : "button";
    return `<a class="${cls}" href="${item.href}">${item.label}</a>`;
  }).join("");
})();

