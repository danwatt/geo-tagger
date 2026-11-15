import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMap } from "react-leaflet";
import { Control, DomEvent, DomUtil, type ControlPosition } from "leaflet";

/* A Leaflet control whose contents are React: Leaflet owns the corner and the
 * container div, React renders into it through a portal. Clicks and scrolls are
 * kept from reaching the map, as every Leaflet control does — otherwise a press
 * on a button would also pan the map, or fire its click-to-probe. Must be a
 * child of a MapContainer. */

export function MapControl({ position, className, children }: {
  position: ControlPosition;
  className: string;
  children: ReactNode;
}) {
  const map = useMap();
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const control = new Control({ position });
    control.onAdd = () => {
      const div = DomUtil.create("div", className);
      DomEvent.disableClickPropagation(div);
      DomEvent.disableScrollPropagation(div);
      return div;
    };
    control.addTo(map);
    setContainer(control.getContainer() ?? null);
    return () => {
      control.remove();
      setContainer(null);
    };
  }, [map, position, className]);

  return container ? createPortal(children, container) : null;
}
