import { useEffect, useId, useRef, useState } from "react";
import { useMapEvents } from "react-leaflet";
import type { ControlPosition } from "leaflet";
import { MapControl } from "./MapControl";

/* A collapsed overlays panel in a map corner — the look of Leaflet's own layers
 * control (it reuses its classes and icon), but React-owned so the overlay
 * on/off state lives with the page that fetches for it, and keyboard-operable:
 * the toggle is a real button with aria-expanded, Enter/Space opens it and
 * moves focus to the first checkbox, Escape closes it and returns focus, and
 * Tabbing out closes it. Hovering opens it too, as the Leaflet control did. */

export type OverlayOption<K extends string> = { key: K; label: string };

export function OverlayToggles<K extends string>({ options, enabled, onToggle, position = "topright", label = "Map layers" }: {
  options: readonly OverlayOption<K>[];
  enabled: ReadonlySet<K>;
  onToggle: (key: K, on: boolean) => void;
  position?: ControlPosition;
  label?: string;
}) {
  // The map's own click collapses it, as Leaflet's control does.
  const [mapClicks, setMapClicks] = useState(0);
  useMapEvents({ click: () => setMapClicks((n) => n + 1) });
  return (
    <MapControl position={position} className="leaflet-control-layers overlay-toggles">
      <OverlayPanel options={options} enabled={enabled} onToggle={onToggle} label={label} closeSignal={mapClicks} />
    </MapControl>
  );
}

export function OverlayPanel<K extends string>({ options, enabled, onToggle, label, closeSignal = 0 }: {
  options: readonly OverlayOption<K>[];
  enabled: ReadonlySet<K>;
  onToggle: (key: K, on: boolean) => void;
  label: string;
  /** Changes when something outside (a map click) should collapse the panel. */
  closeSignal?: number;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);

  useEffect(() => {
    // Expanded from the keyboard: hand focus to the first checkbox, since the
    // toggle itself is hidden while the list shows (Leaflet's CSS).
    if (open && focusFirst.current) {
      focusFirst.current = false;
      listRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    }
  }, [open]);

  useEffect(() => { if (closeSignal) setOpen(false); }, [closeSignal]);

  return (
    // The control's own container carries .leaflet-control-layers; this wrapper
    // toggles the expanded class Leaflet's CSS keys off.
    <div
      className={open ? "overlay-toggles-inner leaflet-control-layers-expanded" : "overlay-toggles-inner"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <button
        ref={toggleRef} type="button" className="leaflet-control-layers-toggle" title={label} aria-label={label}
        aria-expanded={open} aria-controls={`${uid}-list`}
        onClick={() => { focusFirst.current = true; setOpen(true); }}
      />
      <div ref={listRef} id={`${uid}-list`} className="leaflet-control-layers-list" role="group" aria-label={label}>
        <div className="leaflet-control-layers-overlays">
          {options.map((o) => (
            <label key={o.key}>
              <input type="checkbox" className="leaflet-control-layers-selector" checked={enabled.has(o.key)}
                onChange={(e) => onToggle(o.key, e.target.checked)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
