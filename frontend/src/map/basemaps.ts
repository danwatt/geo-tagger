/* Basemap definitions. Port of web/basemaps.js's BASEMAPS: the same tile URLs,
 * attribution and options. Tiles come only from OSM and server.arcgisonline.com
 * (the sanctioned runtime network dependencies — see CLAUDE.md). The legacy
 * switcher never remembered a choice across visits, so every map opens on Street. */

export type BasemapKey = "street" | "satellite" | "hybrid";

export type BasemapDef = {
  label: string;
  url: string;
  /** Hybrid only: Esri's boundaries-and-places reference overlay on top of the imagery. */
  overlayUrl?: string;
  options: { attribution: string; maxZoom: number };
};

const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export const BASEMAPS: Record<BasemapKey, BasemapDef> = {
  street: {
    label: "Street",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { attribution: "© OpenStreetMap contributors", maxZoom: 19 },
  },
  satellite: {
    label: "Satellite",
    url: ESRI_IMAGERY,
    options: { attribution: "Tiles © Esri", maxZoom: 19 },
  },
  hybrid: {
    label: "Hybrid",
    url: ESRI_IMAGERY,
    overlayUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    options: { attribution: "Tiles © Esri", maxZoom: 19 },
  },
};

export const BASEMAP_KEYS = Object.keys(BASEMAPS) as BasemapKey[];

/** The tile layers a basemap draws, bottom first. */
export function basemapLayers(key: BasemapKey): { url: string; options: { attribution?: string; maxZoom: number; opacity?: number } }[] {
  const def = BASEMAPS[key];
  const layers: { url: string; options: { attribution?: string; maxZoom: number; opacity?: number } }[] = [
    { url: def.url, options: def.options },
  ];
  if (def.overlayUrl) layers.push({ url: def.overlayUrl, options: { maxZoom: 19, opacity: 1 } });
  return layers;
}
