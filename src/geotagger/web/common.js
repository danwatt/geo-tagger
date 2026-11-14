/* Shared helpers loaded by every page before its own scripts.
 *
 * escapeHtml is the single defence against XSS from data we didn't author:
 * camera strings and filenames come from EXIF / the filesystem, place and
 * person names from the user's data and OSM extracts. Anything interpolated
 * into an innerHTML template, an HTML attribute value, or a Leaflet
 * tooltip/popup string (Leaflet treats those as HTML) must go through it.
 * Prefer textContent when no markup is needed.
 */

/** Escape text for use in HTML element content AND quoted attribute values. */
function escapeHtml(value) {
  // Quotes matter: the result is often placed inside title="…" / data-x="…".
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Full month names, index 0 = January. */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

/** localStorage key for the work-queue batches skipped on the Geocode page
 *  (written by app.js, counted/cleared by home.js). */
const SKIPPED_BATCHES_KEY = "geotagger.workqueue.skipped";

/** Reduce an untrusted URL (query param, stored value) to a same-origin
 *  path+query+hash, or return `fallback`. Guards `location.href = <param>`
 *  against javascript:/data: URLs and off-site redirects: anything that does
 *  not resolve to this origin over http(s) is rejected. Parsing against
 *  location.origin also normalises `//evil.com` and `/\evil.com` (browsers
 *  treat `\` as `/`), so those resolve off-origin and fail the check. */
function safeSameOriginPath(raw, fallback) {
  if (!raw) return fallback;
  try {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return fallback;
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.pathname + url.search + url.hash;
  } catch (_) {
    return fallback;
  }
}
