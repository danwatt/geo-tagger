import { dirLabel, formatDateRange, locationKey, minMaxOf, minOf, primaryDirKey, primaryLocationKey, sortGroups, type Face, type GroupSort } from "../../faces/faceGrid";
import { wallClockParts } from "../../lib/wallClock";

/* Grouping and sorting of face lists for the People grid: month, location,
 * person, photo, directory, ignore / come-back / tag batches, events. Port of
 * people-grouping.js. Pure: the one piece of memory, the frozen person-run
 * order (`RunRank`), is passed in. */

/** "<bucket key>|<person id>" → the earliest photo timestamp that person had in
 *  that bucket the first time it was seen. Staging removes faces from the grid,
 *  which would otherwise raise a person's earliest timestamp and reshuffle their
 *  run under the cursor mid-pass — so the rank is captured once per load. */
export type RunRank = Map<string, number>;

export type FaceGroup = { faces: Face[] };

export type MonthGroup = { year: number | null; month: number | null; faces: Face[] };

/** Consecutive runs of the same wall-clock month (`list` is chronological). */
export function computeMonthGroups(list: readonly Face[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  let cur: MonthGroup | null = null;
  for (const f of list) {
    const p = wallClockParts(f.photo_datetime);
    const year = p ? p.year : null, month = p ? p.month : null;
    if (!cur || cur.year !== year || cur.month !== month) {
      cur = { year, month, faces: [] };
      groups.push(cur);
    }
    cur.faces.push(f);
  }
  return groups;
}

export type LocationBucket = MonthGroup & { place: string | null; dir: string | null };

/** Month → location buckets. Within each month, faces are bucketed by resolved
 *  location in first-seen order; located-less faces share one "No location"
 *  bucket per month — except in the Undated month, where that bucket is split by
 *  folder (often the only hint of what a scanned batch is). Each bucket's faces
 *  are then clustered by suggested person (sortBucketBySuggestion), which is what
 *  keeps the flat selection list and the render in the same order. */
export function computeMonthLocationGroups(list: readonly Face[], rank?: RunRank): LocationBucket[] {
  const out: LocationBucket[] = [];
  for (const mg of computeMonthGroups(list)) {
    const undated = mg.year === null;
    const buckets = new Map<string, LocationBucket>();
    for (const f of mg.faces) {
      const loc = locationKey(f);
      const dir = !loc && undated ? dirLabel(f) : null;
      const key = loc ? `loc:${loc}` : dir ? `dir:${dir}` : "";
      let b = buckets.get(key);
      if (!b) {
        b = { year: mg.year, month: mg.month, place: loc || null, dir, faces: [] };
        buckets.set(key, b);
      }
      b.faces.push(f);
    }
    buckets.forEach((b, key) => { b.faces = sortBucketBySuggestion(b.faces, `ml:${mg.year}-${mg.month}:${key}`, rank); });
    out.push(...buckets.values());
  }
  return out;
}

export type TimeGroup = { faces: Face[]; undated: boolean; start?: number; end?: number };

/** Event groups: a new group after more than `gapSeconds` between faces
 *  (`list` chronological, undated last); undated faces form one trailing group. */
export function computeTimeGroups(list: readonly Face[], gapSeconds: number): TimeGroup[] {
  const groups: TimeGroup[] = [];
  let cur: TimeGroup | null = null;
  for (const f of list) {
    const ts = f.photo_datetime;
    if (!ts) {
      if (!cur || !cur.undated) { cur = { faces: [], undated: true }; groups.push(cur); }
      cur.faces.push(f);
      continue;
    }
    if (!cur || cur.undated || ts - cur.end! > gapSeconds) {
      cur = { faces: [], start: ts, end: ts, undated: false };
      groups.push(cur);
    }
    cur.faces.push(f);
    cur.end = ts;
  }
  return groups;
}

export function formatGroupRange(g: TimeGroup): string {
  return g.undated ? "Undated" : formatDateRange(g.start, g.end);
}

export const UNLABELED_PERSON_GAP_SECONDS = 86400;

export type PersonBucket = { personId: number | "none"; name: string | null; faces: Face[]; chunks: TimeGroup[] };

/** Person-first Unlabeled hierarchy: suggested person (A→Z, "No suggestion"
 *  last) → date-range chunks within that person. */
export function computeUnlabeledPersonGroups(list: readonly Face[]): PersonBucket[] {
  const buckets = new Map<number | "none", PersonBucket>();
  for (const f of list) {
    const pid = f.suggestion ? f.suggestion.person_id : "none";
    let b = buckets.get(pid);
    if (!b) {
      b = { personId: pid, name: f.suggestion ? (f.suggestion.person_name ?? "") : null, faces: [], chunks: [] };
      buckets.set(pid, b);
    }
    b.faces.push(f);
  }
  const named = [...buckets.values()].filter((b) => b.personId !== "none").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const none = buckets.get("none");
  const groups = none ? [...named, none] : named;
  groups.forEach((b) => { b.chunks = computeTimeGroups(b.faces, UNLABELED_PERSON_GAP_SECONDS); });
  return groups;
}

export type PhotoBucket = { photoId: number; filename: string; year: number | null; month: number | null; faces: Face[] };

/** Photo hierarchy: one group per source photo, faces in the shared bucket order. */
export function computeUnlabeledPhotoGroups(list: readonly Face[], rank?: RunRank): PhotoBucket[] {
  const buckets = new Map<number, PhotoBucket>();
  for (const f of list) {
    let b = buckets.get(f.photo_id);
    if (!b) {
      const p = wallClockParts(f.photo_datetime);
      b = { photoId: f.photo_id, filename: f.filename || dirLabel(f), year: p ? p.year : null, month: p ? p.month : null, faces: [] };
      buckets.set(f.photo_id, b);
    }
    b.faces.push(f);
  }
  buckets.forEach((b) => { b.faces = sortBucketBySuggestion(b.faces, `photo:${b.photoId}`, rank); });
  return [...buckets.values()];
}

export type DirBucket = { dir: string | null; name: string; faces: Face[] };

/** Directory hierarchy: one group per full folder path (so …/1985/Scans and
 *  …/1990/Scans stay apart), A→Z by path. */
export function computeUnlabeledDirGroups(list: readonly Face[], rank?: RunRank): DirBucket[] {
  const buckets = new Map<string, DirBucket>();
  for (const f of list) {
    const key = f.dir || "";
    let b = buckets.get(key);
    if (!b) {
      b = { dir: f.dir || null, name: dirLabel(f), faces: [] };
      buckets.set(key, b);
    }
    b.faces.push(f);
  }
  const groups = [...buckets.values()].sort((a, b) => (a.dir || "").localeCompare(b.dir || ""));
  groups.forEach((g) => { g.faces = sortBucketBySuggestion(g.faces, `dir:${g.dir}`, rank); });
  return groups;
}

/** "…/Scans/1985 Box": the last two segments of a path. */
export function shortDirPath(dir: string | null | undefined): string {
  if (!dir) return "Unknown folder";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return "…/" + parts.slice(-2).join("/");
}

/** Order one bucket so each suggested person's faces are adjacent: guessed faces
 *  first, person blocks in first-appearance order (frozen in `rank` under
 *  `cacheKey`), each block chronological; unsuggested faces last. A fixed point:
 *  re-sorting sorted faces changes nothing. */
export function sortBucketBySuggestion(faces: readonly Face[], cacheKey?: string, rank?: RunRank): Face[] {
  const firstTs = new Map<number, number>();
  for (const f of faces) {
    const pid = f.suggestion?.person_id;
    if (pid == null) continue;
    const ts = f.photo_datetime || 0;
    const prev = firstTs.get(pid);
    if (prev === undefined || ts < prev) firstTs.set(pid, ts);
  }
  if (cacheKey && rank) {
    firstTs.forEach((ts, pid) => {
      const k = `${cacheKey}|${pid}`;
      const frozen = rank.get(k);
      if (frozen !== undefined) firstTs.set(pid, frozen);
      else rank.set(k, ts);
    });
  }
  return faces.slice().sort((a, b) => {
    const pa = a.suggestion?.person_id ?? null;
    const pb = b.suggestion?.person_id ?? null;
    if ((pa == null) !== (pb == null)) return pa == null ? 1 : -1;
    if (pa !== pb) {
      const fa = firstTs.get(pa!)!, fb = firstTs.get(pb!)!;
      if (fa !== fb) return fa - fb;
      return pa! - pb!;
    }
    return (a.photo_datetime || 0) - (b.photo_datetime || 0);
  });
}

/** "Mar 3 – Mar 8" across a group's faces (undated ignored). */
export function facesDateRange(faces: readonly Face[]): string {
  const ts = faces.map((f) => f.photo_datetime).filter((t): t is number => !!t);
  if (!ts.length) return "Undated";
  return formatDateRange(...minMaxOf(ts));
}

export type Batch = { ts: number | null; faces: Face[] };

/** Consecutive runs sharing one batch stamp (`list` newest-first by it): faces
 *  ignored / deferred / tagged together share a value. */
export function computeBatches(list: readonly Face[], stamp: (f: Face) => number | null | undefined): Batch[] {
  const groups: Batch[] = [];
  let cur: Batch | null = null;
  for (const f of list) {
    const key = stamp(f) ?? null;
    if (!cur || cur.ts !== key) { cur = { ts: key, faces: [] }; groups.push(cur); }
    cur.faces.push(f);
  }
  return groups;
}

/** A real instant (a batch stamp) relative to now — local zone is right here. */
export function formatRelativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "unknown time";
  const sec = now / 1000 - ts;
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  if (sec < 7 * 86400) return `${Math.round(sec / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleString();
}

/** Distinct photos behind some faces — what "Number of photos" sorts on. */
export function photoCountLabel(faces: readonly { photo_id: number }[]): string {
  const n = new Set(faces.map((f) => f.photo_id)).size;
  return `${n} photo${n === 1 ? "" : "s"}`;
}

/** sortGroups for groups whose faces live in `.faces`. */
export function sortFaceGroups<G extends { faces: Face[]; place?: string | null; dir?: string | null }>(groups: readonly G[], mode: GroupSort): G[] {
  return sortGroups(groups, mode, (g) => ({
    date: minOf(g.faces.map((f) => f.photo_datetime || Infinity)),
    count: new Set(g.faces.map((f) => f.photo_id)).size,
    place: g.place ?? primaryLocationKey(g.faces),
    dir: g.dir ?? primaryDirKey(g.faces),
  }));
}

/** Runs of consecutive faces sharing one suggested person (null = no guess). */
export function personRuns(faces: readonly Face[]): Face[][] {
  const runs: Face[][] = [];
  let prev: number | null | undefined;
  let run: Face[] = [];
  for (const f of faces) {
    const sug = f.suggestion?.person_id ?? null;
    if (prev === undefined || sug !== prev) { run = []; runs.push(run); }
    run.push(f);
    prev = sug;
  }
  return runs;
}
