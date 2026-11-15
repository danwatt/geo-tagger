import type { CSSProperties, ReactNode } from "react";
import { FaceCrop } from "../photos/FaceCrop";
import { bboxStyle, type Bbox } from "./faceGrid";

/* A face crop as a real button (audit Y1): click / Enter / Space activates it,
 * and the context-menu gesture — right-click, a long press on touch, the
 * ContextMenu key or Shift+F10 — opens its quick actions. Shared by the Photo
 * Faces cards, Discover's samples and Quick Tag's group. `children` overlay the
 * crop (name chip, score). */

export function FaceTile({ face, label, className, onActivate, onMenu, children, pressed, current, title }: {
  face: { id: number; filename?: string | null };
  label: string;
  className?: string;
  onActivate?: (el: HTMLButtonElement) => void;
  onMenu?: (el: HTMLButtonElement, point?: { x: number; y: number }) => void;
  children?: ReactNode;
  pressed?: boolean;
  current?: boolean;
  title?: string;
}) {
  return (
    <button type="button" className={className} aria-label={label} title={title}
      aria-pressed={pressed} aria-current={current || undefined} data-face-id={face.id}
      onClick={(e) => onActivate?.(e.currentTarget)}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e.currentTarget, { x: e.clientX, y: e.clientY }); } : undefined}
      onKeyDown={onMenu ? (e) => {
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          onMenu(e.currentTarget);
        }
      } : undefined}>
      <FaceCrop face={face} alt="" />
      {children}
    </button>
  );
}

/** An absolutely positioned box over a photo, from a normalized bbox. */
export function BboxBox({ bbox, className, style, children, ...rest }: {
  bbox: Bbox;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={className} style={{ ...bboxStyle(bbox), ...style }} {...rest}>{children}</div>;
}
