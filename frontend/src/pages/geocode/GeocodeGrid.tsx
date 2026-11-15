import { memo, useId } from "react";
import { GroupHeader } from "../../photos/GroupHeader";
import { ThumbCell } from "../../photos/PhotoGrid";
import type { ClickModifiers } from "../../photos/selection";
import type { CameraColors } from "./cameraColors";
import { bandLabel, monthName, type DaySection, type GridEntry, type GridItem } from "./grouping";

/* The photo grid, by day: year and month dividers, one section per calendar
 * day with its "pin / fit / select untagged" buttons, and inside a dated day the
 * cells broken again into time bands (width from the Rows dropdown) — a day on
 * the road is a hundred thumbnails, and "which of these are the 3pm ones" is the
 * question you're actually asking when placing them. A day that falls in one
 * band gets no label: it would only repeat the header. Cells are the shared
 * ThumbCell buttons with the camera stripe, draggable onto the map. */

export type GridHandlers = {
  onActivate: (idx: number, mod: ClickModifiers) => void;
  onKey: (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => void;
  onDragStart: (e: React.DragEvent<HTMLButtonElement>, idx: number) => void;
  onContextMenu: (e: React.MouseEvent<HTMLButtonElement>, idx: number) => void;
  onIsolate: (day: string) => void;
  onZoomDay: (entries: GridEntry[]) => void;
  onSelectUntagged: (entries: GridEntry[], title: string) => void;
};

const plural = (n: number, w: string) => `${n} ${w}${n !== 1 ? "s" : ""}`;

const DaySectionView = memo(function DaySectionView({ sec, band, isolated, selected, focusedId, colors, h }: {
  sec: DaySection;
  band: number;
  isolated: boolean;
  selected: ReadonlySet<number>;
  focusedId: number | null;
  colors: CameraColors;
  h: GridHandlers;
}) {
  const uid = useId();
  const tagged = sec.entries.filter(({ photo }) => photo.lat != null && photo.lng != null);
  const untagged = sec.entries.filter(({ photo }) => photo.lat == null && !photo.geocode_ignored);
  const day = sec.day;
  return (
    <section className={`face-group-section group-tint-${sec.tint}`} aria-labelledby={`${uid}-t`}>
      <GroupHeader id={`${uid}-t`} title={sec.title} meta={`· ${plural(sec.entries.length, "photo")}`}>
        {day && (
          <>
            <button type="button" className={`icon-btn${isolated ? " active" : ""}`} aria-pressed={isolated}
              aria-label={isolated ? "Show all days on map" : "Show only this day on map"}
              title={isolated ? "Show all days on map" : "Show only this day on map"}
              onClick={() => h.onIsolate(day)}>📍</button>
            <button type="button" className="icon-btn" aria-label="Zoom to this day" disabled={!tagged.length}
              title={tagged.length ? `Zoom map to fit ${plural(tagged.length, "geotagged photo")} on this day` : "No geotagged photos on this day"}
              onClick={() => h.onZoomDay(tagged)}>⛶</button>
            <button type="button" className="icon-btn" aria-label="Select untagged" disabled={!untagged.length}
              title={untagged.length ? `Select ${plural(untagged.length, "untagged photo")} on this day` : "No untagged photos on this day"}
              onClick={() => h.onSelectUntagged(untagged, sec.title)}>☐</button>
          </>
        )}
      </GroupHeader>
      {sec.bands.map((b, i) => (
        <div key={b.start ?? `n${i}`} className="grid-band">
          {b.start !== null && sec.bands.length > 1 && (
            <div className={`grid-band-divider${i === 0 ? " first-band" : ""}`}>{bandLabel(b.start, band)} · {b.entries.length}</div>
          )}
          <div className="face-group-cells">
            {b.entries.map(({ photo, idx }) => (
              <ThumbCell key={photo.id} photo={photo} idx={idx} selected={selected.has(photo.id)} focused={photo.id === focusedId}
                onActivate={h.onActivate} onKey={h.onKey} stripColor={colors.color(photo.camera)}
                onDragStart={h.onDragStart} onContextMenu={h.onContextMenu} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
});

export function GeocodeGrid({ items, band, isolation, selected, focusedId, colors, busy, busyShown, handlers, emptyMessage }: {
  items: readonly GridItem[];
  band: number;
  isolation: string | null;
  selected: ReadonlySet<number>;
  focusedId: number | null;
  colors: CameraColors;
  /** A new scope is loading (U4): clicks on the outgoing grid are swallowed. */
  busy: boolean;
  busyShown: boolean;
  handlers: GridHandlers;
  emptyMessage: string | null;
}) {
  return (
    <div id="grid" className={`geocode-grid${busy ? " is-busy" : ""}${busyShown ? " is-busy-shown" : ""}`} aria-busy={busy}
      onClickCapture={(e) => { if (busy) { e.preventDefault(); e.stopPropagation(); } }}
      onContextMenuCapture={(e) => { if (busy) { e.preventDefault(); e.stopPropagation(); } }}
      onDragStartCapture={(e) => { if (busy) { e.preventDefault(); e.stopPropagation(); } }}>
      {!items.length && emptyMessage && <div className="grid-empty">{emptyMessage}</div>}
      {items.map((it) => {
        if (it.kind === "year") return <div key={it.key} className="grid-year-divider">{it.year}</div>;
        if (it.kind === "month") return <div key={it.key} className="grid-month-divider">{monthName(it.month)}</div>;
        return (
          <DaySectionView key={it.key} sec={it} band={band} isolated={it.day !== null && isolation === it.day}
            selected={selected} focusedId={focusedId} colors={colors} h={handlers} />
        );
      })}
    </div>
  );
}
