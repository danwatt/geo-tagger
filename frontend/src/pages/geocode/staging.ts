import type { Schemas } from "../../api/client";

/* ── Geotag staging ──
 * A drop on the map doesn't write: the point is reverse-geocoded, the photos are
 * pulled out of the grid and parked in the staging area under the resolved place
 * name, and a provisional pin marks the spot until the change is committed or
 * reverted. "Needs no location" marks and "remove the saved location" (U2) stage
 * the same way. All kinds share the staging area, the revert buttons and Commit;
 * only drops have a point. Port of app.js's "Geotag staging" section — pure, so
 * the reducer, the grouping and the U7 records can be tested on their own. */

export type Photo = Schemas["SearchPhoto"];
export type ResolvedLoc = Schemas["ResolvedLocation"] | null;

// Group heading for staged "needs no location" marks. Doubles as their key in
// groupStaged, so it must not collide with a real geocoded place name.
export const IGNORE_LABEL = "🚫 No location needed";
// Same, for staged removals.
export const REMOVE_LABEL = "❌ Remove saved location";

/** The photo's server state when it was staged — a restore compares it with
 *  the server's state then, to spot photos changed elsewhere meanwhile. */
export type Was = { lat: number | null; lng: number | null; gi: boolean };

type Base = { id: number; photo: Photo; label: string; was: Was };
export type DropEntry = Base & { kind: "drop"; lat: number; lng: number; accuracy: number | null; loc: ResolvedLoc };
export type IgnoreEntry = Base & { kind: "ignore" };
export type RemoveEntry = Base & { kind: "remove" };
export type StagedEntry = DropEntry | IgnoreEntry | RemoveEntry;
export type Staged = ReadonlyMap<number, StagedEntry>;

export function wasOf(p: Photo): Was {
  return { lat: p.lat ?? null, lng: p.lng ?? null, gi: !!p.geocode_ignored };
}

export function dropEntry(photo: Photo, lat: number, lng: number, accuracy: number | null, loc: ResolvedLoc, label: string): DropEntry {
  return { kind: "drop", id: photo.id, photo, lat, lng, accuracy, loc, label, was: wasOf(photo) };
}
export function ignoreEntry(photo: Photo): IgnoreEntry {
  return { kind: "ignore", id: photo.id, photo, label: IGNORE_LABEL, was: wasOf(photo) };
}
export function removeEntry(photo: Photo): RemoveEntry {
  return { kind: "remove", id: photo.id, photo, label: REMOVE_LABEL, was: wasOf(photo) };
}

/** Distinct coordinate a staged photo will actually be written at — the commit
 *  batching key, and what the provisional pins are grouped by. */
export function pointKey(e: Pick<DropEntry, "lat" | "lng" | "accuracy">): string {
  return `${e.lat.toFixed(6)},${e.lng.toFixed(6)},${e.accuracy ?? ""}`;
}

// ── Reducer ──

export type StagingAction =
  | { type: "stage"; entries: StagedEntry[] }
  | { type: "unstage"; ids: readonly number[] };

/** Staging a photo already staged overwrites it (re-dropping moves it between
 *  groups). Returns the same map when nothing changed, so React can skip a render. */
export function stagingReducer(state: Staged, action: StagingAction): Staged {
  if (action.type === "stage") {
    if (!action.entries.length) return state;
    const next = new Map(state);
    action.entries.forEach((e) => next.set(e.id, e));
    return next;
  }
  if (!action.ids.some((id) => state.has(id))) return state;
  const next = new Map(state);
  action.ids.forEach((id) => next.delete(id));
  return next;
}

// ── Groups ──

export type StagedGroup = { label: string; kind: StagedEntry["kind"]; entries: StagedEntry[] };

/** The staging area's groups, by resolved place: alphabetical, raw-coordinate
 *  ones after the named places, then the removals, and the no-location group —
 *  which isn't a place at all — last of all. `entries` may be a subset (the
 *  restore banner's Commit must not sweep up drops made since). */
export function groupStaged(entries: Iterable<StagedEntry>): StagedGroup[] {
  const groups = new Map<string, StagedGroup>();
  for (const e of entries) {
    let g = groups.get(e.label);
    if (!g) {
      g = { label: e.label, kind: e.kind, entries: [] };
      groups.set(e.label, g);
    }
    g.entries.push(e);
  }
  const rank = (g: StagedGroup) => (g.kind === "ignore" ? 2 : g.kind === "remove" ? 1 : 0);
  return [...groups.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ua = a.label.startsWith("📌"), ub = b.label.startsWith("📌");
    if (ua !== ub) return ua ? 1 : -1;   // un-geocoded points sink to the bottom
    return a.label.localeCompare(b.label);
  });
}

export function groupPointCount(g: StagedGroup): number {
  return g.kind === "drop" ? new Set(g.entries.map((e) => pointKey(e as DropEntry))).size : 0;
}

/** One provisional pin per distinct staged point, with how many photos it carries. */
export function stagedPins(staged: Staged): (DropEntry & { count: number })[] {
  const byPoint = new Map<string, DropEntry & { count: number }>();
  staged.forEach((e) => {
    if (e.kind !== "drop") return;   // no coordinate, nothing to pin
    const k = pointKey(e);
    const pin = byPoint.get(k);
    if (pin) pin.count++;
    else byPoint.set(k, { ...e, count: 1 });
  });
  return [...byPoint.values()];
}

/** The chip under a staged cell. */
export function stagedChip(e: StagedEntry): string {
  if (e.kind === "ignore") return "🚫 no location";
  if (e.kind === "remove") return "❌ remove location";
  return `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}` + (e.accuracy ? ` ±${e.accuracy}m` : "");
}

/* ── Staged work that survives a reload (U7) ──
 * The staged set is mirrored to this tab's sessionStorage on every change and
 * offered back on the next load. sessionStorage, not localStorage: it is per
 * tab, so two Geocode tabs never overwrite each other, yet it survives a reload,
 * Ctrl+Shift+T and the browser's restore-after-crash. Same key and record shape
 * as the legacy page (common.js stagedWorkStore("geocode", 1)), so work staged
 * there carries over. Version 1 record: {id, lat, lng, accuracy, loc, label,
 * ignore, remove, was}. `remove` was added without a version bump: a bump would
 * sweep (lose) records staged by the previous build, and that build simply drops
 * a remove record it can't validate. Every storage call is wrapped — blocked or
 * full storage only means the backup is skipped, never that staging stops. */

const STAGED_PREFIX = "geotagger.staged.";
const STAGED_PAGE = "geocode";
const STAGED_VERSION = 1;
export const STAGED_KEY = `${STAGED_PREFIX}${STAGED_PAGE}.v${STAGED_VERSION}`;

export const STAGED_SAVE_FAILED_MSG =
  "Couldn't back up the staged changes in this tab (browser storage is full or blocked). " +
  "They're still staged, but a reload or crash before you commit will lose them.";

export type StagedRecord = {
  id: number;
  lat?: number;
  lng?: number;
  accuracy?: number | null;
  loc?: ResolvedLoc;
  label?: string;
  ignore?: true;
  remove?: true;
  was?: Partial<Was>;
};

export function toRecord(e: StagedEntry): StagedRecord {
  if (e.kind === "ignore") return { id: e.id, ignore: true, was: e.was };
  if (e.kind === "remove") return { id: e.id, remove: true, was: e.was };
  return { id: e.id, lat: e.lat, lng: e.lng, accuracy: e.accuracy ?? null, loc: e.loc ?? null, label: e.label, was: e.was };
}

export function validRecord(r: StagedRecord): boolean {
  if (r.ignore === true || r.remove === true) return true;
  return Number.isFinite(r.lat) && Math.abs(r.lat!) <= 90 &&
    Number.isFinite(r.lng) && Math.abs(r.lng!) <= 180 &&
    (r.accuracy == null || Number.isFinite(r.accuracy)) &&
    typeof r.label === "string";
}

/** The saved records (integer ids only), or []. Sweeps records an older (or
 *  newer) build of this page wrote under another version's key. */
export function loadStagedRecords(): StagedRecord[] {
  try {
    const stem = `${STAGED_PREFIX}${STAGED_PAGE}.v`;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(stem) && k !== STAGED_KEY) sessionStorage.removeItem(k);
    }
    const raw = sessionStorage.getItem(STAGED_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as { v?: unknown; entries?: unknown };
    if (!data || data.v !== STAGED_VERSION || !Array.isArray(data.entries)) return [];
    return (data.entries as StagedRecord[]).filter((r) => r && Number.isInteger(r.id));
  } catch {
    return [];
  }
}

/** Replace the saved set; an empty list removes the key. False on failure. */
export function saveStagedRecords(records: StagedRecord[]): boolean {
  try {
    if (!records.length) sessionStorage.removeItem(STAGED_KEY);
    else sessionStorage.setItem(STAGED_KEY, JSON.stringify({ v: STAGED_VERSION, savedAt: Date.now(), entries: records }));
    return true;
  } catch {
    return false;
  }
}

/** The records to write: every live entry, plus carried records (read back at
 *  startup, still being validated) that nothing has re-staged since. */
export function recordsToSave(staged: Staged, carry: readonly StagedRecord[]): StagedRecord[] {
  const records = [...staged.values()].map(toRecord);
  const live = new Set(records.map((r) => r.id));
  carry.forEach((r) => { if (!live.has(r.id)) records.push(r); });
  return records;
}

function sameCoord(a: number | null | undefined, b: number | null | undefined): boolean {
  return a != null && b != null && Math.abs(a - b) < 1e-6;
}

export type RestoreResult = { entries: StagedEntry[]; gone: number; applied: number; changed: number };

/** Re-check saved records against the server's current photos: a photo deleted
 *  since, or already at its staged point / already marked, is dropped; one
 *  geotagged or marked elsewhere since is kept but counted as `changed`
 *  (committing overwrites it). Ids staged again during the check are skipped —
 *  the newer staging wins. Nothing here writes. */
export function classifyRestore(records: readonly StagedRecord[], current: ReadonlyMap<number, Photo>,
  isStaged: (id: number) => boolean): RestoreResult {
  let gone = 0, applied = 0, changed = 0;
  const entries: StagedEntry[] = [];
  records.forEach((r) => {
    if (isStaged(r.id)) return;
    const photo = current.get(r.id);
    if (!photo) { gone++; return; }
    // A removal is "already applied" once the photo has no location at all.
    const done = r.ignore ? !!photo.geocode_ignored
      : r.remove ? photo.lat == null
      : sameCoord(photo.lat, r.lat) && sameCoord(photo.lng, r.lng) && (photo.gps_accuracy ?? null) === (r.accuracy ?? null);
    if (done) { applied++; return; }
    const was = r.was || {};
    if ((was.lat ?? null) !== (photo.lat ?? null) || (was.lng ?? null) !== (photo.lng ?? null) ||
        !!was.gi !== !!photo.geocode_ignored) changed++;
    entries.push(r.ignore ? ignoreEntry(photo)
      : r.remove ? removeEntry(photo)
      : dropEntry(photo, r.lat!, r.lng!, r.accuracy ?? null, r.loc ?? null, r.label!));
  });
  return { entries, gone, applied, changed };
}

/* ── Undo last commit (U2) ──
 * Every write on the commit path answers with a per-photo `previous` snapshot;
 * the whole commit's snapshots are kept as "the last commit", in this tab's
 * sessionStorage (like the staged set), so it survives a reload and a scope
 * change. Replaced by the next commit that lands, cleared by a clean undo, and
 * trimmed to the failed photos by a partial one. Same key as the legacy page. */

export const UNDO_COMMIT_KEY = "geotagger.undo.geocode.v1";
export type Snapshot = Schemas["GeotagSnapshotOut"];
export type LastCommit = { previous: Snapshot[]; at: number };

export function loadLastCommit(): LastCommit | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(UNDO_COMMIT_KEY) || "null") as LastCommit | null;
    if (data && Array.isArray(data.previous) && data.previous.length &&
        data.previous.every((s) => s && Number.isInteger(s.id))) return data;
  } catch { /* storage blocked or garbled: no undo to offer */ }
  return null;
}

export function saveLastCommit(lc: LastCommit | null): void {
  try {
    if (lc) sessionStorage.setItem(UNDO_COMMIT_KEY, JSON.stringify(lc));
    else sessionStorage.removeItem(UNDO_COMMIT_KEY);
  } catch { /* storage blocked: undo still works until the tab reloads */ }
}
