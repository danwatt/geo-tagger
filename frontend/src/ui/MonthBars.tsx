import { MONTH_NAMES } from "../lib/format";
import "./MonthBars.css";

/* Stacked bar per month. `segments` is bottom-to-top stacking order, each `key`
 * reading a count off the month. "pct": every bar fills the height, split by
 * each segment's share (segments must partition the month). "abs": bar height is
 * the month's total against the tallest month, so spikes stay visible. Each bar
 * links to `linkPage?month=YYYY-MM`; they're real links so they work from the
 * keyboard (audit Y1). */

export type MonthBarMode = "pct" | "abs";

export type Segment<K extends string> = { key: K; cls: string; label: string };

type Month<K extends string> = { year: number; month: number } & Record<K, number>;

/** Per-bar geometry, pulled out so it's testable without a DOM. */
export function barLayout<K extends string>(months: Month<K>[], segments: Segment<K>[], mode: MonthBarMode) {
  const totals = months.map((m) => segments.reduce((sum, s) => sum + m[s.key], 0));
  const maxTotal = Math.max(0, ...totals);
  let lastYear: number | null = null;
  return months.map((m, i) => {
    const total = totals[i] ?? 0;
    const yearLabel = m.year !== lastYear ? m.year : null;
    lastYear = m.year;
    return {
      key: `${m.year}-${String(m.month).padStart(2, "0")}`,
      heightPct: mode === "abs" ? (maxTotal > 0 ? (total / maxTotal) * 100 : 0) : 100,
      segments: segments.map((s) => ({ ...s, pct: total > 0 ? (m[s.key] / total) * 100 : 0, n: m[s.key] })),
      title: `${MONTH_NAMES[m.month - 1]} ${m.year} — ` + segments.map((s) => `${m[s.key].toLocaleString()} ${s.label}`).join(", "),
      yearLabel,
    };
  });
}

export function MonthBars<K extends string>({ months, segments, mode, linkPage }: {
  /** Oldest first. */
  months: Month<K>[];
  segments: Segment<K>[];
  mode: MonthBarMode;
  linkPage: string;
}) {
  return (
    <div className="months-bar-container">
      {barLayout(months, segments, mode).map((bar) => (
        <a
          key={bar.key}
          className="month-bar"
          href={`${linkPage}?month=${bar.key}`}
          title={bar.title}
          aria-label={bar.title}
          style={mode === "abs" ? { height: `${bar.heightPct}%` } : undefined}
        >
          {bar.segments.map((s) => <div key={s.key} className={s.cls} style={{ height: `${s.pct}%` }} />)}
          {bar.yearLabel !== null && <span className="month-year-label">{bar.yearLabel}</span>}
        </a>
      ))}
    </div>
  );
}

/** "📁 12 undated photos →" under a month chart; nothing when there are none. */
export function UndatedLink({ total, linkPage }: { total: number; linkPage: string }) {
  if (!total) return null;
  return (
    <a className="undated-link" href={`${linkPage}?month=undated`}>
      📁 {total.toLocaleString()} undated photo{total === 1 ? "" : "s"} →
    </a>
  );
}
