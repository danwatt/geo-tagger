import { useState } from "react";
import { TileLayer } from "react-leaflet";
import { BASEMAP_KEYS, BASEMAPS, basemapLayers, type BasemapKey } from "./basemaps";
import { MapControl } from "./MapControl";

/* Street / Satellite / Hybrid switcher. Port of web/basemaps.js setBasemap +
 * addBasemapControl: the active basemap's tile layer(s) plus the button stack in
 * the bottom-right corner (theme.css .basemap-control / .basemap-btn). Real
 * buttons with aria-pressed, so the switch works from the keyboard. */

export function BasemapButtons({ value, onChange }: { value: BasemapKey; onChange: (key: BasemapKey) => void }) {
  return (
    <div role="group" aria-label="Basemap">
      {BASEMAP_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className={`basemap-btn${key === value ? " active" : ""}`}
          aria-pressed={key === value}
          onClick={() => key !== value && onChange(key)}
        >
          {BASEMAPS[key].label}
        </button>
      ))}
    </div>
  );
}

export function BasemapSwitcher({ initial = "street" }: { initial?: BasemapKey }) {
  const [active, setActive] = useState<BasemapKey>(initial);
  return (
    <>
      {basemapLayers(active).map((layer, i) => (
        // Keyed by basemap so a switch removes the old layers and adds the new
        // ones; the reference overlay gets a higher zIndex so it can't land
        // under the imagery whatever order Leaflet loads them in.
        <TileLayer key={`${active}-${i}`} url={layer.url} zIndex={i + 1} {...layer.options} />
      ))}
      <MapControl position="bottomright" className="basemap-control">
        <BasemapButtons value={active} onChange={setActive} />
      </MapControl>
    </>
  );
}
