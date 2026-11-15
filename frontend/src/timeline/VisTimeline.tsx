import { useEffect, useRef } from "react";
// The standalone build bundles vis-data, moment and hammer; npm installs them as
// vis-timeline peer deps, but nothing imports them. Pinned at 7.7.4 (the legacy
// page loaded 7.7.3 from unpkg).
import { DataSet, Timeline, moment } from "vis-timeline/standalone";
import "vis-timeline/styles/vis-timeline-graph2d.min.css";
import "./VisTimeline.css";

/* A vis-timeline that owns its DOM node, the way MarkerClusterLayer owns its
 * Leaflet layer: created once on mount, destroyed on unmount, and fed through
 * props in between. Pages import it from here, so tests can vi.mock this module
 * with a plain stub and never load the 1.5 MB bundle into jsdom.
 *
 * Items are photos: a point per photo, one group (row) per camera, drawn as the
 * photo's thumbnail with a border in the camera's colour. Selection is
 * controlled: the timeline reports what the user picked (onSelect, with whether
 * Shift was held) and mirrors the `selection` prop back. `fit` and `focus` are
 * one-shot requests: pass a new object (its `n` changes) to move the window. */

export type TimelineItem = {
  id: number;
  group: string;
  /** Milliseconds, wall clock as if UTC (see lib/wallClock.ts). */
  start: number;
  filename: string;
  color: string;
  /** Carries an unsaved time offset: drawn dimmed with a glow. */
  shifted: boolean;
};
export type TimelineGroup = { id: string; content: string; color: string };
export type FitRequest = { start: number; end: number; n: number };
export type FocusRequest = { id: number; n: number };

export type VisTimelineProps = {
  items: readonly TimelineItem[];
  groups: readonly TimelineGroup[];
  selection: ReadonlySet<number>;
  onSelect: (ids: number[], shift: boolean) => void;
  onDoubleClick: (id: number) => void;
  fit?: FitRequest | null;
  focus?: FocusRequest | null;
  /** Holds the timeline while the next month's photos load (U4): the previous
   *  month's items stay drawn until the reply lands, so they're dimmed and take
   *  no clicks or drags meanwhile. */
  busy?: boolean;
  id?: string;
};

type VisItem = {
  id: number; group: string; start: Date; type: "point"; className: string;
  photoId: number; filename: string; color: string;
};

// vis-timeline's bundled declarations lean on vis-data / moment types the
// standalone package doesn't ship, so the handles are typed loosely here.
type TimelineHandle = {
  on: (event: string, cb: (props: never) => void) => void;
  destroy: () => void;
  setSelection: (ids: number[]) => void;
  getSelection: () => (string | number)[];
  setWindow: (start: Date, end: Date, opts?: object) => void;
  focus: (id: number, opts?: object) => void;
};
type DataSetHandle = { clear: () => void; add: (rows: object[]) => void };

function thumb(item: VisItem | null | undefined): HTMLElement | string {
  if (!item?.photoId) return "";
  // An element rather than an HTML string: vis-timeline runs string templates
  // through its XSS filter, which would strip the inline border colour.
  const img = document.createElement("img");
  img.src = `/api/thumbnail/${item.photoId}`;
  img.alt = "";
  img.title = item.filename;
  img.style.border = `2px solid ${item.color}`;
  return img;
}

const sameSet = (a: readonly (string | number)[], b: ReadonlySet<number>) =>
  a.length === b.size && a.every((id) => b.has(Number(id)));

export function VisTimeline({ items, groups, selection, onSelect, onDoubleClick, fit, focus, busy, id = "timeline-container" }: VisTimelineProps) {
  const el = useRef<HTMLDivElement>(null);
  const tl = useRef<TimelineHandle | null>(null);
  const data = useRef<{ items: DataSetHandle; groups: DataSetHandle } | null>(null);
  const cb = useRef({ onSelect, onDoubleClick, selection });
  cb.current = { onSelect, onDoubleClick, selection };

  useEffect(() => {
    if (!el.current) return;
    const itemSet = new DataSet([]) as unknown as DataSetHandle;
    const groupSet = new DataSet([]) as unknown as DataSetHandle;
    const timeline = new Timeline(el.current, itemSet as never, groupSet as never, {
      orientation: "top",
      stack: false,
      zoomMin: 1000 * 60,                    // 1 minute
      zoomMax: 1000 * 60 * 60 * 24 * 31,     // 31 days
      multiselect: true,
      selectable: true,
      snap: null,
      // photo_datetime is the camera's wall clock stored as a UTC epoch, so the
      // axis must render in UTC â€” the browser's zone would shift every label
      // (and the day boundaries) by the local offset.
      moment: (date: Date) => moment(date).utc(),
      editable: { updateTime: false, updateGroup: false },
      template: thumb,
    } as never) as unknown as TimelineHandle;
    tl.current = timeline;
    data.current = { items: itemSet, groups: groupSet };

    // The page narrows a Shift-select to one camera, so it needs to know
    // whether Shift was down; vis's select event doesn't say reliably.
    let shift = false;
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") shift = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") shift = false; };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    timeline.on("select", (p: { items: (string | number)[] }) => cb.current.onSelect(p.items.map(Number), shift));
    timeline.on("doubleClick", (p: { item: string | number | null }) => {
      if (p.item != null) cb.current.onDoubleClick(Number(p.item));
    });
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      timeline.destroy();
      tl.current = null;
      data.current = null;
    };
  }, []);

  useEffect(() => {
    const d = data.current;
    if (!d) return;
    d.groups.clear();
    d.groups.add(groups.map((g) => ({ id: g.id, content: g.content, style: `background: ${g.color}22; color: var(--text);` })));
    d.items.clear();
    d.items.add(items.map((it): VisItem => ({
      id: it.id, group: it.group, start: new Date(it.start), type: "point",
      className: it.shifted ? "time-shifted" : "", photoId: it.id, filename: it.filename, color: it.color,
    })));
    // A rebuild drops vis's own selection; put the page's back.
    tl.current?.setSelection([...cb.current.selection]);
  }, [items, groups]);

  useEffect(() => {
    const t = tl.current;
    if (t && !sameSet(t.getSelection(), selection)) t.setSelection([...selection]);
  }, [selection]);

  useEffect(() => {
    if (fit) tl.current?.setWindow(new Date(fit.start), new Date(fit.end), { animation: true });
  }, [fit]);

  useEffect(() => {
    if (focus) tl.current?.focus(focus.id, { animation: { duration: 500, easingFunction: "easeInOutQuad" } });
  }, [focus]);

  return (
    <div ref={el} id={id} className={`vis-host${busy ? " is-busy is-busy-shown" : ""}`} aria-busy={busy || undefined}
      role="region" aria-label="Photo timeline, one row per camera. The grid below offers the same selection by keyboard." />
  );
}
