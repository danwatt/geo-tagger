import { divIcon, type DivIcon } from "leaflet";
import { cssVar } from "../../lib/cssVar";
import { sourcePinStyle } from "./guess";

/* The map's pin icons, as the legacy page drew them (SVG in a divIcon). The
 * colours are data (a camera's colour, a time-proximity hue) or theme tokens
 * read through cssVar, since Leaflet needs concrete values. */

/** Saved-location pin: an SVG teardrop in the camera's colour. Imprecise pins
 *  (an accuracy radius over 30 m) get a dashed outline and a hollow centre. */
export function photoPinIcon(color: string, imprecise: boolean): DivIcon {
  const strokeDash = imprecise ? 'stroke-dasharray="3,2"' : "";
  const inner = imprecise
    ? `<circle cx="12" cy="12" r="5" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.2" stroke-dasharray="1.5,1"/>`
    : `<circle cx="12" cy="12" r="5" fill="rgba(255,255,255,0.35)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="0 0 24 34">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 8 12 22 12 22s12-14 12-22C24 5.373 18.627 0 12 0z"
          fill="${color}" stroke="rgba(0,0,0,0.55)" stroke-width="1.5" ${strokeDash}/>
    ${inner}
  </svg>`;
  // className "" suppresses Leaflet's default white box; the anchor is the tip.
  return divIcon({ html: svg, className: "", iconSize: [24, 34], iconAnchor: [12, 34], popupAnchor: [0, -34] });
}

/** Staged pin: a dashed amber teardrop with the photo count — deliberately unlike
 *  the solid camera-coloured pins, so "not saved yet" reads at a glance. */
export function stagedPinIcon(count: number): DivIcon {
  const gold = cssVar("--gold", "#e0a040");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="0 0 24 34">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 8 12 22 12 22s12-14 12-22C24 5.373 18.627 0 12 0z"
          fill="${gold}" fill-opacity="0.85" stroke="#fff2d8" stroke-width="1.5" stroke-dasharray="3,2"/>
    <text x="12" y="16" text-anchor="middle" font-size="11" font-weight="bold"
          font-family="system-ui, sans-serif" fill="#3a2a08">${Number(count)}</text>
  </svg>`;
  return divIcon({ html: svg, className: "", iconSize: [24, 34], iconAnchor: [12, 34] });
}

/** The guess pin: a dashed-outline amber "?" pin, distinct from confirmed pins. */
export function guessPinIcon(): DivIcon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38">
    <path d="M14 1C7.373 1 2 6.373 2 13c0 9 12 24 12 24S26 22 26 13C26 6.373 20.627 1 14 1z"
          fill="#f0a500" fill-opacity="0.85" stroke="#fff" stroke-width="2" stroke-dasharray="4 3"/>
    <circle cx="14" cy="13" r="5" fill="rgba(255,255,255,0.4)"/>
    <text x="14" y="17" text-anchor="middle" font-size="9" fill="white" font-family="sans-serif">?</text>
  </svg>`;
  return divIcon({ html: svg, className: "", iconSize: [28, 38], iconAnchor: [14, 38], popupAnchor: [0, -38] });
}

/** A guess's source photo: a small circle, clearly distinct from the teardrops. */
export function sourcePinIcon(deltaSec: number, isBefore: boolean, windowSec: number): DivIcon {
  const s = sourcePinStyle(deltaSec, isBefore, windowSec);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s.size}" height="${s.size}" viewBox="0 0 ${s.size} ${s.size}">
    <circle cx="${s.size / 2}" cy="${s.size / 2}" r="${s.r}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="2"/>
  </svg>`;
  return divIcon({ html: svg, className: "", iconSize: [s.size, s.size], iconAnchor: [s.size / 2, s.size / 2], tooltipAnchor: [0, -(s.size / 2)] });
}
