import { MONTH_NAMES } from "../../lib/format";

/* ── Time Focus ── Port of people-focus.js.
 * The Focus dropdown windows the tagging surfaces (people list, Unlabeled,
 * suggestions, Discover, Crowds) to one calendar Year. Option values are
 * "y:<year>"; a "?month=YYYY-MM" URL argument adds a one-shot "m:YYYY-MM"
 * option. Windows are UTC ranges, matching how the backend buckets
 * photo_datetime. The per-person / All / Recently-tagged views stay full-library. */

export const FOCUS_LS_KEY = "geotagger.people.focusYear";

export type FocusWindow = { start: number | null; end: number | null; label: string | null };
export const NO_FOCUS: FocusWindow = { start: null, end: null, label: null };

export function focusFromValue(val: string): FocusWindow {
  if (val.startsWith("m:")) {
    const [year, month] = val.slice(2).split("-").map(Number) as [number, number];
    return {
      start: Date.UTC(year, month - 1, 1) / 1000,
      end: Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) / 1000,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
    };
  }
  if (val.startsWith("y:")) {
    const year = parseInt(val.slice(2), 10);
    return { start: Date.UTC(year, 0, 1) / 1000, end: Date.UTC(year + 1, 0, 1) / 1000, label: String(year) };
  }
  return NO_FOCUS;
}

export const focusActive = (f: FocusWindow) => f.start != null || f.end != null;

/** The window as query params (none when inactive). */
export function focusParams(f: FocusWindow): { start_ts?: number; end_ts?: number } {
  return { ...(f.start != null ? { start_ts: f.start } : {}), ...(f.end != null ? { end_ts: f.end } : {}) };
}

/** "start_ts=…&end_ts=…" (no leading separator), or "". */
export function focusQuery(f: FocusWindow): string {
  return Object.entries(focusParams(f)).map(([k, v]) => `${k}=${v}`).join("&");
}

/** " · Focus: <name>" for windowed status lines. */
export function focusStatusSuffix(f: FocusWindow): string {
  return focusActive(f) ? ` · Focus: ${f.label || "time window"}` : "";
}

export const FOCUS_WIDEN_HINT = " (Focus is active — set “All time” to widen.)";

export type FocusStart = {
  /** The one-shot "m:YYYY-MM" option, when the URL asked for a month. */
  monthOption: { value: string; label: string } | null;
  value: string;
  /** "?month=undated": jump to the Undated section once the queue renders. */
  jumpToUndated: boolean;
};

/** The dropdown's starting value: the URL's month, else (unless the URL asked
 *  for undated faces, which any time window would hide) the saved Year. */
export function initialFocus(search: string, years: readonly number[], saved: string | null): FocusStart {
  const monthArg = new URLSearchParams(search).get("month");
  const m = monthArg?.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const value = `m:${m[1]}-${m[2]}`;
    return { monthOption: { value, label: `${MONTH_NAMES[parseInt(m[2]!, 10) - 1]} ${parseInt(m[1]!, 10)}` }, value, jumpToUndated: false };
  }
  if (monthArg === "undated") return { monthOption: null, value: "", jumpToUndated: true };
  const value = saved && years.some((y) => `y:${y}` === saved) ? saved : "";
  return { monthOption: null, value, jumpToUndated: false };
}

/* ── Per-viewer view preferences ── Port of common.js loadViewPref /
 * saveViewPref: never fatal — blocked storage or a value failing `valid` just
 * yields the fallback. */
export function loadViewPref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveViewPref(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered */ }
}

/** Plain-string prefs (the sort / hierarchy / focus / pane width keys hold raw strings). */
export function readString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeString(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* not remembered */ }
}

export const isBool = (v: unknown): v is boolean => typeof v === "boolean";
