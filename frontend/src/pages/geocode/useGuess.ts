import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "../../api/client";
import { LATEST_ONLY_STALE, latestOnly } from "../../lib/latestOnly";
import type { Guess } from "./guess";
import type { MapHandle } from "./useMapHandle";
import { latLngBounds } from "leaflet";

/* "Guess location": a centre-of-mass guess from the focused photo's nearest-in-
 * time geotagged neighbours, shown on the map with its source pins until it is
 * applied or dismissed. Latest-only, and bound to the photo focused at the time:
 * moving focus cancels a guess in flight and drops a shown one, and the pending
 * guess records its own photo id so Apply can never geotag whatever happens to
 * be focused by then. The guess pin is draggable for manual refinement. */

export type PendingGuess = { photoId: number; lat: number; lng: number; data: Guess };

export function useGuess({ focusedId, windowSecs, map, say }: {
  focusedId: number | null;
  windowSecs: string;
  map: MapHandle;
  say: (msg: string, isError?: boolean) => void;
}) {
  const [guess, setGuess] = useState<PendingGuess | null>(null);
  const [searching, setSearching] = useState(false);
  const focusRef = useRef(focusedId);
  focusRef.current = focusedId;
  const sayRef = useRef(say);
  sayRef.current = say;

  const run = useMemo(() => latestOnly(async (signal: AbortSignal, photoId: number, win: string) => {
    try {
      return await getJson<Guess>(`/api/guess/${photoId}?window=${win}`, { signal });
    } finally {
      // A newer guess owns the button while it runs.
      if (!signal.aborted) setSearching(false);
    }
  }), []);

  // A guess still in flight (or shown) is for the photo being left.
  useEffect(() => {
    run.cancel();
    setSearching(false);
    setGuess(null);
  }, [focusedId, run]);

  const start = useCallback(async () => {
    const photoId = focusRef.current;
    if (photoId == null) return;
    setSearching(true);
    setGuess(null);   // clear an old pin, keep the button
    try {
      const data = await run(photoId, windowSecs);
      if (data === LATEST_ONLY_STALE || focusRef.current !== photoId) return;
      setGuess({ photoId, lat: data.lat, lng: data.lng, data });
      // Fit the map to the guess and its source pins.
      const pts: [number, number][] = [[data.lat, data.lng], ...data.sources.map((s) => [s.lat, s.lng] as [number, number])];
      map.run((m) => m.flyToBounds(latLngBounds(pts).pad(0.3), { duration: 1, maxZoom: 16 }));
    } catch (e) {
      // 400/404 carry a readable detail ("No geotagged photos found within the time window").
      sayRef.current((e as Error).message || "No nearby geotagged photos found", true);
    }
  }, [run, windowSecs, map]);

  const dismiss = useCallback(() => setGuess(null), []);
  /** The guess pin was dragged: Apply writes where it now is. */
  const move = useCallback((lat: number, lng: number) => setGuess((g) => (g ? { ...g, lat, lng } : g)), []);

  return { guess, searching, start, dismiss, move };
}
