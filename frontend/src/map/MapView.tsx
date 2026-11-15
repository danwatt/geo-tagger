import type { ReactNode, Ref } from "react";
import { MapContainer, TileLayer } from "react-leaflet";
import type { Map as LeafletMap, LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import "./map.css";
import { BasemapSwitcher } from "./BasemapSwitcher";
import { WorldWrap } from "./WorldWrap";

/* The shared Leaflet map: owns the container and the base tile layer; layers
 * go in as children (react-leaflet components). Leaflet is bundled from npm on
 * ported pages, no CDN. `basemaps` swaps the fixed street layer for the Street /
 * Satellite / Hybrid switcher and keeps the view world-wrapped, as every legacy
 * page that loaded basemaps.js did. */

type Props = {
  id?: string;
  className?: string;
  center?: LatLngExpression;
  zoom?: number;
  mapRef?: Ref<LeafletMap>;
  basemaps?: boolean;
  children?: ReactNode;
};

export function MapView({ id, className, center = [39, -96], zoom = 4, mapRef, basemaps, children }: Props) {
  return (
    <MapContainer id={id} className={`map-view ${className ?? ""}`} center={center} zoom={zoom} ref={mapRef}>
      {basemaps ? (
        <>
          <BasemapSwitcher />
          <WorldWrap />
        </>
      ) : (
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="© OpenStreetMap contributors"
          maxZoom={19}
        />
      )}
      {children}
    </MapContainer>
  );
}

// Kept importable from here for the map pages; lives in lib so non-map code
// (canvas charts) can use it without pulling in Leaflet.
export { cssVar } from "../lib/cssVar";
