import { useCallback, useMemo, useRef } from "react";
import { latLngBounds, type Map as LeafletMap } from "leaflet";
import { getJson } from "../../api/client";
import { LATEST_ONLY_STALE, latestOnly } from "../../lib/latestOnly";
import { EMPTY_RANGE } from "../../ui/DateRangePicker";
import { placeBboxWithBuffer, scopeLoadedText, scopeLoadingText, scopeRequest, type ScopeDef } from "./scope";
import type { Photo } from "./staging";
import type { MapHandle } from "./useMapHandle";
import type { Staging } from "./useStaging";
import { showingText, type WorkspaceStore } from "./useWorkspace";

/* Scope loading. Every scope loader (month/year/undated, batch, folder, ids,
 * area, place, recorded location) fills the same photo list, so they all fetch
 * through one latest-only wrapper: pick month A then month B, and A's response —
 * cancelled, or arriving late anyway — resolves to LATEST_ONLY_STALE and is
 * never applied over B.
 *
 * U4: the grid keeps showing the previous scope until the new one lands, so it
 * is held busy (`loading`: dimmed after a beat, clicks and grid shortcuts
 * ignored) for the fetch. The landing renders in the same update that clears
 * `loading`, so there is no window where the stale grid is live again.
 *
 * Landing (land) is the single point every scope comes through, so the
 * per-scope resets can't be forgotten by one of them: the date range starts
 * over, the shift-click anchor and day isolation go, and a focused photo that
 * isn't in the new scope — and isn't staged, which keeps it on the page — is
 * dropped from the preview. */

export function fitToPhotos(map: LeafletMap, photos: readonly Photo[]): void {
  const tagged = photos.filter((p) => p.lat != null && p.lng != null);
  if (!tagged.length) return;
  map.flyToBounds(latLngBounds(tagged.map((p) => [p.lat!, p.lng!])), { padding: [40, 40], duration: 1.2, maxZoom: 16 });
}

export function useScopeLoader({ ws, staging, map, say, windowSecs, beforeEnter }: {
  ws: WorkspaceStore;
  staging: Staging;
  map: MapHandle;
  say: (msg: string, isError?: boolean) => void;
  /** The "include untagged within" window, read when a load starts. */
  windowSecs: () => string;
  /** Runs as a scope is entered, before its fetch: `keepBatch` false means the
   *  user picked it by hand and has stopped being driven by the work queue. */
  beforeEnter: (def: ScopeDef, keepBatch: boolean) => void;
}) {
  const windowRef = useRef(windowSecs);
  windowRef.current = windowSecs;
  const enterRef = useRef(beforeEnter);
  enterRef.current = beforeEnter;

  const fetchScope = useMemo(() => latestOnly(async (signal: AbortSignal, url: string, init?: RequestInit) =>
    getJson<Photo[]>(url, { ...init, signal })), []);

  const land = useCallback((def: ScopeDef, photos: Photo[], fitMap: boolean) => {
    const w = ws.ref.current;
    const focusedGone = w.focusedId != null && !staging.ref.current.has(w.focusedId) && !photos.some((p) => p.id === w.focusedId);
    const next = { ...w, photos, dateRange: EMPTY_RANGE };
    const shown = ws.filteredOf(next);
    const visible = new Set(shown.map((p) => p.id));
    const selected = new Set([...w.selected].filter((id) => visible.has(id)));
    const deselected = w.selected.size - selected.size;
    ws.update({
      scope: def, photos, dateRange: EMPTY_RANGE, generation: w.generation + 1, loading: false,
      anchorId: null, isolation: null, dayOverride: null, selected,
      ...(focusedGone ? { focusedId: null } : {}),
    });
    say(scopeLoadedText(def, photos.length) ?? showingText(shown.length, photos.length, deselected));
    if (fitMap) map.run((m) => fitToPhotos(m, shown));
  }, [ws, staging, map, say]);

  /** Enter `def` and load it. Resolves to the landed photos, or null when a newer
   *  scope superseded this one or the load failed (reported on the status line). */
  const load = useCallback(async (def: ScopeDef, { fitMap = false, keepBatch = false } = {}): Promise<Photo[] | null> => {
    enterRef.current(def, keepBatch);
    // The day isolation and "Show nearby on map" were for the scope being left.
    ws.update({ scope: def, loading: true, isolation: null, dayOverride: null });
    if (def.kind === "place") {
      // Zoom to the (buffered) search bounds so the buffer is visible; the
      // landing doesn't fit again.
      const box = placeBboxWithBuffer(def.place, def.buffer);
      map.run((m) => m.fitBounds(latLngBounds([box.min_lat, box.min_lng], [box.max_lat, box.max_lng]).pad(0.1)));
    }
    const loading = scopeLoadingText(def);
    if (loading) say(loading);
    const req = scopeRequest(def, windowRef.current());
    try {
      const data = await fetchScope(req.url, req.init);
      if (data === LATEST_ONLY_STALE) return null;
      land(def, data, fitMap);
      return data;
    } catch (e) {
      ws.update({ loading: false });
      say("Load error: " + (e as Error).message, true);
      return null;
    }
  }, [ws, map, say, fetchScope, land]);

  /** Re-run the loaded scope (a Window or buffer change). */
  const reload = useCallback((patch?: (def: ScopeDef) => ScopeDef) => {
    const def = ws.ref.current.scope;
    if (!def) return;
    const next = patch ? patch(def) : def;
    const keepBatch = next.kind === "range" || next.kind === "dir";
    void load(next, { fitMap: next.kind === "area" || next.kind === "location", keepBatch });
  }, [ws, load]);

  return { load, reload, cancel: fetchScope.cancel };
}
