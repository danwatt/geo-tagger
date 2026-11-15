import type { ReactNode } from "react";
import "./GroupHeader.css";

/* A grid group's header bar: title, a quieter meta line, and optional group
 * buttons on the right. Port of face-grid.js faceGroupHeader. */

export function GroupHeader({ id, title, meta, children }: { id?: string; title: string; meta?: string; children?: ReactNode }) {
  return (
    <div className="face-group-header">
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
