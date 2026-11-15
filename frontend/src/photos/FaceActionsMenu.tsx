import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./FaceActionsMenu.css";

/* The per-face quick-action menu (confirm, unassign, not-this-person, assign
 * to…, ignore, come back later, open photo). Port of face-grid.js
 * openQuickActions as an ARIA menu: it opens next to its anchor, focus moves to
 * the first item, Up/Down cycle the items, Escape or a click outside closes it
 * and focus goes back to the anchor. The caller supplies the items. */

export type FaceMenuItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  primary?: boolean;
  title?: string;
  /** Shown but inert: the action exists, this target just can't take it. */
  disabled?: boolean;
};

export function FaceActionsMenu({ anchor, label, items, onClose, point, heading, sheet }: {
  anchor: HTMLElement;
  label: string;
  items: FaceMenuItem[];
  onClose: () => void;
  /** Open at this viewport point (a right-click) instead of under the anchor;
   *  the anchor still gets focus back on close. */
  point?: { x: number; y: number };
  /** A non-interactive first line naming the target (Geocode's photo menu). */
  heading?: string;
  /** Bottom sheet over a backdrop instead of a popup (narrow / touch screens:
   *  Quick Tag on a phone). Same items, larger tap targets. */
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Below the anchor (or at the point), flipped up / pulled left when it would
  // leave the viewport.
  const px = point?.x, py = point?.y;
  useLayoutEffect(() => {
    if (sheet) {
      ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
      return;
    }
    const m = ref.current?.getBoundingClientRect();
    const w = m?.width ?? 200, h = m?.height ?? 200;
    let left: number, top: number;
    if (px !== undefined && py !== undefined) {
      left = Math.max(4, Math.min(px, window.innerWidth - w - 8));
      top = Math.max(4, Math.min(py, window.innerHeight - h - 8));
    } else {
      const a = anchor.getBoundingClientRect();
      left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
      top = a.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4);
    }
    setPos({ left, top });
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
  }, [anchor, px, py, sheet]);

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
    const els = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
    } else if (e.key === "Tab") { close(); }
  }

  const style = sheet ? undefined : pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" as const };
  return (
    <>
    {sheet && <div className="face-qa-backdrop" aria-hidden="true" />}
    <div ref={ref} className={`face-expand${sheet ? " as-sheet" : ""}`} role="menu" aria-label={label} onKeyDown={onKeyDown}
      style={style}>
      {heading && <div className="face-expand-heading" title={heading}>{heading}</div>}
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" title={it.title} disabled={it.disabled}
          className={`expand-btn${it.danger ? " danger" : ""}${it.primary ? " primary" : ""}`}
          onClick={() => { onClose(); it.onSelect(); }}>
          {it.label}
        </button>
      ))}
    </div>
    </>
  );
}
