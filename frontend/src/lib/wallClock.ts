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

/** Locale date + time of a wall-clock epoch; timeZone is forced to UTC. */
export function formatWallClock(ts: number, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Date(ts * 1000).toLocaleString(undefined, { ...opts, timeZone: "UTC" });
}

/** Wall-clock epoch (seconds) for a calendar date/time; month is 1-based. */
export function wallClockTs(year: number, month: number, day = 1, hour = 0, minute = 0, second = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/** Wall-clock epoch of a "YYYY-MM-DD" day's midnight. Parsed with an explicit
 *  Z: a date-only string parses as UTC but "YYYY-MM-DDT00:00" as *local*. */
export function parseWallClockDay(s: string): number {
  return Date.parse(`${s}T00:00:00Z`) / 1000;
}
