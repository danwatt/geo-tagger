import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Popup, useMap, useMapEvents } from "react-leaflet";
import { divIcon, marker as leafletMarker, polygon as leafletPolygon, type Map as LeafletMap, type PathOptions } from "leaflet";
import type { Feature, GeoJsonObject } from "geojson";
import { api, getJson, unwrap, type Schemas } from "../../api/client";
import { AppShell } from "../../shell/AppShell";
import { StatusBar } from "../../shell/StatusBar";
import { MapView, cssVar } from "../../map/MapView";
import { MarkerClusterLayer } from "../../map/MarkerClusterLayer";
import { GeoJsonLayer } from "../../map/GeoJsonLayer";
import { OverlayToggles } from "../../map/OverlayToggles";
import {
  DEFAULT_OVERLAYS, MIN_ZOOM_FOR_BUILDINGS, MIN_ZOOM_FOR_MARKERS, OSM_CATEGORY_TOKENS, OSM_OTHER_TOKEN, OVERLAYS,
  REFRESH_DEBOUNCE_MS, bboxParam, cellColor, mapHint, mapStatus, overlayErrorMessage, overlayMinZoom, type OverlayKey,
} from "./geoData";
import { ProbeResult, placePopupElement } from "./ProbeResult";
import "./map.css";

/* Geo Data (map.html, nav "Geo Data") — the reverse-geocode reference data on a
 * map, so you can check what place name a location in your library would
 * resolve to. Port of web/map.js.
 *
 * Past MIN_ZOOM_FOR_MARKERS, GeoNames places in view come from
 * /api/geocode/places, clustered. Past MIN_ZOOM_FOR_VORONOI, /api/geocode/voronoi
 * supplies each place's cell — the area a coordinate must fall in to
 * reverse-geocode to that place — drawn translucent under the markers. With the
 * population-weighted lookup on (the default) those boundaries are curved and
 * the server traces them off a grid, so a cell can come back as more than one
 * ring. Past their own thresholds, /api/geocode/osm-places, /census-places and
 * /zctas supply the polygon datasets the lookup consults, as GeoJSON. Each
 * overlay is toggled from the layers panel (top right) and fetched per viewport
 * only while it's on; every fetch is keyed by the view, so a pan supersedes (and
 * aborts) the previous one and a stale answer is never drawn. Click anywhere to
 * probe that point the way a photo taken there would be geocoded. */

type View = { zoom: number; bbox: string };
type Bounds = Schemas["LibraryBounds"];
type FeatureCollection = Schemas["FeatureCollection"];

function viewOf(map: LeafletMap): View {
  const b = map.getBounds();
  return { zoom: map.getZoom(), bbox: bboxParam({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }) };
}

export function GeoDataPage() {
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [overlays, setOverlays] = useState<ReadonlySet<OverlayKey>>(DEFAULT_OVERLAYS);
  const [probe, setProbe] = useState<{ lat: number; lng: number } | null>(null);

  // Open on the library: fit to the photos' extent, else keep the world view.
  useEffect(() => {
    if (!map) return;
    let live = true;
    getJson<Bounds>("/api/stats/bounds")
      .then((b) => {
        if (live && b.has_data) map.fitBounds([[b.min_lat!, b.min_lng!], [b.max_lat!, b.max_lng!]], { padding: [40, 40] });
      })
      .catch(() => { /* keep the default world view */ })
      .finally(() => { if (live) setView(viewOf(map)); });
    return () => { live = false; };
  }, [map]);

  const zoom = view?.zoom ?? 0;
  const bbox = view?.bbox ?? "";
  const wants = (key: OverlayKey) => !!view && overlays.has(key) && zoom >= overlayMinZoom(key);

  const markersOn = !!view && zoom >= MIN_ZOOM_FOR_MARKERS;
  const markersQ = useQuery({
    queryKey: ["geonames-places", bbox],
    enabled: markersOn,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/geocode/places", { params: { query: { bbox } }, signal })),
  });
  const voronoiQ = useQuery({
    queryKey: ["geonames-voronoi", bbox],
    enabled: wants("voronoi"),
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/geocode/voronoi", { params: { query: { bbox } }, signal })),
  });
  const buildings = zoom >= MIN_ZOOM_FOR_BUILDINGS;
  const osmQ = useQuery({
    queryKey: ["osm-places", bbox, buildings],
    enabled: wants("osm"),
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/geocode/osm-places", { params: { query: { bbox, buildings } }, signal })),
  });
  const censusQ = useQuery({
    queryKey: ["census-places", bbox],
    enabled: wants("census"),
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/geocode/census-places", { params: { query: { bbox } }, signal })),
  });
  const zctaQ = useQuery({
    queryKey: ["zctas", bbox],
    enabled: wants("zcta"),
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/geocode/zctas", { params: { query: { bbox } }, signal })),
  });

  // A layer that's off, or zoomed out past its threshold, draws nothing — even
  // if an earlier answer is still cached.
  const markerPlaces = useMemo(() => (markersOn && markersQ.data ? markersQ.data.places : []), [markersOn, markersQ.data]);
  const cells = wants("voronoi") ? voronoiQ.data?.cells ?? null : null;
  const geo = (on: boolean, d: FeatureCollection | undefined) => (on && d ? (d as unknown as GeoJsonObject) : null);

  const overlayErrors = ([
    ["osm", osmQ], ["census", censusQ], ["zcta", zctaQ],
  ] as const).flatMap(([key, q]) => (wants(key) && q.isError ? [overlayErrorMessage(key, q.error)] : []));
  const status = mapStatus({
    zoom, markersLoading: markersOn && markersQ.isFetching, markersError: markersOn ? markersQ.error : null,
    markers: markersOn ? markersQ.data : undefined, overlayErrors,
  });
  const hint = view ? mapHint(zoom, overlays, markersOn ? markersQ.error : null) : null;

  const onToggle = useCallback((key: OverlayKey, on: boolean) => {
    setOverlays((prev) => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  return (
    <AppShell active="map">
      <div id="main">
        <MapView id="map" mapRef={setMap} center={[20, 0]} zoom={2} basemaps>
          <ViewTracker onView={setView} onClick={setProbe} />
          {/* Cells first so they render underneath; the OSM outlines draw over
              the translucent fills; markers sit in their own pane above all. */}
          <VoronoiLayer cells={cells} />
          <GeoJsonLayer data={geo(wants("osm"), osmQ.data)} options={OSM_OPTIONS} />
          <GeoJsonLayer data={geo(wants("census"), censusQ.data)} options={CENSUS_OPTIONS} />
          <GeoJsonLayer data={geo(wants("zcta"), zctaQ.data)} options={ZCTA_OPTIONS} />
          <MarkerClusterLayer items={markerPlaces} toMarker={placeMarker} options={{ maxClusterRadius: 60 }} />
          <OverlayToggles options={OVERLAYS} enabled={overlays} onToggle={onToggle} label="Boundary overlays" />
          {probe && <ProbePopup key={`${probe.lat},${probe.lng}`} at={probe} onClosed={() => setProbe((p) => (p === probe ? null : p))} />}
        </MapView>
        <div id="map-hint" className={hint ? "visible" : undefined} aria-live="polite">{hint}</div>
      </div>
      <StatusBar status={status} />
    </AppShell>
  );
}

/** Debounced view tracking (a pan fires many moveends' worth of frames), plus
 *  the click-to-probe. */
function ViewTracker({ onView, onClick }: { onView: (v: View) => void; onClick: (at: { lat: number; lng: number }) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const map = useMapEvents({
    moveend: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onView(viewOf(map)), REFRESH_DEBOUNCE_MS);
    },
    click: (e) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }),
  });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return null;
}

// Click anywhere on the map to reverse-geocode that exact point the way a photo
// taken there would be, and show what would be persisted. Keyed by the point,
// so a second click supersedes the first and its answer never lands here.
function ProbePopup({ at, onClosed }: { at: { lat: number; lng: number }; onClosed: () => void }) {
  const q = useQuery({
    queryKey: ["geocode-probe", at.lat, at.lng],
    retry: false,
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/geocode/lookup", { params: { query: { lat: at.lat, lng: at.lng } }, signal })),
  });
  return (
    <Popup position={[at.lat, at.lng]} className="map-popup-wrap" eventHandlers={{ remove: onClosed }}>
      <ProbeResult data={q.data} loading={q.isPending} error={q.error} />
    </Popup>
  );
}

/* ── Voronoi cells ──
 * One L.polygon per ring rather than one multi-ring polygon: Leaflet reads
 * trailing rings as holes, which is wrong for the disjoint pieces a grid-traced
 * weighted cell can break into. Not interactive, so clicks fall through to the
 * probe. */
function VoronoiLayer({ cells }: { cells: Schemas["VoronoiCell"][] | null }) {
  const map = useMap();
  useEffect(() => {
    if (!cells) return;
    const layers = cells.flatMap((cell) => {
      const color = cellColor(cell.city || `${cell.lat},${cell.lng}`);
      return (cell.polygons.length ? cell.polygons : [cell.polygon]).map((ring) =>
        leafletPolygon(ring as [number, number][], { color, weight: 1.5, opacity: 0.8, fillColor: color, fillOpacity: 0.12, interactive: false }).addTo(map));
    });
    return () => layers.forEach((l) => l.remove());
  }, [map, cells]);
  return null;
}

type GeoNamesPlace = Schemas["GeoNamesPlace"];

function placeMarker(place: GeoNamesPlace) {
  const m = leafletMarker([place.lat, place.lng], {
    icon: divIcon({ html: `<span class="place-dot"></span>`, className: "", iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6] }),
    title: place.city ?? undefined,
  });
  m.bindPopup(() => placePopupElement(place), { className: "map-popup-wrap" });
  return m;
}

/* ── Overlay styles ──
 * All interactive:false, so clicks fall through to the map's own click handler
 * (the probe) everywhere — including inside a polygon — instead of the polygon
 * swallowing the click. The polygon's name still surfaces: the probe
 * reverse-geocodes the clicked point. */

const tokenColor = ([token, fallback]: [string, string]) => cssVar(token, fallback);

const OSM_OPTIONS = {
  interactive: false,
  style: (feature?: Feature): PathOptions => {
    const category = String(feature?.properties?.category ?? "");
    const color = tokenColor(OSM_CATEGORY_TOKENS[category] ?? OSM_OTHER_TOKEN);
    return { color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.12 };
  },
};

// Census places: one colour, dashed, no fill — they tile the map wall-to-wall,
// so a fill would bury everything under it, and the dashes distinguish a CDP
// boundary from the OSM city boundary it may sit on top of.
const CENSUS_OPTIONS = {
  interactive: false,
  style: (feature?: Feature): PathOptions => ({
    color: feature?.properties?.kind === "CDP" ? cssVar("--census-cdp", "#ffd166") : cssVar("--census-place", "#f4a259"),
    weight: 2, opacity: 0.95, dashArray: "6 4", fill: false,
  }),
};

// ZIP areas: solid outline in their own hue, plus a permanent centroid label —
// "77070" alone means nothing on a map, and the mailing city next to it is
// exactly what the geocoder would fall back to for a photo inside this polygon.
// Magenta because every other hue on this map is taken or camouflaged: blue
// reads as water (and is OSM's city colour), green as parks, yellow/orange are
// the Census place outlines these sit directly on top of.
const ZCTA_OPTIONS = {
  interactive: false,
  style: (): PathOptions => ({ color: cssVar("--zcta", "#ff3ecb"), weight: 2, opacity: 0.95, fill: false }),
  onEachFeature: (feature: Feature, layer: { bindTooltip: (content: HTMLElement, opts: object) => unknown }) => {
    const { zip, city } = (feature.properties ?? {}) as { zip?: string; city?: string | null };
    const label = document.createElement("span");
    label.textContent = city ? `${zip} · ${city}` : String(zip ?? "");
    layer.bindTooltip(label, { permanent: true, direction: "center", className: "zcta-label" });
  },
};
