import { Dialog } from "../../ui/Dialog";
import type { Proposal } from "./useProposal";
import type { BatchDetail } from "./useBatchFlow";

/* The small bars around the grid: the work-queue batch banner, the proposal
 * banner and the keyboard shortcuts sheet. The camera legend and the
 * staged-restore banner (U7) are shared with Time Sync: photos/CameraLegend.tsx
 * and ui/RestoreBanner.tsx. */

/** What the work queue loaded, and the two keys that drive it. Three spans, not
 *  one string: the grid pane is narrow, and the position and the live count are
 *  the parts that must never be the ones ellipsized away. */
export function BatchBanner({ batch, selected, onSkip, onNext, onExit }: {
  batch: BatchDetail;
  selected: number;
  onSkip: () => void;
  onNext: () => void;
  onExit: () => void;
}) {
  return (
    <div id="batch-banner" role="region" aria-label="Work queue batch">
      <span id="batch-banner-pos">⚡ Batch {batch.position + 1} of {batch.total_batches}</span>
      <span id="batch-banner-title" title={batch.title}>{batch.title + (batch.start_ts ? "" : " · no dates")}</span>
      <span id="batch-banner-count" aria-live="polite">{selected.toLocaleString()} selected</span>
      <div className="batch-banner-actions">
        <button type="button" title="Pass over this batch for now (remembered in this browser)" onClick={onSkip}>Skip <kbd>S</kbd></button>
        <button type="button" className="primary" title="Load the next batch in the queue" onClick={onNext}>Next batch ▸ <kbd>N</kbd></button>
        <button type="button" title="Stop working the queue; leaves these photos loaded" onClick={onExit}>✕ Exit</button>
      </div>
    </div>
  );
}

/** Where the selection's photos were probably taken, from their nearest-in-time
 *  geotagged neighbours. Staging from here never touches the map. */
export function ProposeBar({ proposal, selected, onStage, onDismiss }: {
  proposal: Proposal;
  selected: number;
  onStage: (lat: number, lng: number) => void;
  onDismiss: () => void;
}) {
  const top = proposal.candidates[0]!;
  return (
    <div id="propose-bar" role="region" aria-label="Suggested location">
      <span id="propose-summary">{top.votes} of {proposal.selected} nearby →</span>
      <div id="propose-actions">
        {proposal.candidates.map((c, i) => (
          <button key={`${c.lat},${c.lng}`} type="button" className={i === 0 ? "primary" : undefined}
            title={`Stage the ${selected} selected photo(s) at ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`}
            onClick={() => onStage(c.lat, c.lng)}>
            {i === 0 ? `📍 Stage all at ${c.label}` : `${c.label} (${c.votes})`}
          </button>
        ))}
      </div>
      <button type="button" id="propose-dismiss" aria-label="Hide this suggestion" title="Hide this suggestion" onClick={onDismiss}>✕</button>
    </div>
  );
}

const SHORTCUTS: [string[], string][] = [
  [["↑", "↓", "k", "j"], "Move focus to prev/next photo"],
  [["Shift", "↑/↓"], "Extend selection range"],
  [["Space"], "Toggle selection of focused photo"],
  [["l"], "Tag selection as… (saved places, recents, hotspots)"],
  [["i"], "Stage selection as needing no location"],
  [["Del"], "Stage removing the selection's saved location"],
  [["g"], "Guess location for the focused photo"],
  [["Enter"], "Commit all staged locations"],
  [["u"], "Undo the last commit"],
  [["n", "s"], "Next / skip batch (work queue)"],
  [["Shift+F10"], "Photo actions menu for the focused photo"],
  [["?"], "Show this help"],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} id="shortcuts-help-modal">
      <table className="sh-table">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={what}>
              <td>{keys.map((k, i) => <span key={k}>{i ? " " : ""}<kbd>{k}</kbd></span>)}</td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sh-foot">Shortcuts are ignored while typing in a text field.</div>
    </Dialog>
  );
}
