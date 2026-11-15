import { Spinner } from "../../ui/ui";
import { HOTSPOT_LIMIT, hotspotCountLabel, hotspotKey, hotspotMeta, type Hotspot } from "./hotspots";

/* Sidebar halves of the hotspot features: the standing "name this?" suggestion
 * and the opt-in Hotspots list. Naming one turns it into a place above, at
 * which point it drops off this list. */

export function SuggestionBanner({ hotspot, onZoom, onName, onDismiss }: {
  hotspot: Hotspot; onZoom: () => void; onName: () => void; onDismiss: () => void;
}) {
  // Reuses .hotspot-item's card in accent blue, not hotspot amber — a pointer at
  // one specific spot worth naming, not a browsable list.
  return (
    <section id="suggest-place-banner" className="hotspot-item" aria-label="Suggested place">
      <div className="hotspot-body">
        <div className="hotspot-label">{hotspot.label}</div>
        <div className="hotspot-meta">{hotspot.count} photos here — no place named yet</div>
        <div className="hotspot-actions">
          <button type="button" onClick={onZoom}>Zoom</button>
          <button type="button" className="name-btn primary" onClick={onName}>✏️ Name it…</button>
          <button type="button" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    </section>
  );
}

export function HotspotSection({ hotspots, total, inView, selectedKey, loading, error, busy, loadingMore, onSelect, onName, onLoadMore }: {
  hotspots: readonly Hotspot[];
  total: number;
  inView: boolean;
  selectedKey: string | null;
  /** First load, nothing to show yet. */
  loading: boolean;
  error: string | null;
  /** A refresh (pan, sort) over rows already listed: held busy until it lands. */
  busy: boolean;
  loadingMore: boolean;
  onSelect: (h: Hotspot) => void;
  onName: (h: Hotspot) => void;
  onLoadMore: () => void;
}) {
  return (
    <section id="hotspot-section" aria-labelledby="hotspot-title">
      <div id="hotspot-header">
        <h3 id="hotspot-title">Hotspots</h3>
        <span id="hotspot-count">{error ? "" : hotspotCountLabel(hotspots.length, total, inView)}</span>
      </div>
      <div id="hotspot-list" className={busy ? "is-busy" : undefined} aria-busy={busy || loading} inert={busy}>
        {error ? (
          <div className="hotspot-empty" role="alert">Couldn't load hotspots: {error}</div>
        ) : loading ? (
          <div className="hotspot-empty">Loading…</div>
        ) : !hotspots.length ? (
          <div className="hotspot-empty">
            {inView
              ? "No unnamed hotspots in this view — pan or zoom out, or untick \"Only in view\"."
              : "Nothing unnamed left — every recurring spot in your photos is already covered by a place above."}
          </div>
        ) : (
          <>
            <ul aria-label="Hotspots">
              {hotspots.map((h) => (
                <li
                  key={hotspotKey(h)}
                  className={`hotspot-item${hotspotKey(h) === selectedKey ? " selected" : ""}`}
                  onClick={() => onSelect(h)}
                >
                  {h.sample_photo_id != null && (
                    <img className="hotspot-thumb" src={`/api/thumbnail/${h.sample_photo_id}`} alt="" title="A photo tagged here" />
                  )}
                  <div className="hotspot-body">
                    <div className="hotspot-label">{h.label}</div>
                    <div className="hotspot-meta">{hotspotMeta(h)}</div>
                    <div className="hotspot-actions">
                      <button type="button" className="zoom-btn" aria-label={`Zoom to ${h.label}`}
                        onClick={(e) => { e.stopPropagation(); onSelect(h); }}>Zoom</button>
                      <button type="button" className="name-btn primary" aria-label={`Name ${h.label}…`}
                        onClick={(e) => { e.stopPropagation(); onName(h); }}>✏️ Name it…</button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {/* The tail of a long list. Appends the next page rather than
                replacing the list, so rows already scrolled past stay put. */}
            {hotspots.length < total && (
              <button type="button" id="hotspot-more-btn" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? <><Spinner /> Loading…</> : `Load ${Math.min(HOTSPOT_LIMIT, total - hotspots.length)} more`}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
