import type { Schemas } from "../../api/client";
import { stagedWorkStore } from "../../lib/stagedWork";
import { parseWallClockDay } from "../../lib/wallClock";
import type { ClickModifiers } from "../../photos/selection";
import { inTimelineRange, type Histogram, type TimeRange } from "../../ui/TimelineHistogram";

/* Time Sync's pure logic, port of timesync.js: the offset maths, the save
 * payload and how its reply settles the offsets, the camera-limited selection
 * rules, the filters, and the staged-offset backup (U7). Kept free of React so
 * it can be tested on its own. */

export type Photo = Schemas["SearchPhoto"];
export type UpdateTimesResponse = Schemas["UpdateTimesResponse"];
export type TimeUpdate = Schemas["TimeUpdate"];

/** An applied offset: seconds to add, and the photo_datetime it was applied to
 *  (the save's `expected`). */
export type Offset = { offset: number; base: number };
export type Offsets = ReadonlyMap<number, Offset>;

export const cameraOf = (p: { camera?: string | null }) => p.camera || "Unknown";

// ── Offset maths ──

/** The toolbar's minutes + seconds as one offset in seconds; a blank or
 *  non-numeric field counts as 0 (parseInt, like the legacy page). */
export function totalOffset(minutes: string, seconds: string): number {
  return (parseInt(minutes, 10) || 0) * 60 + (parseInt(seconds, 10) || 0);
}

export function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n}`;
}

/** Apply `total` to the selected photos — relative to each photo's original
 *  time, not cumulative: applying +60 twice is still +60. Undated photos have
 *  nothing to shift (0 / null means "no date"), so they're skipped; pre-1970
 *  (negative) times are real dates and shift like any other. The base time is
 *  remembered so the save can send absolute times. */
export function applyOffset(offsets: Offsets, photos: ReadonlyMap<number, Photo>, selected: Iterable<number>, total: number):
  { next: Map<number, Offset>; applied: number; skipped: number } {
  const next = new Map(offsets);
  let applied = 0, skipped = 0;
  for (const id of selected) {
    const p = photos.get(id);
    if (!p || !p.photo_datetime) { skipped++; continue; }
    next.set(id, { offset: total, base: p.photo_datetime });
    applied++;
  }
  return { next, applied, skipped };
}

/** Drop the offsets of `ids`. */
export function resetOffsets(offsets: Offsets, ids: Iterable<number>): Map<number, Offset> {
  const next = new Map(offsets);
  for (const id of ids) next.delete(id);
  return next;
}

/** The time a photo shows at: its own plus any applied offset. */
export function adjustedTime(p: Photo, offsets: Offsets): number | null {
  if (!p.photo_datetime) return null;
  return p.photo_datetime + (offsets.get(p.id)?.offset ?? 0);
}

// ── Save ──

/** Absolute targets, not offsets: the request says "this photo is at X and
 *  should be at Y", so re-sending it after a partial failure (or a lost reply)
 *  can't shift a photo that already landed a second time. */
export function saveUpdates(offsets: Offsets): TimeUpdate[] {
  return [...offsets].map(([id, o]) => ({ id, expected: o.base, target: o.base + o.offset }));
}

/** The offsets left after a save reply, and the photos worth retrying.
 *  Only what landed is cleared; failed photos keep their offset so Save can be
 *  pressed again (safe: the request is idempotent). A conflict can't be retried
 *  as-is (the photo's date moved), nor can a photo that no longer exists, so
 *  those offsets are dropped too. */
export function settleSave(offsets: Offsets, out: UpdateTimesResponse): { next: Map<number, Offset>; retryable: number[] } {
  const settled = [...out.written, ...out.not_found, ...out.failed.filter((f) => f.conflict).map((f) => f.id)];
  return {
    next: resetOffsets(offsets, settled),
    retryable: out.failed.filter((f) => !f.conflict).map((f) => f.id),
  };
}

/** "2 failed: <first reason>" for the status line, or "" when everything landed
 *  (same wording as the Geocode page's batchProblems). */
export function batchProblems(out: Pick<UpdateTimesResponse, "failed" | "not_found">): string {
  const bad = out.failed.length + out.not_found.length;
  if (!bad) return "";
  const first = out.failed.length ? out.failed[0]!.error : "photo not found";
  return `${bad} failed: ${first}`;
}

// ── Selection ──

/** The grid's click rules (port of renderGrid's handler): Ctrl/Cmd toggles;
 *  Shift adds the range from the last click, but only photos from the last
 *  clicked photo's camera (an offset corrects one camera's clock); a plain click
 *  selects just this one. `photos` is the list the grid draws. */
export function gridSelection(selected: ReadonlySet<number>, photos: readonly Photo[], idx: number, lastIdx: number, mod: ClickModifiers): Set<number> {
  const photo = photos[idx];
  if (!photo) return new Set(selected);
  if (mod.toggle) {
    const next = new Set(selected);
    if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id);
    return next;
  }
  const anchor = photos[lastIdx];
  if (mod.shift && anchor) {
    const next = new Set(selected);
    const cam = cameraOf(anchor);
    const lo = Math.min(lastIdx, idx), hi = Math.max(lastIdx, idx);
    for (let i = lo; i <= hi; i++) if (cameraOf(photos[i]!) === cam) next.add(photos[i]!.id);
    return next;
  }
  return new Set([photo.id]);
}

/** A Shift-select on the timeline keeps only photos from the camera of the
 *  (first) photo already selected; anything else is taken as picked. */
export function timelineSelection(ids: number[], shift: boolean, selected: ReadonlySet<number>, photos: ReadonlyMap<number, Photo>): number[] {
  if (!shift || ids.length <= 1 || !selected.size) return ids;
  const prev = photos.get([...selected][0]!);
  if (!prev) return ids;
  const cam = cameraOf(prev);
  return ids.filter((id) => { const p = photos.get(id); return !!p && cameraOf(p) === cam; });
}

// ── Filters ──

/** The grid's photos: hidden cameras out, then the day-range sliders (undated
 *  photos always stay; the timeline itself shows every loaded photo). */
export function filterPhotos(photos: readonly Photo[], hidden: ReadonlySet<string>, h: Histogram | null, range: TimeRange | null): Photo[] {
  return inTimelineRange(photos.filter((p) => !hidden.has(cameraOf(p))), h, range);
}

/** The timeline window that fits `photos` at their adjusted times (ms), or
 *  null when none is dated. A plain loop: a library-sized list would overflow
 *  Math.min(...spread)'s argument limit. */
export function fitWindow(photos: readonly Photo[], offsets: Offsets): { start: number; end: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (const p of photos) {
    const t = adjustedTime(p, offsets);
    if (t === null) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return lo === Infinity ? null : { start: lo * 1000, end: hi * 1000 };
}

/** The month's day histogram for the range sliders: one bucket per day from the
 *  first day with photos to the last (gap days count 0), ending a day past the
 *  last so its photos sit inside the full range. `dates` are "YYYY-MM-DD"
 *  wall-clock days, sorted (SQLite DATE(…,'unixepoch')). Null when empty. */
export function dayHistogram(dates: readonly { date: string; count: number }[]): Histogram | null {
  if (!dates.length) return null;
  const DAY = 86400;
  const min = parseWallClockDay(dates[0]!.date);
  const last = parseWallClockDay(dates[dates.length - 1]!.date);
  const counts = new Array<number>(Math.round((last - min) / DAY) + 1).fill(0);
  dates.forEach((d) => {
    const i = Math.round((parseWallClockDay(d.date) - min) / DAY);
    if (i >= 0 && i < counts.length) counts[i] = (counts[i] ?? 0) + d.count;
  });
  return { min, max: last + DAY, bucket_secs: DAY, counts };
}

/* ── Staged offsets survive a reload or crash (U7) ──
 * The applied offsets are mirrored to this tab's sessionStorage (lib/stagedWork
 * — see there for why sessionStorage) after every apply, reset and save:
 * {id, offset, base} per photo, nothing else. Same key as the legacy page
 * (stagedWorkStore("timesync", 1)), so offsets applied there survive the move.
 * On load they're re-checked against the server before being offered back: a
 * photo deleted since, or already at base+offset, is dropped; one whose time
 * moved since (base no longer matches) is dropped too, because Save would
 * reject it as a conflict anyway. Restored offsets apply to their photos
 * whichever month is open — like any applied offset — and nothing is written
 * until Save. */

export type OffsetRecord = { id: number; offset: number; base: number };
export const offsetStore = stagedWorkStore<OffsetRecord>("timesync", 1);

export function validOffsetRecord(r: Partial<OffsetRecord>): r is OffsetRecord {
  return Number.isFinite(r.offset) && r.offset !== 0 && Number.isFinite(r.base);
}

/** The records to back up: every live offset, plus carried records (read back
 *  at startup, not yet validated) that nothing has re-applied since. */
export function offsetRecords(offsets: Offsets, carry: readonly OffsetRecord[]): OffsetRecord[] {
  const records = [...offsets].map(([id, o]) => ({ id, offset: o.offset, base: o.base }));
  carry.forEach((r) => { if (!offsets.has(r.id)) records.push(r); });
  return records;
}

export type OffsetRestore = { restored: OffsetRecord[]; gone: number; applied: number; moved: number };

/** Sort saved records against the photos' current times. Ids applied again
 *  during the check are skipped: the newer offset wins. */
export function classifyOffsetRestore(records: readonly OffsetRecord[], current: ReadonlyMap<number, Photo>, isApplied: (id: number) => boolean): OffsetRestore {
  let gone = 0, applied = 0, moved = 0;
  const restored: OffsetRecord[] = [];
  records.forEach((r) => {
    if (isApplied(r.id)) return;
    const photo = current.get(r.id);
    if (!photo) { gone++; return; }
    if (photo.photo_datetime === r.base + r.offset) { applied++; return; }
    if (photo.photo_datetime !== r.base) { moved++; return; }
    restored.push(r);
  });
  return { restored, gone, applied, moved };
}

export function restoreDroppedNote(r: Pick<OffsetRestore, "gone" | "applied" | "moved">): string {
  const dropped: string[] = [];
  if (r.gone) dropped.push(`${r.gone} photo(s) no longer exist`);
  if (r.applied) dropped.push(`${r.applied} already saved`);
  if (r.moved) dropped.push(`${r.moved} whose time was changed elsewhere since`);
  return dropped.length ? `Dropped: ${dropped.join(", ")}.` : "";
}
