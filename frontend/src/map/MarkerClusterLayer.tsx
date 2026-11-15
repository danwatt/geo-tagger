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
 * component per marker. `toMarker` builds each Leaflet marker; the layer is
 * replaced wholesale whenever `items` changes. */

// The plugin hangs its factory off the global L, which is the very object the
// "leaflet" import resolves to — read it from there so a bundler's CJS interop
// copy of the exports can't miss the late addition.
const globalL = () => (window as unknown as { L: typeof Leaflet }).L;

export function MarkerClusterLayer<T>({ items, toMarker, options }: {
  items: readonly T[];
  toMarker: (item: T) => Leaflet.Marker;
  options?: Leaflet.MarkerClusterGroupOptions;
}) {
  const map = useMap();
  const group = useRef<Leaflet.MarkerClusterGroup | null>(null);
  const build = useRef(toMarker);
  build.current = toMarker;
  const opts = useRef(options);

  useEffect(() => {
    const g = globalL().markerClusterGroup(opts.current);
    map.addLayer(g);
    group.current = g;
    return () => {
      map.removeLayer(g);
      group.current = null;
    };
  }, [map]);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    g.clearLayers();
    g.addLayers(items.map((item) => build.current(item)));
  }, [items, map]);

  return null;
}
