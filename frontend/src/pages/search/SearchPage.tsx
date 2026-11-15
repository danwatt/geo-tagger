import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { SEARCH_HANDOFF_URL_MAX, nav, stashSearchHandoff } from "../../lib/handoff";
import { AppShell } from "../../shell/AppShell";
import { StatusBar, type Status } from "../../shell/StatusBar";
import { PhotoGrid } from "../../photos/PhotoGrid";
import { PhotoPreviewPane } from "../../photos/PhotoPreviewPane";
import { DateRangePicker } from "../../ui/DateRangePicker";
import { LocationPicker } from "../../ui/LocationPicker";
import { PaneDivider, usePaneLayout } from "../../ui/ResizablePanes";
import { TimelineHistogram, timelineNarrowed } from "../../ui/TimelineHistogram";
import { Spinner } from "../../ui/ui";
import { AssignDateDialog, GuessDatesDialog, type DateSnapshot } from "./DateDialogs";
import { PeoplePicker } from "./PeoplePicker";
import {
  EMPTY_FORM, NEARBY_OPTIONS, SEARCH_REQUEST_MAX, isTruncated, pagingCounts, pagingText, scopeText,
  selectionCountText, summaryText, withSimilar, withText, type Person, type SearchForm,
} from "./query";
import { UntaggedResults } from "./UntaggedResults";
import { useSearchResults } from "./useSearchResults";
import "../../ui/ui.css";
import "./search.css";

/* Flexible photo search: a description, date range, location, geotag status,
 * camera / folder / GPS accuracy / faces facets, and one-or-more people (either
 * "together in the same photo" or "any of them"). Results are grouped by
 * year/month; the left pane is a selectable photo grid and the right pane
 * previews the focused photo. Search also acts as the selection tool for the
 * rest of the app: results hand off to Geocode and People, and a selection can
 * be dated or downloaded as a ZIP of the original files. Port of web/search.js. */

const LOCATION_HELP = {
  none: "Choose a place or search photo location text.",
  place: "Matches photo GPS coordinates within this saved area.",
  metadata: "Matches this location and its region in photo metadata.",
};

/** A busy flag that only turns on after `ms`, so a fast load doesn't flicker
 *  its spinner (the legacy setBusy's delay). */
function useDelayed(on: boolean, ms = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return shown;
}

export function SearchPage() {
  const queryClient = useQueryClient();
  const [status, setStatusState] = useState<Status>({ message: "" });
  const setStatus = useCallback((s: Status) => setStatusState(s), []);
  const say = useCallback((message: string, isError = false) => setStatus({ message, isError }), [setStatus]);
  const results = useSearchResults(setStatus);
  const r = results.state;

  const [form, setForm] = useState<SearchForm>(EMPTY_FORM);
  const formRef = useRef(form);
  formRef.current = form;
  const patchForm = (p: Partial<SearchForm>) => setForm((f) => ({ ...f, ...p }));

  const [assignIds, setAssignIds] = useState<number[] | null>(null);
  const [guessIds, setGuessIds] = useState<number[] | null>(null);
  // Opaque snapshot from the last guessed-dates commit, for Undo.
  const [lastCommit, setLastCommit] = useState<{ updated: number; previous: DateSnapshot[] } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [selectAllBusy, setSelectAllBusy] = useState(false);
  const [confirmLoadAll, setConfirmLoadAll] = useState(false);

  // ── Facets and people (loaded once) ──
  const persons = useQuery({
    queryKey: ["persons"],
    queryFn: async () => unwrap(await api.GET("/api/persons", {})),
  });
  useEffect(() => {
    if (persons.isError) say(`Could not load people: ${persons.error.message}`, true);
  }, [persons.isError, persons.error, say]);
  const allPersons: Person[] = (persons.data ?? []).map((p) => ({ id: p.id, name: p.name }));
  // The facets are a convenience: if one can't load, it stays at "Any".
  const cameras = useQuery({
    queryKey: ["search", "cameras"],
    queryFn: async () => unwrap(await api.GET("/api/search/cameras")).cameras,
  });
  const dirs = useQuery({
    queryKey: ["photos", "dirs", 5000],
    queryFn: async () => unwrap(await api.GET("/api/photos/dirs", { params: { query: { limit: 5000 } } })),
  });

  const { runSearch: runResults } = results;
  const runSearch = useCallback((f: SearchForm = formRef.current) => runResults(f), [runResults]);

  /* ── Deep link: ?place_id=N ──
   * The Named Places page links here to answer "show me the photos this place
   * stands for". The picker's state is filled by hand rather than by driving the
   * autocomplete: the place is already chosen, and typing into the box would just
   * reopen a suggestion list over the results. */
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;
    const placeId = Number(new URLSearchParams(window.location.search).get("place_id"));
    if (!placeId) return;
    void (async () => {
      try {
        const places = unwrap(await api.GET("/api/places", {}));
        const place = places.find((p) => p.id === placeId);
        if (!place) { say("That saved place no longer exists.", true); return; }
        const next: SearchForm = {
          ...formRef.current,
          location: { kind: "place", id: place.id, label: place.name },
          locationText: place.name,
          nearby: "0",
        };
        setForm(next);
        void runSearch(next);
      } catch (e) {
        say(`Could not open that saved place: ${(e as Error).message}`, true);
      }
    })();
  }, [runSearch, say]);

  // ── Derived result state ──
  const truncated = isTruncated(r.paging);
  const photoActionable = r.mode === "photos" && !r.loading && results.filtered.length > 0;
  const selectionActionable = r.mode === "photos" && !r.loading && r.selected.size > 0;
  const busyShown = useDelayed(r.loading);

  function clearForm() {
    setForm(EMPTY_FORM);
    results.clear();
    say("");
  }

  function runUntagged() {
    void results.runUntagged(formRef.current);
  }

  function searchSimilar() {
    const id = r.focusedId;
    if (id == null) return;
    const photo = r.photos.find((p) => p.id === id);
    const next = withSimilar(formRef.current, { id, filename: photo?.filename || `photo ${id}` });
    setForm(next);
    void runSearch(next);
  }

  // Enter in a filter field runs the search — one handler on the form, so one
  // search per press (W4). Scoped to the form, not the document: Enter in the
  // Assign-date / Guess-dates dialogs must never start a search behind them (it
  // would replace the results and clear the selection the dialog acts on).
  // Skipped: keys a field already handled (location suggestion picked, date
  // range applied, a person added — all preventDefault), the date-range panel,
  // and buttons (Enter on a button is that button's click).
  function onFormKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (t.closest(".drp")) return;
    if (t.tagName !== "INPUT" && t.tagName !== "SELECT") return;
    e.preventDefault();
    void runSearch();
  }

  // ── Selection / handoff ──

  // The visible photos only: `filtered` is what the grid draws. With a
  // truncated result (A3) that is the loaded pages only — say so, and point at
  // the banner's "Select all N".
  function selectAllLoaded() {
    if (!photoActionable) return;
    results.setSelection(results.filtered.map((p) => p.id));
    if (truncated) {
      const notLoaded = r.paging.total - r.paging.loaded;
      say(`Selected the ${results.filtered.length.toLocaleString()} loaded photo(s) — ${notLoaded.toLocaleString()} more matches aren't loaded. ` +
        `Use "Select all ${r.paging.total.toLocaleString()}" above the grid to include them.`);
    }
  }

  // "Select all 12,345": the whole result set, not just the loaded pages. The
  // selection actions all take id lists in a POST body (Download ZIP keeps its
  // own size cap and says so), and Open in Geocode hands large sets over
  // through sessionStorage — so nothing downstream needs the photos loaded.
  async function selectAllMatches() {
    // Not photoActionable: a timeline range can hold matches even when none of
    // the *loaded* photos fall in it, and this is how to reach them.
    if (r.mode !== "photos" || r.loading || !truncated || r.paging.busy) return;
    const gen = results.generation();
    const narrowed = timelineNarrowed(r.histogram, r.timeRange);
    setSelectAllBusy(true);
    say(`Selecting all ${r.paging.total.toLocaleString()} matches…`);
    try {
      const ids = await results.fetchAllMatchIds();
      if (gen !== results.generation()) return;
      results.setSelection(ids);
      const set = new Set(ids);
      const unloaded = ids.length - results.current().photos.filter((p) => set.has(p.id)).length;
      say(`Selected all ${ids.length.toLocaleString()} matches` + (narrowed ? " in the timeline range" : "") +
        (unloaded ? ` — ${unloaded.toLocaleString()} of them aren't loaded in the grid, but the selection actions include them.` : "."));
    } catch (e) {
      if (gen === results.generation()) say(`Select all failed: ${(e as Error).message}`, true);
    } finally {
      setSelectAllBusy(false);
    }
  }

  // The selection, or — with nothing selected — every result in the timeline
  // range: the loaded ones when that's all there is, else every match (fetched
  // as ids only, A3). Up to SEARCH_HANDOFF_URL_MAX ids ride in the URL (?ids=,
  // and Geocode POSTs them on to /api/photos/by-ids); a bigger set goes through
  // a sessionStorage hand-off, since tens of thousands of ids don't fit in a
  // request line.
  async function openInGeocode() {
    if (!photoActionable) return;
    let ids: number[];
    if (r.selected.size > 0) {
      ids = [...r.selected];
    } else if (truncated) {
      const gen = results.generation();
      say(`Collecting all ${r.paging.total.toLocaleString()} matches for Geocode…`);
      try {
        ids = await results.fetchAllMatchIds();
      } catch (e) {
        if (gen === results.generation()) say(`Open in Geocode failed: ${(e as Error).message}`, true);
        return;
      }
      if (gen !== results.generation()) return;
    } else {
      ids = results.filtered.map((p) => p.id);
    }
    if (!ids.length) return;
    if (ids.length <= SEARCH_HANDOFF_URL_MAX) {
      nav.go(`/geocode.html?ids=${ids.join(",")}`);
      return;
    }
    const token = stashSearchHandoff(ids);
    if (!token) {
      say(`Can't hand ${ids.length.toLocaleString()} photos to Geocode: this browser's session storage is unavailable or full. ` +
        `Select ${SEARCH_HANDOFF_URL_MAX.toLocaleString()} or fewer and try again.`, true);
      return;
    }
    nav.go(`/geocode.html?handoff=${token}`);
  }

  function onLoadAll() {
    if (r.paging.busy || !truncated || r.loading) return;
    // A load-all that would put a very large grid on screen (every cell is a
    // live <img>) asks first, like People's Load all.
    if (r.paging.total > SEARCH_REQUEST_MAX && !confirmLoadAll) { setConfirmLoadAll(true); return; }
    setConfirmLoadAll(false);
    results.loadMore("all");
  }
  useEffect(() => { setConfirmLoadAll(false); }, [r.generation]);

  // ── Selection toolbar ──

  async function downloadSelected() {
    if (!selectionActionable || zipBusy) return;
    const ids = [...r.selected];
    setZipBusy(true);
    try {
      // Preflight: the server validates the selection (files exist, under the
      // size cap) without building anything. A navigation download can't report
      // errors — a 404/413 would replace this page with raw JSON — so only
      // submit once it passes.
      const info = unwrap(await api.POST("/api/photos/download-zip", { params: { query: { check: true } }, body: { photo_ids: ids } }));
      // A plain form POST (navigation download): the response is an attachment,
      // so the browser streams it to disk and the page stays put. The archive
      // never passes through JS memory.
      const f = document.createElement("form");
      f.method = "POST";
      f.action = "/api/photos/download-zip";
      f.style.display = "none";
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "photo_ids";
      field.value = ids.join(",");
      f.appendChild(field);
      document.body.appendChild(f);
      f.submit();
      f.remove();
      const mb = (info.total_bytes / (1024 * 1024)).toFixed(1);
      const skipped = info.skipped ? ` (${info.skipped} missing file(s) skipped)` : "";
      say(`Downloading ${info.count} photo(s), ${mb} MB${skipped}…`);
    } catch (e) {
      say(`Download failed: ${(e as Error).message}`, true);
    } finally {
      setZipBusy(false);
    }
  }

  async function undoDateCommit() {
    if (!lastCommit || undoBusy) return;
    setUndoBusy(true);
    try {
      const body = { previous: lastCommit.previous } as Schemas["UndoDateCommitRequest"];
      const res = unwrap(await api.POST("/api/photos/undo-date-commit", { body }));
      setLastCommit(null);
      say(`Reverted ${res.reverted} date(s).`);
      await runSearch();
    } catch (e) {
      say(`Undo failed: ${(e as Error).message}`, true);
    } finally {
      setUndoBusy(false);
    }
  }

  // ── Render ──

  const p = r.paging;
  const counts = pagingCounts(p);
  const untagged = r.mode === "untagged";
  const showPaging = truncated && !r.loading;
  const n1 = form.persons.length;
  const locHelp = form.location?.kind === "place" ? LOCATION_HELP.place : form.location?.kind === "metadata" ? LOCATION_HELP.metadata : LOCATION_HELP.none;
  const layout = usePaneLayout("geotagger.workspace.search.v1", [70, 30]);
  const mainRef = useRef<HTMLDivElement>(null);
  const summary = r.loading || p.key === null ? "" : summaryText(p, untagged ? r.candidates.length : r.photos.length, r.rankedBySort);

  return (
    <AppShell active="search">
      <div id="search-form" role="search" aria-label="Photo search" onKeyDown={onFormKeyDown}>
        <div className="search-field search-field-text">
          <label htmlFor="text-input">Describe</label>
          <input type="search" id="text-input" placeholder="Describe the photo… e.g. sunset over a bridge" autoComplete="off"
            maxLength={300} aria-describedby="text-help" value={form.text}
            onChange={(e) => setForm((f) => withText(f, e.target.value))} />
          <span id="text-help">Ranks results by what's in the picture. Combines with the filters.</span>
        </div>
        <div className="search-field search-field-location">
          <label htmlFor="location-input">Location</label>
          <LocationPicker id="location-input" value={form.locationText} placeholder="Search saved places, cities, counties…"
            describedBy="location-help"
            emptyMessage="No saved or recorded locations match. Search will use your text."
            errorMessage="Could not load locations. Type to retry, or search photo location text."
            onTextChange={(text) => patchForm({ locationText: text })}
            onSelect={(item) => patchForm({ location: item, nearby: "0" })}
            onEdit={() => patchForm({ location: null, nearby: "0" })} />
          <span id="location-help" aria-live="polite">{locHelp}</span>
        </div>
        {form.location?.kind === "place" && (
          <div className="search-field" id="nearby-field">
            <label htmlFor="nearby-select">Search area</label>
            <select id="nearby-select" title="Grow the place's bounds outward before filtering photos" value={form.nearby}
              onChange={(e) => patchForm({ nearby: e.target.value })}>
              {NEARBY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div className="search-field search-field-dates">
          <span className="field-label" id="date-range-label">Date range</span>
          {/* Applying a range only stages it: the page keeps its explicit Search
              button, so nothing re-queries until the user asks, matching every
              other filter in this form. */}
          <DateRangePicker id="date-range" labelledBy="date-range-label" value={form.dateRange}
            onChange={(range) => patchForm({ dateRange: range })} disabled={form.undatedOnly}
            disabledTitle="Turn off Undated only to pick dates" />
          <label className="checkbox-label">
            <input type="checkbox" id="undated-only-checkbox" checked={form.undatedOnly}
              onChange={(e) => patchForm({ undatedOnly: e.target.checked })} /> Undated only
          </label>
        </div>
        <div className="search-field">
          <label htmlFor="geotagged-select">Geotagged</label>
          <select id="geotagged-select" value={form.geotagged} onChange={(e) => patchForm({ geotagged: e.target.value as SearchForm["geotagged"] })}>
            <option value="all">Any</option>
            <option value="yes">Geotagged only</option>
            <option value="no">Not geotagged</option>
          </select>
        </div>
        <div className="search-field">
          <label htmlFor="camera-select">Camera</label>
          <select id="camera-select" value={form.camera} onChange={(e) => patchForm({ camera: e.target.value })}>
            <option value="">Any</option>
            {(cameras.data ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="search-field">
          <label htmlFor="folder-select">Folder</label>
          <select id="folder-select" value={form.folder} onChange={(e) => patchForm({ folder: e.target.value })}>
            <option value="">Any</option>
            {(dirs.data ?? []).map((d) => <option key={d.dir} value={d.dir}>{d.dir}</option>)}
          </select>
        </div>
        <div className="search-field">
          <label htmlFor="gps-accuracy-select">GPS accuracy</label>
          <select id="gps-accuracy-select" value={form.gpsAccuracy} onChange={(e) => patchForm({ gpsAccuracy: e.target.value as SearchForm["gpsAccuracy"] })}>
            <option value="all">Any</option>
            <option value="precise">Precise only</option>
            <option value="imprecise">Imprecise (radius) only</option>
          </select>
        </div>
        <div className="search-field">
          <label htmlFor="has-faces-select">Faces</label>
          <select id="has-faces-select" value={form.hasFaces} onChange={(e) => patchForm({ hasFaces: e.target.value as SearchForm["hasFaces"] })}>
            <option value="all">Any</option>
            <option value="yes">Has faces</option>
            <option value="no">No faces detected</option>
          </select>
        </div>
        <div className="search-field">
          <label htmlFor="sort-select">Sort</label>
          <select id="sort-select" value={form.sort} onChange={(e) => patchForm({ sort: e.target.value as SearchForm["sort"] })}>
            <option value="relevance">Best match</option>
            <option value="date_asc">Date (oldest first)</option>
            <option value="date_desc">Date (newest first)</option>
            <option value="filename">Filename</option>
            <option value="camera">Camera</option>
          </select>
        </div>
        <div className="search-field search-field-people">
          <label htmlFor="person-picker-input">People</label>
          <PeoplePicker id="person-picker-input" all={allPersons} value={form.persons} onChange={(ps) => patchForm({ persons: ps })} />
        </div>
        {n1 >= 2 && (
          <div className="search-field search-field-mode" id="person-mode-field">
            <label htmlFor="person-mode-select">Match</label>
            <select id="person-mode-select" title="'Together' requires every selected person to appear in the same photo"
              value={form.personMode} onChange={(e) => patchForm({ personMode: e.target.value as SearchForm["personMode"] })}>
              <option value="all">Together (same photo)</option>
              <option value="any">Any of them</option>
            </select>
          </div>
        )}
        {n1 >= 1 && (
          <div className="search-field search-field-untagged" id="untagged-field">
            <span className="field-label" aria-hidden="true">&nbsp;</span>
            <button type="button" id="untagged-btn" onClick={runUntagged}>
              {n1 === 1 ? `🔎 Find untagged faces of ${form.persons[0]!.name}` : "🔎 Find where they appear together (untagged)"}
            </button>
          </div>
        )}
        <div className="search-field search-field-actions">
          <button type="button" id="search-btn" className="primary" onClick={() => void runSearch()}>🔎 Search</button>
          <button type="button" id="clear-btn" onClick={clearForm}>Clear</button>
        </div>
      </div>

      <div className="workspace-scope">
        <span id="workspace-scope-text">{scopeText(form)}</span>
        <button type="button" id="preview-toggle" aria-expanded={layout.previewVisible} aria-controls="detail-pane" onClick={layout.togglePreview}>
          {layout.previewVisible ? "Hide preview" : "Show preview"}
        </button>
      </div>

      {r.histogram && (
        <TimelineHistogram key={r.generation} histogram={r.histogram} onRangeChange={results.setTimeRange} />
      )}

      <div id="main" ref={mainRef} style={{ gridTemplateColumns: layout.columns }}>
        <div id="grid-pane" aria-busy={r.loading}>
          <div id="grid-nav">
            <div className="toolbar-group">
              <span id="search-summary">{summary}</span>
            </div>
            <div className="toolbar-spacer" />
            {photoActionable && (
              <div className="toolbar-group" id="handoff-group">
                <button type="button" title="Select every loaded photo in the current results" onClick={selectAllLoaded}>☑ Select all</button>
                <button type="button" title="Open these results in Geocode for location tagging" onClick={() => void openInGeocode()}>📍 Open in Geocode</button>
                {n1 === 1 && (
                  <button type="button" title="Open this person in People"
                    onClick={() => nav.go(`/people.html?person=${form.persons[0]!.id}`)}>🙂 Open in People</button>
                )}
              </div>
            )}
            {selectionActionable && (
              <div className="toolbar-group" id="selection-group">
                <span id="selection-count">{selectionCountText(r.selected, p, r.photos)}</span>
                <button type="button" title="Assign an approximate (year or month) date to the selected photos"
                  onClick={() => setAssignIds([...r.selected])}>📅 Assign date…</button>
                <button type="button" title="Guess dates from filenames (YYYYMMDD) or folder names (YYYY or YYYY-MM)"
                  onClick={() => setGuessIds([...r.selected])}>🔍 Guess dates…</button>
                <button type="button" className="primary" disabled={zipBusy} onClick={() => void downloadSelected()}>
                  {zipBusy ? "⬇ Preparing…" : "⬇ Download ZIP"}
                </button>
                <button type="button" onClick={results.clearSelection}>Clear selection</button>
              </div>
            )}
            {lastCommit && (
              <div className="toolbar-group" id="date-undo-group">
                <span id="date-undo-count">Committed {lastCommit.updated} guessed date(s).</span>
                <button type="button" disabled={undoBusy} onClick={() => void undoDateCommit()}>↩ Undo</button>
              </div>
            )}
            {/* Paging banner (A3, mirrors People's U5 banner): shown while the
                search matched more photos than are loaded. Full width so it
                stays with the nav. */}
            {showPaging && (
              <div id="search-paging" role="region" aria-label="More results">
                <span id="search-paging-text">{pagingText(p, untagged ? r.candidates.length : r.photos.length, untagged, r.rankedBySort)}</span>
                <button type="button" className="primary" disabled={p.busy} onClick={() => results.loadMore("page")}>
                  {p.busy ? <><Spinner /> Loading…</> : `Load ${counts.nextN.toLocaleString()} more`}
                </button>
                {counts.showAll && (
                  <button type="button" disabled={p.busy} onClick={onLoadAll}>Load all ({counts.remaining.toLocaleString()})</button>
                )}
                {!untagged && (
                  <button type="button" disabled={p.busy || selectAllBusy}
                    title="Select every match, loaded or not (within the timeline range) — Open in Geocode, Download ZIP and the date tools then act on all of them"
                    onClick={() => void selectAllMatches()}>Select all {p.total.toLocaleString()}</button>
                )}
                {confirmLoadAll && (
                  <div className="inline-confirm" role="alertdialog" aria-labelledby="load-all-confirm-text">
                    <p id="load-all-confirm-text">
                      Load all {counts.remaining.toLocaleString()} remaining photo(s)? {p.total.toLocaleString()} photos in one grid can make the page slow to scroll and select.
                    </p>
                    <button type="button" className="primary" autoFocus onClick={onLoadAll}>Load all</button>
                    <button type="button" onClick={() => setConfirmLoadAll(false)}>Cancel</button>
                  </div>
                )}
              </div>
            )}
          </div>
          {busyShown && (
            <div className="grid-busy" role="status"><Spinner /> {untagged ? "Scanning faces…" : "Searching…"}</div>
          )}
          {r.loading ? null : untagged ? (
            <UntaggedResults candidates={r.candidates} persons={allPersons} focusedId={r.focusedId}
              onFocusPhoto={results.focus} patch={results.patchCandidates} status={say}
              onPersonsChanged={() => void queryClient.invalidateQueries({ queryKey: ["persons"] })} />
          ) : p.key !== null ? (
            <PhotoGrid photos={results.filtered} selectedIds={r.selected} focusedId={r.focusedId} onActivate={results.activate}
              ranked={r.rankedBySort ? { title: r.rankedTitle } : null}
              // Truncated + an empty timeline range: matches may exist in the
              // range, just not among the loaded pages (the bars count every match).
              emptyMessage={truncated && r.photos.length
                ? "None of the loaded photos fall in this timeline range. Load more, or search with this date range."
                : "No photos match these filters."} />
          ) : <div id="grid" className="photo-grid" />}
        </div>
        {layout.previewVisible && (
          <PaneDivider index={0} label="Resize photos and preview" weight={layout.weights[0]!} onAdjust={layout.adjust}
            containerRef={mainRef} totalWeight={layout.weights.reduce((a, b) => a + b, 0)} />
        )}
        <PhotoPreviewPane photoId={r.focusedId} hidden={!layout.previewVisible}
          actions={() => (
            <div id="detail-similar">
              <button type="button" title="Find visually similar photos (uses the text search index)" onClick={searchSimilar}>More like this</button>
            </div>
          )} />
      </div>

      {assignIds && (
        <AssignDateDialog ids={assignIds} onClose={() => setAssignIds(null)}
          onAssigned={(updated) => {
            setAssignIds(null);
            say(`Assigned approximate date to ${updated} photo(s).`);
            void runSearch();
          }} />
      )}
      {guessIds && (
        <GuessDatesDialog ids={guessIds} onClose={() => setGuessIds(null)}
          onCommitted={(updated, previous) => {
            setGuessIds(null);
            setLastCommit({ updated, previous });
            say(`Committed ${updated} guessed date(s).`);
            void runSearch();
          }} />
      )}
      <StatusBar status={status} />
    </AppShell>
  );
}
