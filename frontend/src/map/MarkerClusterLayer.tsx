import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
// Order matters: leaflet.markercluster is a UMD script that extends the global
// `L` (Leaflet's own UMD build sets window.L), so Leaflet must evaluate first.
import "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type * as Leaflet from "leaflet";

/* Marker clustering (leaflet.markercluster, bundled from npm at the version the
 * legacy pages pinned on the CDN). Imperative on purpose: a viewport can carry
 * thousands of points, and one addLayers() batch is far cheaper than a React
 * component per marker. `toMarker` builds each Leaflet marker.
 *
 * Two modes:
 *   · default — the layer is replaced wholesale whenever `items` changes;
 *   · keyed (`keyOf` given) — the markers already up are diffed against `items`
 *     by key: stale ones leave and new ones arrive in one removeLayers /
 *     addLayers batch each (one re-cluster, not one per pin), and a kept one is
 *     handed to `update(marker, item)` to move or restyle itself only if it
 *     changed (a move re-files it in the cluster tree, a new icon rebuilds its
 *     DOM). For a pin set that changes a little at a time — Geocode's, on every
 *     stage, commit and filter flip. */

// The plugin hangs its factory off the global L, which is the very object the
// "leaflet" import resolves to — read it from there so a bundler's CJS interop
// copy of the exports can't miss the late addition.
const globalL = () => (window as unknown as { L: typeof Leaflet }).L;

export function MarkerClusterLayer<T>({ items, toMarker, options, keyOf, update }: {
  items: readonly T[];
  toMarker: (item: T) => Leaflet.Marker;
  options?: Leaflet.MarkerClusterGroupOptions;
  keyOf?: (item: T) => string | number;
  update?: (marker: Leaflet.Marker, item: T) => void;
}) {
  const map = useMap();
  const group = useRef<Leaflet.MarkerClusterGroup | null>(null);
  const live = useRef(new Map<string | number, Leaflet.Marker>());
  const fns = useRef({ toMarker, keyOf, update });
  fns.current = { toMarker, keyOf, update };
  const opts = useRef(options);

  useEffect(() => {
    const g = globalL().markerClusterGroup(opts.current);
    map.addLayer(g);
    group.current = g;
    const markers = live.current;
    return () => {
      map.removeLayer(g);
      group.current = null;
      markers.clear();
    };
  }, [map]);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    const { toMarker: build, keyOf: key, update: refresh } = fns.current;
    if (!key) {
      g.clearLayers();
      g.addLayers(items.map((item) => build(item)));
      return;
    }
    const markers = live.current;
    const wanted = new Map<string | number, T>();
    items.forEach((item) => wanted.set(key(item), item));
    const stale: Leaflet.Marker[] = [];
    markers.forEach((m, k) => {
      if (!wanted.has(k)) { stale.push(m); markers.delete(k); }
    });
    if (stale.length) g.removeLayers(stale);
    const fresh: Leaflet.Marker[] = [];
    wanted.forEach((item, k) => {
      const existing = markers.get(k);
      if (existing) { refresh?.(existing, item); return; }
      const m = build(item);
      markers.set(k, m);
      fresh.push(m);
    });
    if (fresh.length) g.addLayers(fresh);
  }, [items, map]);

  return null;
}
