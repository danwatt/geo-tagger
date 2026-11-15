import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, getJson, unwrap, type Schemas } from "../../api/client";
import { isGroupSort, type Face, type GroupSort } from "../../faces/faceGrid";
import { faceUndoable, undoFaceToken, type FaceUndoToken } from "../../photos/faceUndo";
import { fullSizeUrl, isRawName } from "../../lib/fullsize";
import { nav } from "../../lib/handoff";
import { latestOnly } from "../../lib/latestOnly";
import { STAGED_SAVE_FAILED_MSG } from "../../lib/stagedWork";
import type { Status } from "../../shell/StatusBar";
import type { UndoOutcome } from "../../ui/Toast";
import {
  FOCUS_LS_KEY, FOCUS_WIDEN_HINT, NO_FOCUS, focusActive, focusFromValue, focusParams, focusQuery, focusStatusSuffix,
  initialFocus, isBool, loadViewPref, readString, saveViewPref, writeString, type FocusWindow,
} from "./focus";
import { buildGridModel, HIERARCHIES, isFlatGridScope, type Hierarchy, type Scope } from "./gridModel";
import { computeMonthLocationGroups, facesDateRange, type RunRank } from "./grouping";
import {
  applyPreselection, cellClick, extendFocus, freshPreselectMemory, moveFocus, pruneSelection, type PreselectMemory,
} from "./selection";
import {
  classifyRestore, droppedNote, groupPendingEntries, peopleStore, pendingCellLabel, pendingRequest, recordsToSave, validRecord,
  type Change, type Pending, type PendingEntry, type PendingGroup, type PendingRecord,
} from "./staging";

/* The People page's state and actions. Port of the people-*.js scripts, which
 * shared one global scope: here one store (`ref` always the latest, updated
 * synchronously, so async flows read what they just changed — the shape of
 * Geocode's useWorkspace) plus the actions over it. Rendering lives in the
 * components; everything that decides lives here or in the pure modules
 * (grouping, gridModel, selection, staging, focus, keyboard). */

export type Person = Schemas["PersonListItem"];
export type Cluster = Schemas["FaceCluster"];
export type CrowdGroup = Schemas["CrowdGroup"];
export type CrowdPhoto = Schemas["CrowdPhoto"];
type Counts = Schemas["FaceScanStatus"];
type FacePage = Schemas["FacePage"];

/* ── Remembered per browser (the legacy page's keys, so choices carry over) ── */
export const SUGGESTED_ONLY_LS_KEY = "geotagger.people.suggestedOnly.v1";
export const HIDE_DONE_CROWDS_LS_KEY = "geotagger.people.crowdHideDone.v1";
export const GRID_SORT_LS_KEY = "geotagger.people.gridSort";
export const UNLABELED_HIERARCHY_LS_KEY = "geotagger.people.unlabeledHierarchy";

// /api/faces caps one request at this many faces (its `limit` le=).
export const FACE_REQUEST_MAX = 20000;
// /api/faces/by-ids caps one request at this many ids.
const FACES_BY_IDS_MAX = 5000;
// Reverting more staged changes than this at once asks first.
const SELECTION_CONFIRM_THRESHOLD = 3;
// Above this many loaded faces a lone rejection patches the face in place
// rather than re-fetching the whole (possibly huge) queue.
const REJECT_LOCAL_THRESHOLD = 10;

/** U5 paging for the flat grids. `key` is the request minus offset/limit (the
 *  view these counts belong to); `loaded` how many server rows were consumed;
 *  `nextOffset` null once the view is exhausted; `busy` while a load runs. */
export type Paging = { key: string | null; total: number; loaded: number; nextOffset: number | null; busy: boolean };
const NO_PAGING: Paging = { key: null, total: 0, loaded: 0, nextOffset: null, busy: false };

export type PeopleState = {
  persons: Person[];            // full list — pickers, lookups
  navPersons: Person[];         // the left nav (windowed under Focus)
  counts: Counts | null;
  scope: Scope;
  scopePersonId: number | null;
  faces: Face[];                // the current flat scope (Unlabeled: the filtered view)
  unlabeledAll: Face[];         // Unlabeled: the full loaded queue
  unlabeledMeta: { total: number; returned: number };
  suggestFilter: number | null; // Unlabeled: narrow to one top-suggested person
  selected: Set<number>;
  focusedId: number | null;
  anchorIdx: number;            // last click / nav index into the render order
  pending: Pending;
  clusters: Cluster[];
  clustersStale: boolean;
  crowds: CrowdGroup[];
  /** Crowd photos acted on one at a time stay on screen (greyed) until the
   *  view next redraws, rather than vanishing under the pointer. */
  crowdsKeep: Set<number>;
  paging: Paging;
  /** U4: the grid on screen belongs to the previous view until this load lands. */
  busy: string | null;
  status: Status;
  focus: FocusWindow;
  focusValue: string;
  focusYears: number[];
  monthOption: { value: string; label: string } | null;
  suggestedOnly: boolean;
  hideDoneCrowds: boolean;
  gridSort: GroupSort;
  hierarchy: Hierarchy;
  groupGap: number;
  crowdMinFaces: number;
  crowdGap: number;
  guessPerson: string;
  restore: { ids: Set<number>; detail: string } | null;
};

function initialState(): PeopleState {
  const sort = readString(GRID_SORT_LS_KEY);
  const hier = readString(UNLABELED_HIERARCHY_LS_KEY);
  return {
    persons: [], navPersons: [], counts: null,
    scope: "unlabeled", scopePersonId: null,
    faces: [], unlabeledAll: [], unlabeledMeta: { total: 0, returned: 0 }, suggestFilter: null,
    selected: new Set(), focusedId: null, anchorIdx: -1,
    pending: new Map(),
    clusters: [], clustersStale: false, crowds: [], crowdsKeep: new Set(),
    paging: NO_PAGING, busy: null,
    status: { message: "" },
    focus: NO_FOCUS, focusValue: "", focusYears: [], monthOption: null,
    suggestedOnly: loadViewPref(SUGGESTED_ONLY_LS_KEY, false, isBool),
    hideDoneCrowds: loadViewPref(HIDE_DONE_CROWDS_LS_KEY, true, isBool),
    gridSort: isGroupSort(sort) ? sort : "date",
    hierarchy: (HIERARCHIES as readonly string[]).includes(hier ?? "") ? hier as Hierarchy : "date",
    groupGap: 86400, crowdMinFaces: 50, crowdGap: 86400,
    guessPerson: "",
    restore: null,
  };
}

export type Ask = { title: string; message: string; confirmLabel: string; danger?: boolean; resolve: (yes: boolean) => void };
export type PickerReq = {
  title: string; placeholder?: string; initialQuery?: string; allowCreate?: boolean;
  onPick: (who: { person_id: number } | { name: string }) => void;
};
export type BirthEdit = { person: Person };

type Toasts = { toast: (m: string, err?: boolean) => void; undoToast: (m: string, fn: () => Promise<UndoOutcome>) => void };

const faceN = (n: number) => `${n} face(s)`;

export function usePeople(toasts: Toasts) {
  const qc = useQueryClient();
  const [state, setState] = useState<PeopleState>(initialState);
  const ref = useRef(state);
  const update = useCallback((patch: Partial<PeopleState> | ((s: PeopleState) => Partial<PeopleState>)) => {
    const p = typeof patch === "function" ? patch(ref.current) : patch;
    ref.current = { ...ref.current, ...p };
    setState(ref.current);
  }, []);
  const say = useCallback((message: string, isError = false) => update({ status: { message, isError } }), [update]);

  const [ask, setAsk] = useState<Ask | null>(null);
  const [picker, setPicker] = useState<PickerReq | null>(null);
  const [birthEdit, setBirthEdit] = useState<BirthEdit | null>(null);
  const confirm = useCallback((q: Omit<Ask, "resolve">) => new Promise<boolean>((resolve) => setAsk({ ...q, resolve })), []);

  // Live settings (FACE_PRESELECT_MIN_SCORE, FACE_QUERY_LIMIT), read once at start.
  const confidentScore = useRef(0.5);
  const faceLimit = useRef(5000);
  const runRank = useRef<RunRank>(new Map());
  const preselect = useRef<PreselectMemory>(freshPreselectMemory());
  const jumpToUndated = useRef(false);
  const commitInFlight = useRef(false);
  const clusterLoad = useRef<AbortSignal | null>(null);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  /* ── Staged-work mirror (U7) ──
   * Written from an effect on every change to `pending`, once per render however
   * many faces a bulk stage touched. While the start-up restore is checking the
   * saved records against the server they are "carried": written along with any
   * new staging, so staging during that fetch can't overwrite them. Nothing is
   * written before the start-up read, which an empty first render would wipe. */
  const store = useMemo(peopleStore, []);
  const carry = useRef<PendingRecord[]>([]);
  const storeReady = useRef(false);
  const saveFailed = useRef(false);
  const [carryTick, setCarryTick] = useState(0);
  useEffect(() => {
    if (!storeReady.current) return;
    if (!store.save(recordsToSave(state.pending, carry.current)) && !saveFailed.current) {
      saveFailed.current = true;
      say(STAGED_SAVE_FAILED_MSG, true);
    }
  }, [state.pending, carryTick, store, say]);

  // Staged changes are backed up to this tab's sessionStorage, but that's gone
  // once the tab is closed for good — so still ask before leaving.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!ref.current.pending.size) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  /* ── Derived ── */
  const gridFacesOf = (s: PeopleState) => (s.pending.size ? s.faces.filter((f) => !s.pending.has(f.id)) : s.faces);
  const gridFaces = useMemo(() => gridFacesOf(state), [state.faces, state.pending]);
  const model = useMemo(() => buildGridModel({
    scope: state.scope, list: gridFaces, hierarchy: state.hierarchy, sort: state.gridSort, gapSeconds: state.groupGap, rank: runRank.current,
  }), [state.scope, gridFaces, state.hierarchy, state.gridSort, state.groupGap]);
  const orderRef = useRef(model.order);
  orderRef.current = model.order;
  const loadedFacesOf = (s: PeopleState) => (s.scope === "unlabeled" ? s.unlabeledAll : s.faces);
  const truncated = (s: PeopleState) => s.paging.nextOffset != null;
  const stagingEnabled = () => isFlatGridScope(ref.current.scope);
  const personName = (id: number | null | undefined) => ref.current.persons.find((p) => p.id === id)?.name;

  /** The face for `id` from the grid, the staging area, or a Discover sample. */
  const findFace = useCallback((id: number | null | undefined): Face | null => {
    if (id == null) return null;
    const s = ref.current;
    const f = s.faces.find((x) => x.id === id);
    if (f) return f;
    const staged = s.pending.get(id);
    if (staged) return staged.face;
    for (const cl of s.clusters) {
      const x = cl.sample.find((y) => y.id === id);
      if (x) return x;
    }
    return null;
  }, []);

  /* ── People list ── Latest-only: it runs after every mutation and on each
   * Focus change, often overlapping itself, and an older reply must not repaint
   * the list with stale counts. `persons` stays the FULL list (pickers, name
   * lookups — you can still tag someone with no faces in the window); the nav
   * shows `navPersons`, windowed when a Focus is active. */
  const loadPersons = useMemo(() => latestOnly(async (signal: AbortSignal) => {
    const fq = focusParams(ref.current.focus);
    try {
      const [all, counts] = await Promise.all([
        api.GET("/api/persons", { signal }).then(unwrap),
        api.GET("/api/faces/scan/status", { params: { query: fq }, signal }).then(unwrap),
      ]);
      let navList = all;
      if (focusActive(ref.current.focus)) {
        const r = await api.GET("/api/persons", { params: { query: fq }, signal });
        if (r.response.ok && r.data) navList = r.data;
      }
      if (signal.aborted) return;
      update({ persons: all, navPersons: navList, counts });
    } catch (err) {
      if (signal.aborted) return;
      say("Failed to load people: " + (err as Error).message, true);
    }
  }), [update, say]);

  /* ── Faces grid ──
   * One latest-only loader for everything that fills the grid — faces, Discover
   * clusters, Crowds — so switching scope mid-load drops the slower reply.
   * `more` pages the flat scopes: "page" appends the next page, "all" the rest. */
  const facesRequest = (s: PeopleState) => {
    const q: Record<string, string | number | boolean> = { scope: s.scope };
    if ((s.scope === "person" || s.scope === "suggested") && s.scopePersonId) q.person_id = s.scopePersonId;
    if (s.scope === "unlabeled" && s.suggestedOnly) q.suggested_only = true;
    // Focus windows the candidate scopes only; the server ignores it elsewhere.
    if (s.scope === "unlabeled" || s.scope === "suggested") Object.assign(q, focusParams(s.focus));
    return q;
  };
  const facesKey = (s: PeopleState) => new URLSearchParams(Object.entries(facesRequest(s)).map(([k, v]) => [k, String(v)])).toString();

  const busyToken = useRef(0);
  const holdBusy = (label: string) => {
    const t = ++busyToken.current;
    update({ busy: label });
    return () => { if (busyToken.current === t) update({ busy: null }); };
  };

  const statusForLoaded = useCallback((total: number, returned: number) => {
    const s = ref.current;
    const pName = personName(s.scopePersonId) || "this person";
    if (s.scope === "suggested") {
      if (returned === 0) {
        say(`No guesses for ${pName}${focusActive(s.focus) ? " in this window" : ""} yet — ` +
          `label a few of their faces first so recognition has examples to match against.` +
          (focusActive(s.focus) ? FOCUS_WIDEN_HINT : ""));
      } else {
        const ambiguous = s.faces.filter((f) => f.alternatives?.length).length;
        const ambig = ambiguous ? `${ambiguous} (amber) may be someone else — check those. ` : "";
        const shownN = gridFacesOf(s).length;
        const selNote = s.selected.size === shownN ? "all selected" : `${s.selected.size} of ${shownN} selected`;
        const countNote = total > returned ? `${returned} of ${total}` : `${returned}`;
        say(`${countNote} guesses for ${pName}, ${selNote}. ${ambig}` +
          `Click any wrong ones to deselect, then Assign to approve the rest.` + focusStatusSuffix(s.focus));
      }
    } else if (s.scope === "recent") {
      if (returned === 0) say("Nothing tagged yet. Faces you assign to a person will show up here, newest first.");
      else say(`${total > returned ? `${returned} of ${total}` : returned} recently tagged face(s), newest first — ` +
        `click a name to un-tag, or use “Untag all” on a batch.`);
    } else {
      const label = s.scope === "person" ? pName : s.scope === "come_back" ? "Come Back" : s.scope;
      say(`${returned} of ${total} faces — ${label}`);
    }
  }, [say]);

  const unlabeledStatus = useCallback(() => {
    const s = ref.current;
    const { total, returned } = s.unlabeledMeta;
    const presel = s.selected.size ? `. ${s.selected.size} confident guess(es) pre-selected.` : "";
    if (s.suggestFilter != null) {
      let msg = `${s.faces.length} face(s) suggested to be ${personName(s.suggestFilter) || "this person"}`;
      if (returned < total) msg += `, within the first ${returned} loaded`;
      say(msg + presel + focusStatusSuffix(s.focus));
      return;
    }
    if (s.suggestedOnly && total === 0) {
      say("No unlabeled faces have a recognition guess yet — uncheck “Only suggested” to see the rest, " +
        "or label a few faces so recognition has examples to match against." + (focusActive(s.focus) ? FOCUS_WIDEN_HINT : ""));
      return;
    }
    const noun = s.suggestedOnly ? "suggested face(s)" : "unlabeled face(s)";
    const by = s.hierarchy === "person" ? "person then date" : s.hierarchy === "photo" ? "photo"
      : s.hierarchy === "directory" ? "folder" : "month then place";
    say(`${returned} of ${total} ${noun}, grouped by ${by}` + presel + focusStatusSuffix(s.focus));
  }, [say]);

  /** Render the Unlabeled queue from its master list, narrowed by the
   *  suggested-person filter; pre-select only the confident guesses (W15). */
  const applyUnlabeledView = useCallback(() => {
    const s = ref.current;
    const pid = s.suggestFilter;
    const faces = pid == null ? s.unlabeledAll.slice() : s.unlabeledAll.filter((f) => f.suggestion?.person_id === pid);
    const visible = s.pending.size ? faces.filter((f) => !s.pending.has(f.id)) : faces;
    const { selected, memory } = applyPreselection(s.selected, preselect.current, `${s.scope}:${s.scopePersonId ?? ""}`, visible,
      (f) => !!f.suggestion && f.suggestion.score >= confidentScore.current && !f.person_name && !f.ignored, (id) => s.pending.has(id));
    preselect.current = memory;
    const focusedId = visible.some((f) => f.id === s.focusedId) ? s.focusedId : visible[0]?.id ?? null;
    update({ faces, selected, focusedId });
    unlabeledStatus();
  }, [update, unlabeledStatus]);

  /** Sort, select and status a freshly loaded (or extended) face list. */
  const showLoadedFaces = useCallback((faces: Face[], total: number, fresh: boolean) => {
    const s = ref.current;
    if (s.scope === "unlabeled") {
      // Oldest first, so each month's place buckets land in first-seen order;
      // fresh data re-freezes the person-run order off the full queue.
      faces.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
      if (fresh) runRank.current = new Map();
      const unlabeledAll = computeMonthLocationGroups(faces, runRank.current).flatMap((g) => g.faces);
      // A filter whose person has no suggested faces here any more falls back to all.
      const suggestFilter = s.suggestFilter != null && unlabeledAll.some((f) => f.suggestion?.person_id === s.suggestFilter)
        ? s.suggestFilter : null;
      update({ unlabeledAll, unlabeledMeta: { total, returned: faces.length }, suggestFilter });
      applyUnlabeledView();
      return true;
    }
    let selected: Set<number>;
    let focusedId = s.focusedId;
    if (s.scope === "suggested") {
      // Chronological (undated last), then pre-select every guess — on entry
      // only; a reload keeps the user's deselections.
      faces.sort((a, b) => (a.photo_datetime || Infinity) - (b.photo_datetime || Infinity) || 0);
      const visible = faces.filter((f) => !s.pending.has(f.id));
      const r = applyPreselection(s.selected, preselect.current, `${s.scope}:${s.scopePersonId ?? ""}`, visible, () => true, (id) => s.pending.has(id));
      preselect.current = r.memory;
      selected = r.selected;
      if (!visible.some((f) => f.id === focusedId)) focusedId = visible[0]?.id ?? null;
    } else {
      if (s.scope === "recent") faces.sort((a, b) => (b.assigned_at || 0) - (a.assigned_at || 0));
      else if (s.scope === "person") faces.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
      selected = pruneSelection(s.selected, faces.filter((f) => !s.pending.has(f.id)));
    }
    const guessPerson = (s.scope === "person" || s.scope === "suggested") && s.scopePersonId ? String(s.scopePersonId) : s.guessPerson;
    update({ faces, selected, focusedId, guessPerson });
    statusForLoaded(total, faces.length);
    return false;
  }, [update, applyUnlabeledView, statusForLoaded]);

  const fetchFacePages = async (q: Record<string, string | number | boolean>, offset: number, want: number, signal: AbortSignal) => {
    const out: Face[] = [];
    let total = 0;
    let next: number | null = offset;
    do {
      const n = Math.max(1, Math.min(want - out.length, FACE_REQUEST_MAX));
      const params = new URLSearchParams(Object.entries({ ...q, limit: n, offset: next }).map(([k, v]) => [k, String(v)]));
      const data: FacePage = await getJson<FacePage>(`/api/faces?${params}`, { signal });
      out.push(...data.faces);
      total = data.total;
      next = data.next_offset ?? null;
    } while (next != null && out.length < want && !signal.aborted);
    return { faces: out, total, nextOffset: next };
  };

  const loadFlat = async (signal: AbortSignal, more: "page" | "all" | null) => {
    const s = ref.current;
    const key = facesKey(s);
    const sameView = s.paging.key === key;
    let prior: Face[] = [], offset = 0, want: number;
    if (more && sameView && truncated(s)) {
      prior = loadedFacesOf(s);
      offset = s.paging.nextOffset!;
      want = more === "all" ? s.paging.total - offset : faceLimit.current;
    } else {
      more = null;
      // A reload of the view on screen (after a commit, a rejection…) keeps as
      // many faces as it had, or every commit after a Load more would snap back.
      want = sameView ? Math.max(faceLimit.current, s.paging.loaded) : faceLimit.current;
    }
    update((c) => ({ paging: { ...c.paging, busy: true } }));
    try {
      const page = await fetchFacePages(facesRequest(s), offset, want, signal);
      if (signal.aborted) return;
      // Offsets are positional: a face that moved between requests could come
      // back twice — drop repeats rather than draw one cell twice.
      const seen = new Set(prior.map((f) => f.id));
      const faces = prior.concat(page.faces.filter((f) => !seen.has(f.id)));
      update({ paging: { key, total: page.total, loaded: offset + page.faces.length, nextOffset: page.nextOffset, busy: false } });
      const wasUnlabeled = showLoadedFaces(faces, page.total, !more);
      if (more) {
        say(`Loaded ${(faces.length - prior.length).toLocaleString()} more face(s) — ` +
          `${faces.length.toLocaleString()} of ${page.total.toLocaleString()} now shown.` +
          (wasUnlabeled && ref.current.suggestFilter != null ? " (The suggested-person filter still applies.)" : ""));
      } else if (wasUnlabeled && jumpToUndated.current) {
        jumpToUndated.current = false;
        setTimeout(scrollToUndated, 0);
      }
    } catch (err) {
      if (signal.aborted) return;
      say((more ? "Failed to load more faces: " : "Failed to load faces: ") + (err as Error).message, true);
    } finally {
      if (!signal.aborted) update((c) => ({ paging: { ...c.paging, busy: false } }));
    }
  };

  const scrollToUndated = () => {
    const divider = [...document.querySelectorAll<HTMLElement>("#grid .grid-year-divider")].find((el) => el.textContent === "Undated");
    if (divider) divider.scrollIntoView({ block: "start" });
    else if (ref.current.gridSort !== "date") say('Switch Sort back to "Date" to jump to the undated section.');
    else say("No undated faces — every face here has a timestamp.");
  };

  const loadClusters = async (signal: AbortSignal) => {
    update({ selected: new Set(), focusedId: null });
    say("Finding groups… this can take a few seconds on a large library.");
    clusterLoad.current = signal;
    const f = ref.current.focus;
    try {
      const data = unwrap(await api.GET("/api/faces/clusters", { params: { query: focusParams(f) }, signal }));
      if (signal.aborted) return;
      update({ clusters: data.clusters, clustersStale: false });
      if (!data.clusters.length) {
        say(`No groups found among ${data.scanned} clear unlabeled faces. ` +
          `Tag a few faces and use “Find more”, or rescan if many are still pending.` + (focusActive(f) ? FOCUS_WIDEN_HINT : ""));
      } else {
        say(`${data.clusters.length} group(s) across ${data.grouped} of ${data.scanned} faces. Name or assign each group, or Ignore it.`);
      }
    } catch (err) {
      if (signal.aborted) return;
      say("Clustering failed: " + (err as Error).message, true);
    } finally {
      if (clusterLoad.current === signal) clusterLoad.current = null;
    }
  };

  const loadCrowds = async (signal: AbortSignal) => {
    update({ selected: new Set(), focusedId: null, crowdsKeep: new Set() });
    say("Loading crowd photos…");
    const s = ref.current;
    try {
      const data = unwrap(await api.GET("/api/crowds", {
        params: { query: { min_faces: s.crowdMinFaces, group_gap: s.crowdGap, ...focusParams(s.focus) } }, signal,
      }));
      if (signal.aborted) return;
      update({ crowds: data.groups });
      if (!data.groups.length) {
        say(`No crowd photos found with ≥ ${s.crowdMinFaces} faces. Try lowering the threshold or scan more photos.` +
          (focusActive(s.focus) ? FOCUS_WIDEN_HINT : ""));
      } else {
        say(`${data.groups.length} event group(s) across ${data.photo_count} crowd photo(s). ` +
          `Open a photo, tag the key people, then ignore the rest.`);
      }
    } catch (err) {
      if (signal.aborted) return;
      say("Failed to load crowds: " + (err as Error).message, true);
    }
  };

  const loadFaces = useMemo(() => latestOnly(async (signal: AbortSignal, more: "page" | "all" | null = null) => {
    // Person tags may have changed since the last fetch.
    void qc.invalidateQueries({ queryKey: ["photo-tagged-people"] });
    const s = ref.current;
    if (s.scope === "discover" || s.scope === "crowds") {
      const release = holdBusy(s.scope === "discover" ? "Grouping faces…" : "Finding crowds…");
      try {
        if (s.scope === "discover") await loadClusters(signal);
        else await loadCrowds(signal);
      } finally { if (!signal.aborted) release(); }
      return;
    }
    // A Load more appends: the grid stays live and the banner shows progress.
    const appending = !!more && s.paging.key === facesKey(s) && truncated(s);
    const release = appending ? () => {} : holdBusy("Loading faces…");
    try {
      await loadFlat(signal, more);
    } finally { if (!signal.aborted) release(); }
  }), []);

  const reload = useCallback(async () => {
    await loadPersons();
    await loadFaces();
  }, [loadPersons, loadFaces]);

  /* ── Scope selection ── */
  const selectScope = useCallback(async (scope: Scope, personId: number | null = null) => {
    // A new visit pre-selects afresh, starts from one page, and drops the
    // Unlabeled filter; reloads within it keep all three.
    preselect.current = freshPreselectMemory();
    update({ scope, scopePersonId: personId, selected: new Set(), anchorIdx: -1, focusedId: null, suggestFilter: null, paging: NO_PAGING });
    await loadFaces();
    await loadPersons();
  }, [update, loadFaces, loadPersons]);

  /* ── Selection ── */
  const setSel = (next: { selected: Set<number>; focusedId: number | null; anchorIdx: number }) => update(next);
  const selOf = (s: PeopleState) => ({ selected: s.selected, focusedId: s.focusedId, anchorIdx: s.anchorIdx });

  const clickCell = useCallback((idx: number, mod: { shift: boolean; toggle: boolean }) => {
    const s = ref.current;
    setSel(cellClick(selOf(s), orderRef.current, idx, mod, s.scope === "suggested"));
  }, []);

  const focusFace = useCallback((id: number) => update({ focusedId: id }), [update]);

  const deselectAll = useCallback(() => {
    update({ selected: new Set(), anchorIdx: -1 });
    say("Deselected all faces.");
  }, [update, say]);

  const selectAll = useCallback(() => {
    const s = ref.current;
    const visible = gridFacesOf(s);
    if (!visible.length) return;
    update({ selected: new Set(visible.map((f) => f.id)) });
    const notLoaded = truncated(s) ? s.paging.total - s.paging.loaded : 0;
    say(`Selected all ${visible.length} face(s)` + (notLoaded
      ? ` loaded so far — ${notLoaded.toLocaleString()} more aren't loaded (Load more above the grid).` : "."));
  }, [update, say]);

  const selectGroup = useCallback((faces: readonly Face[], additive: boolean, label: string) => {
    const s = ref.current;
    const selected = additive ? new Set(s.selected) : new Set<number>();
    faces.forEach((f) => selected.add(f.id));
    update({ selected, focusedId: faces[0]?.id ?? s.focusedId });
    say(`${additive ? "Added" : "Selected only"} ${faces.length} face(s) from ${label || facesDateRange(faces)}. ` +
      `Assign to approve, or refine with click/Ctrl-click.`);
  }, [update, say]);

  const deselectGroup = useCallback((faces: readonly Face[], label: string) => {
    const selected = new Set(ref.current.selected);
    faces.forEach((f) => selected.delete(f.id));
    update({ selected });
    say(`Deselected ${faces.length} face(s) from ${label}.`);
  }, [update, say]);

  const addToSelection = useCallback((faces: readonly Face[]) => {
    const selected = new Set(ref.current.selected);
    faces.forEach((f) => selected.add(f.id));
    update({ selected });
  }, [update]);

  const keyMove = useCallback((delta: number, extend: boolean) => {
    const s = ref.current;
    const next = (extend ? extendFocus : moveFocus)(selOf(s), orderRef.current, delta);
    setSel(next);
    return next.focusedId;
  }, []);

  const toggleFocused = useCallback(() => {
    const s = ref.current;
    if (s.focusedId == null) return;
    const selected = new Set(s.selected);
    if (selected.has(s.focusedId)) selected.delete(s.focusedId); else selected.add(s.focusedId);
    update({ selected });
  }, [update]);

  const selectionOrFocused = (): number[] => {
    const s = ref.current;
    if (s.selected.size) return [...s.selected];
    return s.focusedId != null ? [s.focusedId] : [];
  };

  /* ── Staging ── */
  const stageNoRender = (ids: readonly number[], change: Change): number => {
    const s = ref.current;
    const pending = new Map(s.pending);
    const selected = new Set(s.selected);
    let focusedId = s.focusedId;
    let n = 0;
    for (const id of ids) {
      const face = findFace(id);
      if (!face) continue;
      pending.set(id, { face, ...change });
      selected.delete(id);
      if (focusedId === id) focusedId = null;
      n++;
    }
    // The render order shifts under the cells just removed.
    if (n) update({ pending, selected, focusedId, anchorIdx: -1 });
    return n;
  };

  const stageFaces = useCallback((ids: readonly number[], change: Change, dest: string) => {
    const n = stageNoRender(ids, change);
    if (!n) { say("Nothing to stage.", true); return; }
    say(`Staged ${n} face(s) → ${dest}. Nothing saved yet — review at the bottom of the grid, then Commit.`);
  }, [say]);

  const unstage = useCallback((ids: readonly number[], quiet = false) => {
    const pending = new Map(ref.current.pending);
    let removed = 0;
    ids.forEach((id) => { if (pending.delete(id)) removed++; });
    if (!removed) return;
    update({ pending });
    if (!quiet) say(`Reverted ${removed} staged change(s).`);
  }, [update, say]);

  const groupsOfPending = (entries?: Iterable<PendingEntry>) =>
    groupPendingEntries(entries ?? ref.current.pending.values(), ref.current.persons);

  const commitPending = useCallback(async (groups: PendingGroup[], what?: string) => {
    if (commitInFlight.current) { say("A commit is already in progress…", true); return; }
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    if (!total) { say("Nothing staged to commit.", true); return; }
    const yes = await confirm({
      title: "Commit staged changes",
      message: `Commit ${total} staged change(s)${what ? ` — ${what}` : ""}? This writes them to the database.`,
      confirmLabel: "Commit",
    });
    if (!yes) return;
    commitInFlight.current = true;
    try {
      say(`Committing ${total} change(s)…`);
      let saved = 0;
      const failures: string[] = [];
      for (const g of groups) {
        const ids = g.entries.map((e) => e.face.id);
        try {
          const [path, body] = pendingRequest(g, ids);
          unwrap(await api.POST(path, { body } as never));
          // Only what landed leaves the staging area; a failed group stays staged.
          const pending = new Map(ref.current.pending);
          ids.forEach((id) => pending.delete(id));
          update({ pending });
          saved += ids.length;
        } catch (err) {
          failures.push(`${g.label} (${(err as Error).message})`);
        }
      }
      await loadPersons();
      await loadFaces();
      if (failures.length) say(`Committed ${saved} of ${total} change(s). Still staged after failing: ${failures.join(", ")}.`, true);
      else say(`Committed ${saved} change(s).`);
    } finally {
      commitInFlight.current = false;
    }
  }, [confirm, say, update, loadPersons, loadFaces]);

  const revertPending = useCallback(async (groups: PendingGroup[], what?: string) => {
    const ids = groups.flatMap((g) => g.entries.map((e) => e.face.id));
    if (!ids.length) { say("Nothing staged to revert.", true); return; }
    if (ids.length > SELECTION_CONFIRM_THRESHOLD) {
      const yes = await confirm({ title: "Revert staged changes", message: `Discard ${ids.length} staged change(s)${what ? ` — ${what}` : ""}?`,
        confirmLabel: "Discard", danger: true });
      if (!yes) return;
    }
    unstage(ids);
  }, [confirm, say, unstage]);

  /* ── Undo toasts (U3) for the immediate writes ── The faces go back
   * server-side; the view is reloaded rather than patched. */
  const offerUndo = useCallback((message: string, token: FaceUndoToken | null | undefined) => {
    if (!faceUndoable(token)) return;
    toastsRef.current.undoToast(message, async () => {
      const r = await undoFaceToken(token);
      await loadPersons();
      await loadFaces();
      return r;
    });
  }, [loadPersons, loadFaces]);

  /* ── Discover: patch the groups in place (U6) ──
   * Faces that left the unlabeled pool drop out of their groups instead of the
   * library being re-clustered. Empty groups go; a group that only lost some
   * faces, or any assignment (the gallery grew), marks the groups stale. If the
   * focused face goes, focus moves to its neighbour in the same group. */
  const dropFromClusters = useCallback((ids: readonly number[], assigned = false) => {
    const gone = new Set(ids);
    if (!gone.size) return;
    const s = ref.current;
    let nextFocus: number | null = null;
    if (s.focusedId != null && gone.has(s.focusedId)) {
      const cl = s.clusters.find((c) => c.sample.some((f) => f.id === s.focusedId));
      if (cl) {
        const i = cl.sample.findIndex((f) => f.id === s.focusedId);
        const rest = cl.sample.filter((f) => !gone.has(f.id));
        nextFocus = rest[Math.min(i, rest.length - 1)]?.id ?? null;
      }
    }
    let partial = false;
    const clusters: Cluster[] = [];
    for (const cl of s.clusters) {
      if (!cl.face_ids.some((id) => gone.has(id))) { clusters.push(cl); continue; }
      const face_ids = cl.face_ids.filter((id) => !gone.has(id));
      if (!face_ids.length) continue;
      partial = true;
      clusters.push({ ...cl, face_ids, sample: cl.sample.filter((f) => !gone.has(f.id)), size: face_ids.length });
    }
    const selected = new Set(s.selected);
    ids.forEach((id) => selected.delete(id));
    update({
      clusters, selected,
      focusedId: s.focusedId != null && gone.has(s.focusedId) ? nextFocus : s.focusedId,
      clustersStale: s.clustersStale || partial || assigned,
    });
    // A clustering request in flight was computed before this action and would
    // put the faces back — restart it so the fresh result wins.
    if (clusterLoad.current && !clusterLoad.current.aborted) void loadFaces();
  }, [update, loadFaces]);

  /** In Discover, patch the groups after a successful write and say so (true);
   *  anywhere else false, and the caller reloads. */
  const patchClusters = (ids: readonly number[], assigned = false) => {
    if (ref.current.scope !== "discover") return false;
    dropFromClusters(ids, assigned);
    return true;
  };

  /* ── Face actions ── */
  const untagFaces = useCallback(async (ids: number[], who?: string) => {
    if (!ids.length) return;
    if (stagingEnabled()) { stageFaces(ids, { kind: "unassign" }, "Unassign"); return; }
    if (ids.length > 1 && !(await confirm({ title: "Un-tag faces", message: `Un-tag ${ids.length} face(s)${who ? ` (${who})` : ""}?`, confirmLabel: "Un-tag", danger: true }))) return;
    try {
      const data = unwrap(await api.POST("/api/faces/assign", { body: { face_ids: ids, clear: true } }));
      say(`Un-tagged ${ids.length} face(s).`);
      update((s) => ({ selected: new Set(), focusedId: s.focusedId != null && ids.includes(s.focusedId) ? null : s.focusedId }));
      await reload();
      offerUndo(`Un-tagged ${ids.length} face(s).`, data.undo);
    } catch (err) {
      say("Un-tag failed: " + (err as Error).message, true);
    }
  }, [stageFaces, confirm, say, update, reload, offerUndo]);

  const requireSelection = () => {
    const ids = selectionOrFocused();
    if (!ids.length) say("Select one or more faces first.", true);
    return ids;
  };

  /** Selection bar / shortcuts: these exist on the flat (staged) scopes only. */
  const unassignSelected = useCallback(() => {
    const ids = requireSelection();
    if (ids.length) stageFaces(ids, { kind: "unassign" }, "Unassign");
  }, [stageFaces]);

  const ignoreIds = useCallback(async (ids: number[], ignored: boolean) => {
    if (stagingEnabled()) { stageFaces(ids, { kind: ignored ? "ignore" : "unignore" }, ignored ? "Ignore" : "Un-ignore"); return; }
    try {
      const data = unwrap(await api.POST("/api/faces/ignore", { body: { face_ids: ids, ignored } }));
      const msg = ignored ? `Ignored ${ids.length} face(s).` : `Restored ${ids.length} face(s).`;
      say(msg);
      offerUndo(msg, data.undo);
      // Discover only ever ignores here: its faces are live.
      if (patchClusters(ignored ? ids : [])) { await loadPersons(); return; }
      update({ selected: new Set() });
      await reload();
    } catch (err) {
      say("Ignore failed: " + (err as Error).message, true);
    }
  }, [stageFaces, say, offerUndo, loadPersons, update, reload]);

  const comeBackIds = useCallback(async (ids: number[], comeBack: boolean) => {
    if (stagingEnabled()) { stageFaces(ids, { kind: comeBack ? "come_back" : "uncome_back" }, comeBack ? "Come Back" : "Back to Unlabeled"); return; }
    try {
      const data = unwrap(await api.POST("/api/faces/come-back", { body: { face_ids: ids, come_back: comeBack } }));
      const msg = comeBack ? `Moved ${ids.length} face(s) to Come Back.` : `Restored ${ids.length} face(s).`;
      say(msg);
      offerUndo(msg, data.undo);
      if (patchClusters(comeBack ? ids : [])) { await loadPersons(); return; }
      update({ selected: new Set() });
      await reload();
    } catch (err) {
      say("Come back failed: " + (err as Error).message, true);
    }
  }, [stageFaces, say, offerUndo, loadPersons, update, reload]);

  const ignoreSelected = useCallback((ignored: boolean) => {
    const ids = requireSelection();
    if (ids.length) void ignoreIds(ids, ignored);
  }, [ignoreIds]);

  const comeBackSelected = useCallback((comeBack: boolean) => {
    const ids = requireSelection();
    if (ids.length) void comeBackIds(ids, comeBack);
  }, [comeBackIds]);

  /** One face to a person (or unassign): staged on the flat grids, else a
   *  per-face write (Discover's samples and detail pane). */
  const confirmFace = useCallback(async (faceId: number, personId: number | null) => {
    if (stagingEnabled()) {
      stageFaces([faceId], personId == null ? { kind: "unassign" } : { kind: "assign", personId },
        personId == null ? "Unassign" : (personName(personId) || "a person"));
      return;
    }
    try {
      const data = unwrap(await api.POST("/api/faces/{face_id}/assign", {
        params: { path: { face_id: faceId } }, body: personId == null ? { clear: true } : { person_id: personId, clear: false },
      }));
      const who = personName(personId);
      const msg = personId == null ? "Unassigned this face." : `Assigned this face${who ? ` to ${who}` : ""}.`;
      offerUndo(msg, data.undo);
      update((s) => { const selected = new Set(s.selected); selected.delete(faceId); return { selected }; });
      if (patchClusters(personId == null ? [] : [faceId], true)) { say(msg); await loadPersons(); return; }
      update((s) => ({ focusedId: s.focusedId === faceId ? null : s.focusedId }));
      await reload();
    } catch (err) {
      say("Confirm failed: " + (err as Error).message, true);
    }
  }, [stageFaces, offerUndo, update, say, loadPersons, reload]);

  /** A face to a new person by name (quick actions / detail pane). */
  const assignFaceNew = useCallback(async (faceId: number, name: string) => {
    if (stagingEnabled()) { stageFaces([faceId], { kind: "assign", personId: null, name }, `${name} (new person)`); return; }
    try {
      const data = unwrap(await api.POST("/api/faces/{face_id}/assign", { params: { path: { face_id: faceId } }, body: { name, clear: false } }));
      offerUndo(`Assigned this face to ${name} (new person).`, data.undo);
      if (patchClusters([faceId], true)) { say(`Assigned this face to ${name} (new person).`); await loadPersons(); return; }
      await Promise.all([loadPersons(), loadFaces()]);
    } catch (err) {
      say("Assign failed: " + (err as Error).message, true);
    }
  }, [stageFaces, offerUndo, say, loadPersons, loadFaces]);

  /** Detail-pane assignment acts on the previewed face only, never the selection. */
  const assignFocused = useCallback((who: { person_id: number } | { name: string } | null) => {
    const f = findFace(ref.current.focusedId);
    if (!f) { say("Select a face first.", true); return; }
    if (who === null) void confirmFace(f.id, null);
    else if ("person_id" in who) void confirmFace(f.id, who.person_id);
    else void assignFaceNew(f.id, who.name);
  }, [findFace, say, confirmFace, assignFaceNew]);

  const assignSelectedTo = useCallback((who: { person_id: number } | { name: string }) => {
    const ids = requireSelection();
    if (!ids.length) return;
    if ("person_id" in who) stageFaces(ids, { kind: "assign", personId: who.person_id }, personName(who.person_id) || "a person");
    else stageFaces(ids, { kind: "assign", personId: null, name: who.name }, who.name);
  }, [stageFaces]);

  const openAssignPicker = useCallback(() => {
    const ids = selectionOrFocused();
    if (!ids.length) { say("Select one or more faces first.", true); return; }
    setPicker({ title: `Assign ${ids.length} face(s) to…`, onPick: assignSelectedTo });
  }, [say, assignSelectedTo]);

  const openDetailPicker = useCallback(() => {
    if (!findFace(ref.current.focusedId)) { say("Select a face first.", true); return; }
    setPicker({ title: "Assign to…", onPick: (who) => assignFocused(who) });
  }, [findFace, say, assignFocused]);

  /* ── Suggestions ── */
  const acceptSuggestionsFor = useCallback(async (faces: readonly Face[], label?: string) => {
    const targets = faces.filter((f) => f.suggestion && !f.person_name && !f.ignored);
    const where = label ? ` in ${label}` : "";
    if (!targets.length) { say(`No suggestions to accept${where}.`, true); return; }
    const byPerson = new Map<number, number[]>();
    targets.forEach((f) => {
      const pid = f.suggestion!.person_id;
      byPerson.set(pid, [...(byPerson.get(pid) ?? []), f.id]);
    });
    if (stagingEnabled()) {
      // One staged group per suggested person, one render at the end.
      byPerson.forEach((ids, pid) => stageNoRender(ids, { kind: "assign", personId: pid }));
      say(`Staged ${targets.length} suggested face(s)${where} across ${byPerson.size} person(s). Nothing saved yet — ` +
        `review at the bottom of the grid, then Commit.`);
      return;
    }
    // One POST per person, disjoint faces: their undo tokens concatenate.
    const undoFaces: unknown[] = [];
    try {
      for (const [pid, ids] of byPerson) {
        const data = unwrap(await api.POST("/api/faces/assign", { body: { face_ids: ids, person_id: pid, clear: false } }));
        undoFaces.push(...(((data.undo as { faces?: unknown[] } | null)?.faces) ?? []));
      }
      say(`Accepted suggestions for ${targets.length} face(s)${where}.`);
      update({ selected: new Set() });
      await reload();
      offerUndo(`Accepted suggestions for ${targets.length} face(s).`, { faces: undoFaces, person: null, created_person_id: null });
    } catch (err) {
      say("Accept failed: " + (err as Error).message, true);
    }
  }, [say, update, reload, offerUndo]);

  const acceptSelected = useCallback(() => {
    const ids = new Set(selectionOrFocused());
    void acceptSuggestionsFor(ref.current.faces.filter((f) => ids.has(f.id)));
  }, [acceptSuggestionsFor]);

  /** Patch one face after a "not this person": record the negative, drop the
   *  person, promote the next alternative — mirroring the server's re-ranking.
   *  In a view narrowed to that person the face no longer belongs. */
  const applyRejectionLocally = (faceId: number, personId: number) => {
    const s = ref.current;
    const patch = (f: Face): Face => {
      if (f.id !== faceId) return f;
      const alts = (f.alternatives ?? []).filter((a) => a.person_id !== personId);
      let suggestion = f.suggestion ?? null;
      if (suggestion?.person_id === personId) {
        const next = alts.shift();
        suggestion = next ? { person_id: next.person_id, person_name: next.person_name, score: next.score } : null;
      }
      return { ...f, negatives: [...(f.negatives ?? []), personId], suggestion, alternatives: alts };
    };
    let faces = s.faces.map(patch);
    let unlabeledAll = s.unlabeledAll.map(patch);
    let paging = s.paging;
    const selected = new Set(s.selected);
    let focusedId = s.focusedId;
    const viewPid = s.scope === "suggested" ? s.scopePersonId : s.scope === "unlabeled" ? s.suggestFilter : null;
    if (viewPid != null && personId === viewPid) {
      faces = faces.filter((f) => f.id !== faceId);
      if (s.scope === "unlabeled") unlabeledAll = unlabeledAll.filter((f) => f.id !== faceId);
      // The server drops it from this person's guesses too, so the next page
      // starts one row earlier (the Unlabeled filter is client-side: no shift).
      if (s.scope === "suggested") {
        const loaded = Math.max(0, paging.loaded - 1);
        paging = { ...paging, loaded, total: Math.max(0, paging.total - 1), nextOffset: paging.nextOffset != null ? loaded : null };
      }
      selected.delete(faceId);
      if (focusedId === faceId) focusedId = null;
    }
    update({ faces, unlabeledAll, paging, selected, focusedId });
  };

  const rejectSuggestion = useCallback(async (faceId: number, personId: number, name: string, negative = true) => {
    try {
      unwrap(await api.POST("/api/faces/negatives", { body: { face_ids: [faceId], person_id: personId, negative } }));
      say(negative ? `Marked as not ${name}.` : `Undid: ${name} can be suggested again.`);
      // A negative moves no face between Discover's groups, only the vote.
      if (ref.current.scope === "discover") { update({ clustersStale: true }); return; }
      if (negative && ref.current.faces.length > REJECT_LOCAL_THRESHOLD) applyRejectionLocally(faceId, personId);
      else await loadFaces();
    } catch (err) {
      say((negative ? "Reject" : "Undo") + " failed: " + (err as Error).message, true);
    }
  }, [say, update, loadFaces]);

  /* ── Nuclear option ── Wipe every face + cached rendition for the photos
   * behind the selected faces, so a rescan starts from scratch. */
  const nukeSelected = useCallback(async () => {
    const ids = requireSelection();
    if (!ids.length) return;
    const photoIds = [...new Set(ids.map((id) => findFace(id)?.photo_id).filter((x): x is number => x != null))];
    if (!photoIds.length) { say("Could not resolve photos for the selected face(s).", true); return; }
    const plural = photoIds.length === 1 ? "photo" : "photos";
    const yes = await confirm({
      title: "Nuclear option",
      message: `Permanently delete ALL faces (detected, assigned, and ignored) for ${photoIds.length} ${plural}, and wipe their ` +
        `cached thumbnails/previews so detection starts completely from scratch. This cannot be undone. Continue?`,
      confirmLabel: "Delete all faces", danger: true,
    });
    if (!yes) return;
    try {
      const data = unwrap(await api.POST("/api/faces/nuke", { body: { photo_ids: photoIds } }));
      say(`Nuked ${data.faces_deleted} face(s) across ${data.photos} ${plural}. Rescan to re-detect.`);
      // Those faces no longer exist — drop staged decisions pointing at them.
      const gone = new Set(photoIds);
      const pending = new Map(ref.current.pending);
      [...pending].forEach(([id, e]) => { if (gone.has(e.face.photo_id)) pending.delete(id); });
      update({ pending, selected: new Set(), focusedId: null });
      await reload();
    } catch (err) {
      say("Nuke failed: " + (err as Error).message, true);
    }
  }, [findFace, say, confirm, update, reload]);

  /* ── Discover group actions (immediate, with undo) ── */
  const clusterAssign = useCallback(async (cl: Cluster, who: { person_id: number } | { name: string }, label: string) => {
    try {
      const data = unwrap(await api.POST("/api/faces/assign", { body: { face_ids: cl.face_ids, ...who, clear: false } }));
      say(`Assigned ${cl.face_ids.length} face(s) to ${label}.`);
      dropFromClusters(cl.face_ids, true);
      await loadPersons();
      offerUndo(`Assigned ${cl.face_ids.length} face(s) to ${label}.`, data.undo);
    } catch (err) {
      say("Assign failed: " + (err as Error).message, true);
    }
  }, [say, dropFromClusters, loadPersons, offerUndo]);

  const clusterIgnore = useCallback(async (cl: Cluster) => {
    if (!(await confirm({ title: "Ignore group", message: `Ignore all ${cl.size} face(s) in this group?`, confirmLabel: "Ignore all", danger: true }))) return;
    try {
      const data = unwrap(await api.POST("/api/faces/ignore", { body: { face_ids: cl.face_ids, ignored: true } }));
      say(`Ignored ${cl.face_ids.length} face(s).`);
      dropFromClusters(cl.face_ids);
      await loadPersons();
      offerUndo(`Ignored ${cl.face_ids.length} face(s).`, data.undo);
    } catch (err) {
      say("Ignore failed: " + (err as Error).message, true);
    }
  }, [confirm, say, dropFromClusters, loadPersons, offerUndo]);

  const nameCluster = useCallback((cl: Cluster) => {
    setPicker({
      title: `Name this group of ${cl.size} face(s)`,
      placeholder: "Search people, or type a new name…",
      initialQuery: cl.suggestion?.person_name ?? "",
      onPick: (who) => void clusterAssign(cl, who, "person_id" in who ? (personName(who.person_id) ?? "") : who.name),
    });
  }, [clusterAssign]);

  /* ── Crowds ── */
  const crowdIgnore = useCallback(async (photoIds: number[]): Promise<number | null> => {
    try {
      const data = unwrap(await api.POST("/api/crowds/ignore-unlabeled", { body: { photo_ids: photoIds } }));
      say(`Ignored ${data.ignored} face(s).`);
      await loadPersons();
      offerUndo(`Ignored ${data.ignored} unlabeled face(s).`, data.undo);
      return data.ignored;
    } catch (err) {
      say("Ignore failed: " + (err as Error).message, true);
      return null;
    }
  }, [say, loadPersons, offerUndo]);

  const crowdIgnorePhoto = useCallback(async (photo: CrowdPhoto) => {
    if ((await crowdIgnore([photo.id])) === null) return;
    update((s) => ({
      crowdsKeep: new Set([...s.crowdsKeep, photo.id]),
      crowds: s.crowds.map((g) => !g.photos.some((p) => p.id === photo.id) ? g : {
        ...g,
        unlabeled_faces: g.unlabeled_faces - photo.unlabeled_faces,
        photos: g.photos.map((p) => (p.id === photo.id ? { ...p, unlabeled_faces: 0 } : p)),
      }),
    }));
  }, [crowdIgnore, update]);

  const crowdIgnoreGroup = useCallback(async (g: CrowdGroup) => {
    const pending = g.photos.filter((p) => p.unlabeled_faces > 0);
    if (!(await confirm({ title: "Ignore unlabeled faces",
      message: `Ignore all ${g.unlabeled_faces} unlabeled face(s) across ${pending.length} photo(s) in this group?`,
      confirmLabel: "Ignore", danger: true }))) return;
    if ((await crowdIgnore(pending.map((p) => p.id))) === null) return;
    update((s) => ({
      crowdsKeep: new Set(),
      crowds: s.crowds.map((x) => (x === g || x.label === g.label && x.photos[0]?.id === g.photos[0]?.id)
        ? { ...x, unlabeled_faces: 0, photos: x.photos.map((p) => ({ ...p, unlabeled_faces: 0 })) } : x),
    }));
  }, [confirm, crowdIgnore, update]);

  /* ── People CRUD ── */
  const createPerson = useCallback(async (name: string) => {
    if (!name.trim()) return;
    try {
      unwrap(await api.POST("/api/persons", { body: { name: name.trim() } }));
      await loadPersons();
    } catch (err) {
      say("Could not add person: " + (err as Error).message, true);
    }
  }, [loadPersons, say]);

  const addPerson = useCallback(() => {
    setPicker({
      title: "Add person", placeholder: "Type a name…",
      onPick: async (who) => {
        if ("person_id" in who) {
          const p = ref.current.persons.find((q) => q.id === who.person_id);
          await selectScope("person", who.person_id);
          say(`${p ? p.name : "That person"} already exists — showing them.`);
        } else {
          void createPerson(who.name);
        }
      },
    });
  }, [selectScope, say, createPerson]);

  const saveBirth = useCallback(async (p: Person, value: string) => {
    const birth = value.trim() || null;
    try {
      unwrap(await api.PATCH("/api/persons/{person_id}", { params: { path: { person_id: p.id } }, body: { birth_date: birth } }));
      say(birth ? `Set ${p.name}'s birth date to ${birth}.` : `Cleared ${p.name}'s birth date.`);
      await loadPersons();
      // Suggestions depend on birth dates.
      if (ref.current.scope === "unlabeled" || ref.current.scope === "suggested") await loadFaces();
      return true;
    } catch (err) {
      say("Could not set birth date: " + (err as Error).message, true);
      return false;
    }
  }, [say, loadPersons, loadFaces]);

  const deletePerson = useCallback(async (p: Person) => {
    // The confirm stays (a person can carry thousands of labels); the Undo toast
    // covers the click that gets past it.
    if (!(await confirm({ title: "Delete person", message: `Delete "${p.name}"? Their faces will become unassigned.`, confirmLabel: "Delete", danger: true }))) return;
    try {
      const { undo } = unwrap(await api.DELETE("/api/persons/{person_id}", { params: { path: { person_id: p.id } } }));
      // Staged assignments to this person can't be committed any more (the
      // server 404s an unknown person): put those faces back, kept for Undo.
      const orphaned: [number, PendingEntry][] = [];
      ref.current.pending.forEach((e, id) => { if (e.kind === "assign" && e.personId === p.id) orphaned.push([id, e]); });
      unstage(orphaned.map(([id]) => id), true);
      const s = ref.current;
      const wasViewing = s.scope === "person" && s.scopePersonId === p.id;
      if (wasViewing) {
        preselect.current = freshPreselectMemory();
        update({ scope: "unlabeled", scopePersonId: null, selected: new Set(), paging: NO_PAGING });
      }
      await reload();
      if (faceUndoable(undo)) {
        toastsRef.current.undoToast(`Deleted “${p.name}”.`, async () => {
          const r = await undoFaceToken(undo);
          const pid = r.out.person_id ?? p.id;
          // Re-stage what the delete unstaged, under the (maybe new) id.
          const pending = new Map(ref.current.pending);
          let restaged = 0;
          orphaned.forEach(([id, e]) => { if (!pending.has(id)) { pending.set(id, { ...e, personId: pid }); restaged++; } });
          if (restaged) update({ pending });
          const c = ref.current;
          if (wasViewing && c.scope === "unlabeled" && c.scopePersonId == null) await selectScope("person", pid);
          else await reload();
          return r;
        });
      }
    } catch (err) {
      say("Could not delete person: " + (err as Error).message, true);
    }
  }, [confirm, unstage, update, reload, say, selectScope]);

  /* ── Toolbar / nav controls ── */
  const changeFocus = useCallback(async (value: string) => {
    const focus = focusFromValue(value);
    // A month window comes from the URL: one-shot, never saved as the preference.
    if (!value.startsWith("m:")) writeString(FOCUS_LS_KEY, value || null);
    update({ focusValue: value, focus });
    await loadPersons();
    await loadFaces();
  }, [update, loadPersons, loadFaces]);

  const setSuggestedOnly = useCallback((on: boolean) => {
    update({ suggestedOnly: on });
    saveViewPref(SUGGESTED_ONLY_LS_KEY, on);
    if (ref.current.scope === "unlabeled") void loadFaces();
  }, [update, loadFaces]);

  const setSuggestFilter = useCallback((pid: number | null) => {
    update({ suggestFilter: pid });
    if (ref.current.scope === "unlabeled") applyUnlabeledView();
  }, [update, applyUnlabeledView]);

  const setHierarchy = useCallback((h: Hierarchy) => {
    update({ hierarchy: h });
    writeString(UNLABELED_HIERARCHY_LS_KEY, h);
    if (ref.current.scope === "unlabeled") unlabeledStatus();
  }, [update, unlabeledStatus]);

  const setGridSort = useCallback((sort: GroupSort) => {
    // Render-only: no refetch, and the selection survives.
    update({ gridSort: sort, crowdsKeep: new Set() });
    writeString(GRID_SORT_LS_KEY, sort);
  }, [update]);

  const setHideDoneCrowds = useCallback((on: boolean) => {
    update({ hideDoneCrowds: on, crowdsKeep: new Set() });
    saveViewPref(HIDE_DONE_CROWDS_LS_KEY, on);
  }, [update]);

  const loadMore = useCallback(async (all: boolean) => {
    const s = ref.current;
    if (s.paging.busy || !truncated(s)) return;
    if (all && s.paging.total > FACE_REQUEST_MAX) {
      const remaining = s.paging.total - s.paging.loaded;
      const yes = await confirm({ title: "Load all faces", confirmLabel: "Load all",
        message: `Load all ${remaining.toLocaleString()} remaining face(s)? ${s.paging.total.toLocaleString()} faces in one grid ` +
          `can make the page slow to scroll and select.` });
      if (!yes) return;
    }
    void loadFaces(all ? "all" : "page");
  }, [confirm, loadFaces]);

  const reviewGuesses = useCallback(() => {
    const pid = parseInt(ref.current.guessPerson, 10);
    if (!pid) { say("Pick a person to review guesses for.", true); return; }
    void selectScope("suggested", pid);
  }, [say, selectScope]);

  /* ── Photos ── */
  const openPhoto = useCallback((photoId: number) => nav.open(`/api/preview/${photoId}`), []);
  const openFocusedPhoto = useCallback(() => {
    const f = findFace(ref.current.focusedId);
    if (f) openPhoto(f.photo_id);
  }, [findFace, openPhoto]);
  const openFocusedFullsize = useCallback(() => {
    const f = findFace(ref.current.focusedId);
    if (f && isRawName(f.filename)) nav.open(fullSizeUrl(f.photo_id));
  }, [findFace]);
  const openPhotoFaces = useCallback((photoId: number) => nav.go(`/photo-faces.html?photo_id=${photoId}`), []);
  const crowdReviewUrl = useCallback((photoId: number) => {
    const s = ref.current;
    const fq = focusQuery(s.focus);
    // The Focus rides along, so Crowd Review's Prev/Next walks these photos.
    return `/photo-faces.html?photo_id=${photoId}&mode=crowd&min_faces=${s.crowdMinFaces}&group_gap=${s.crowdGap}` + (fq ? `&${fq}` : "");
  }, []);

  /* ── Start-up ── */
  const restoreStaged = async () => {
    const records = store.load().filter(validRecord);
    carry.current = records;
    storeReady.current = true;
    setCarryTick((t) => t + 1);
    if (!records.length) return;
    const current = new Map<number, Face>();
    try {
      const ids = records.map((r) => r.id);
      for (let i = 0; i < ids.length; i += FACES_BY_IDS_MAX) {
        const data = unwrap(await api.POST("/api/faces/by-ids", { body: { face_ids: ids.slice(i, i + FACES_BY_IDS_MAX) } }));
        data.faces.forEach((f) => current.set(f.id, f));
      }
    } catch (err) {
      // Can't tell what's still valid: keep the backup (it stays carried).
      say(`Couldn't check the ${records.length} staged change(s) kept from your last visit ` +
        `(${(err as Error).message}). They're kept for the next reload.`, true);
      return;
    }
    const s = ref.current;
    const o = classifyRestore(records, current, new Set(s.persons.map((p) => p.id)),
      new Map(loadedFacesOf(s).map((f) => [f.id, f])), (id) => s.pending.has(id));
    carry.current = [];   // what's left of the backup is now exactly `pending`
    setCarryTick((t) => t + 1);
    const dropped = droppedNote(o);
    if (!o.entries.length) { say(`Nothing left to restore from your last visit. ${dropped}`); return; }
    const pending = new Map(s.pending);
    const selected = new Set(s.selected);
    let focusedId = s.focusedId;
    for (const e of o.entries) {
      pending.set(e.face.id, e);
      selected.delete(e.face.id);
      if (focusedId === e.face.id) focusedId = null;
    }
    const notes: string[] = [];
    if (o.changed) notes.push(`${o.changed} changed elsewhere since; committing overwrites that.`);
    if (dropped) notes.push(dropped);
    update({ pending, selected, focusedId, anchorIdx: -1, restore: { ids: new Set(o.entries.map((e) => e.face.id)), detail: notes.join(" ") } });
    say(`Restored ${o.entries.length} staged change(s) from your last visit — review them at the bottom of the grid. ` +
      `Nothing is saved until you Commit.`);
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      // Live settings first, so the first render pre-selects with the right cutoff.
      try {
        const data = unwrap(await api.GET("/api/settings"));
        const score = data.settings.find((x) => x.key === "FACE_PRESELECT_MIN_SCORE");
        if (score && typeof score.value === "number") confidentScore.current = score.value;
        const limit = data.settings.find((x) => x.key === "FACE_QUERY_LIMIT");
        if (limit && typeof limit.value === "number") faceLimit.current = limit.value;
      } catch { /* keep the built-in defaults */ }
      // Focus years, restoring a saved Focus (or the URL's month) before the first load.
      let years: number[] = [];
      try { years = unwrap(await api.GET("/api/stats/years")).years; } catch { /* Focus stays at All time */ }
      const init = initialFocus(window.location.search, years, readString(FOCUS_LS_KEY));
      jumpToUndated.current = init.jumpToUndated;
      if (!init.value && !init.monthOption) writeString(FOCUS_LS_KEY, null);
      update({ focusYears: years, monthOption: init.monthOption, focusValue: init.value, focus: focusFromValue(init.value) });
      await loadPersons();
      // Deep links: ?person=<id>&review=suggested opens their suggestion queue,
      // ?person=<id> alone their tagged faces.
      const qp = new URLSearchParams(window.location.search);
      const linkId = qp.get("person") ? parseInt(qp.get("person")!, 10) : null;
      if (linkId && qp.get("review") === "suggested") await selectScope("suggested", linkId);
      else if (linkId) await selectScope("person", linkId);
      else await loadFaces();
      // The first load says what it found; the hint only fills an empty bar.
      if (!ref.current.status.isError && !ref.current.status.message.trim()) say("Select a person on the left, or scan for faces to begin.");
      await restoreStaged();
    })();
  }, []);

  /* ── Restore banner ── */
  const restoredGroups = () => {
    const s = ref.current;
    const ids = s.restore ? [...s.restore.ids].filter((id) => s.pending.has(id)) : [];
    return groupsOfPending(ids.map((id) => s.pending.get(id)!));
  };
  const restoreRemaining = state.restore ? [...state.restore.ids].filter((id) => state.pending.has(id)).length : 0;
  useEffect(() => {
    if (state.restore && restoreRemaining === 0) update({ restore: null });
  }, [state.restore, restoreRemaining, update]);

  return {
    state, ref, update, say, model, gridFaces, findFace,
    ask, setAsk, picker, setPicker, birthEdit, setBirthEdit,
    restoreRemaining,
    /** Faces per page (the server's FACE_QUERY_LIMIT). */
    pageSize: faceLimit.current,
    actions: {
      selectScope, clickCell, focusFace, deselectAll, selectAll, selectGroup, deselectGroup, addToSelection,
      keyMove, toggleFocused, stageFaces, unstage, commitPending, revertPending,
      commitAll: () => commitPending(groupsOfPending()),
      revertAll: () => revertPending(groupsOfPending()),
      groupsOfPending,
      untagFaces, unassignSelected, ignoreIds, comeBackIds, ignoreSelected, comeBackSelected,
      confirmFace, assignFaceNew, assignFocused, openAssignPicker, openDetailPicker,
      acceptSuggestionsFor, acceptSelected, rejectSuggestion, nukeSelected,
      clusterAssign, clusterIgnore, nameCluster, crowdIgnorePhoto, crowdIgnoreGroup,
      addPerson, saveBirth, deletePerson,
      changeFocus, setSuggestedOnly, setSuggestFilter, setHierarchy, setGridSort, setHideDoneCrowds,
      loadMore, reviewGuesses, reloadGrid: () => void loadFaces(),
      openPhoto, openFocusedPhoto, openFocusedFullsize, openPhotoFaces, crowdReviewUrl,
      cellLabel: (e: PendingEntry) => pendingCellLabel(e, ref.current.persons),
      restoreReview: () => {
        document.getElementById("pending-pane")?.scrollIntoView({ behavior: "smooth", block: "start" });
        say(`Restored ${restoreRemaining} staged change(s) — nothing is saved until you Commit.`);
      },
      restoreCommit: () => commitPending(restoredGroups(), "restored from your last visit"),
      restoreDiscard: () => revertPending(restoredGroups(), "restored from your last visit"),
      restoreHide: () => update({ restore: null }),
      faceN,
    },
  };
}

export type PeopleController = ReturnType<typeof usePeople>;
