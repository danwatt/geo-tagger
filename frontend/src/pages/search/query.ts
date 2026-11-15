/* The Search page's pure logic: form → query string, paging arithmetic and the
 * summary/banner/selection texts. Kept framework-free so the rules can be tested
 * directly (and match search.js line for line where the comments say so). */

import type { Schemas } from "../../api/client";
import type { DateRange } from "../../ui/DateRangePicker";
import type { LocationItem } from "../../ui/LocationPicker";

export type SearchPhoto = Schemas["SearchPhoto"];
export type Candidate = Schemas["UntaggedCandidate"];
export type Person = { id: number; name: string };
export type Sort = "relevance" | "date_asc" | "date_desc" | "filename" | "camera";

export type SearchForm = {
  text: string;
  /** Photo picked via "More like this", until text is typed or Clear. */
  similarTo: { id: number; filename: string } | null;
  locationText: string;
  location: LocationItem | null;
  /** Miles to grow a saved place's bounds by ("0" = within bounds). */
  nearby: string;
  dateRange: DateRange;
  undatedOnly: boolean;
  geotagged: "all" | "yes" | "no";
  camera: string;
  folder: string;
  gpsAccuracy: "all" | "precise" | "imprecise";
  hasFaces: "all" | "yes" | "no";
  sort: Sort;
  persons: Person[];
  personMode: "all" | "any";
};

export const EMPTY_FORM: SearchForm = {
  text: "", similarTo: null, locationText: "", location: null, nearby: "0",
  dateRange: { from: null, to: null, preset: null, label: null }, undatedOnly: false,
  geotagged: "all", camera: "", folder: "", gpsAccuracy: "all", hasFaces: "all",
  sort: "date_asc", persons: [], personMode: "all",
};

export const NEARBY_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "Within bounds" },
  { value: "0.1", label: "+0.1 miles" },
  { value: "0.25", label: "+0.25 miles" },
  { value: "0.5", label: "+0.5 miles" },
  { value: "1", label: "+1 mile" },
  { value: "2", label: "+2 miles" },
  { value: "5", label: "+5 miles" },
  { value: "10", label: "+10 miles" },
];

const METRES_PER_MILE = 1609.34;

/** The /api/search (and /api/search/untagged-faces) query for a form. Port of
 *  search.js buildQuery: the same parameters in the same order, so the server
 *  sees exactly what the legacy page sent. Throws on an inverted date range. */
export function buildQuery(f: SearchForm): URLSearchParams {
  const params = new URLSearchParams();
  const text = f.text.trim();
  const location = f.locationText.trim();

  // A typed description wins over a pending "More like this" — they're two
  // different queries for the same ranking slot (the API rejects both at once).
  if (text) params.set("text", text);
  else if (f.similarTo) params.set("similar_to", String(f.similarTo.id));
  if (f.undatedOnly) {
    params.set("undated", "true");
  } else {
    const { from, to } = f.dateRange;
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    if (from && to && from > to) throw new Error("From date must be on or before To date.");
  }
  if (f.location?.kind === "place" && f.location.id != null) {
    params.set("place_id", String(f.location.id));
    params.set("nearby_m", String(Number(f.nearby) * METRES_PER_MILE));
  } else if (f.location?.kind === "metadata") {
    params.set("location_fields", JSON.stringify(f.location.fields));
  } else if (location) {
    params.set("location", location);
  }
  if (f.geotagged !== "all") params.set("geotagged", f.geotagged);
  if (f.camera) params.set("camera", f.camera);
  if (f.folder) params.set("dir", f.folder);
  if (f.gpsAccuracy !== "all") params.set("gps_accuracy", f.gpsAccuracy);
  if (f.hasFaces !== "all") params.set("has_faces", f.hasFaces);
  // "Best match" only means something with a ranking query; without one, fall
  // back to the API's date default rather than sending a sort it would reject.
  const rankedQuery = params.has("text") || params.has("similar_to");
  if (f.sort === "relevance") {
    if (rankedQuery) params.set("sort", f.sort);
  } else if (f.sort !== "date_asc" || rankedQuery) {
    params.set("sort", f.sort);
  }
  if (f.persons.length > 0) {
    params.set("person_ids", f.persons.map((p) => p.id).join(","));
    params.set("person_mode", f.personMode);
  }
  return params;
}

/** Typing a description: it replaces a pending "More like this", and a ranking
 *  query defaults to Best match; clearing it (with nothing else ranking) goes
 *  back to date order. Port of search.js onTextInput. */
export function withText(f: SearchForm, text: string): SearchForm {
  const next = { ...f, text };
  if (text.trim()) {
    next.similarTo = null;
    if (next.sort === "date_asc") next.sort = "relevance";
  } else if (!next.similarTo && next.sort === "relevance") {
    next.sort = "date_asc";
  }
  return next;
}

/** "More like this": a similarity query on the focused photo, ranked. */
export function withSimilar(f: SearchForm, photo: { id: number; filename: string }): SearchForm {
  return { ...f, similarTo: photo, text: "", sort: "relevance" };
}

/* ── Paging (A3) ──
 * /api/search returns one page (config SEARCH_PAGE_SIZE, 2000 by default) plus
 * the true `total`; the rest is reachable through the "Load more" banner, same
 * UX as People's (U5). `key` is the query string the results came from (minus
 * paging) — Load more / Select all matches continue *that* search even if the
 * form has been edited since; `loaded` counts server rows consumed (the next
 * page's offset); `pageSize` is the server's default page, learned from the
 * first response. */

export const SEARCH_REQUEST_MAX = 20000;   // /api/search caps `limit` here
export const UNTAGGED_REQUEST_MAX = 5000;  // /api/search/untagged-faces' cap

export type Paging = {
  key: string | null;
  total: number;
  loaded: number;
  nextOffset: number | null;
  pageSize: number | null;
  busy: boolean;
  /** Summary suffix, e.g. " similar to IMG_1.jpg". */
  what: string;
};

export const EMPTY_PAGING: Paging = { key: null, total: 0, loaded: 0, nextOffset: null, pageSize: null, busy: false, what: "" };

export const isTruncated = (p: Paging) => p.nextOffset != null;

/** How many results a (re)load should fetch: a reload of the search already on
 *  screen (after Assign date, Guess dates, Undo, or Search pressed again with the
 *  same filters) keeps as many loaded as before, otherwise every action after a
 *  "Load more" would snap the grid back to the first page. null = one request at
 *  the server's default page size. */
export function reloadWant(key: string, prev: Paging): number | null {
  return prev.key === key && prev.loaded > (prev.pageSize || 0) ? prev.loaded : null;
}

/** The `limit` of each request when fetching `want` items in requests of at most
 *  `max` (the endpoint's cap); null = let the server pick its page size. */
export function nextLimit(want: number | null, have: number, max: number): number | null {
  return want == null ? null : Math.max(1, Math.min(want - have, max));
}

/** Append a page, dropping repeats. Offsets are positional, so a photo that
 *  moved between requests (a date edit in another tab, a scan) could come back
 *  twice — drop it rather than draw (and count) the same cell twice. */
export function appendUnique<T>(existing: readonly T[], page: readonly T[], idOf: (item: T) => number): { merged: T[]; added: T[] } {
  const seen = new Set(existing.map(idOf));
  const added = page.filter((item) => !seen.has(idOf(item)));
  return { merged: existing.concat(added), added };
}

/** Where the next untagged-face page starts. Tagging edits the loaded
 *  candidates locally (no refetch), and a candidate whose last proposed face was
 *  confirmed / ignored / rejected no longer qualifies server-side — so the
 *  server's list is that many rows shorter and the next page starts that much
 *  earlier. `loaded`/`total` stay in local-list terms (emptied candidates
 *  included), so the server offset is `loaded` minus the candidates emptied. */
export function untaggedOffset(candidates: readonly Candidate[], loaded: number): { offset: number; dropped: number } {
  const dropped = candidates.filter((c) => c.proposed.length === 0).length;
  return { offset: Math.max(0, loaded - dropped), dropped };
}

const noun = (n: number) => (n === 1 ? "photo" : "photos");

/** "Showing first 2,000 of 12,345 photos found" while truncated — never a bare
 *  page count passed off as the total (A3). */
export function summaryText(p: Paging, shown: number, rankedBySort: boolean): string {
  return isTruncated(p)
    ? `Showing ${rankedBySort ? "top" : "first"} ${shown.toLocaleString()} of ${p.total.toLocaleString()} ${noun(p.total)} found${p.what}`
    : `${p.total.toLocaleString()} ${noun(p.total)} found${p.what}`;
}

/** The paging banner's line: spells out that Select all and the selection
 *  actions see the loaded photos only. */
export function pagingText(p: Paging, loadedN: number, untagged: boolean, rankedBySort: boolean): string {
  return `Showing ${loadedN.toLocaleString()} of ${p.total.toLocaleString()} ` +
    (untagged
      ? "photos. Group buttons only cover the loaded photos."
      : `${rankedBySort ? "best matches" : "photos"}. Select all and the timeline range ` +
        "only cover the loaded photos; the timeline's bars count every match.");
}

/** Load more's size, and whether Load all adds anything beyond it. */
export function pagingCounts(p: Paging): { remaining: number; nextN: number; showAll: boolean } {
  const remaining = Math.max(0, p.total - p.loaded);
  const nextN = Math.min(p.pageSize || remaining, remaining);
  return { remaining, nextN, showAll: remaining > nextN };
}

/** While the results are truncated the count says which part of the result set
 *  the selection covers: all of it (Select all N), some photos that aren't
 *  loaded, or loaded photos only. */
export function selectionCountText(selected: ReadonlySet<number>, p: Paging, loaded: readonly { id: number }[]): string {
  const n = selected.size;
  if (!isTruncated(p)) return `${n.toLocaleString()} selected`;
  if (n === p.total) return `All ${n.toLocaleString()} matches selected`;
  const loadedSel = loaded.reduce((k, ph) => k + (selected.has(ph.id) ? 1 : 0), 0);
  return loadedSel < n
    ? `${n.toLocaleString()} selected (${(n - loadedSel).toLocaleString()} not loaded)`
    : `${n.toLocaleString()} selected (of ${loaded.length.toLocaleString()} loaded)`;
}

/** The scope line above the panes: location, search area, dates. */
export function scopeText(f: SearchForm): string {
  const location = f.locationText.trim() || "All locations";
  const bounds = f.location?.kind === "place" ? NEARBY_OPTIONS.find((o) => o.value === f.nearby)?.label ?? "" : "";
  const dates = f.undatedOnly ? "Undated only" : f.dateRange.label || "All dates";
  return [location, bounds, dates].filter(Boolean).join(" · ");
}

/** Guess-dates label: "~2004", "~March 2004" or "March 5, 2004". */
export function formatGuess(g: Schemas["DateGuess"] | null | undefined, months: readonly string[]): string {
  if (!g) return "No date found";
  if (g.precision === "year") return `~${g.year}`;
  if (g.precision === "month") return `~${months[(g.month ?? 1) - 1]} ${g.year}`;
  return `${months[(g.month ?? 1) - 1]} ${g.day}, ${g.year}`;
}
