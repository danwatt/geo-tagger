import type { ReactNode } from "react";
import { BAND_OPTIONS, FILTER_BUTTONS, type FilterKey, type Toggles } from "./grouping";

/* The grid pane's chrome. The whole header sticks (batch banner, toolbar,
 * selection actions, proposal banner), so a suggestion raised while scrolled
 * deep into a month stays reachable; the grid, the staging area and the undo
 * bar scroll below it (`children`). */

export function GridPane({ banner, proposal, toggles, onToggle, band, onBand, onNextBatch, selectedCount, onTagAs, onIgnore, onRemove, onHelp, children }: {
  banner: ReactNode;
  proposal: ReactNode;
  toggles: Toggles;
  onToggle: (key: FilterKey) => void;
  band: number;
  onBand: (secs: number) => void;
  onNextBatch: () => void;
  selectedCount: number;
  onTagAs: () => void;
  onIgnore: () => void;
  onRemove: () => void;
  onHelp: () => void;
  children: ReactNode;
}) {
  return (
    <div id="grid-pane">
      <div id="grid-header">
        {banner}
        <div id="grid-nav">
          {/* Show filter: four independent toggles, not a dropdown. Each photo
              falls in exactly one of geotagged / not tagged / ignored; Screenshots
              cuts across all three. */}
          <div className="toolbar-group filter-toggles" id="filter-toggles" role="group" aria-label="Show">
            {FILTER_BUTTONS.map((b) => (
              <button key={b.key} type="button" className={`filter-toggle${toggles[b.key] ? " on" : ""}`} aria-pressed={toggles[b.key]}
                title={b.title} onClick={() => onToggle(b.key)}>{b.label}</button>
            ))}
          </div>
          <div className="toolbar-group">
            {/* How finely each day's thumbnails are split into rows; remembered per browser. */}
            <select id="band-select" aria-label="Rows" title="Split each day's photos into rows by time taken" value={band}
              onChange={(e) => onBand(Number(e.target.value))}>
              {BAND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="toolbar-group">
            {/* Entry point into the work queue without going via Home. */}
            <button type="button" id="next-batch-btn" title="Load the next batch of untagged photos from the work queue" onClick={onNextBatch}>⚡ Next batch</button>
          </div>
          <div className="toolbar-spacer" />
          <div className="toolbar-group">
            <button type="button" id="shortcuts-help-btn" className="icon-btn" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={onHelp}>?</button>
          </div>
        </div>
        {selectedCount > 0 && (
          <div id="photo-selection-actions" role="group" aria-label="Selection">
            <span id="workspace-selection-count" aria-live="polite">{selectedCount} selected</span>
            <button type="button" id="tag-as-btn" className="primary" onClick={onTagAs}
              title="Tag the selected photos at a place you already use — saved places, recent locations, hotspots (shortcut: L)">
              📍 Tag as… <kbd>L</kbd>
            </button>
            {/* Stages, like a map drop — nothing is written until Commit. Undoing a
                committed mark is the preview pane's "Ignore for geocoding" checkbox. */}
            <button type="button" id="mark-ignored-btn" onClick={onIgnore}
              title="Stage the selected photos as not needing a location (e.g. screenshots) — review and Commit below">
              🚫 Ignore location <kbd>I</kbd>
            </button>
            {/* Stages too: a committed removal can be taken back with Undo below. */}
            <button type="button" id="remove-location-btn" onClick={onRemove}
              title="Stage removing the saved location from the selected geotagged photos — review and Commit below">
              ❌ Remove location <kbd>Del</kbd>
            </button>
          </div>
        )}
        {proposal}
      </div>
      {children}
    </div>
  );
}
