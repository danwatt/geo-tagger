import { useCallback, useEffect, useRef, useState } from "react";
import { postJson, type Schemas } from "../../api/client";

/* ── Proposal banner ──
 * Most selections are a run of photos from one outing, and the outing next to it
 * in time is usually already tagged. Asking the server where the selection's
 * time-neighbours are geotagged answers "where was this?" before the user has
 * touched the map at all. Every selection change is a chance to ask; debounced,
 * since a shift-range fires a change per cell, and only the newest selection's
 * answer may land. Port of app.js scheduleProposal / fetchProposal. */

export type Proposal = Schemas["ProposeResponse"];

const DEBOUNCE_MS = 250;

export function selectionSignature(ids: Iterable<number>): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

export function useProposal(selected: ReadonlySet<number>, suppressed: boolean) {
  const [proposal, setProposal] = useState<{ sig: string; data: Proposal } | null>(null);
  // The selection the user waved the bar off for; a new batch resets it.
  const [dismissedFor, setDismissedFor] = useState("");
  const sig = selectionSignature(selected);
  const sigRef = useRef(sig);
  sigRef.current = sig;

  useEffect(() => {
    if (!sig || sig === dismissedFor || suppressed) { setProposal(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const data = await postJson<Proposal>("/api/geotag/propose", { ids: sig.split(",").map(Number) }, { signal: ctl.signal });
        // The selection moved on while we were waiting.
        if (ctl.signal.aborted || sigRef.current !== sig) return;
        setProposal(data.candidates.length ? { sig, data } : null);
      } catch {
        if (!ctl.signal.aborted) setProposal(null);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [sig, dismissedFor, suppressed]);

  const dismiss = useCallback(() => { setDismissedFor(sigRef.current); setProposal(null); }, []);
  const resetDismissed = useCallback(() => setDismissedFor(""), []);
  const hide = useCallback(() => setProposal(null), []);

  // Only shown for the selection it answers.
  return { proposal: proposal && proposal.sig === sig ? proposal.data : null, dismiss, resetDismissed, hide };
}
