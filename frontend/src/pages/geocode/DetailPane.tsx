import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { nav } from "../../lib/handoff";
import { PhotoPreviewPane, photoQueryKey, type PhotoDetail } from "../../photos/PhotoPreviewPane";
import { formatAccuracy, guessSummary } from "./guess";
import type { PendingGuess } from "./useGuess";

/* The preview pane: the shared PhotoPreviewPane plus Geocode's extras — the
 * Faces link, the accuracy / source / sidecar rows, the "Ignore for geocoding"
 * checkbox (the one-photo, immediate way back from an ignore mark), and the
 * Guess location bar for an untagged photo that has a timestamp. */

function IgnoreToggle({ detail, onChange }: { detail: PhotoDetail; onChange: (ignored: boolean) => Promise<boolean> }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <label className="inline-toggle">
      <input type="checkbox" checked={!!detail.geocode_ignored} disabled={busy}
        onChange={async (e) => {
          const want = e.target.checked;
          setBusy(true);
          // On failure the photo kept its old flag, and so does the box.
          const ok = await onChange(want);
          if (ok) await queryClient.invalidateQueries({ queryKey: photoQueryKey(detail.id) });
          setBusy(false);
        }} /> not applicable (e.g. screenshot)
    </label>
  );
}

export function DetailPane({ photoId, hidden, guess, guessing, onGuess, onApplyGuess, onDismissGuess, onSetIgnored }: {
  photoId: number | null;
  hidden: boolean;
  guess: PendingGuess | null;
  guessing: boolean;
  onGuess: () => void;
  onApplyGuess: () => void;
  onDismissGuess: () => void;
  onSetIgnored: (id: number, ignored: boolean) => Promise<boolean>;
}) {
  return (
    <PhotoPreviewPane
      photoId={photoId}
      hidden={hidden}
      buttons={(d) => (
        <button type="button" title="View and edit every detected face in this photo"
          onClick={() => nav.go(`/photo-faces.html?photo_id=${d.id}&back=${encodeURIComponent(location.pathname + location.search)}`)}>
          👥 Faces
        </button>
      )}
      extraRows={(d) => [
        ["GPS accuracy", formatAccuracy(d.gps_accuracy)],
        ["Geotag source", d.geotag_source ?? "—"],
        ["Sidecar", d.sidecar_path ? d.sidecar_path.split(/[\\/]/).pop() ?? "none" : "none"],
        ["Ignore for geocoding", <IgnoreToggle key={d.id} detail={d} onChange={(ignored) => onSetIgnored(d.id, ignored)} />],
      ]}
      footer={(d) => (d.lat == null && d.datetime ? (
        <div id="guess-bar">
          <button type="button" id="guess-btn" disabled={guessing} title="Guess from the nearest-in-time geotagged photos (shortcut: G)"
            onClick={onGuess}>{guessing ? "Searching…" : "Guess location"}</button>
          {guess && guess.photoId === d.id && (
            <div id="guess-result">
              <span id="guess-summary">{guessSummary(guess.data)}</span>
              <div className="guess-actions">
                <button type="button" className="primary" onClick={onApplyGuess}>Apply</button>
                <button type="button" onClick={onDismissGuess}>Dismiss</button>
              </div>
            </div>
          )}
        </div>
      ) : null)}
    />
  );
}
