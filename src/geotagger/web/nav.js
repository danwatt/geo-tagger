/* Shared top nav, rendered into <div id="app-nav" data-active="..."></div>. */
(function () {
  const ITEMS = [
    { key: "home", label: "🏠 Home", href: "/" },
    { key: "geocode", label: "📍 Geocode", href: "/geocode.html" },
    { key: "quick-geocode", label: "⚡ Quick Geocode", href: "/quick-geocode.html" },
    { key: "timesync", label: "🕐 Time Sync", href: "/timesync.html" },
    { key: "people", label: "🙂 People", href: "/people.html" },
    { key: "contexts", label: "🗺️ Contexts", href: "/contexts.html" },
  ];

  const el = document.getElementById("app-nav");
  if (!el) return;
  const active = el.dataset.active;
  el.innerHTML = ITEMS.map((item) => {
    const cls = item.key === active ? "button active" : "button";
    return `<a class="${cls}" href="${item.href}">${item.label}</a>`;
  }).join("");
})();
