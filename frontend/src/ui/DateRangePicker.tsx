import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import {
  DRP_MONTHS, addMonths, axisTicks, bucketInRange, buildPresets, buildVolume, checkFields, dateAt, dayCount,
  dayOfWeek, daysInMonth, formatYmd, isRealPreset, matchPreset, monthOf, parseYmd, posOf, rangeLabel, rangeTotal,
  shiftDays, spanMonths, todayYmd, ymd, type DayRow, type Volume, type YearMonth,
} from "./dateRange";
import "./DateRangePicker.css";

/* Shared date range picker. Port of date-range-picker.js.
 *
 * One trigger field + one popover carrying four ways to pick the same
 * {from, to}: a presets rail, typed YYYY-MM-DD bounds, a histogram scrubber,
 * and twin day calendars. Every surface renders from one draft; nothing reaches
 * the caller until Apply.
 *
 * Volume data is a list of {date, count} rows — by default the whole library
 * from /api/stats/dates, or the caller's own via `dates` (a loaded month on
 * Geocode). Daily counts give the calendar density dots, the exact in-range
 * total, and the histogram bars, so nothing round-trips while the panel is open.
 *
 * Two commit modes:
 *   · default — the panel edits a draft, and only Apply calls onChange. Right
 *     for a page with its own Search button.
 *   · live — every valid edit commits at once and the footer button just
 *     closes. Right for a control that filters an already-loaded set. */

export type DateRange = {
  from: string | null;
  to: string | null;
  /** Preset key the range came from ("30d", "y2021"), so the trigger says "Last 30 days". */
  preset?: string | null;
  /** The trigger text at commit time, for callers that echo it (a scope line). */
  label?: string | null;
};

export const EMPTY_RANGE: DateRange = { from: null, to: null, preset: null, label: null };

type Draft = { from: string | null; to: string | null; preset: string };

export function DateRangePicker({ value, onChange, live = false, compact = false, dates, disabled, disabledTitle, labelledBy, id }: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  live?: boolean;
  compact?: boolean;
  /** The working set's day counts; omitted = the whole library. */
  dates?: DayRow[];
  disabled?: boolean;
  disabledTitle?: string;
  labelledBy?: string;
  id?: string;
}) {
  const uid = useId();
  const library = useQuery({
    queryKey: ["stats", "dates"],
    queryFn: async () => unwrap(await api.GET("/api/stats/dates", {})).dates,
    enabled: dates === undefined,
    staleTime: 5 * 60_000,
  });
  const rows = dates ?? library.data;
  const loadError = dates === undefined && library.isError;
  const loaded = rows !== undefined || loadError;
  const volume = useMemo(() => buildVolume(rows), [rows]);
  const presets = useMemo(() => buildPresets(volume), [volume]);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ from: null, to: null, preset: "any" });
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  /* Two-click range building: the next calendar click extends rather than restarts. */
  const [awaitingEnd, setAwaitingEnd] = useState(false);
  const [leftMonth, setLeftMonth] = useState<YearMonth | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);

  const presetLabel = value.preset
    ? presets.filter(isRealPreset).find((p) => p.key === value.preset)?.label ?? null
    : null;
  const triggerText = rangeLabel(value.from, value.to, presetLabel);
  const check = checkFields(fromText, toText);

  // A requested focus target (a day after a keyboard move, a handle after a
  // nudge) is focused once React has drawn it.
  useLayoutEffect(() => {
    if (!focusAfter.current || !panelRef.current) return;
    panelRef.current.querySelector<HTMLElement>(focusAfter.current)?.focus();
    focusAfter.current = null;
  });

  function commit(d: Draft) {
    const preset = d.preset !== "custom" && d.preset !== "any" ? d.preset : null;
    const label = rangeLabel(d.from, d.to, preset ? presets.filter(isRealPreset).find((p) => p.key === preset)?.label : null);
    onChange({ from: d.from, to: d.to, preset, label });
  }

  /** Every edit from a non-text surface: new draft, fields re-synced, and in
   *  live mode that edit *is* the commit. */
  function edit(next: { from: string | null; to: string | null }, opts: { keepAwaiting?: boolean } = {}) {
    const d = { ...next, preset: matchPreset(presets, next.from, next.to) };
    setDraft(d);
    setFromText(d.from ?? "");
    setToText(d.to ?? "");
    if (!opts.keepAwaiting) setAwaitingEnd(false);
    if (live) commit(d);
  }

  /* Park a bound in view. An end date goes on the RIGHT calendar so the start
     usually stays visible on the left, rather than scrolling itself off. */
  function anchorOn(date: string | null, edge: "from" | "to") {
    if (!date || !parseYmd(date)) return;
    const m = monthOf(date);
    setLeftMonth(edge === "to" ? addMonths(m, -1) : m);
  }

  function openPanel() {
    if (open || disabled) return;
    const d = { from: value.from, to: value.to, preset: value.preset || matchPreset(presets, value.from, value.to) };
    setDraft(d);
    setFromText(d.from ?? "");
    setToText(d.to ?? "");
    setAwaitingEnd(false);
    setCursor(d.from);
    setLeftMonth(d.from ? monthOf(d.from) : null);
    setOpen(true);
  }

  function closePanel(focusTrigger = true) {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function apply() {
    if (!live) {
      if (!check.ok) return;
      commit(draft);
    }
    closePanel();
  }

  // Outside pointer / Escape close the panel while it's open.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closePanel(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closePanel(); }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  // Flip to the trigger's right edge when the panel would run off-screen.
  const [alignRight, setAlignRight] = useState(false);
  useLayoutEffect(() => {
    if (!open || !panelRef.current) { setAlignRight(false); return; }
    setAlignRight(panelRef.current.getBoundingClientRect().right > window.innerWidth - 8);
  }, [open]);

  /* ── Typed bounds ── */

  function onField(which: "from" | "to", text: string) {
    if (which === "from") setFromText(text); else setToText(text);
    const parsed = parseYmd(text);
    if (parsed || !text.trim()) {
      const v = parsed ? ymd(parsed.y, parsed.m, parsed.d) : null;
      const next = which === "from" ? { from: v, to: draft.to } : { from: draft.from, to: v };
      const d = { ...next, preset: matchPreset(presets, next.from, next.to) };
      setDraft(d);
      setAwaitingEnd(false);
      if (v) { anchorOn(v, which); setCursor(v); }
      const nextCheck = checkFields(which === "from" ? text : fromText, which === "to" ? text : toText);
      if (live && nextCheck.ok) commit(d);
    }
  }

  /* ── Presets ── */

  function pickPreset(key: string) {
    const p = presets.filter(isRealPreset).find((x) => x.key === key);
    if (!p) return;
    const d = { from: p.from, to: p.to, preset: p.key };
    setDraft(d);
    setFromText(d.from ?? "");
    setToText(d.to ?? "");
    setAwaitingEnd(false);
    if (d.from) setLeftMonth(monthOf(d.from));
    setCursor(d.from);
    if (live) commit(d);
  }

  function reset() {
    const d = { from: null, to: null, preset: "any" };
    setDraft(d);
    setFromText("");
    setToText("");
    setAwaitingEnd(false);
    if (live) commit(d);
  }

  /* ── Calendars ── */

  /* Two-click range building: the first click restarts the range, the second
     closes it on whichever side the click falls. */
  function pickDate(date: string) {
    if (!awaitingEnd || !draft.from) {
      edit({ from: date, to: null }, { keepAwaiting: true });
      setAwaitingEnd(true);
    } else {
      edit(date < draft.from ? { from: date, to: draft.from } : { from: draft.from, to: date });
    }
    setCursor(date);
    focusAfter.current = `.drp-day[data-date="${date}"]`;
  }

  /* Scroll the twin calendars to keep the cursor visible, then focus it. */
  function moveCursor(date: string, left: YearMonth) {
    setCursor(date);
    const p = monthOf(date);
    const right = addMonths(left, 1);
    const ci = p.y * 12 + p.m - 1;
    if (ci < left.y * 12 + left.m - 1) setLeftMonth(p);
    else if (ci > right.y * 12 + right.m - 1) setLeftMonth(addMonths(p, -1));
    focusAfter.current = `.drp-day[data-date="${date}"]`;
  }

  function onDayKey(e: React.KeyboardEvent, date: string, left: YearMonth) {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
    if (step !== undefined) {
      e.preventDefault();
      moveCursor(shiftDays(date, step), left);
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const p = parseYmd(date)!;
      const m = addMonths({ y: p.y, m: p.m }, e.key === "PageUp" ? -1 : 1);
      moveCursor(ymd(m.y, m.m, Math.min(p.d, daysInMonth(m.y, m.m))), left);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickDate(date);
    }
  }

  /* ── Histogram scrubber ── */

  const trackRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!volume.buckets.length || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const posAt = (x: number) => (x - rect.left) / (rect.width || 1);
    let { from, to } = draftRef.current;
    /* Grab the handle under the cursor, else the nearer of the two — so a bare
       click on the track moves the closest edge rather than resetting. */
    let edge = (e.target as HTMLElement).closest<HTMLElement>(".drp-handle")?.dataset.edge as "from" | "to" | undefined;
    if (!edge) {
      const pos = posAt(e.clientX);
      const lo = from ? posOf(volume, from) : 0;
      const hi = to ? posOf(volume, shiftDays(to, 1)) : 1;
      edge = Math.abs(pos - lo) <= Math.abs(pos - hi) ? "from" : "to";
    }
    e.preventDefault();
    /* Dragging an unset range seeds it to the full span first. */
    if (!from && !to) {
      from = volume.days[0]?.date ?? null;
      to = volume.days[volume.days.length - 1]?.date ?? null;
    }
    /* Capture keeps the drag alive past the panel's edge, but it is only an
       improvement — move/up are bound to window, so a browser that refuses the
       capture still drags correctly. */
    try { trackRef.current.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    const dragEdge = edge;
    const move = (clientX: number) => {
      const date = dateAt(volume, posAt(clientX));
      if (!date) return;
      if (dragEdge === "from") from = to && date > to ? to : date;
      else to = from && date < from ? from : date;
      edit({ from, to });
      anchorOn(dragEdge === "from" ? from : to, dragEdge);
    };
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /* Handles are real sliders: arrows nudge a day, PageUp/PageDown a month. */
  function onHandleKey(e: React.KeyboardEvent, edge: "from" | "to") {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, PageUp: -30, PageDown: 30 } as Record<string, number>)[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const base = edge === "from" ? (draft.from || volume.days[0]?.date) : (draft.to || volume.days[volume.days.length - 1]?.date);
    if (!base) return;
    const next = shiftDays(base, step);
    const range = edge === "from"
      ? { from: draft.to && next > draft.to ? draft.to : next, to: draft.to }
      : { from: draft.from, to: draft.from && next < draft.from ? draft.from : next };
    edit(range);
    anchorOn(edge === "from" ? range.from : range.to, edge);
    focusAfter.current = `.drp-handle[data-edge="${edge}"]`;
  }

  /* ── Render ── */

  // Where the calendars open: a short scope (a loaded month or year) reads from
  // its start; a long one — the whole library — opens on its most recent months,
  // since its first month is usually decades of scrolling away.
  const scopeStart = spanMonths(volume) <= 24 ? volume.days[0]?.date : volume.days[volume.days.length - 1]?.date;
  const left: YearMonth = leftMonth ?? monthOf(draft.from || draft.to || scopeStart || todayYmd());

  return (
    <div ref={rootRef} id={id} role="group" aria-labelledby={labelledBy} className={`drp${compact ? " drp-compact" : ""}${disabled ? " drp-disabled" : ""}`}>
      <div
        className="drp-control"
        title={disabled ? disabledTitle : undefined}
        // Clicks anywhere in the field open the panel — the caret is inert so it
        // never steals the click from the trigger.
        onClick={(e) => {
          if (disabled || (e.target as HTMLElement).closest(".drp-clear")) return;
          if (open) closePanel(); else openPanel();
        }}
      >
        <button type="button" ref={triggerRef} className="drp-trigger" aria-expanded={open} aria-haspopup="dialog"
          aria-labelledby={labelledBy ? `${labelledBy} ${uid}-value` : undefined} disabled={disabled}>
          <span aria-hidden="true">📅</span>
          <span id={`${uid}-value`} className={`drp-value${triggerText ? "" : " placeholder"}`}>{triggerText ?? "Any date"}</span>
        </button>
        {triggerText && (
          <button type="button" className="drp-clear" title="Clear date range" aria-label="Clear date range"
            onClick={() => { closePanel(false); onChange(EMPTY_RANGE); }}>×</button>
        )}
        <span className="drp-caret" aria-hidden="true">▾</span>
      </div>
      {open && (
        <div ref={panelRef} className={`drp-panel${alignRight ? " align-right" : ""}`} role="dialog" aria-label="Choose a date range">
          {!loaded ? (
            <div className="drp-main">Loading photo dates…</div>
          ) : (
            <>
              {presets.length > 1 && (
                <div className="drp-presets">
                  {presets.map((p, i) => isRealPreset(p) ? (
                    <button key={p.key} type="button" className={`drp-preset${draft.preset === p.key ? " active" : ""}`}
                      aria-pressed={draft.preset === p.key} onClick={() => pickPreset(p.key)}>
                      {p.label}<span className="n">{rangeTotal(volume, p.from, p.to).toLocaleString()}</span>
                    </button>
                  ) : <div key={`sep-${i}`} className="drp-preset-sep" />)}
                  {draft.preset === "custom" && (
                    <>
                      <div className="drp-preset-sep" />
                      <button type="button" className="drp-preset active" aria-pressed="true">Custom range</button>
                    </>
                  )}
                </div>
              )}
              <div className="drp-main">
                <div className="drp-fields">
                  <div className={`drp-field${check.fromBad ? " invalid" : ""}`}>
                    <label htmlFor={`${uid}-from`}>From</label>
                    <input type="text" id={`${uid}-from`} placeholder="YYYY-MM-DD" inputMode="numeric" autoComplete="off"
                      value={fromText} aria-invalid={check.fromBad} onChange={(e) => onField("from", e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
                  </div>
                  <span className="drp-dash">–</span>
                  <div className={`drp-field${check.toBad || check.inverted ? " invalid" : ""}`}>
                    <label htmlFor={`${uid}-to`}>To</label>
                    <input type="text" id={`${uid}-to`} placeholder="YYYY-MM-DD" inputMode="numeric" autoComplete="off"
                      value={toText} aria-invalid={check.toBad || check.inverted} onChange={(e) => onField("to", e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
                  </div>
                  <span className={`drp-hint${check.ok ? "" : " error"}`} aria-live="polite">{check.hint}</span>
                </div>
                <Scrubber volume={volume} draft={draft} trackRef={trackRef} onPointerDown={onTrackPointerDown} onHandleKey={onHandleKey} />
                <div className="drp-cals">
                  <Month ym={left} side="left" volume={volume} draft={draft} cursor={cursor}
                    onNav={(step) => setLeftMonth(addMonths(left, step))} onPick={pickDate} onKey={(e, d) => onDayKey(e, d, left)} />
                  <Month ym={addMonths(left, 1)} side="right" volume={volume} draft={draft} cursor={cursor}
                    onNav={(step) => setLeftMonth(addMonths(left, step))} onPick={pickDate} onKey={(e, d) => onDayKey(e, d, left)} />
                </div>
                <div className="drp-foot">
                  <FootCount volume={volume} draft={draft} loadError={loadError} />
                  <div className="drp-foot-btns">
                    <button type="button" className="drp-reset" onClick={reset}>↩ Reset</button>
                    <button type="button" className="drp-apply primary" disabled={!check.ok} onClick={apply}>{live ? "Done" : "Apply"}</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FootCount({ volume, draft, loadError }: { volume: Volume; draft: Draft; loadError: boolean }) {
  /* Deliberately does not name the scope — the same control describes the
     whole library on Search and a single loaded month on Geocode. */
  if (loadError) return <span className="drp-count">Photo counts unavailable.</span>;
  if (!draft.from && !draft.to) {
    const all = rangeTotal(volume, null, null);
    return <span className="drp-count"><b>{all.toLocaleString()}</b> dated photo{all === 1 ? "" : "s"}</span>;
  }
  const n = rangeTotal(volume, draft.from, draft.to);
  return <span className="drp-count"><b>{n.toLocaleString()}</b> photo{n === 1 ? "" : "s"} in range</span>;
}

function Scrubber({ volume, draft, trackRef, onPointerDown, onHandleKey }: {
  volume: Volume;
  draft: Draft;
  trackRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onHandleKey: (e: React.KeyboardEvent, edge: "from" | "to") => void;
}) {
  if (!volume.buckets.length) {
    return <div className="drp-hist"><div className="drp-count" style={{ padding: "6px 2px" }}>No dated photos in this view.</div></div>;
  }
  /* Bars are flex-weighted by their day count, so the axis stays linear in time
     even when months of different lengths sit side by side. */
  const peak = Math.max(1, ...volume.buckets.map((b) => b.count));
  /* Handles are drawn even with no range set — parked at the full span — so the
     scrubber looks draggable before it has been touched. */
  const lo = draft.from ? posOf(volume, draft.from) : 0;
  const hi = draft.to ? posOf(volume, shiftDays(draft.to, 1)) : 1;
  return (
    <div className="drp-hist" role="group" aria-label="Photo volume by month; drag the handles to set the range">
      <div className="drp-track" ref={trackRef} onPointerDown={onPointerDown}>
        <div className="drp-bars">
          {volume.buckets.map((b) => {
            const h = Math.max(b.count ? 4 : 0, Math.round((b.count / peak) * 100));
            return <i key={b.start} className={bucketInRange(b, draft.from, draft.to) ? "in" : undefined} style={{ flex: `${b.days} 0 0`, height: `${h}%` }} />;
          })}
        </div>
        <div className="drp-band" style={{ left: `${lo * 100}%`, width: `${Math.max(0, hi - lo) * 100}%` }} />
        <span className="drp-handle" data-edge="from" role="slider" tabIndex={0} aria-label="Range start"
          aria-valuetext={draft.from ? formatYmd(draft.from) : "the earliest photo"} style={{ left: `${lo * 100}%` }}
          onKeyDown={(e) => onHandleKey(e, "from")} />
        <span className="drp-handle" data-edge="to" role="slider" tabIndex={0} aria-label="Range end"
          aria-valuetext={draft.to ? formatYmd(draft.to) : "the latest photo"} style={{ left: `${hi * 100}%` }}
          onKeyDown={(e) => onHandleKey(e, "to")} />
      </div>
      <div className="drp-ticks">
        {axisTicks(volume.buckets).map((t, i) => <span key={i} style={{ flex: `${t.n} 0 0` }}>{t.label}</span>)}
      </div>
    </div>
  );
}

function Month({ ym, side, volume, draft, cursor, onNav, onPick, onKey }: {
  ym: YearMonth;
  side: "left" | "right";
  volume: Volume;
  draft: Draft;
  cursor: string | null;
  onNav: (step: number) => void;
  onPick: (date: string) => void;
  onKey: (e: React.KeyboardEvent, date: string) => void;
}) {
  const today = todayYmd();
  const dim = daysInMonth(ym.y, ym.m);
  const lead = dayOfWeek(ym.y, ym.m, 1);
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < lead; i++) cells.push(<span key={`b${i}`} className="drp-day blank" aria-hidden="true" />);
  for (let d = 1; d <= dim; d++) {
    const date = ymd(ym.y, ym.m, d);
    const count = dayCount(volume, date);
    const cls = ["drp-day"];
    if (!count) cls.push("empty");
    if (draft.from && draft.to && date > draft.from && date < draft.to) cls.push("in-range");
    if (date === draft.from) cls.push("edge", "start");
    if (date === draft.to) cls.push("edge", "end");
    if (date === today) cls.push("today");
    cells.push(
      <button key={date} type="button" className={cls.join(" ")} data-date={date}
        tabIndex={date === (cursor || draft.from) ? 0 : -1}
        aria-label={count ? `${formatYmd(date)}, ${count} photo${count === 1 ? "" : "s"}` : `${formatYmd(date)}, no photos`}
        aria-pressed={date === draft.from || date === draft.to}
        onClick={() => onPick(date)} onKeyDown={(e) => onKey(e, date)}>
        {d}{count ? <span className="drp-dot" /> : null}
      </button>,
    );
  }
  while (cells.length % 7) cells.push(<span key={`t${cells.length}`} className="drp-day blank" aria-hidden="true" />);
  const weeks: React.ReactNode[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(<div key={i} className="drp-week">{cells.slice(i, i + 7)}</div>);

  /* Only the outer arrow of each calendar moves; the pair always stays adjacent,
     so the inner arrow would be a no-op. */
  return (
    <div className="drp-cal">
      <div className="drp-cal-head">
        <button type="button" className="drp-nav" aria-label="Previous month" disabled={side !== "left"} onClick={() => onNav(-1)}>‹</button>
        <span className="drp-cal-title">{DRP_MONTHS[ym.m - 1]} {ym.y}</span>
        <button type="button" className="drp-nav" aria-label="Next month" disabled={side !== "right"} onClick={() => onNav(1)}>›</button>
      </div>
      <div className="drp-dow" aria-hidden="true"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      {weeks}
    </div>
  );
}
