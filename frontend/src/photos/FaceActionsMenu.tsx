import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./FaceActionsMenu.css";

/* The per-face quick-action menu (confirm, unassign, not-this-person, assign
 * to…, ignore, come back later, open photo). Port of face-grid.js
 * openQuickActions as an ARIA menu: it opens next to its anchor, focus moves to
 * the first item, Up/Down cycle the items, Escape or a click outside closes it
 * and focus goes back to the anchor. The caller supplies the items. */

export type FaceMenuItem = { label: string; onSelect: () => void; danger?: boolean; primary?: boolean; title?: string };

export function FaceActionsMenu({ anchor, label, items, onClose }: {
  anchor: HTMLElement;
  label: string;
  items: FaceMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Below the anchor, flipped up / pulled left when it would leave the viewport.
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const m = ref.current?.getBoundingClientRect();
    const w = m?.width ?? 200, h = m?.height ?? 200;
    let left = Math.min(a.left, window.innerWidth - w - 8);
    let top = a.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4);
    left = Math.max(8, left);
    setPos({ left, top });
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchor]);

  function close() {
    onClose();
    if (anchor.isConnected) anchor.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
    } else if (e.key === "Tab") { close(); }
  }

  return (
    <div ref={ref} className="face-expand" role="menu" aria-label={label} onKeyDown={onKeyDown}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}>
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" title={it.title}
          className={`expand-btn${it.danger ? " danger" : ""}${it.primary ? " primary" : ""}`}
          onClick={() => { onClose(); it.onSelect(); }}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
