/* Wall-clock timestamps. Port of common.js's helpers.
 *
 * photo_datetime — and every value derived from it (a histogram bucket's ts, a
 * date-picker day turned into a bound) — is the camera's wall clock stored *as
 * if* it were UTC (see timeutil.py). It is not an instant: reading it with the
 * local-zone Date API (getFullYear, toLocaleString without a timeZone) shifts it
 * by the viewer's UTC offset, so west of UTC a photo taken 1 Jan 00:30 lands
 * under the previous December. Everything here goes through getUTC* / timeZone
 * "UTC", which hands back exactly what the camera wrote and matches the backend.
 * `month` in wallClockParts is 0-based (like MONTH_NAMES and getUTCMonth). */

export type WallClockParts = { year: number; month: number; day: number };

/** Year / 0-based month / day of a wall-clock epoch, or null when undated
 *  (null/0; negative = pre-1970, a real date). */
export function wallClockParts(ts: number | null | undefined): WallClockParts | null {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

/** Locale date formatting of a wall-clock epoch; timeZone is forced to UTC. */
export function formatWallClockDate(ts: number, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}
