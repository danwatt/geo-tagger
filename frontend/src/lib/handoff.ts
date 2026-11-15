/* Search → Geocode hand-off (A3). Port of common.js stashSearchHandoff, sharing
 * its keys so the legacy Geocode page reads what this writes.
 *
 * "Open in Geocode" puts up to SEARCH_HANDOFF_URL_MAX ids in the URL (?ids=,
 * shareable, and well inside uvicorn's ~64 KB request line). A bigger set is
 * parked in this tab's sessionStorage under a one-off token and the URL carries
 * only ?handoff=<token>; same-tab navigation keeps sessionStorage, and the
 * Geocode page leaves the entry so a reload still works. Only the newest few
 * hand-offs are kept, so repeated opens can't fill the quota. */

export const SEARCH_HANDOFF_URL_MAX = 2000;
const SEARCH_HANDOFF_PREFIX = "geotagger.searchHandoff.";
const SEARCH_HANDOFF_KEEP = 3;

/** Park `ids` for the Geocode page; the token, or null when storage is
 *  unavailable or full (the caller then can't hand the set over). */
export function stashSearchHandoff(ids: number[]): string | null {
  try {
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const old: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(SEARCH_HANDOFF_PREFIX)) old.push(k);
    }
    // Tokens start with a base-36 timestamp, so a string sort is oldest-first.
    old.sort();
    old.slice(0, Math.max(0, old.length - (SEARCH_HANDOFF_KEEP - 1))).forEach((k) => sessionStorage.removeItem(k));
    sessionStorage.setItem(SEARCH_HANDOFF_PREFIX + token, JSON.stringify(ids));
    return token;
  } catch {
    return null;
  }
}

/** Page navigation, behind one function so tests can stub it (jsdom can't navigate). */
export const nav = {
  go(url: string): void {
    window.location.assign(url);
  },
  open(url: string): void {
    window.open(url, "_blank");
  },
};
