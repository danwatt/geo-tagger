import { useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../../ui/Dialog";
import { matchChoices, type LocationChoice } from "./locations";
import "./TagAsDialog.css";

/* "Tag as…": pick one of the locations already in use (Recent, Saved places,
 * Hotspots) for the selection. Port of face-grid.js openEntityPicker in cards
 * mode — a thumbnail on top and the name under it, since these are picked by
 * recognising the photo — as a Dialog with a combobox over a grouped listbox.
 * Arrows move the highlight over the matching cards, Enter picks it. A pick
 * stages, exactly as a map drop does; new locations are made by dropping on the
 * map, so there is no Create row. */

export function TagAsDialog({ count, items, onPick, onClose }: {
  count: number;
  items: LocationChoice[];
  onPick: (item: LocationChoice) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => matchChoices(items, query), [items, query]);
  const hl = Math.min(active, rows.length - 1);

  let lastGroup: string | null = null;
  return (
    <Dialog title={`Tag ${count} photo(s) as…`} onClose={onClose} initialFocus={inputRef} id="tag-as-dialog">
      <label htmlFor={`${uid}-q`} className="visually-hidden">Location</label>
      <input ref={inputRef} id={`${uid}-q`} type="text" className="pp-search" autoComplete="off"
        placeholder="Search places, recents, hotspots…" role="combobox" aria-expanded="true" aria-controls={`${uid}-list`}
        aria-activedescendant={rows.length ? `${uid}-opt-${hl}` : undefined} value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (rows.length) setActive(Math.max(0, Math.min(rows.length - 1, hl + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const row = rows[hl];
            if (row) onPick(row);
          }
        }} />
      <div id={`${uid}-list`} className="pp-list pp-cards" role="listbox" aria-label="Known locations">
        {rows.map((it, i) => {
          const head = it.group !== lastGroup ? <div className="pp-group" role="presentation">{it.group}</div> : null;
          lastGroup = it.group;
          return (
            <FragmentRow key={`${it.group}-${it.lat}-${it.lng}`} head={head}>
              <div id={`${uid}-opt-${i}`} role="option" aria-selected={i === hl} className={`pp-item${i === hl ? " pp-hl" : ""}`}
                title={`${it.name} — ${it.lat.toFixed(5)}, ${it.lng.toFixed(5)}`}
                onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(it)}>
                {it.thumb ? <img className="pp-thumb" src={it.thumb} loading="lazy" alt="" />
                  : <span className="pp-thumb pp-thumb-empty" aria-hidden="true">📍</span>}
                <span className="pp-item-main">
                  <span className="pp-name">{it.name}</span>
                  {it.meta && <span className="pp-meta">{it.meta}</span>}
                </span>
                {it.count != null && <span className="pp-count">{it.count}</span>}
              </div>
            </FragmentRow>
          );
        })}
        {!rows.length && <div className="pp-empty">{query.trim() ? "No matches." : "No known locations yet."}</div>}
      </div>
    </Dialog>
  );
}

function FragmentRow({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return <>{head}{children}</>;
}
