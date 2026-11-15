import { useEffect, useRef } from "react";
import { countLabel, emptyListHint, placeMeta, PLACE_FILTERS, PLACE_SORTS, type Place, type PlaceFilter, type PlaceSort } from "./places";

/* The places sidebar: header (count, density toggle), search / sort / filter,
 * and the list. These narrow the sidebar list only; every place stays drawn on
 * the map. Each row is keyboard-operable: the name is a button that selects
 * the place (zooming the map to it and showing its edit handles), and the
 * actions are their own buttons. */

export type Hover = { id: number; fromMap: boolean } | null;

export function PlaceListHeader({ shown, total, dense, onToggleDense }: {
  shown: number; total: number; dense: boolean; onToggleDense: () => void;
}) {
  const label = dense ? "Switch to gallery rows" : "Switch to compact rows";
  return (
    <div id="sidebar-header">
      <h2>Custom Places</h2>
      <span id="place-count">{countLabel(shown, total)}</span>
      {/* Compact drops the big representative thumbnail to a 46px one, so a
          long list is scannable instead of two cards to a screen. */}
      <button type="button" id="place-density-btn" className="icon-btn" title={label} aria-label={label} onClick={onToggleDense}>
        {dense ? "▤" : "▥"}
      </button>
    </div>
  );
}

export function PlaceControls({ query, sort, filter, onQuery, onSort, onFilter }: {
  query: string; sort: PlaceSort; filter: PlaceFilter;
  onQuery: (q: string) => void; onSort: (s: PlaceSort) => void; onFilter: (f: PlaceFilter) => void;
}) {
  return (
    <div id="place-controls">
      {/* Filtered keystroke by keystroke: the list is already in memory, so it
          costs nothing and beats waiting for Enter. */}
      <input
        type="search" id="place-search" placeholder="Search places…" autoComplete="off"
        aria-label="Search places" value={query} onChange={(e) => onQuery(e.target.value)}
      />
      <div id="place-controls-row">
        <select id="place-sort" aria-label="Sort places" title="How to order the list" value={sort} onChange={(e) => onSort(e.target.value as PlaceSort)}>
          {PLACE_SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select id="place-filter" aria-label="Which places to list" title="Which places to list" value={filter} onChange={(e) => onFilter(e.target.value as PlaceFilter)}>
          {PLACE_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}

export function PlaceList({ places, shown, query, filter, dense, selectedId, hover, busy, scrollTick, onSelect, onHover, onRename, onDelete, onPickRep, onClearRep }: {
  places: readonly Place[];
  shown: readonly Place[];
  query: string;
  filter: PlaceFilter;
  dense: boolean;
  selectedId: number | null;
  hover: Hover;
  /** A reload after an edit keeps the old rows up until the reply lands; held
   *  busy meanwhile (U4) so a click can't act on a place being replaced. */
  busy: boolean;
  /** Bumped by the page when a selection should scroll its row into view. */
  scrollTick: number;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  onRename: (p: Place) => void;
  onDelete: (p: Place) => void;
  onPickRep: (p: Place) => void;
  onClearRep: (p: Place) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // `nearest` so a row already on screen doesn't jump the list around under a
  // sidebar click; only an off-screen one scrolls.
  useEffect(() => {
    if (selectedId == null || !scrollTick) return;
    listRef.current?.querySelector(`[data-id="${selectedId}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [selectedId, scrollTick]);

  return (
    <div id="place-list" className={`${dense ? "compact" : ""}${busy ? " is-busy" : ""}`} aria-busy={busy} inert={busy}>
      {!shown.length ? (
        <div className="no-places-hint">{emptyListHint(places.length, query, filter)}</div>
      ) : (
        <ul ref={listRef} aria-label="Places">
          {shown.map((p) => (
            <PlaceRow
              key={p.id} place={p} selected={p.id === selectedId} mapHover={hover?.fromMap === true && hover.id === p.id}
              onSelect={onSelect} onHover={onHover} onRename={onRename} onDelete={onDelete} onPickRep={onPickRep} onClearRep={onClearRep}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PlaceRow({ place: p, selected, mapHover, onSelect, onHover, onRename, onDelete, onPickRep, onClearRep }: {
  place: Place; selected: boolean; mapHover: boolean;
  onSelect: (id: number) => void; onHover: (id: number | null) => void;
  onRename: (p: Place) => void; onDelete: (p: Place) => void;
  onPickRep: (p: Place) => void; onClearRep: (p: Place) => void;
}) {
  const broken = p.bounds_valid === false;
  const rep = p.representative_photo_id;
  const count = p.photo_count ?? 0;
  return (
    // Row ↔ shape hover, so a row can be matched to its area without clicking —
    // the sidebar is a list of names and the map is a field of identical blue
    // rings, and neither alone says which is which. A click anywhere on the row
    // selects it, as before; the name button is the keyboard path.
    <li
      data-id={p.id}
      className={`place-item${selected ? " selected" : ""}${broken ? " broken" : ""}${mapHover ? " hover" : ""}`}
      onMouseEnter={() => onHover(p.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(p.id)}
    >
      <div className="place-item-main">
        {/* The thumbnail (or its placeholder) is the way into the picker — this
            page is the only place a representative is chosen. */}
        {!broken && (rep ? (
          <button type="button" className="rep-thumb-btn" title="Click to choose a different photo"
            aria-label={`Choose a different representative photo for ${p.name}`}
            onClick={(e) => { e.stopPropagation(); onPickRep(p); }}>
            <img className="place-rep-thumb" src={`/api/thumbnail/${rep}`} alt="Representative photo" />
          </button>
        ) : (
          <button type="button" className="rep-empty" title="Choose a representative photo from the photos taken here"
            aria-label={`Choose a representative photo for ${p.name}`}
            onClick={(e) => { e.stopPropagation(); onPickRep(p); }}>
            <span className="rep-empty-icon" aria-hidden="true">🖼</span><span className="rep-empty-text">Choose a photo</span>
          </button>
        ))}
        <button type="button" className="place-item-body" aria-pressed={selected}
          onClick={(e) => { e.stopPropagation(); onSelect(p.id); }}>
          <span className="place-item-name">{p.name}</span>
          <span className="place-item-meta">{placeMeta(p)}</span>
        </button>
      </div>
      <div className="place-item-actions">
        {/* A place is a search filter (Search's "nearby a saved place"); this is
            the way from here to the photos it stands for. An anchor, not a
            button, so middle-click and "open in new tab" work. */}
        {count > 0 && (
          <a className="icon-btn photos-btn" href={`/search.html?place_id=${p.id}`}
            title={`Search the ${count} photo${count === 1 ? "" : "s"} taken here`}
            aria-label={`Search the ${count} photo${count === 1 ? "" : "s"} taken at ${p.name}`}
            onClick={(e) => e.stopPropagation()}>📷</a>
        )}
        {!broken && (
          <button type="button" className="icon-btn zoom-btn" title="Zoom to this place" aria-label={`Zoom to ${p.name}`}
            onClick={(e) => { e.stopPropagation(); onSelect(p.id); }}>🔍</button>
        )}
        <button type="button" className="icon-btn rename-btn" title="Rename" aria-label={`Rename ${p.name}`}
          onClick={(e) => { e.stopPropagation(); onRename(p); }}>✏️</button>
        {rep != null && (
          <button type="button" className="icon-btn clear-rep-btn" title="Remove representative photo"
            aria-label={`Remove the representative photo of ${p.name}`}
            onClick={(e) => { e.stopPropagation(); onClearRep(p); }}>🚫</button>
        )}
        <button type="button" className="icon-btn delete-btn" title="Delete" aria-label={`Delete ${p.name}`}
          onClick={(e) => { e.stopPropagation(); onDelete(p); }}>🗑️</button>
      </div>
    </li>
  );
}
