import { useEffect, useRef, useState } from "react";
import { NAV_ITEMS, isGroup, type NavLink } from "./navItems";

/* Top nav. Reuses theme.css's .nav-group / .button classes so ported and legacy
 * pages look identical. One dropdown open at a time; closes on outside click and
 * Escape. aria-expanded on the toggles (audit Y4). */

function Link({ item, active, inGroup }: { item: NavLink; active: string; inGroup?: boolean }) {
  const cls = ["button", inGroup ? "nav-group-item" : "", item.key === active ? "active" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <a className={cls} href={item.href} aria-current={item.key === active ? "page" : undefined}>
      {item.label}
    </a>
  );
}

export function NavBar({ active }: { active: string }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (openKey === null) return;
    const onClick = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenKey(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenKey(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openKey]);

  return (
    <nav className="toolbar-group" id="app-nav" ref={navRef} aria-label="Main">
      {NAV_ITEMS.map((item) => {
        if (!isGroup(item)) return <Link key={item.key} item={item} active={active} />;
        const groupActive = item.children.some((c) => c.key === active);
        const open = openKey === item.key;
        const menuId = `nav-menu-${item.key}`;
        return (
          <div key={item.key} className={`nav-group${open ? " open" : ""}`}>
            <button
              type="button"
              className={`button nav-group-toggle${groupActive ? " active" : ""}`}
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => setOpenKey(open ? null : item.key)}
            >
              {item.label} ▾
            </button>
            <div className="nav-group-menu" id={menuId}>
              {item.children.map((c) => (
                <Link key={c.key} item={c} active={active} inGroup />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
