import { useCallback, useMemo, useRef } from "react";
import { latLngBounds } from "leaflet";
import { getJson, type Schemas } from "../../api/client";
import { clickSelection, type ClickModifiers } from "../../photos/selection";
import { dayKey, locationKey, stepGridIndex, type GridEntry } from "./grouping";
import { dropEntry, ignoreEntry, removeEntry, type DropEntry, type Photo, type ResolvedLoc, type StagedEntry } from "./staging";
import type { MapHandle } from "./useMapHandle";
import type { Staging } from "./useStaging";
import type { WorkspaceStore } from "./useWorkspace";

/* What the grid's clicks and keys do: selection (click, Shift-range, Ctrl-
 * toggle, j/k, Shift+j/k, Space), focus (preview, accuracy circle, map fly-to),
 * and staging (drop, ignore, remove). Port of app.js handleThumbClick /
 * focusPhotoAt / moveGridFocus / stageDrop / stageIgnore / stageRemove. Staged
 * photos have left the grid, so every range and step skips them. */

const NOTHING_SAVED = " Nothing saved yet — review at the bottom of the grid, then Commit.";

// Reverse-geocode a dropped point into {loc, label}, cached per 4-decimal
// coordinate (~11 m — the geocoder's own quantization grid), so repeated drops
// in one spot don't re-query. A failed or empty lookup degrades to the raw
// coordinate as the label rather than blocking the drop.
const labelCache = new Map<string, { loc: ResolvedLoc; label: string }>();
export async function lookupLocation(lat: number, lng: number): Promise<{ loc: ResolvedLoc; label: string }> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  let out: { loc: ResolvedLoc; label: string } = { loc: null, label: `📌 ${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  try {
    const data = await getJson<Schemas["ProbeResponse"]>(`/api/geocode/lookup?lat=${lat}&lng=${lng}`);
    const loc = data.location ?? null;
    const label = locationKey(loc);
    out = { loc, label: label || out.label };
  } catch {
    // Offline geocode data missing or unreadable — stage under the coordinate.
  }
  labelCache.set(key, out);
  return out;
}

export function useGridActions({ ws, staging, map, say, dropAccuracy }: {
  ws: WorkspaceStore;
  staging: Staging;
  map: MapHandle;
  say: (msg: string, isError?: boolean) => void;
  /** The Imprecise Drop radius when it's on: it applies wherever a drop happens. */
  dropAccuracy: () => number | null;
}) {
  const accuracyRef = useRef(dropAccuracy);
  accuracyRef.current = dropAccuracy;
  const isStaged = useCallback((id: number) => staging.ref.current.has(id), [staging]);
  const filteredNow = useCallback(() => ws.filteredOf(ws.ref.current), [ws]);

  /** The shared tail of a click or a keyboard move: park focus on filtered[idx]
   *  (preview, accuracy circle), fly the map to it, and — for a key — move DOM
   *  focus to its cell, scrolled into view. */
  const focusAt = useCallback((idx: number, { keyboard = false } = {}) => {
    const photo = filteredNow()[idx];
    if (!photo) return;
    ws.update({ anchorId: photo.id, focusedId: photo.id });
    if (photo.lat != null && photo.lng != null) {
      map.run((m) => m.flyTo([photo.lat!, photo.lng!], Math.max(m.getZoom(), 14), { duration: 0.6 }));
    }
    const cell = document.querySelector<HTMLElement>(`#grid .thumb-cell[data-id="${photo.id}"]`);
    cell?.scrollIntoView?.({ block: "nearest" });
    if (keyboard) cell?.focus({ preventScroll: true });
  }, [filteredNow, ws, map]);

  const activate = useCallback((idx: number, mod: ClickModifiers) => {
    const shown = filteredNow();
    const ids = shown.map((p) => p.id);
    const w = ws.ref.current;
    const anchor = w.anchorId == null ? -1 : ids.indexOf(w.anchorId);
    const next = clickSelection(w.selected, ids, idx, anchor, mod);
    // A range drawn over staged photos skips them: they aren't in the grid.
    staging.ref.current.forEach((_e, id) => next.delete(id));
    ws.update({ selected: next });
    focusAt(idx);
  }, [filteredNow, ws, staging, focusAt]);

  /** j/k: move focus `delta` photos, collapsing the selection to that one —
   *  mirrors a plain click on the destination cell. */
  const move = useCallback((delta: number) => {
    const ids = filteredNow().map((p) => p.id);
    const from = ws.ref.current.focusedId == null ? -1 : ids.indexOf(ws.ref.current.focusedId);
    const idx = stepGridIndex(ids, from, delta, isStaged);
    if (idx === -1) return;
    ws.update({ selected: new Set([ids[idx]!]) });
    focusAt(idx, { keyboard: true });
  }, [filteredNow, ws, isStaged, focusAt]);

  /** Shift+j/k: extend the selection from the anchor to `delta` photos past the
   *  current focus — mirrors Shift-click's range. */
  const extend = useCallback((delta: number) => {
    const ids = filteredNow().map((p) => p.id);
    if (!ids.length) return;
    const w = ws.ref.current;
    const focusIdx = w.focusedId == null ? -1 : ids.indexOf(w.focusedId);
    const anchorIdx = w.anchorId != null && ids.includes(w.anchorId) ? ids.indexOf(w.anchorId) : Math.max(0, focusIdx);
    const idx = stepGridIndex(ids, focusIdx === -1 ? anchorIdx : focusIdx, delta, isStaged);
    if (idx === -1) return;
    const next = new Set(w.selected);
    for (let i = Math.min(anchorIdx, idx); i <= Math.max(anchorIdx, idx); i++) if (!isStaged(ids[i]!)) next.add(ids[i]!);
    ws.update({ selected: next });
    focusAt(idx, { keyboard: true });
  }, [filteredNow, ws, isStaged, focusAt]);

  const toggleFocused = useCallback(() => {
    const id = ws.ref.current.focusedId;
    if (id == null) return;
    const next = new Set(ws.ref.current.selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    ws.update({ selected: next });
  }, [ws]);

  /** A pin click: select just that photo and preview it. */
  const selectOnly = useCallback((id: number) => {
    ws.update({ selected: new Set([id]), focusedId: id });
  }, [ws]);

  /** Stage `entries`, pulling them out of the grid and the selection. */
  const park = useCallback((entries: StagedEntry[]) => {
    staging.stage(entries);
    const sel = new Set(ws.ref.current.selected);
    entries.forEach((e) => sel.delete(e.id));
    // The grid's index run shifts under the removed cells.
    ws.update({ selected: sel, anchorId: null });
  }, [staging, ws]);

  /** Park `ids` at one dropped point. Re-dropping a staged photo overwrites its
   *  pending location, so moving it between groups is just another drop. */
  const stageDrop = useCallback(async (ids: readonly number[], lat: number, lng: number, accuracy: number | null = accuracyRef.current()) => {
    if (!ids.length) return;
    say(`Looking up ${ids.length} photo(s)…`);
    const { loc, label } = await lookupLocation(lat, lng);
    const byId = new Map(ws.ref.current.photos.map((p) => [p.id, p]));
    const entries: DropEntry[] = [];
    ids.forEach((id) => {
      const photo = byId.get(id) ?? staging.ref.current.get(id)?.photo;
      if (photo) entries.push(dropEntry(photo, lat, lng, accuracy, loc, label));
    });
    if (!entries.length) { say("Nothing to stage.", true); return; }
    park(entries);
    say(`Staged ${entries.length} photo(s) → ${label}${accuracy ? ` (±${accuracy}m)` : ""}.${NOTHING_SAVED}`);
  }, [say, ws, staging, park]);

  /** "This photo needs no location" is a judgement like any other tag, and just
   *  as easy to make on the wrong selection — so it stages too, and Revert undoes
   *  it for free. */
  const stageIgnore = useCallback((ids: readonly number[] = [...ws.ref.current.selected]) => {
    if (!ids.length) { say("No photos selected", true); return; }
    const byId = new Map(ws.ref.current.photos.map((p) => [p.id, p]));
    const entries = ids.map((id) => byId.get(id)).filter((p): p is Photo => !!p).map(ignoreEntry);
    if (!entries.length) { say("Nothing to stage.", true); return; }
    park(entries);
    say(`Staged ${entries.length} photo(s) as needing no location.${NOTHING_SAVED}`);
  }, [ws, say, park]);

  /** The ids whose photo has a saved location — all a removal can act on. */
  const locatedIds = useCallback((ids: readonly number[]) => {
    const byId = new Map(ws.ref.current.photos.map((p) => [p.id, p]));
    return ids.filter((id) => byId.get(id)?.lat != null);
  }, [ws]);

  /** "Remove location" (U2) stages as well; a committed removal can still be
   *  taken back with "Undo last commit". */
  const stageRemove = useCallback((ids: readonly number[] = [...ws.ref.current.selected]) => {
    if (!ids.length) { say("No photos selected", true); return; }
    const located = locatedIds(ids);
    if (!located.length) {
      say(ids.length > 1 ? "None of the selected photos has a saved location to remove." : "That photo has no saved location to remove.", true);
      return;
    }
    const byId = new Map(ws.ref.current.photos.map((p) => [p.id, p]));
    park(located.map((id) => removeEntry(byId.get(id)!)));
    const skipped = ids.length - located.length;
    say(`Staged removing the location from ${located.length} photo(s).` +
      (skipped ? ` (${skipped} without a location left as they are.)` : "") + NOTHING_SAVED);
  }, [ws, say, locatedIds, park]);

  /* ── "Show nearby on map" ──
   * Answering "where was I that day?" means seeing the day's *geotagged* photos —
   * usually exactly the ones the Show toggles hide, since the reason you're here
   * is the untagged ones. So the map takes a day override that outranks the
   * toggles, and the grid is left alone. */
  const showDayOnMap = useCallback((photo: Photo) => {
    const key = dayKey(photo);
    if (!key) { say("That photo has no date, so it has no day to show.", true); return; }
    ws.update({ dayOverride: key, isolation: null });   // an isolation would fight the override
    const dayPhotos = ws.ref.current.photos.filter((p) => dayKey(p) === key);
    const located = dayPhotos.filter((p) => p.lat != null && p.lng != null);
    if (located.length) {
      map.run((m) => m.flyToBounds(latLngBounds(located.map((p) => [p.lat!, p.lng!])), { padding: [50, 50], maxZoom: 15, duration: 0.8 }));
    }
    say(`Map: ${located.length} of ${dayPhotos.length} photo(s) from ${key} (ignoring the Show toggles). Press Esc to clear.`);
  }, [ws, map, say]);

  const clearDayOnMap = useCallback(() => {
    if (!ws.ref.current.dayOverride) return;
    ws.update({ dayOverride: null });
    say("Map back to the filtered photos.");
  }, [ws, say]);

  const isolateDay = useCallback((day: string) => {
    ws.update((w) => ({ isolation: w.isolation === day ? null : day }));
  }, [ws]);

  const zoomTo = useCallback((points: { lat: number; lng: number }[], padding = 40, maxZoom = 16) => {
    if (!points.length) return;
    map.run((m) => m.flyToBounds(latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [padding, padding], maxZoom, duration: 0.8 }));
  }, [map]);

  const selectUntagged = useCallback((entries: GridEntry[], title: string) => {
    ws.update({ selected: new Set(entries.map((e) => e.photo.id)) });
    say(`Selected ${entries.length} untagged photo(s) on ${title}.`);
  }, [ws, say]);

  return useMemo(() => ({
    activate, move, extend, toggleFocused, selectOnly, stageDrop, stageIgnore, stageRemove, locatedIds,
    showDayOnMap, clearDayOnMap, isolateDay, zoomTo, selectUntagged,
  }), [activate, move, extend, toggleFocused, selectOnly, stageDrop, stageIgnore, stageRemove, locatedIds,
    showDayOnMap, clearDayOnMap, isolateDay, zoomTo, selectUntagged]);
}

export type GridActions = ReturnType<typeof useGridActions>;
