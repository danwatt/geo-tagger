import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import { geoJSON, type GeoJSON as LeafletGeoJSON, type GeoJSONOptions } from "leaflet";
import type { GeoJsonObject } from "geojson";

/* One L.geoJSON() layer, created once and refilled (clearLayers + addData)
 * whenever `data` changes; null clears it. Core Leaflet — GeoJSON needs no
 * plugin. `options` (style, onEachFeature, interactive) are read at creation:
 * Leaflet applies them per feature as it is added. */

export function GeoJsonLayer({ data, options }: { data: GeoJsonObject | null; options: GeoJSONOptions }) {
  const map = useMap();
  const layer = useRef<LeafletGeoJSON | null>(null);
  const opts = useRef(options);

  useEffect(() => {
    const l = geoJSON(undefined, opts.current).addTo(map);
    layer.current = l;
    return () => { l.remove(); layer.current = null; };
  }, [map]);

  useEffect(() => {
    const l = layer.current;
    if (!l) return;
    l.clearLayers();
    if (data) l.addData(data);
  }, [data, map]);

  return null;
}
