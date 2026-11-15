import { useEffect, useMemo, useRef } from "react";
import { Circle, Rectangle, Tooltip, useMap } from "react-leaflet";
import { circle as leafletCircle, marker as leafletMarker, type Marker } from "leaflet";
import { cssVar } from "../../lib/cssVar";
import { MarkerClusterLayer } from "../../map/MarkerClusterLayer";
import { parseShape } from "../../map/shapes";
import type { CameraColors } from "../../photos/cameraColors";
import { formatDelta } from "./guess";
import { guessPinIcon, photoPinIcon, sourcePinIcon, stagedPinIcon } from "./pinIcons";
import { placeBboxWithBuffer, type Place, type ScopeDef } from "./scope";
import { stagedPins, type Photo, type Staged } from "./staging";
import type { PendingGuess } from "./useGuess";

/* The Geocode map's layers. Saved-location pins are clustered (same library and
 * version as the legacy page), so a month of photos isn't thousands of live DOM
 * markers. Only those: staged, guess and accuracy layers go straight on the map
 * and are never hidden in a cluster. The cluster radius is kept small — about a
 * pin's width — so only pins already stacked on top of each other merge; pins
 * that stood apart stay individually clickable and draggable. */

const CLUSTER_OPTIONS = { maxClusterRadius: 30, chunkedLoading: true, showCoverageOnHover: false };

// What a pin was last drawn as, so an update only touches pins that changed.
const pinLook = new WeakMap<Marker, string>();
const lookOf = (photo: Photo, colors: CameraColors) => `${colors.color(photo.camera)}|${!!(photo.gps_accuracy && photo.gps_accuracy > 30)}`;

export function PhotoPins({ photos, colors, onClick, onDragEnd }: {
  photos: readonly Photo[];
  colors: CameraColors;
  onClick: (id: number) => void;
  /** Dragging a pin is the same "put this photo here" gesture as a grid drop,
   *  so it stages; the pin snaps back to the *saved* position meanwhile. */
  onDragEnd: (id: number, lat: number, lng: number) => void;
}) {
  const handlers = useRef({ onClick, onDragEnd });
  handlers.current = { onClick, onDragEnd };
  const byId = useRef(new Map<number, Photo>());
  byId.current = new Map(photos.map((p) => [p.id, p]));

  return (
    <MarkerClusterLayer
      items={photos}
      options={CLUSTER_OPTIONS}
      keyOf={(p) => p.id}
      toMarker={(photo) => {
        const look = lookOf(photo, colors);
        const m = leafletMarker([photo.lat!, photo.lng!], {
          draggable: true, icon: photoPinIcon(colors.color(photo.camera), look.endsWith("true")),
          title: photo.filename, alt: photo.filename,
        });
        pinLook.set(m, look);
        m.on("click", () => handlers.current.onClick(photo.id));
        m.on("dragend", () => {
          const ll = m.getLatLng();
          const cur = byId.current.get(photo.id);
          if (cur && cur.lat != null && cur.lng != null) m.setLatLng([cur.lat, cur.lng]);
          handlers.current.onDragEnd(photo.id, ll.lat, ll.lng);
        });
        return m;
      }}
      update={(m, photo) => {
        const ll = m.getLatLng();
        if (ll.lat !== photo.lat || ll.lng !== photo.lng) m.setLatLng([photo.lat!, photo.lng!]);
        const look = lookOf(photo, colors);
        if (pinLook.get(m) !== look) {
          m.setIcon(photoPinIcon(colors.color(photo.camera), look.endsWith("true")));
          pinLook.set(m, look);
        }
      }}
    />
  );
}

/** One provisional pin per distinct staged point (badged with the photo count),
 *  plus its uncertainty circle for imprecise drops. Rebuilt wholesale — there
 *  are only ever a handful. */
export function StagedPins({ staged }: { staged: Staged }) {
  const map = useMap();
  useEffect(() => {
    const gold = cssVar("--gold", "#e0a040");
    const layers = stagedPins(staged).flatMap((p) => {
      const out = [];
      if (p.accuracy) {
        out.push(leafletCircle([p.lat, p.lng], {
          radius: p.accuracy, color: gold, fillColor: gold, fillOpacity: 0.1,
          weight: 1.5, opacity: 0.6, dashArray: "5, 5", interactive: false,
        }).addTo(map));
      }
      const m = leafletMarker([p.lat, p.lng], { icon: stagedPinIcon(p.count), zIndexOffset: 500, keyboard: false }).addTo(map);
      m.bindTooltip(textEl(`Staged: ${p.count} photo(s) → ${p.label}`));
      out.push(m);
      return out;
    });
    return () => layers.forEach((l) => l.remove());
  }, [map, staged]);
  return null;
}

function textEl(text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function sourcePopup(src: PendingGuess["data"]["sources"][number]): HTMLElement {
  const box = document.createElement("div");
  box.className = "source-popup";
  const img = document.createElement("img");
  img.src = `/api/thumbnail/${src.id}`;
  img.alt = src.filename;
  const label = document.createElement("div");
  label.className = "source-popup-label";
  label.textContent = src.filename;
  const time = document.createElement("div");
  time.className = "source-popup-time";
  time.textContent = `${formatDelta(src.delta_sec)} ${src.is_before ? "before" : "after"}`;
  box.append(img, label, time);
  return box;
}

/** A pending guess: its source photos (before = blue, after = green, vivid when
 *  close in time) and the draggable guess pin on top. */
export function GuessLayer({ guess, onMove }: { guess: PendingGuess | null; onMove: (lat: number, lng: number) => void }) {
  const map = useMap();
  const move = useRef(onMove);
  move.current = onMove;
  const data = guess?.data;
  useEffect(() => {
    if (!data) return;
    const sources = data.sources.map((src) => leafletMarker([src.lat, src.lng], {
      icon: sourcePinIcon(src.delta_sec, src.is_before, data.window_sec), interactive: true,
    }).addTo(map).bindPopup(sourcePopup(src), { maxWidth: 160, className: "source-popup-wrap" }));
    const pin = leafletMarker([data.lat, data.lng], { icon: guessPinIcon(), draggable: true, zIndexOffset: 1000, title: "Guessed location (drag to refine)" }).addTo(map);
    pin.on("dragend", () => { const ll = pin.getLatLng(); move.current(ll.lat, ll.lng); });
    return () => { sources.forEach((m) => m.remove()); pin.remove(); };
  }, [map, data]);
  return null;
}

/** Saved places, read-only: creating and editing them is the Named Places page's. */
export function PlaceShapes({ places }: { places: readonly Place[] }) {
  const color = useMemo(() => cssVar("--accent", "#4a90d9"), []);
  return (
    <>
      {places.map((p) => {
        const shape = parseShape(p.type, p.bounds);
        if (!shape) return null;
        const tip = <Tooltip direction="top">{p.name}</Tooltip>;
        return shape.type === "rectangle" ? (
          <Rectangle key={p.id} bounds={[[shape.bounds.south, shape.bounds.west], [shape.bounds.north, shape.bounds.east]]}
            pathOptions={{ color, weight: 2, fillOpacity: 0.1 }}>{tip}</Rectangle>
        ) : (
          <Circle key={p.id} center={[shape.bounds.lat, shape.bounds.lng]} radius={shape.bounds.radius}
            pathOptions={{ color, weight: 2, fillOpacity: 0.1 }}>{tip}</Circle>
        );
      })}
    </>
  );
}

/** The loaded scope's own outline: a drawn area's circle, a place's (buffered)
 *  search bounds. */
export function ScopeOutline({ scope }: { scope: ScopeDef | null }) {
  const color = useMemo(() => cssVar("--accent", "#4a90d9"), []);
  if (scope?.kind === "area") {
    return <Circle center={[scope.lat, scope.lng]} radius={scope.radius} pathOptions={{ color, weight: 2, fillOpacity: 0.2 }} />;
  }
  if (scope?.kind === "place") {
    const b = placeBboxWithBuffer(scope.place, scope.buffer);
    return <Rectangle bounds={[[b.min_lat, b.min_lng], [b.max_lat, b.max_lng]]} pathOptions={{ color, weight: 2, dashArray: "5,5", fillOpacity: 0.05 }} />;
  }
  return null;
}

/** The focused photo's GPS accuracy, in its camera's colour. */
export function AccuracyCircle({ photo, colors }: { photo: Photo | null; colors: CameraColors }) {
  if (!photo || photo.lat == null || photo.lng == null || !(photo.gps_accuracy && photo.gps_accuracy > 0)) return null;
  const color = colors.color(photo.camera);
  return <Circle center={[photo.lat, photo.lng]} radius={photo.gps_accuracy}
    pathOptions={{ color, fillColor: color, fillOpacity: 0.12, weight: 1.5, opacity: 0.5, interactive: false }} />;
}
