import { useCallback, useRef, useState } from "react";
import { getJson, type Schemas } from "../../api/client";
import { buildLocationChoices, loadRecent, pickerTimeSpan, type Hotspot, type LocationChoice } from "./locations";
import type { WorkspaceStore } from "./useWorkspace";

/* Opening "Tag as…": gather the choices (Recent, Saved places, Hotspots), then
 * show the dialog. Saved places are fetched fresh rather than read off the
 * page-load list, so places created on Named Places in another tab are there
 * without a reload. */

type Place = Schemas["PlaceItem"];

async function fetchHotspots(span: { from: number; to: number } | null): Promise<Hotspot[]> {
  const base = "/api/geotag/hotspots?limit=25&hide_named=true&sort=";
  const get = async (url: string) => (await getJson<Schemas["HotspotsResponse"]>(url)).hotspots || [];
  try {
    if (!span) return await get(base + "count");
    // sort=time drops places with nothing in the window, so a span with no
    // history at all comes back empty — fall back to the all-time favourites
    // rather than showing an empty section.
    const timed = await get(`${base}time&from_ts=${span.from}&to_ts=${span.to}`);
    return timed.length ? timed : await get(base + "count");
  } catch {
    return [];   // no geotags yet, or no geocode data installed
  }
}

export type TagAsDialogProps = { count: number; items: LocationChoice[]; onPick: (item: LocationChoice) => void; onClose: () => void };

export function useTagAs({ ws, say, onPick, fallbackPlaces }: {
  ws: WorkspaceStore;
  say: (msg: string, isError?: boolean) => void;
  onPick: (ids: number[], item: LocationChoice) => void;
  fallbackPlaces: () => readonly Place[];
}) {
  const [dialog, setDialog] = useState<TagAsDialogProps | null>(null);
  const deps = useRef({ say, onPick, fallbackPlaces });
  deps.current = { say, onPick, fallbackPlaces };

  /** `ids` defaults to the grid selection (the toolbar button and the "l" key);
   *  the photo menu passes its own target set. */
  const open = useCallback(async (ids: number[] = [...ws.ref.current.selected]) => {
    const { say } = deps.current;
    if (!ids.length) { say("Select some photos first, then pick a location.", true); return; }
    // Mid scope load (U4) the selection is the outgoing scope's.
    if (ws.ref.current.loading) return;
    say("Loading known locations…");
    let places: readonly Place[] = deps.current.fallbackPlaces();
    try {
      places = (await getJson<Place[]>("/api/places")).filter((p) => p.bounds_valid !== false);
    } catch { /* offline or a server hiccup — what the page loaded with */ }
    const hotspots = await fetchHotspots(pickerTimeSpan(ws.ref.current.photos, new Set(ids)));
    const items = buildLocationChoices(loadRecent(), places, hotspots);
    if (!items.length) {
      say("No saved places, recent locations or hotspots yet — drop photos on the map once and they'll show up here.", true);
      return;
    }
    say(`Pick a location for ${ids.length} photo(s).`);
    setDialog({
      count: ids.length,
      items,
      // Recents keep the accuracy they were tagged with; anything else follows
      // the Imprecise Drop toggle, like a map drop (the caller's onPick).
      onPick: (item) => { setDialog(null); deps.current.onPick(ids, item); },
      onClose: () => { setDialog(null); deps.current.say(""); },
    });
  }, [ws]);

  return { dialog, open };
}
