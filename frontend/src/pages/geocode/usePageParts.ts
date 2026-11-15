import { useCallback, useRef, useState } from "react";
import { latLng, latLngBounds } from "leaflet";
import type { Shape } from "../../map/shapes";
import type { LocationItem } from "../../ui/LocationPicker";
import type { Place, ScopeDef } from "./scope";
import { groupStaged, type DropEntry } from "./staging";
import type { CommitFlow } from "./useCommitFlow";
import type { MapHandle } from "./useMapHandle";
import type { Restored } from "./useStartup";
import type { Staging } from "./useStaging";

/* Three small pieces of page state with their own rules: the Location box, the
 * Select Area draw, and the staged-restore banner (U7). */

type Load = (def: ScopeDef, opts?: { fitMap?: boolean }) => Promise<unknown>;

/** The Location box's text and what a pick loads. The text names the loaded
 *  place or recorded location, and is cleared by any other scope. */
export function useLocationScope() {
  const [text, setTextState] = useState("");
  const textRef = useRef(text);
  const [editing, setEditing] = useState(false);
  const setText = useCallback((t: string) => { textRef.current = t; setTextState(t); }, []);

  const entered = useCallback((def: ScopeDef) => {
    setText(def.kind === "place" ? def.place.name : def.kind === "location" ? def.item.label : "");
    setEditing(false);
  }, [setText]);

  /** A pick: a saved place loads its bounds (buffer back to "Within bounds"),
   *  a recorded location the photos recorded there. */
  const pick = useCallback(async (item: LocationItem, refreshPlaces: () => Promise<readonly Place[]>, load: Load,
    say: (msg: string, isError?: boolean) => void) => {
    if (item.kind !== "place") { await load({ kind: "location", item }, { fitMap: true }); return; }
    // Refresh the shapes as well: saved places may have changed in another tab.
    let places: readonly Place[] = [];
    try { places = await refreshPlaces(); } catch { /* fall through to "unavailable" */ }
    // Typed over while the places were loading: that pick no longer stands.
    if (textRef.current !== item.label) return;
    const place = places.find((p) => p.id === item.id);
    if (!place) { say("Saved place is unavailable. Choose another location.", true); return; }
    await load({ kind: "place", place, buffer: 0 });
  }, []);

  return { text, setText, editing, edit: useCallback(() => setEditing(true), []), entered, pick };
}

/** Select Area: one press-drag-release circle on the map (DrawShapeTool), or the
 *  circle that fits the visible map (the keyboard path). */
export function useAreaSelect({ map, say, load }: { map: MapHandle; say: (msg: string, isError?: boolean) => void; load: Load }) {
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  const set = (on: boolean) => { drawingRef.current = on; setDrawing(on); };

  const cancel = useCallback(() => { set(false); say("Area selection cancelled"); }, [say]);
  const toggle = useCallback(() => {
    if (drawingRef.current) { cancel(); return; }
    set(true);
    say("Draw a circle on the map to select photos in that area (Esc cancels)");
  }, [cancel, say]);
  const drawn = useCallback((shape: Shape) => {
    set(false);
    if (shape.type !== "circle") return;
    void load({ kind: "area", lat: shape.bounds.lat, lng: shape.bounds.lng, radius: shape.bounds.radius }, { fitMap: true });
  }, [load]);
  // A status line, not an alert(): nothing happened, so there is nothing to
  // acknowledge — the drag just didn't take.
  const tooSmall = useCallback(() => { set(false); say("That area is too small — drag further to set its size.", true); }, [say]);
  const useMapView = useCallback(() => {
    const m = map.get();
    if (!m) return;
    const c = m.getCenter(), b = m.getBounds();
    const radius = Math.min(c.distanceTo(latLng(b.getNorth(), c.lng)), c.distanceTo(latLng(c.lat, b.getEast())));
    set(false);
    void load({ kind: "area", lat: c.lat, lng: c.lng, radius }, { fitMap: true });
  }, [map, load]);

  return { drawing, toggle, cancel, cancelled: cancel, drawn, tooSmall, useMapView };
}

/** The "uncommitted changes from your last visit" banner. Its Commit and
 *  Discard act on the restored photos still staged — not on drops made since. */
export function useRestoreBanner({ staging, map, say, commit }: {
  staging: Staging;
  map: MapHandle;
  say: (msg: string, isError?: boolean) => void;
  commit: CommitFlow;
}) {
  const [state, setState] = useState<{ ids: number[]; detail: string; hidden: boolean } | null>(null);
  const show = useCallback((r: Restored) => setState({ ids: r.ids, detail: r.detail, hidden: false }), []);
  const still = () => (state ? state.ids.filter((id) => staging.ref.current.has(id)) : []);
  const remaining = state ? state.ids.filter((id) => staging.staged.has(id)).length : 0;
  const what = "restored from your last visit";
  const groups = () => groupStaged(still().map((id) => staging.ref.current.get(id)!));
  return {
    show,
    visible: !!state && !state.hidden && remaining > 0,
    props: {
      remaining,
      detail: state?.detail ?? "",
      onReview: () => {
        document.getElementById("pending-pane")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        const pts = still().map((id) => staging.ref.current.get(id)!).filter((e): e is DropEntry => e.kind === "drop");
        if (pts.length) map.run((m) => m.flyToBounds(latLngBounds(pts.map((e) => [e.lat, e.lng])), { padding: [60, 60], maxZoom: 15, duration: 0.6 }));
        say(`Restored ${still().length} staged change(s) — nothing is saved until you Commit.`);
      },
      onCommit: () => commit.commit(groups(), what),
      onDiscard: () => commit.revert(groups(), what),
      onClose: () => setState((s) => (s ? { ...s, hidden: true } : s)),
    },
  };
}
