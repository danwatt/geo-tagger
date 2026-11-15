import { useCallback, useMemo, useRef, useState } from "react";
import { getJson, type Schemas } from "../../api/client";
import { latestOnly } from "../../lib/latestOnly";
import type { Status } from "../../shell/StatusBar";
import { clickSelection, type ClickModifiers } from "../../photos/selection";
import { inTimelineRange, timelineNarrowed, type Histogram, type TimeRange } from "../../ui/TimelineHistogram";
import {
  EMPTY_PAGING, SEARCH_REQUEST_MAX, UNTAGGED_REQUEST_MAX, appendUnique, buildQuery, isTruncated, nextLimit,
  reloadWant, untaggedOffset, type Candidate, type Paging, type SearchForm, type SearchPhoto,
} from "./query";

/* The Search page's result state and its loaders. Port of search.js's results
 * half (runSearch / searchPhotos / searchUntaggedFaces / Load more / Select all
 * matches), with the same guarantees:
 *
 *  - Latest-only. The plain and untagged-face searches both fill the one results
 *    grid, so they share one latest-only guard: a second search started before
 *    the first returns supersedes it, whichever kind either is. Load more pages
 *    go through the same guard, so a new search discards a page still in flight,
 *    and a Load more can't land on top of a newer search. Every await is followed
 *    by a `signal.aborted` check before state is touched.
 *  - `loading` is true from the moment a results load starts until the latest
 *    one settles. Bulk actions (Select all, Open in Geocode, the selection
 *    toolbar) refuse to run meanwhile: there is no result set on screen for them
 *    to act on. A Load more append doesn't set it — the loaded results stay on
 *    screen and actionable.
 *  - `generation` is bumped by every reset. A request that isn't part of the
 *    results loader (Select all matches, Open in Geocode's id fetch) captures it
 *    first and drops its answer if a newer search or Clear replaced the results.
 *
 * State lives in a ref mirrored into React state: the async loaders read the
 * current results (to append to them) without waiting for a re-render. */

export type Mode = "photos" | "untagged";

export type Results = {
  mode: Mode;
  loading: boolean;
  generation: number;
  photos: SearchPhoto[];
  candidates: Candidate[];
  /** The whole-result-set timeline from the server — every match, not just the loaded page. */
  histogram: Histogram | null;
  timeRange: TimeRange | null;
  paging: Paging;
  /** Last results came from a text / similar query (photos carry `score`). */
  ranked: boolean;
  /** ...and are ordered by score, so they aren't month-grouped. */
  rankedBySort: boolean;
  rankedTitle: string;
  selected: ReadonlySet<number>;
  lastIdx: number;
  focusedId: number | null;
};

const INITIAL: Results = {
  mode: "photos", loading: false, generation: 0, photos: [], candidates: [], histogram: null, timeRange: null,
  paging: EMPTY_PAGING, ranked: false, rankedBySort: false, rankedTitle: "", selected: new Set(), lastIdx: -1, focusedId: null,
};

type PageResponse = { total: number; next_offset?: number | null; limit: number };

/** Fetch `want` results of `base` (an endpoint URL with its query) from
 *  `offset`, in requests of at most `max`. `want` null = one request at the
 *  server's default page size. Returns the items, the server's total, where the
 *  following page starts (null once exhausted), and the first response. */
export async function fetchResultPages<R extends PageResponse, T>(
  base: string, pick: (r: R) => T[], offset: number, want: number | null, max: number, signal: AbortSignal,
): Promise<{ items: T[]; total: number; nextOffset: number | null; first: R }> {
  const items: T[] = [];
  let first: R | null = null;
  let total = 0;
  let next: number | null = offset;
  do {
    const n = nextLimit(want, items.length, max);
    const data: R = await getJson<R>(`${base}&offset=${next}` + (n ? `&limit=${n}` : ""), { signal });
    first ??= data;
    items.push(...(pick(data) ?? []));
    total = data.total;
    next = data.next_offset ?? null;
  } while (want != null && next != null && items.length < want && !signal.aborted);
  return { items, total, nextOffset: next, first: first! };
}

export function useSearchResults(setStatus: (s: Status) => void) {
  const ref = useRef<Results>(INITIAL);
  const [state, setState] = useState<Results>(INITIAL);
  const update = useCallback((fn: (r: Results) => Results) => {
    ref.current = fn(ref.current);
    setState(ref.current);
  }, []);
  const status = useCallback((message: string, isError = false) => setStatus({ message, isError }), [setStatus]);

  const run = useMemo(() => latestOnly((signal: AbortSignal, body: (signal: AbortSignal) => Promise<void>) => body(signal)), []);

  // Drop every piece of result state at once — both modes' results, the
  // timeline's narrowing, the selection and the focused photo — and enter
  // `mode`. Both loaders call this before fetching (W12): previously the
  // untagged search left the plain results and the handoff toolbar in place, so
  // "Select all" / "Open in Geocode" acted on the invisible previous search.
  const reset = useCallback((mode: Mode, loading: boolean) => {
    update((r) => ({ ...INITIAL, mode, loading, generation: r.generation + 1 }));
  }, [update]);

  // Settle the loading flag — only for the load that still owns the grid (a
  // superseded one returns early on its aborted signal and must not clear the
  // newer load's flag).
  const finish = useCallback((signal: AbortSignal) => {
    if (signal.aborted) return;
    update((r) => (r.loading ? { ...r, loading: false } : r));
  }, [update]);

  // Warn when ranked results are partial because indexing hasn't finished;
  // silent otherwise. `signal` is the calling search's: a newer search owns the
  // status line.
  const noteIndexCoverage = useCallback(async (signal: AbortSignal) => {
    try {
      const s = await getJson<Schemas["SemanticStatusResponse"]>("/api/semantic/status", { signal });
      if (signal.aborted) return;
      if (s.remaining > 0) {
        status(`${s.remaining.toLocaleString()} photos aren't indexed for text search yet — results are partial. Index them from Data Management.`);
      }
    } catch { /* status is a hint only */ }
  }, [status]);

  const searchPhotos = useCallback(async (signal: AbortSignal, form: SearchForm) => {
    const prev = ref.current.paging;
    reset("photos", true);
    status("Searching…");
    try {
      const params = buildQuery(form);
      const key = params.toString();
      const want = reloadWant(key, prev);
      // 409/400 carry a human-readable reason (model not downloaded, photo not
      // indexed yet): getJson's ApiError shows it instead of a bare status code,
      // and flattens a 422's detail list.
      const page = await fetchResultPages<Schemas["SearchPage"], SearchPhoto>(
        `/api/search?${key}`, (d) => d.photos, 0, want, SEARCH_REQUEST_MAX, signal);
      if (signal.aborted) return;
      const ranked = params.has("text") || params.has("similar_to");
      update((r) => ({
        ...r,
        photos: page.items,
        histogram: page.first.histogram ?? null,
        ranked,
        rankedBySort: ranked && (params.get("sort") || "relevance") === "relevance",
        rankedTitle: params.has("similar_to") ? "Most similar" : "Best matches",
        paging: {
          ...EMPTY_PAGING, key, total: page.total, loaded: page.items.length, nextOffset: page.nextOffset,
          pageSize: want == null ? page.first.limit : prev.pageSize,
          what: params.has("similar_to") && form.similarTo ? ` similar to ${form.similarTo.filename}` : "",
        },
      }));
      status("");
      finish(signal);
      if (ranked) await noteIndexCoverage(signal);
    } catch (e) {
      if (signal.aborted) return;
      status(`Search failed: ${(e as Error).message}`, true);
    } finally {
      finish(signal);
    }
  }, [finish, noteIndexCoverage, reset, status, update]);

  // Load more / Load all for the plain results: append the next page(s) of the
  // search on screen, keeping selection, focus and the timeline range. React
  // appends the new cells below the old ones in place, so the scroll position
  // holds without the save/restore the legacy grid rebuild needed.
  const appendSearchPage = useCallback(async (signal: AbortSignal, more: "page" | "all") => {
    const r0 = ref.current;
    const p = r0.paging;
    if (r0.mode !== "photos" || !isTruncated(p)) return;
    const offset = p.nextOffset!;
    const want = more === "all" ? p.total - offset : p.pageSize;
    update((r) => ({ ...r, paging: { ...r.paging, busy: true } }));
    try {
      const page = await fetchResultPages<Schemas["SearchPage"], SearchPhoto>(
        `/api/search?${p.key}`, (d) => d.photos, offset, want, SEARCH_REQUEST_MAX, signal);
      if (signal.aborted) return;
      const { merged, added } = appendUnique(ref.current.photos, page.items, (ph) => ph.id);
      update((r) => ({
        ...r, photos: merged,
        paging: { ...r.paging, total: page.total, loaded: offset + page.items.length, nextOffset: page.nextOffset },
      }));
      status(`Loaded ${added.length.toLocaleString()} more — ${merged.length.toLocaleString()} of ${page.total.toLocaleString()} now shown.`);
    } catch (e) {
      if (signal.aborted) return;
      status(`Failed to load more results: ${(e as Error).message}`, true);
    } finally {
      if (!signal.aborted) update((r) => ({ ...r, paging: { ...r.paging, busy: false } }));
    }
  }, [status, update]);

  const searchUntagged = useCallback(async (signal: AbortSignal, form: SearchForm) => {
    const prev = ref.current.paging;
    reset("untagged", true);
    status("Scanning for untagged faces…");
    try {
      const key = buildQuery(form).toString();
      const want = reloadWant(key, prev);
      const page = await fetchResultPages<Schemas["UntaggedFacesResponse"], Candidate>(
        `/api/search/untagged-faces?${key}`, (d) => d.candidates, 0, want, UNTAGGED_REQUEST_MAX, signal);
      if (signal.aborted) return;
      update((r) => ({
        ...r, candidates: page.items,
        paging: {
          ...EMPTY_PAGING, key, total: page.total, loaded: page.items.length, nextOffset: page.nextOffset,
          pageSize: want == null ? page.first.limit : prev.pageSize,
        },
      }));
      const warnings = page.first.warnings ?? [];
      status(warnings.join(" "), warnings.length > 0);
    } catch (e) {
      if (signal.aborted) return;
      status(`Search failed: ${(e as Error).message}`, true);
    } finally {
      finish(signal);
    }
  }, [finish, reset, status, update]);

  // Load more for the untagged-face candidates; see untaggedOffset for why the
  // server offset trails the local count. Repeats are dropped by photo id.
  const appendUntaggedPage = useCallback(async (signal: AbortSignal, more: "page" | "all") => {
    const r0 = ref.current;
    const p = r0.paging;
    if (r0.mode !== "untagged" || !isTruncated(p)) return;
    const { offset, dropped } = untaggedOffset(r0.candidates, p.loaded);
    const want = more === "all" ? Math.max(1, p.total - p.loaded) : p.pageSize;
    update((r) => ({ ...r, paging: { ...r.paging, busy: true } }));
    try {
      const page = await fetchResultPages<Schemas["UntaggedFacesResponse"], Candidate>(
        `/api/search/untagged-faces?${p.key}`, (d) => d.candidates, offset, want, UNTAGGED_REQUEST_MAX, signal);
      if (signal.aborted) return;
      const { merged, added } = appendUnique(ref.current.candidates, page.items, (c) => c.photo.id);
      const total = page.total + dropped;
      update((r) => ({
        ...r, candidates: merged,
        paging: { ...r.paging, total, loaded: offset + page.items.length + dropped, nextOffset: page.nextOffset },
      }));
      status(`Loaded ${added.length.toLocaleString()} more — ${merged.length.toLocaleString()} of ${total.toLocaleString()} now shown.`);
    } catch (e) {
      if (signal.aborted) return;
      status(`Failed to load more results: ${(e as Error).message}`, true);
    } finally {
      if (!signal.aborted) update((r) => ({ ...r, paging: { ...r.paging, busy: false } }));
    }
  }, [status, update]);

  const filtered = useMemo(
    () => inTimelineRange(state.photos, state.histogram, state.timeRange),
    [state.photos, state.histogram, state.timeRange],
  );
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  // Every match of the search on screen (loaded or not), narrowed by the
  // timeline range the same way the grid is (undated photos always pass). One
  // ids-only request: ids plus timestamps, no photo rows.
  const fetchAllMatchIds = useCallback(async (): Promise<number[]> => {
    const r = ref.current;
    const data = await getJson<Schemas["SearchIds"]>(`/api/search?${r.paging.key}&ids_only=true`);
    if (!timelineNarrowed(r.histogram, r.timeRange)) return data.ids;
    const { lo, hi } = r.timeRange!;
    return data.ids.filter((_, i) => {
      const ts = data.datetimes[i];
      return !ts || (ts >= lo && ts <= hi);
    });
  }, []);

  const actions = useMemo(() => ({
    runSearch: (form: SearchForm) => run((signal) => searchPhotos(signal, form)),
    runUntagged: (form: SearchForm) => run((signal) => searchUntagged(signal, form)),
    loadMore: (more: "page" | "all") => {
      const r = ref.current;
      if (r.paging.busy || !isTruncated(r.paging) || r.loading) return;
      void run((signal) => (r.mode === "untagged" ? appendUntaggedPage(signal, more) : appendSearchPage(signal, more)));
    },
    /** Supersede any in-flight load (its results must not land after Clear),
     *  then drop the result state the same way a new search does. */
    clear: () => {
      void run(async () => {});
      reset("photos", false);
    },
    /** A grid cell activated (click, Enter/Space or an arrow key). */
    activate: (idx: number, mod: ClickModifiers) => {
      const list = filteredRef.current;
      const photo = list[idx];
      if (!photo) return;
      update((r) => ({
        ...r,
        selected: clickSelection(r.selected, list.map((p) => p.id), idx, r.lastIdx, mod),
        lastIdx: idx,
        focusedId: photo.id,
      }));
    },
    focus: (photoId: number) => update((r) => ({ ...r, focusedId: photoId })),
    setSelection: (ids: Iterable<number>) => update((r) => ({ ...r, selected: new Set(ids), lastIdx: -1 })),
    clearSelection: () => update((r) => ({ ...r, selected: new Set() })),
    /** The timeline narrowed: the selection and focus described the old range. */
    setTimeRange: (range: TimeRange) => update((r) => ({ ...r, timeRange: range, selected: new Set(), lastIdx: -1, focusedId: null })),
    /** Local-only edits to the untagged candidates after a tagging action, so the
     *  results don't reshuffle or refetch mid-session — the user re-runs the
     *  search explicitly when ready for the next batch. */
    patchCandidates: (fn: (cs: Candidate[]) => Candidate[]) => update((r) => ({ ...r, candidates: fn(r.candidates) })),
    fetchAllMatchIds,
    /** For requests outside the loader: compare before using their answer. */
    generation: () => ref.current.generation,
    current: () => ref.current,
  }), [appendSearchPage, appendUntaggedPage, fetchAllMatchIds, reset, run, searchPhotos, searchUntagged, update]);

  return { state, filtered, ...actions };
}
