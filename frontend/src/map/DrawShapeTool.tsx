import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import { circle as leafletCircle, latLngBounds, rectangle as leafletRectangle, type Circle, type LatLng, type Rectangle } from "leaflet";
import { cssVar } from "../lib/cssVar";
import { armMapDrawGesture } from "./drawGesture";
import { distanceMeters, isTooSmall, rectFromCorners, type Shape, type ShapeType } from "./shapes";

/* Press-drag-release drawing of one rectangle or circle (port of the drawing
 * half of web/custom-places.js). While `mode` is set the map is armed for one
 * gesture; the shape being drawn is previewed, and once released it *stays* on
 * the map until `mode` goes back to null — so the caller's name dialog is
 * answered with the area still in sight. A drag below the minimum size reports
 * onTooSmall instead of onDrawn. Drawing is mouse/touch/pen only; the caller's
 * Escape handling clears `mode` to cancel. */

export function DrawShapeTool({ mode, onDrawn, onTooSmall, onCancel }: {
  mode: ShapeType | null;
  onDrawn: (shape: Shape) => void;
  onTooSmall: () => void;
  onCancel: () => void;
}) {
  const map = useMap();
  const handlers = useRef({ onDrawn, onTooSmall, onCancel });
  handlers.current = { onDrawn, onTooSmall, onCancel };

  useEffect(() => {
    if (!mode) return;
    const style = { color: cssVar("--gold", "#e0a040"), weight: 2, fillOpacity: 0.2 };
    let preview: Rectangle | Circle | null = null;
    let start: LatLng | null = null;

    const shapeTo = (latlng: LatLng): Shape | null => {
      if (!start) return null;
      return mode === "rectangle"
        ? { type: "rectangle", bounds: rectFromCorners(start, latlng) }
        : { type: "circle", bounds: { lat: start.lat, lng: start.lng, radius: distanceMeters(start, latlng) } };
    };
    const onMove = (latlng: LatLng) => {
      if (!preview || !start) return;
      if (mode === "rectangle") (preview as Rectangle).setBounds([[start.lat, start.lng], [latlng.lat, latlng.lng]]);
      else (preview as Circle).setRadius(distanceMeters(start, latlng));
    };

    const disarm = armMapDrawGesture(map, {
      onStart: (latlng) => {
        start = latlng;
        preview = mode === "rectangle"
          ? leafletRectangle(latLngBounds(latlng, latlng), style).addTo(map)
          : leafletCircle(latlng, { radius: 0, ...style }).addTo(map);
      },
      onMove,
      onEnd: (latlng) => {
        // The release point counts too: a quick flick may have no move in between.
        onMove(latlng);
        const shape = shapeTo(latlng);
        if (!shape || isTooSmall(shape)) handlers.current.onTooSmall();
        else handlers.current.onDrawn(shape);
      },
      onCancel: () => handlers.current.onCancel(),
    });
    return () => {
      disarm();
      preview?.remove();
    };
  }, [map, mode]);

  return null;
}
