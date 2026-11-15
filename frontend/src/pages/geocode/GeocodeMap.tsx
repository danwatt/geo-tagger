import { useRef, useState } from "react";
import { circle as leafletCircle, point, type Circle as LeafletCircle } from "leaflet";
import { getJson, type Schemas } from "../../api/client";
import { cssVar } from "../../lib/cssVar";
import { MapView } from "../../map/MapView";
import { DrawShapeTool } from "../../map/DrawShapeTool";
import type { Shape } from "../../map/shapes";
import type { CameraColors } from "../../photos/cameraColors";
import { AccuracyCircle, GuessLayer, PhotoPins, PlaceShapes, ScopeOutline, StagedPins } from "./mapLayers";
import type { Place, ScopeDef } from "./scope";
import type { Photo, Staged } from "./staging";
import type { PendingGuess } from "./useGuess";
import type { MapHandle } from "./useMapHandle";

/* The map pane: the Imprecise Drop and Jump-to-location controls over the map,
 * and the map itself — photo pins, staged pins, the guess, saved places, the
 * scope outline, the focused photo's accuracy circle and the Select Area draw.
 * Photos dragged from the grid drop here (and stage); while one is dragged with
 * Imprecise Drop on, a dashed circle previews the radius under the pointer. */

// Values in metres, as the legacy page offered them (25 miles by default).
export const IMPRECISE_RADII: { value: string; label: string }[] = [
  { value: "160.934", label: "0.1 miles" },
  { value: "402.336", label: "0.25 miles" },
  { value: "804.672", label: "0.5 miles" },
  { value: "1609.34", label: "1 mile" },
  { value: "8046.72", label: "5 miles" },
  { value: "16093.44", label: "10 miles" },
  { value: "40233.6", label: "25 miles" },
  { value: "80467.2", label: "50 miles" },
];

export type Imprecise = { on: boolean; radius: string };

// The full Esri credit, as the legacy page gave its satellite imagery.
const ATTRIBUTIONS = {
  satellite: "Tiles © Esri — Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
};

export const DRAG_MIME = "application/json";

export function GeocodeMap(props: {
  map: MapHandle;
  pins: readonly Photo[];
  colors: CameraColors;
  staged: Staged;
  places: readonly Place[];
  scope: ScopeDef | null;
  focused: Photo | null;
  guess: PendingGuess | null;
  onGuessMove: (lat: number, lng: number) => void;
  drawing: boolean;
  onAreaDrawn: (shape: Shape) => void;
  onAreaTooSmall: () => void;
  onAreaCancel: () => void;
  onPinClick: (id: number) => void;
  onStageAt: (ids: number[], lat: number, lng: number) => void;
  /** Stage the selection at the map's centre — the keyboard path for a drop. */
  onStageAtCenter: () => void;
  selectedCount: number;
  imprecise: Imprecise;
  onImprecise: (v: Imprecise) => void;
  say: (msg: string, isError?: boolean) => void;
}) {
  const { map, imprecise } = props;
  const [query, setQuery] = useState("");
  const [dropTarget, setDropTarget] = useState(false);
  const dragCircle = useRef<LeafletCircle | null>(null);

  // Where a drag currently sits on the map, in map coordinates.
  function dragLatLng(e: React.DragEvent) {
    const m = map.get();
    if (!m) return null;
    const rect = m.getContainer().getBoundingClientRect();
    return m.containerPointToLatLng(point(e.clientX - rect.left, e.clientY - rect.top));
  }
  function clearDragCircle() {
    dragCircle.current?.remove();
    dragCircle.current = null;
  }

  // Offline: matches saved places and locations already in the library's photo
  // metadata (the Search page's location source). No online geocoder (CLAUDE.md):
  // a place with no photos or saved area won't be found.
  async function jump() {
    const q = query.trim();
    if (!q) return;
    try {
      const { locations } = await getJson<Schemas["LocationsResponse"]>(`/api/search/locations?q=${encodeURIComponent(q)}`);
      // Best-ranked match that has coordinates (metadata-only rows may not).
      const hit = locations.find((l) => l.bounds);
      if (!hit || !hit.bounds) {
        props.say(locations.length
          ? `"${locations[0]!.label}" has no GPS coordinates to jump to`
          : "No saved place or photo location matches — place search only knows places in your library");
        return;
      }
      const [s, w, n, e] = hit.bounds as [number, number, number, number];
      // A single photo gives a zero-size box; maxZoom keeps that from zooming to street level.
      map.run((m) => m.flyToBounds([[s, w], [n, e]], { maxZoom: 14, padding: [40, 40] }));
      props.say(`Flew to: ${hit.label}`);
    } catch (err) {
      props.say("Place search error: " + (err as Error).message, true);
    }
  }

  return (
    <div id="map-pane" className={dropTarget ? "drop-target" : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDropTarget(true);
        const ll = dragLatLng(e);
        const m = map.get();
        if (!ll || !m) return;
        if (imprecise.on) {
          const radius = parseFloat(imprecise.radius);
          if (!dragCircle.current) {
            const gold = cssVar("--gold", "#e0a040");
            dragCircle.current = leafletCircle(ll, {
              radius, color: gold, fillColor: gold, fillOpacity: 0.15, weight: 1.5, opacity: 0.6, dashArray: "5, 5", interactive: false,
            }).addTo(m);
          } else {
            dragCircle.current.setLatLng(ll);
            dragCircle.current.setRadius(radius);
          }
        } else {
          clearDragCircle();
        }
      }}
      onDragLeave={() => { setDropTarget(false); clearDragCircle(); }}
      onDrop={(e) => {
        e.preventDefault();
        setDropTarget(false);
        clearDragCircle();
        let ids: number[] = [];
        try { ids = JSON.parse(e.dataTransfer.getData(DRAG_MIME) || "[]") as number[]; } catch { /* not ours */ }
        const ll = dragLatLng(e);
        if (ids.length && ll) props.onStageAt(ids, ll.lat, ll.lng);
      }}
    >
      <div id="map-nav">
        <div className="toolbar-group imprecise-control-group">
          <label title="Drop photos with a specified uncertainty radius">
            <input type="checkbox" id="imprecise-toggle" checked={imprecise.on}
              onChange={(e) => props.onImprecise({ ...imprecise, on: e.target.checked })} />
            Imprecise Drop
          </label>
          {imprecise.on && (
            <select id="imprecise-radius-select" aria-label="Imprecise drop radius" value={imprecise.radius}
              onChange={(e) => props.onImprecise({ ...imprecise, radius: e.target.value })}>
              {IMPRECISE_RADII.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          )}
        </div>
        <div className="toolbar-group">
          <input id="place-search" type="text" placeholder="Jump to map location…" aria-label="Jump to map location"
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void jump(); } }} />
          <button type="button" id="place-search-btn" onClick={() => void jump()}>Go</button>
        </div>
        <div className="toolbar-group">
          <button type="button" id="stage-at-center-btn" disabled={!props.selectedCount}
            title="Stage the selected photos at the centre of the map — the keyboard alternative to dropping them on it"
            onClick={props.onStageAtCenter}>⌖ Drop at centre</button>
        </div>
      </div>
      <MapView id="map" mapRef={map.ref} center={[20, 0]} zoom={2} basemaps basemapAttributions={ATTRIBUTIONS}>
        <PlaceShapes places={props.places} />
        <ScopeOutline scope={props.scope} />
        <PhotoPins photos={props.pins} colors={props.colors} onClick={props.onPinClick}
          onDragEnd={(id, lat, lng) => props.onStageAt([id], lat, lng)} />
        <StagedPins staged={props.staged} />
        <AccuracyCircle photo={props.focused} colors={props.colors} />
        <GuessLayer guess={props.guess} onMove={props.onGuessMove} />
        <DrawShapeTool mode={props.drawing ? "circle" : null} onDrawn={props.onAreaDrawn}
          onTooSmall={props.onAreaTooSmall} onCancel={props.onAreaCancel} />
      </MapView>
    </div>
  );
}
