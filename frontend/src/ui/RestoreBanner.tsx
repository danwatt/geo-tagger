/* "Uncommitted changes from your last visit" (U7): a fixed card (theme.css
 * .staged-restore-banner), so it doesn't reflow the page's panes; non-modal.
 * Port of common.js showStagedRestoreBanner, shared by Geocode and Time Sync.
 * The page owns whether it shows: it hides it once `remaining` reaches 0. */

export function RestoreBanner({ remaining, detail, noun = "change", onReview, onCommit, onDiscard, onClose }: {
  remaining: number;
  detail: string;
  /** What the restored items are ("change", "time offset"); pluralised with an s. */
  noun?: string;
  onReview: () => void;
  onCommit: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  return (
    <div id="staged-restore-banner" className="staged-restore-banner" role="status">
      <div className="srb-text">
        <b className="srb-count">You have {remaining.toLocaleString()} uncommitted {noun}{remaining !== 1 ? "s" : ""} from your last visit.</b>
        {detail && <span className="srb-detail">{detail}</span>}
      </div>
      <div className="srb-btns">
        <button type="button" title="Show the restored changes. Nothing is saved until you commit" onClick={onReview}>Review</button>
        <button type="button" className="primary" title="Write the restored changes now (asks to confirm)" onClick={onCommit}>Commit</button>
        <button type="button" className="danger" title="Throw the restored changes away" onClick={onDiscard}>Discard</button>
        <button type="button" className="srb-close" aria-label="Hide this banner" title="Hide this banner. The changes stay staged" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
