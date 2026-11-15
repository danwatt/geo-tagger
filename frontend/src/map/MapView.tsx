import type { ReactNode, Ref } from "react";
import { MapContainer, TileLayer } from "react-leaflet";
import type { Map as LeafletMap, LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import "./map.css";

/* The shared Leaflet map: owns the container and the base tile layer; layers
 * go in as children (react-leaflet components). Leaflet is bundled from npm on
 * ported pages, no CDN. Basemap switching (Street / Satellite / Hybrid) joins
 * here when the first page that needs it is ported. */

type Props = {
  id?: string;
  className?: string;
  center?: LatLngExpression;
  zoom?: number;
  mapRef?: Ref<LeafletMap>;
  children?: ReactNode;
};

export function MapView({ id, className, center = [39, -96], zoom = 4, mapRef, children }: Props) {
  return (
    <MapContainer id={id} className={`map-view ${className ?? ""}`} center={center} zoom={zoom} ref={mapRef}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="© OpenStreetMap contributors"
        maxZoom={19}
      />
      {children}
    </MapContainer>
  );
}

// Kept importable from here for the map pages; lives in lib so non-map code
// (canvas charts) can use it without pulling in Leaflet.
export { cssVar } from "../lib/cssVar";
