/** A theme.css token's current value, for APIs that need a concrete colour
 *  (Leaflet options, canvas fill styles). */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
