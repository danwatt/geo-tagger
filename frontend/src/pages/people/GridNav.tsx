import { useId, useMemo } from "react";
import { isGroupSort } from "../../faces/faceGrid";
import { Spinner } from "../../ui/ui";
import { HIERARCHIES, isFlatGridScope, type Hierarchy } from "./gridModel";
import type { PeopleController } from "./usePeople";

/* The sticky bar over the grid: the current scope's controls, the selection
 * actions (right-aligned), and the U5 "Load more" banner. Port of
 * people-list.js updateGridNavVisibility and the #grid-nav markup. */

const GAP_OPTIONS: [number, string][] = [[21600, "6 hours"], [86400, "1 day"], [259200, "3 days"], [604800, "1 week"], [2592000, "1 month"]];
const HIERARCHY_LABELS: Record<Hierarchy, string> = { date: "Date, then person", person: "Person, then date", photo: "Photo", directory: "Directory" };

/** The suggested-person filter's options: people who are a *top* suggestion in
 *  the loaded queue, most-suggested first, with counts. */
export function suggestOptions(faces: readonly { suggestion?: { person_id: number; person_name?: string | null } | null }[]) {
  const counts = new Map<number, { name: string; count: number }>();
  for (const f of faces) {
    if (!f.suggestion) continue;
    const e = counts.get(f.suggestion.person_id) ?? { name: f.suggestion.person_name || "Unknown", count: 0 };
    e.count++;
    counts.set(f.suggestion.person_id, e);
  }
  return [...counts.entries()].sort((a, b) => b[1].count - a[1].count).map(([id, v]) => ({ id, ...v }));
}

export function GridNav({ ctl }: { ctl: PeopleController }) {
  const uid = useId();
  const { state: s, actions: a } = ctl;
  const scope = s.scope;
  const showPerson = scope === "person" || scope === "suggested";
  const showSelection = scope !== "discover" && scope !== "crowds";
  // Person-first Unlabeled orders its own groups by name, so it has no Sort.
  const showSort = scope === "discover" || scope === "crowds" || scope === "suggested" || (scope === "unlabeled" && s.hierarchy !== "person");
  const sugOpts = useMemo(() => suggestOptions(s.unlabeledAll), [s.unlabeledAll]);
  const n = s.selected.size;
  const truncated = s.paging.nextOffset != null;
  const loadedN = (scope === "unlabeled" ? s.unlabeledAll : s.faces).length;
  const remaining = Math.max(0, s.paging.total - s.paging.loaded);
  const nextN = Math.min(ctl.pageSize, remaining);   // one more page is all there is
  const restoring = scope === "ignored", restoringCB = scope === "come_back";
  const id = (x: string) => `${uid}-${x}`;

  return (
    <div id="grid-nav">
      {scope === "unlabeled" && (
        <>
          <div id="grid-nav-unlabeled">
            <label htmlFor={id("sug")} title="Limit the queue below to faces whose top recognition guess is one person">Suggested person:</label>
            <select id={id("sug")} value={s.suggestFilter == null ? "" : String(s.suggestFilter)} disabled={sugOpts.length === 0}
              title="Show only unlabeled faces suggested to be this person"
              onChange={(e) => a.setSuggestFilter(e.target.value ? parseInt(e.target.value, 10) : null)}>
              <option value="">All suggestions</option>
              {sugOpts.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.count})</option>)}
            </select>
          </div>
          <div id="grid-nav-hierarchy">
            <label htmlFor={id("hier")} title="Change how faces below are grouped">Group by:</label>
            <select id={id("hier")} value={s.hierarchy} onChange={(e) => a.setHierarchy(e.target.value as Hierarchy)}>
              {HIERARCHIES.map((h) => <option key={h} value={h}>{HIERARCHY_LABELS[h]}</option>)}
            </select>
          </div>
        </>
      )}
      {showSort && (
        <div id="grid-nav-sort">
          <label htmlFor={id("sort")} title="Reorder the groups below">Sort:</label>
          <select id={id("sort")} value={s.gridSort} onChange={(e) => { if (isGroupSort(e.target.value)) a.setGridSort(e.target.value); }}>
            <option value="date">Date</option>
            <option value="count">Number of photos</option>
            <option value="location">Location, then date</option>
            <option value="dir">Folder, then date</option>
          </select>
        </div>
      )}
      {showPerson && (
        <div id="grid-nav-person">
          <label htmlFor={id("guess")}>Review guesses for:</label>
          <select id={id("guess")} value={s.guessPerson} onChange={(e) => ctl.update({ guessPerson: e.target.value })}>
            <option value="">Choose person…</option>
            {s.persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" title="Show every face guessed to be this person, all pre-selected, so you can approve the good ones at once"
            onClick={a.reviewGuesses}>🔮 Review</button>
          <label htmlFor={id("gap")}>Group by:</label>
          <select id={id("gap")} value={s.groupGap} title="Start a new event group when photos are more than this far apart in time"
            onChange={(e) => ctl.update({ groupGap: parseInt(e.target.value, 10) })}>
            {GAP_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      )}
      {scope === "crowds" && (
        <div id="grid-nav-crowds">
          <label htmlFor={id("min")} title="Photos with at least this many detected faces are shown as crowd photos">Min faces:</label>
          <input type="number" id={id("min")} min={2} max={9999} className="crowd-min" value={s.crowdMinFaces}
            onChange={(e) => ctl.update({ crowdMinFaces: parseInt(e.target.value, 10) || 50 })} />
          <label htmlFor={id("cgap")}>Group gap:</label>
          <select id={id("cgap")} value={s.crowdGap} onChange={(e) => ctl.update({ crowdGap: parseInt(e.target.value, 10) || 86400 })}>
            {GAP_OPTIONS.slice(0, 4).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" onClick={a.reloadGrid}>Reload</button>
          <label title="Only show crowd photos that still have unlabeled faces" className="check-label">
            <input type="checkbox" checked={s.hideDoneCrowds} onChange={(e) => a.setHideDoneCrowds(e.target.checked)} /> Hide completed
          </label>
        </div>
      )}
      {scope === "discover" && (
        <div id="grid-nav-discover">
          <button type="button" title="Re-run grouping over the unlabeled faces" onClick={a.reloadGrid}>↻ Refresh groups</button>
          {s.clustersStale && <span id="discover-stale-note" role="status">Groups changed since they were found and may be outdated.</span>}
        </div>
      )}
      {showSelection && (
        <div id="grid-nav-selection" className={n === 0 ? "empty" : undefined} role="group" aria-label="Selection actions">
          <span id="selection-count" aria-live="polite" title="These buttons act on the faces you have selected, anywhere in the grid">
            {n === 0 ? "Nothing selected" : truncated ? `${n} selected (of ${loadedN.toLocaleString()} loaded)` : `${n} selected`}
          </span>
          <button type="button" className="primary" disabled={!n} title="Assign selected faces to a person" onClick={a.openAssignPicker}>Assign…</button>
          <button type="button" className="danger icon-btn" disabled={!n} title="Unassign" aria-label="Unassign" onClick={a.unassignSelected}>×</button>
          <button type="button" className="icon-btn" disabled={!n} title="Confirm the suggested name for every selected face" aria-label="Accept suggestions" onClick={a.acceptSelected}>✓</button>
          <button type="button" className="icon-btn" disabled={!n}
            title={restoring ? "Restore selected faces" : "Hide selected faces from the queue (background strangers, false detections)"}
            aria-label={restoring ? "Restore" : "Ignore"} onClick={() => a.ignoreSelected(!restoring)}>{restoring ? "↩" : "🚫"}</button>
          <button type="button" className="icon-btn" disabled={!n}
            title={restoringCB ? "Restore selected faces to the Unlabeled queue" : "Move selected faces to the Come Back queue — people you know or suspect but aren't ready to assign yet"}
            aria-label={restoringCB ? "Restore" : "Come back later"} onClick={() => a.comeBackSelected(!restoringCB)}>{restoringCB ? "↩" : "🕒"}</button>
          <button type="button" className="danger icon-btn" disabled={!n} aria-label="Nuclear option"
            title="Nuclear option: permanently delete ALL faces (detected, assigned, and ignored) for the photo(s) behind the selected face(s), and wipe their cached thumbnails/previews so detection starts completely from scratch"
            onClick={() => void a.nukeSelected()}>🧨</button>
        </div>
      )}
      {isFlatGridScope(scope) && truncated && (
        <div id="grid-paging" role="status">
          <span id="grid-paging-text">
            Showing {loadedN.toLocaleString()} of {s.paging.total.toLocaleString()} faces. Select all, group buttons and bulk actions only cover the loaded faces.
          </span>
          <button type="button" className="primary" disabled={s.paging.busy} onClick={() => void a.loadMore(false)}>
            {s.paging.busy ? <><Spinner /> Loading…</> : `Load ${nextN.toLocaleString()} more`}
          </button>
          {remaining > nextN && (
            <button type="button" disabled={s.paging.busy} onClick={() => void a.loadMore(true)}>Load all ({remaining.toLocaleString()})</button>
          )}
        </div>
      )}
    </div>
  );
}
