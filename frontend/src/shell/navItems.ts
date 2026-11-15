/* Top nav entries (ported from the legacy web/nav.js ITEMS, which no page
 * loads any more). A flat entry is a link; an entry with children is a
 * dropdown group. */

export type NavLink = { key: string; label: string; href: string };
export type NavGroup = { key: string; label: string; children: NavLink[] };
export type NavItem = NavLink | NavGroup;

export const NAV_ITEMS: NavItem[] = [
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

export function isGroup(item: NavItem): item is NavGroup {
  return "children" in item;
}
