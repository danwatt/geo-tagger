import { useCallback, useMemo, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";

/* The page drives the map's view imperatively (fit a scope, fly to a photo,
 * zoom to a day), as the legacy page did. The Leaflet map only exists once
 * MapContainer has mounted, and the page's start-up sequence (fit the library,
 * open the URL's scope) can run before that — so view changes asked for early
 * are queued and run, in order, the moment the map arrives. View changes are
 * cosmetic: one that throws (a zero-size container mid-layout) is dropped
 * rather than breaking the action that asked for it. */

export type MapHandle = {
  ref: (map: LeafletMap | null) => void;
  get: () => LeafletMap | null;
  run: (fn: (map: LeafletMap) => void) => void;
};

export function useMapHandle(): MapHandle {
  const map = useRef<LeafletMap | null>(null);
  const queue = useRef<((map: LeafletMap) => void)[]>([]);
  const safe = (m: LeafletMap, fn: (map: LeafletMap) => void) => {
    try { fn(m); } catch { /* a view change is never worth failing an action */ }
  };
  const ref = useCallback((m: LeafletMap | null) => {
    map.current = m;
    if (!m) return;
    const pending = queue.current.splice(0);
    pending.forEach((fn) => safe(m, fn));
  }, []);
  const run = useCallback((fn: (map: LeafletMap) => void) => {
    if (map.current) safe(map.current, fn);
    else queue.current.push(fn);
  }, []);
  return useMemo(() => ({ ref, get: () => map.current, run }), [ref, run]);
}
