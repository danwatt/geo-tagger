/* Pure logic behind DateRangePicker. Port of date-range-picker.js's helpers.
 *
 * Dates are plain YYYY-MM-DD strings throughout and compared lexicographically;
 * arithmetic goes through Date.UTC so a local timezone can never shift a day
 * across a boundary. */

const DAY_MS = 86400000;

export const DRP_MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export type Ymd = { y: number; m: number; d: number };
export type YearMonth = { y: number; m: number };
export type DayRow = { date: string; count: number };

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** A strict YYYY-MM-DD parse: null for anything else, including 2023-02-30. */
export function parseYmd(s: string | null | undefined): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayIndex(s: string): number | null {
  const p = parseYmd(s);
  return p ? Date.UTC(p.y, p.m - 1, p.d) / DAY_MS : null;
}

export function fromDayIndex(n: number): string {
  const dt = new Date(n * DAY_MS);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function shiftDays(s: string, days: number): string {
  return fromDayIndex((dayIndex(s) ?? 0) + days);
}

/** Today in the viewer's calendar (a real instant, so local time is right here). */
export function todayYmd(now = new Date()): string {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addMonths({ y, m }: YearMonth, n: number): YearMonth {
  const total = y * 12 + (m - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}

export function monthOf(s: string): YearMonth {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) };
}

/** "Mar 5, 2021" (or "Mar 5"). Unparseable input comes back unchanged. */
export function formatYmd(s: string, withYear = true): string {
  const p = parseYmd(s);
  if (!p) return s;
  const month = DRP_MONTHS[p.m - 1]!.slice(0, 3);
  return withYear ? `${month} ${p.d}, ${p.y}` : `${month} ${p.d}`;
}

/* ── Volume data ── */

export type Bucket = { start: string; end: string; count: number; days: number; y: number };

export type Volume = {
  days: DayRow[];       // ascending
  cum: number[];        // cum[i] = photos in days[0..i-1]
  buckets: Bucket[];    // histogram bars
  axisStart: number;    // day index the histogram's left edge sits on
  axisDays: number;     // days the histogram spans
};

export function buildVolume(rows: DayRow[] | null | undefined): Volume {
  const days = (rows ?? []).filter((d) => parseYmd(d.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const cum = new Array<number>(days.length + 1).fill(0);
  days.forEach((d, i) => { cum[i + 1] = cum[i]! + d.count; });
  return { days, cum, ...buildBuckets(days) };
}

/* Histogram buckets, plus the day-linear axis they are drawn on. A short scope
   (a loaded month or two) gets one bar per day — a single month-wide bar says
   nothing. A long one gets one bar per month, so a 20-year library doesn't try
   to draw 7,000 bars into 400px. Gaps are kept as zero bars either way, so the
   axis stays linear in time rather than in "periods that happen to have photos". */
function buildBuckets(days: DayRow[]): Pick<Volume, "buckets" | "axisStart" | "axisDays"> {
  const buckets: Bucket[] = [];
  if (!days.length) return { buckets, axisStart: 0, axisDays: 0 };
  const first = parseYmd(days[0]!.date)!, last = parseYmd(days[days.length - 1]!.date)!;
  const span = (last.y * 12 + last.m) - (first.y * 12 + first.m) + 1;
  const counts = new Map(days.map((d) => [d.date, d.count]));

  if (span <= 3) {
    const axisStart = dayIndex(days[0]!.date)!;
    const axisDays = dayIndex(days[days.length - 1]!.date)! - axisStart + 1;
    for (let i = 0; i < axisDays; i++) {
      const date = fromDayIndex(axisStart + i);
      buckets.push({ start: date, end: date, count: counts.get(date) ?? 0, days: 1, y: Number(date.slice(0, 4)) });
    }
    return { buckets, axisStart, axisDays };
  }

  /* Month mode: the axis spans whole months so every bar is exactly as wide as
     its month, rather than the first and last being clipped. */
  const axisStart = dayIndex(ymd(first.y, first.m, 1))!;
  let axisDays = 0;
  let m: YearMonth = { y: first.y, m: first.m };
  for (;;) {
    const dim = daysInMonth(m.y, m.m);
    let count = 0;
    for (let d = 1; d <= dim; d++) count += counts.get(ymd(m.y, m.m, d)) ?? 0;
    buckets.push({ start: ymd(m.y, m.m, 1), end: ymd(m.y, m.m, dim), count, days: dim, y: m.y });
    axisDays += dim;
    if (m.y === last.y && m.m === last.m) break;
    m = addMonths(m, 1);
    if (buckets.length > 4000) break; // guard against a corrupt timestamp
  }
  return { buckets, axisStart, axisDays };
}

/** Calendar months the loaded data spans, however the histogram buckets it. */
export function spanMonths(v: Volume): number {
  if (!v.days.length) return 0;
  const first = monthOf(v.days[0]!.date), last = monthOf(v.days[v.days.length - 1]!.date);
  return (last.y * 12 + last.m) - (first.y * 12 + first.m) + 1;
}

function lowerBound(days: DayRow[], date: string): number {
  let a = 0, b = days.length;
  while (a < b) { const mid = (a + b) >> 1; if (days[mid]!.date < date) a = mid + 1; else b = mid; }
  return a;
}

function upperBound(days: DayRow[], date: string): number {
  let a = 0, b = days.length;
  while (a < b) { const mid = (a + b) >> 1; if (days[mid]!.date <= date) a = mid + 1; else b = mid; }
  return a;
}

/** Photos in [lo, hi] (null = open end) — binary search over the ascending days. */
export function rangeTotal(v: Volume, lo: string | null, hi: string | null): number {
  if (!v.days.length) return 0;
  const start = lowerBound(v.days, lo || v.days[0]!.date);
  const end = hi ? upperBound(v.days, hi) : v.days.length;
  return Math.max(0, v.cum[end]! - v.cum[start]!);
}

export function dayCount(v: Volume, date: string): number {
  const i = lowerBound(v.days, date);
  return i < v.days.length && v.days[i]!.date === date ? v.days[i]!.count : 0;
}

/* ── Presets ── */

export type Preset = { key: string; label: string; from: string | null; to: string | null } | { key: "sep" };

/* Presets that would match nothing are dropped rather than shown at zero — on a
   working set of one month, "Last 30 days" and "This year" are usually empty,
   and an always-dead button is worse than a shorter rail. */
export function buildPresets(v: Volume, today = todayYmd()): Preset[] {
  const thisYear = Number(today.slice(0, 4));
  const relative = [
    { key: "30d", label: "Last 30 days", from: shiftDays(today, -29), to: today },
    { key: "12m", label: "Last 12 months", from: shiftDays(today, -364), to: today },
    { key: "year", label: "This year", from: ymd(thisYear, 1, 1), to: today },
  ].filter((p) => rangeTotal(v, p.from, p.to) > 0);

  const years = [...new Set(v.days.map((d) => Number(d.date.slice(0, 4))))].sort((a, b) => b - a);
  const yearPresets = years.slice(0, 3).map((y) => ({ key: `y${y}`, label: String(y), from: ymd(y, 1, 1), to: ymd(y, 12, 31) }));

  const presets: Preset[] = [{ key: "any", label: "Any date", from: null, to: null }, ...relative];
  /* A single year is the whole set — the same thing "Any date" already says. */
  if (yearPresets.length > 1) presets.push({ key: "sep" }, ...yearPresets);
  return presets;
}

export function isRealPreset(p: Preset): p is Exclude<Preset, { key: "sep" }> {
  return p.key !== "sep";
}

/** The preset a draft range is, "custom" for any other range, "any" for none. */
export function matchPreset(presets: Preset[], from: string | null, to: string | null): string {
  const hit = presets.filter(isRealPreset).find((p) => p.from === from && p.to === to);
  return hit ? hit.key : (from || to ? "custom" : "any");
}

/** The trigger's text for a committed range, or null for "Any date". */
export function rangeLabel(from: string | null, to: string | null, presetLabel?: string | null): string | null {
  if (presetLabel) return presetLabel;
  if (from && to) {
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return sameYear ? `${formatYmd(from, false)} – ${formatYmd(to)}` : `${formatYmd(from)} – ${formatYmd(to)}`;
  }
  if (from) return `From ${formatYmd(from)}`;
  if (to) return `Until ${formatYmd(to)}`;
  return null;
}

/* ── Typed bounds ── */

export type FieldCheck = { fromBad: boolean; toBad: boolean; inverted: boolean; ok: boolean; hint: string };

/** Whether the typed bounds are committable, and what to say. An inverted range
 *  is never silently swapped, since which bound the user meant is a guess. */
export function checkFields(fromRaw: string, toRaw: string): FieldCheck {
  const f = fromRaw.trim(), t = toRaw.trim();
  const fromBad = !!f && !parseYmd(f);
  const toBad = !!t && !parseYmd(t);
  const inverted = !fromBad && !toBad && !!f && !!t && f > t;
  let hint = "";
  if (fromBad || toBad) hint = "Use YYYY-MM-DD";
  else if (inverted) hint = "End is before start";
  else if (f && t) {
    const n = dayIndex(t)! - dayIndex(f)! + 1;
    hint = `${n.toLocaleString()} day${n === 1 ? "" : "s"}`;
  }
  return { fromBad, toBad, inverted, ok: !fromBad && !toBad && !inverted, hint };
}

/* ── Histogram geometry ── */

/** Date → 0..1 across the histogram, linear in days. */
export function posOf(v: Volume, date: string): number {
  if (!v.axisDays) return 0;
  const idx = dayIndex(date);
  if (idx === null) return 0;
  return Math.max(0, Math.min(1, (idx - v.axisStart) / v.axisDays));
}

/** 0..1 → date, clamped to the histogram's own span. */
export function dateAt(v: Volume, pos: number): string | null {
  if (!v.axisDays) return null;
  const offset = Math.round(Math.max(0, Math.min(1, pos)) * v.axisDays);
  return fromDayIndex(v.axisStart + Math.min(offset, v.axisDays - 1));
}

export function bucketInRange(b: Bucket, from: string | null, to: string | null): boolean {
  return (!from || from <= b.end) && (!to || to >= b.start);
}

/* Axis labels: months when the scope is short enough to be bucketed by day,
   otherwise years. Either way only every Nth is labelled — a 20-year library
   packs 20 ticks into ~400px — and the unlabelled dividers carry the scale. */
export function axisTicks(buckets: Bucket[]): { n: number; label: string }[] {
  const byDay = buckets.length > 0 && buckets[0]!.days === 1;
  const spans: { key: string; n: number; label: string }[] = [];
  for (const b of buckets) {
    const key = byDay ? b.start.slice(0, 7) : String(b.y);
    const last = spans[spans.length - 1];
    if (last && last.key === key) last.n += b.days;
    else spans.push({ key, n: b.days, label: byDay ? DRP_MONTHS[Number(key.slice(5, 7)) - 1]! : key });
  }
  const every = Math.max(1, Math.ceil(spans.length / 8));
  /* A label needs roughly a month of width to sit in without colliding. */
  const minDays = byDay ? 10 : 120;
  return spans.map((s, i) => ({ n: s.n, label: i % every === 0 && s.n >= minDays ? s.label : "" }));
}
