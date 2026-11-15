import { useCallback, useMemo, useRef, useState } from "react";
import { EMPTY_RANGE, type DateRange } from "../../ui/DateRangePicker";
import { dateBounds, filterPhotos, loadBand, loadToggles, type Toggles } from "./grouping";
import type { ScopeDef } from "./scope";
import type { Photo } from "./staging";

/* The workspace: the loaded scope's photos, how they're viewed (Show toggles,
 * hidden cameras, date range, Rows), the selection and the focused photo. One
 * state object in a ref mirrored into React state (Search's useSearchResults
 * pattern): the async flows — a scope landing, a commit, a batch opening — read
 * and change the current state without waiting for a re-render.
 *
 * Invariant kept by every change here: the selection only holds photos the
 * filters show. L, I, drag, the context menu, Remove and the propose bar all act
 * on the whole selection, so a selected photo a filter has just hidden would be
 * tagged without ever being on screen. Hidden photos are deselected rather than
 * kept-but-skipped — the "N selected" chip then always matches the highlighted
 * cells, at the price of re-selecting after showing them again. */

export type Workspace = {
  scope: ScopeDef | null;
  /** Bumped by every scope landing: the date picker starts over. */
  generation: number;
  /** A scope load is in flight (U4): the grid on screen is the outgoing one. */
  loading: boolean;
  photos: Photo[];
  selected: ReadonlySet<number>;
  /** Shift-click / Shift+j anchor, by photo id so it survives a re-filter. */
  anchorId: number | null;
  focusedId: number | null;
  toggles: Toggles;
  hidden: ReadonlySet<string>;
  dateRange: DateRange;
  band: number;
  /** "Show only this day on map". */
  isolation: string | null;
  /** "Show nearby on map": that day's photos pinned whatever the toggles say. */
  dayOverride: string | null;
};

function initial(): Workspace {
  return {
    scope: null, generation: 0, loading: false, photos: [], selected: new Set(), anchorId: null, focusedId: null,
    toggles: loadToggles(), hidden: new Set(), dateRange: EMPTY_RANGE, band: loadBand(), isolation: null, dayOverride: null,
  };
}

export function useWorkspace() {
  const [state, setState] = useState<Workspace>(initial);
  const ref = useRef(state);

  const update = useCallback((patch: Partial<Workspace> | ((w: Workspace) => Partial<Workspace>)) => {
    const p = typeof patch === "function" ? patch(ref.current) : patch;
    ref.current = { ...ref.current, ...p };
    setState(ref.current);
  }, []);

  // filterPhotos over a month is cheap but not free, and async flows ask for it
  // too — cache it on the inputs' identities.
  const cache = useRef<{ key: unknown[]; value: Photo[] } | null>(null);
  const filteredOf = useCallback((w: Workspace): Photo[] => {
    const key = [w.photos, w.toggles, w.hidden, w.dateRange];
    const c = cache.current;
    if (c && c.key.every((k, i) => k === key[i])) return c.value;
    const value = filterPhotos(w.photos, w.toggles, w.hidden, dateBounds(w.dateRange));
    cache.current = { key, value };
    return value;
  }, []);
  const filtered = useMemo(() => filteredOf(state), [filteredOf, state]);

  /** Change how the scope is viewed, keeping the selection to what's visible.
   *  Returns how many selected photos that hid (for the status line). */
  const view = useCallback((patch: Partial<Pick<Workspace, "toggles" | "hidden" | "dateRange" | "photos">>): number => {
    const next = { ...ref.current, ...patch };
    const visible = new Set(filteredOf(next).map((p) => p.id));
    let deselected = 0;
    const selected = new Set<number>();
    next.selected.forEach((id) => { if (visible.has(id)) selected.add(id); else deselected++; });
    update({ ...patch, ...(deselected ? { selected } : {}) });
    return deselected;
  }, [filteredOf, update]);

  return { state, ref, update, filtered, filteredOf, view };
}

export type WorkspaceStore = ReturnType<typeof useWorkspace>;

export function showingText(shown: number, total: number, deselected = 0): string {
  return `Showing ${shown} of ${total} photos` + (deselected ? ` · deselected ${deselected} now hidden` : "");
}
