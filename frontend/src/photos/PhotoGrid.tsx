import { memo, useCallback, useId, useRef } from "react";
import { MONTH_NAMES } from "../lib/format";
import { wallClockParts } from "../lib/wallClock";
import { GroupSection } from "./GroupHeader";
import type { ClickModifiers } from "./selection";
import "./PhotoGrid.css";

/* The year/month photo grid with selection. Port of search.js renderGrid /
 * makeThumbCell. Cells are real buttons (audit Y1): click, Enter or Space
 * activates one; Shift extends a range from the last activation, Ctrl/Cmd
 * toggles. Arrow keys move to the neighbouring cell and activate it, so the
 * preview follows the keyboard the way it follows clicks (Shift+arrow grows the
 * range); Home/End jump to the ends.
 *
 * Selection state is the caller's (see selection.ts for the rules): the grid only
 * reports which cell was activated with which modifiers. */

export type GridPhoto = {
  id: number;
  filename: string;
  lat?: number | null;
  geocode_ignored?: boolean;
  photo_datetime?: number | null;
  score?: number | null;
};

export type PhotoGroup<T> = { key: string; year: number | null; month: number | null; items: { item: T; idx: number }[] };

/** Consecutive runs of the same calendar month (photos arrive date-sorted from
 *  the API); undated photos fall into their own run. `getTs` reads the date, so
 *  the untagged-face rows can group by their photo's. */
export function groupByMonth<T>(items: readonly T[], getTs: (item: T) => number | null | undefined): PhotoGroup<T>[] {
  const groups: PhotoGroup<T>[] = [];
  let cur: PhotoGroup<T> | null = null;
  items.forEach((item, idx) => {
    const p = wallClockParts(getTs(item)); // UTC getters — see wallClock.ts
    const year = p ? p.year : null, month = p ? p.month : null;
    if (!cur || cur.year !== year || cur.month !== month) {
      cur = { key: `${year}-${month}-${idx}`, year, month, items: [] };
      groups.push(cur);
    }
    cur.items.push({ item, idx });
  });
  return groups;
}

export function groupTitle(g: { year: number | null; month: number | null }): string {
  return g.year != null && g.month != null ? `${MONTH_NAMES[g.month]} ${g.year}` : "Undated";
}

export const photoCount = (n: number) => `${n} photo${n !== 1 ? "s" : ""}`;

/** One grid cell. Exported for grids that lay their cells out themselves
 *  (Geocode's day / time-band sections); those can add a camera-colour stripe,
 *  HTML drag (photos dragged onto a map) and a context menu. Callbacks should be
 *  stable — the cell is memoised. */
export const ThumbCell = memo(function ThumbCell({ photo, idx, selected, focused, onActivate, onKey, stripColor, onDragStart, onContextMenu }: {
  photo: GridPhoto;
  idx: number;
  selected: boolean;
  focused: boolean;
  onActivate: (idx: number, mod: ClickModifiers) => void;
  onKey: (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => void;
  /** A thin bar across the top in this colour (Geocode's per-camera stripe). */
  stripColor?: string;
  /** Makes the cell draggable. */
  onDragStart?: (e: React.DragEvent<HTMLButtonElement>, idx: number) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>, idx: number) => void;
}) {
  const cls = "thumb-cell" + (selected ? " selected" : "") + (focused ? " focused" : "") +
    (photo.lat != null ? " tagged" : "") + (photo.geocode_ignored ? " geo-ignored" : "");
  return (
    <button
      type="button"
      className={cls}
      data-idx={idx}
      data-id={photo.id}
      aria-pressed={selected}
      aria-label={photo.filename + (photo.score != null ? `, match score ${photo.score.toFixed(3)}` : "")}
      onClick={(e) => onActivate(idx, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey })}
      onKeyDown={(e) => onKey(e, idx)}
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart ? (e) => onDragStart(e, idx) : undefined}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, idx) : undefined}
    >
      {stripColor && <span className="cam-strip" style={{ background: stripColor }} aria-hidden="true" />}
      <img src={`/api/thumbnail/${photo.id}`} loading="lazy" alt="" />
      <span className="thumb-name" aria-hidden="true">{photo.filename}</span>
      {photo.score != null && (
        // Raw cosine, not a percentage: SigLIP text scores sit around 0.10–0.15
        // for good matches, so a "%" would read as uniformly terrible.
        <span className="thumb-score" title="Match score (higher = closer to the description)" aria-hidden="true">
          {photo.score.toFixed(3)}
        </span>
      )}
    </button>
  );
});

/** The cell visually below/above `from` (same column, next/previous row), by
 *  layout rather than index: rows wrap differently in every month group. */
function verticalNeighbour(container: HTMLElement, from: HTMLElement, down: boolean): HTMLElement | null {
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  container.querySelectorAll<HTMLElement>(".thumb-cell[data-idx]").forEach((el) => {
    const b = el.getBoundingClientRect();
    const dy = down ? b.top - r.top : r.top - b.top;
    if (dy <= 1) return;
    const score = dy * 10000 + Math.abs(b.left + b.width / 2 - cx);
    if (score < bestScore) { bestScore = score; best = el; }
  });
  return best;
}

export function PhotoGrid({ photos, selectedIds, focusedId, onActivate, ranked, emptyMessage, id = "grid" }: {
  photos: readonly GridPhoto[];
  selectedIds: ReadonlySet<number>;
  focusedId: number | null;
  onActivate: (idx: number, mod: ClickModifiers) => void;
  /** Score order is the point: one "best first" section instead of month
   *  buckets, which would scatter the best matches. */
  ranked?: { title: string } | null;
  emptyMessage: string;
  id?: string;
}) {
  const uid = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Read through a ref so onKey stays one function: the memoised cells then
  // re-render only when their own selected/focused state changes, which keeps a
  // selection change on a 2,000-photo grid cheap.
  const latest = useRef({ count: photos.length, onActivate });
  latest.current = { count: photos.length, onActivate };

  const onKey = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const { count, onActivate } = latest.current;
    let target: number | null = null;
    if (e.key === "ArrowRight") target = idx + 1;
    else if (e.key === "ArrowLeft") target = idx - 1;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = count - 1;
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ref.current) {
      const el = verticalNeighbour(ref.current, e.currentTarget, e.key === "ArrowDown");
      target = el ? Number(el.dataset.idx) : null;
    }
    if (target === null || target < 0 || target >= count) return;
    e.preventDefault();
    ref.current?.querySelector<HTMLElement>(`.thumb-cell[data-idx="${target}"]`)?.focus();
    onActivate(target, { shift: e.shiftKey, toggle: false });
  }, []);

  if (photos.length === 0) {
    return <div id={id} className="photo-grid"><div className="grid-empty">{emptyMessage}</div></div>;
  }

  const cells = (items: { item: GridPhoto; idx: number }[]) => (
    <div className="face-group-cells">
      {items.map(({ item, idx }) => (
        <ThumbCell key={item.id} photo={item} idx={idx} selected={selectedIds.has(item.id)}
          focused={item.id === focusedId} onActivate={onActivate} onKey={onKey} />
      ))}
    </div>
  );

  if (ranked) {
    return (
      <div id={id} className="photo-grid" ref={ref}>
        <GroupSection index={0} labelId={`${uid}-ranked`} title={ranked.title} meta={`· ${photoCount(photos.length)}, best first`}>
          {cells(photos.map((item, idx) => ({ item, idx })))}
        </GroupSection>
      </div>
    );
  }

  return (
    <div id={id} className="photo-grid" ref={ref}>
      {groupByMonth(photos, (p) => p.photo_datetime).map((g, gi) => (
        <GroupSection key={g.key} index={gi} labelId={`${uid}-g${gi}`} title={groupTitle(g)} meta={`· ${photoCount(g.items.length)}`}>
          {cells(g.items)}
        </GroupSection>
      ))}
    </div>
  );
}
