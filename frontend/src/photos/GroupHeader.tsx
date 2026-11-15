import type { ReactNode } from "react";
import "./GroupHeader.css";

/* A grid group's header bar: title, a quieter meta line, and optional group
 * buttons on the right. Port of face-grid.js faceGroupHeader. */

/** `variant` recolours the bar (face-grid.js's tint classes); "amber" marks
 *  staged, not-yet-saved groups. */
export function GroupHeader({ id, title, meta, variant, children }: {
  id?: string;
  title: string;
  meta?: string;
  variant?: "amber";
  children?: ReactNode;
}) {
  return (
    <div className={`face-group-header${variant ? ` ${variant}` : ""}`}>
      <span className="face-group-label" id={id}>
        {title}
        {meta && <span className="face-group-meta"> {meta}</span>}
      </span>
      {children && <div className="face-group-btns">{children}</div>}
    </div>
  );
}

/** The year/month sections every grid draws, with the cycling tint classes. */
export function GroupSection({ index, title, meta, buttons, children, labelId }: {
  index: number;
  title: string;
  meta?: string;
  buttons?: ReactNode;
  children: ReactNode;
  labelId: string;
}) {
  return (
    <section className={`face-group-section group-tint-${index % 6}`} aria-labelledby={labelId}>
      <GroupHeader id={labelId} title={title} meta={meta}>{buttons}</GroupHeader>
      {children}
    </section>
  );
}
