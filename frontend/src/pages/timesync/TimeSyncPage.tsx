import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, getJson, unwrap } from "../../api/client";
import { ApiError } from "../../api/errors";
import { fullSizeUrl, isRawName } from "../../lib/fullsize";
import { nav } from "../../lib/handoff";
import { latestOnly, type LatestOnly } from "../../lib/latestOnly";
import { MONTH_NAMES } from "../../lib/format";
import { STAGED_SAVE_FAILED_MSG } from "../../lib/stagedWork";
import { formatWallClock, wallClockParts } from "../../lib/wallClock";
import { CameraColors } from "../../photos/cameraColors";
import { CameraLegend } from "../../photos/CameraLegend";
import { fetchPhotosByIds } from "../../photos/fetchPhotosByIds";
import { ThumbCell, verticalNeighbour } from "../../photos/PhotoGrid";
import type { ClickModifiers } from "../../photos/selection";
import { AppShell } from "../../shell/AppShell";
import { StatusBar, type Status } from "../../shell/StatusBar";
import { VisTimeline, type FitRequest, type FocusRequest, type TimelineGroup, type TimelineItem } from "../../timeline/VisTimeline";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { MonthPickerDialog } from "../../ui/MonthPickerDialog";
import { RestoreBanner } from "../../ui/RestoreBanner";
import { TimelineHistogram, type Histogram, type TimeRange } from "../../ui/TimelineHistogram";
import {
  adjustedTime, applyOffset, batchProblems, cameraOf, classifyOffsetRestore, dayHistogram, filterPhotos, fitWindow,
  gridSelection, offsetRecords, offsetStore, resetOffsets, restoreDroppedNote, saveUpdates, settleSave, signed,
  timelineSelection, totalOffset, validOffsetRecord, type Offset, type OffsetRecord, type Offsets, type Photo,
  type UpdateTimesResponse,
} from "./timeSync";
import "./timesync.css";

/* Time Sync: line up photos from cameras whose clocks disagree. Pick a month;
 * its photos show on a timeline (one row per camera) and in a grid. Select a
 * camera's photos, apply a minutes/seconds offset (relative to each photo's
 * original time, so re-applying replaces rather than adds), and Save writes the
 * corrected times to XMP sidecars — never to the originals. Port of
 * timesync.js. Offsets are staged in memory and backed up to sessionStorage
 * (U7) until saved. */

type Filter = "all" | "yes" | "no";
type Ask = { title: string; message: string; confirmLabel: string; danger?: boolean; onYes: () => void };
type Restored = { ids: number[]; detail: string; hidden: boolean };

const pad2 = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function TimeSyncPage() {
  const [status, setStatus] = useState<Status>({ message: "" });
  const say = useCallback((message: string, isError = false) => setStatus({ message, isError }), []);
  const colors = useRef(new CameraColors()).current;

  const [month, setMonth] = useState<{ year: number; month: number } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [hist, setHist] = useState<{ h: Histogram; key: number } | null>(null);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [offsets, setOffsetsState] = useState<Offsets>(() => new Map());
  const [minutes, setMinutes] = useState("0");
  const [seconds, setSeconds] = useState("0");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [monthOpen, setMonthOpen] = useState(false);
  const [restored, setRestored] = useState<Restored | null>(null);
  const [fit, setFit] = useState<FitRequest | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);

  // Async flows (the loaders, Save, the restore) read the latest state here
  // rather than a render's closure.
  const offsetsRef = useRef<Offsets>(offsets);
  const latest = useRef({ photos, hidden, hist, range, filter, month, selected });
  latest.current = { photos, hidden, hist, range, filter, month, selected };
  const carry = useRef<OffsetRecord[]>([]);
  const saveWarned = useRef(false);

  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const filtered = useMemo(() => filterPhotos(photos, hidden, hist?.h ?? null, range), [photos, hidden, hist, range]);
  const showing = (list: readonly Photo[], all: readonly Photo[]) => `Showing ${list.length} of ${all.length} photos`;

  /** Every change to the offsets goes through here: state, the ref, and the
   *  sessionStorage backup (only what's still unsaved stays in it). */
  const setOffsets = useCallback((next: Offsets) => {
    offsetsRef.current = next;
    setOffsetsState(next);
    if (!offsetStore.save(offsetRecords(next, carry.current)) && !saveWarned.current) {
      saveWarned.current = true;
      say(STAGED_SAVE_FAILED_MSG, true);
    }
  }, [say]);

  // ── Loaders ──
  // Latest-only, like the legacy page: pick month A then month B and only B's
  // histogram and photos may land.
  const loaders = useRef<{
    hist: LatestOnly<[number, number], void>;
    photos: LatestOnly<[number, number, Filter, boolean], void>;
  } | null>(null);
  if (!loaders.current) {
    let histKey = 0;
    loaders.current = {
      hist: latestOnly(async (signal, year: number, m: number) => {
        try {
          const data = await getJson<{ dates: { date: string; count: number }[] }>(`/api/stats/dates?year=${year}&month=${m}`, { signal });
          if (signal.aborted) return;
          const h = dayHistogram(data.dates ?? []);
          setHist(h ? { h, key: ++histKey } : null);
          setRange(h ? { lo: h.min, hi: h.max } : null);
          latest.current.hist = h ? { h, key: histKey } : null;
          latest.current.range = h ? { lo: h.min, hi: h.max } : null;
        } catch (e) {
          if (signal.aborted) return;
          // Drop the previous month's range too: left in place, the filter would
          // hold this month's photos against last month's dates and hide them all.
          setHist(null);
          setRange(null);
          latest.current.hist = null;
          latest.current.range = null;
          say("Could not load the day histogram: " + (e as Error).message, true);
        }
      }),
      photos: latestOnly(async (signal, year: number, m: number, f: Filter, fitTimeline: boolean) => {
        const from = `${year}-${pad2(m)}-01`;
        const to = `${year}-${pad2(m)}-${daysIn(year, m)}`;
        // U4: the timeline shows the previous month's items until the reply
        // lands — held busy (dimmed, clicks ignored) meanwhile. A superseded
        // call returns before touching it, so it can't clear the newer one's.
        setLoading(true);
        try {
          const data = await getJson<Photo[]>(`/api/photos?geotagged=${f}&date_from=${from}&date_to=${to}`, { signal });
          if (signal.aborted) return;
          data.forEach((p) => colors.color(p.camera));   // pre-assign colours, in photo order
          setPhotos(data);
          const { hidden: hid, hist: hs, range: rg } = latest.current;
          const shown = filterPhotos(data, hid, hs?.h ?? null, rg);
          say(showing(shown, data));
          if (fitTimeline) {
            const w = fitWindow(shown, offsetsRef.current);
            if (w) setFit((prev) => ({ ...w, n: (prev?.n ?? 0) + 1 }));
          }
        } catch (e) {
          if (signal.aborted) return;
          say("Load error: " + (e as Error).message, true);
        } finally {
          if (!signal.aborted) setLoading(false);
        }
      }),
    };
  }

  const selectMonth = useCallback(async (year: number, m: number) => {
    setMonth({ year, month: m });
    latest.current.month = { year, month: m };
    await loaders.current!.hist(year, m);
    await loaders.current!.photos(year, m, latest.current.filter, true);
  }, []);

  const reloadPhotos = useCallback(async (fitTimeline = false) => {
    const { month: ym, filter: f } = latest.current;
    if (ym) await loaders.current!.photos(ym.year, ym.month, f, fitTimeline);
  }, []);

  // ── Start-up: the scan check, then offsets kept from before a reload (U7) ──
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;   // StrictMode's second mount must not restore twice
    started.current = true;
    void (async () => {
      let scanNeeded = false;
      try {
        const s = unwrap(await api.GET("/api/status"));
        // The legacy page read a `scan_needed` flag /api/status no longer sends;
        // an empty library is the same situation.
        if (s.db_total === 0) {
          scanNeeded = true;
          say("No scan data found. Please run a scan first.", true);
        }
      } catch (e) {
        scanNeeded = true;
        say("Connection error: " + (e as Error).message, true);
      }
      // (The legacy page wrote this hint over the scan warning; it no longer does.)
      if (!scanNeeded) say("Click 'Select Month' to begin");
      await restoreOffsets();
    })();
  }, []);

  async function restoreOffsets() {
    const records = offsetStore.load().filter(validOffsetRecord);
    if (!records.length) return;
    // Carried while they're checked: an offset applied meanwhile mustn't
    // overwrite them in the backup.
    carry.current = records;
    let current: Map<number, Photo>;
    try {
      current = new Map((await fetchPhotosByIds(records.map((r) => r.id))).map((p) => [p.id, p]));
    } catch (e) {
      say(`Couldn't check the ${records.length} time offset(s) kept from your last visit ` +
        `(${(e as Error).message}). They're kept for the next reload.`, true);
      return;
    }
    const r = classifyOffsetRestore(records, current, (id) => offsetsRef.current.has(id));
    carry.current = [];
    const next = new Map(offsetsRef.current);
    r.restored.forEach((rec) => next.set(rec.id, { offset: rec.offset, base: rec.base }));
    setOffsets(next);   // the backup now matches what was restored
    const droppedNote = restoreDroppedNote(r);
    if (!r.restored.length) {
      say(`Nothing left to restore from your last visit. ${droppedNote}`);
      return;
    }
    setRestored({
      ids: r.restored.map((rec) => rec.id),
      detail: ["Offsets show on their photos once that month is open.", droppedNote].join(" ").trim(),
      hidden: false,
    });
    say(`Restored ${r.restored.length} unsaved time offset(s) from your last visit. Nothing is written until you Save.`);
  }

  // The sessionStorage backup is gone once the tab is closed for good.
  const unsaved = offsets.size > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // ── Filters ──
  function onFilter(f: Filter) {
    setFilter(f);
    latest.current.filter = f;
    void reloadPhotos();
  }
  function toggleCamera(cam: string) {
    const next = new Set(hidden);
    if (next.has(cam)) next.delete(cam); else next.add(cam);
    setHidden(next);
    say(showing(filterPhotos(photos, next, hist?.h ?? null, range), photos));
  }
  function onRange(r: TimeRange) {
    setRange(r);
    say(showing(filterPhotos(photos, hidden, hist?.h ?? null, r), photos));
  }

  // ── Selection ──
  // Grid clicks and timeline picks read these through refs, so the handlers
  // stay one function and the memoised cells only re-render on their own state.
  const latestFiltered = useRef(filtered);
  latestFiltered.current = filtered;
  const latestById = useRef(byId);
  latestById.current = byId;
  const lastIdxRef = useRef(-1);   // the shift-range anchor

  const onGridActivate = useCallback((idx: number, mod: ClickModifiers) => {
    const { selected: sel } = latest.current;
    const list = latestFiltered.current;
    const photo = list[idx];
    if (!photo) return;
    setSelected(gridSelection(sel, list, idx, lastIdxRef.current, mod));
    if (!mod.toggle && !mod.shift) {
      setFocusedId(photo.id);
      // Bring the timeline to the photo.
      setFocus((prev) => ({ id: photo.id, n: (prev?.n ?? 0) + 1 }));
    }
    lastIdxRef.current = idx;
  }, []);

  const onTimelineSelect = useCallback((ids: number[], shift: boolean) => {
    const { selected: sel } = latest.current;
    const picked = timelineSelection(ids, shift, sel, latestById.current);
    setSelected(new Set(picked));
    if (picked.length === 1) setFocusedId(picked[0]!);
  }, []);
  const onTimelineDouble = useCallback((id: number) => setFocusedId(id), []);

  // ── Offsets ──
  function apply() {
    if (!selected.size) { say("No photos selected", true); return; }
    const total = totalOffset(minutes, seconds);
    if (total === 0) { say("Please enter a non-zero offset", true); return; }
    const { next, applied, skipped } = applyOffset(offsetsRef.current, byId, selected, total);
    setOffsets(next);
    say(`Applied ${signed(total)}s offset to ${applied} photos (relative to original time)` +
      (skipped ? `; ${skipped} undated photo(s) skipped` : ""));
  }

  function reset() {
    if (selected.size) {
      setOffsets(resetOffsets(offsetsRef.current, selected));
      say("Time offsets reset");
      return;
    }
    if (!offsetsRef.current.size) { say("No offsets to reset", true); return; }
    setAsk({
      title: "Reset time offsets", message: "Reset all time offsets?", confirmLabel: "Reset all", danger: true,
      onYes: () => { setOffsets(new Map()); say("Time offsets reset"); },
    });
  }

  function askSave() {
    const n = offsetsRef.current.size;
    if (!n) { say("No time offsets to save", true); return; }
    setAsk({
      title: "Save times", message: `Save time adjustments for ${n} photos to sidecar files?`, confirmLabel: "Save",
      onYes: () => void save(),
    });
  }

  async function save() {
    const updates = saveUpdates(offsetsRef.current);
    setSaving(true);
    try {
      say("Saving time adjustments...");
      const res = await api.POST("/api/photos/update-times", { body: { updates } });
      // 200 carries a {results, written, failed, not_found} breakdown; 502/404/409
      // carry the same body when nothing was written, so !ok alone isn't a
      // request-level failure here. Anything else (400/422/500) has no `written`.
      const out = (res.data ?? res.error) as UpdateTimesResponse | undefined;
      if (!out || !Array.isArray(out.written)) throw new ApiError(res.response.status, res.error);

      // Order matters (audit W8): an offset is a delta on the photo's *loaded*
      // time, so it must be gone before (or together with) that photo's new
      // time arriving — otherwise the reload's already-shifted time gets the
      // offset added again and the photo shows double-shifted.
      const { next, retryable } = settleSave(offsetsRef.current, out);
      setOffsets(next);   // only what settled leaves the backup

      // Patch the saved times in locally first, so the view is right even if
      // the reload below fails (it would otherwise show the old time, offset gone).
      const savedTimes = new Map((out.results ?? []).map((r) => [r.id, r.photo_datetime]));
      setPhotos((ps) => ps.map((p) => (savedTimes.has(p.id) ? { ...p, photo_datetime: savedTimes.get(p.id)! } : p)));

      // Reload to pick up the server's view (sidecar-backed times).
      await reloadPhotos();

      const problems = batchProblems(out);
      if (problems) {
        setSelected(new Set(retryable));   // leave the retryable ones selected
        const hint = retryable.length ? " — press Save again to retry" : "";
        say(`Updated ${out.written.length} of ${updates.length}; ${problems}${hint}`, true);
      } else {
        say(`Saved time adjustments for ${out.written.length} photos`);
      }
    } catch (e) {
      // Request-level failure: the server may or may not have applied part of
      // it. Offsets stay, so Save can be pressed again — it only applies what's left.
      say("Save error: " + (e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  // ── Restore banner ──
  const stillRestored = restored ? restored.ids.filter((id) => offsets.has(id)) : [];
  const restoreProps = {
    remaining: stillRestored.length,
    detail: restored?.detail ?? "",
    noun: "time offset",
    onReview: () => {
      // Open the month of the earliest restored photo.
      const ids = restored ? restored.ids.filter((id) => offsetsRef.current.has(id)) : [];
      if (!ids.length) return;
      const first = ids.reduce((a, b) => (offsetsRef.current.get(a)!.base <= offsetsRef.current.get(b)!.base ? a : b));
      const parts = wallClockParts(offsetsRef.current.get(first)!.base);
      if (parts) void selectMonth(parts.year, parts.month + 1);
    },
    // Save writes every applied offset (it has its own confirm).
    onCommit: askSave,
    onDiscard: () => {
      const ids = stillRestored;
      const discard = () => {
        setOffsets(resetOffsets(offsetsRef.current, ids));
        say(`Discarded ${ids.length} restored time offset(s).`);
      };
      if (ids.length > 3) {
        setAsk({ title: "Discard restored offsets", message: `Discard ${ids.length} restored time offset(s)?`, confirmLabel: "Discard", danger: true, onYes: discard });
      } else discard();
    },
    onClose: () => setRestored((r) => (r ? { ...r, hidden: true } : r)),
  };

  // ── Timeline data ──
  const groups = useMemo<TimelineGroup[]>(() => {
    const cams = [...new Set(photos.map(cameraOf))];
    return cams.map((cam) => ({ id: cam, content: cam, color: colors.color(cam) }));
  }, [photos, colors]);
  const items = useMemo<TimelineItem[]>(() => photos.flatMap((p) => {
    const t = adjustedTime(p, offsets);
    if (t === null) return [];
    return [{ id: p.id, group: cameraOf(p), start: t * 1000, filename: p.filename, color: colors.color(p.camera), shifted: offsets.has(p.id) }];
  }), [photos, offsets, colors]);

  const monthLabel = month ? `${MONTH_NAMES[month.month - 1]} ${month.year}` : "No month selected";
  const minId = useId(), secId = useId(), filterId = useId();
  const focused = focusedId != null ? byId.get(focusedId) ?? null : null;

  return (
    <AppShell active="timesync" toolbar={
      <>
        <div className="toolbar-group">
          <button type="button" id="select-month-btn" onClick={() => setMonthOpen(true)}>Select Month</button>
          <span id="selected-month-label">{monthLabel}</span>
        </div>
        <div className="toolbar-group">
          <label htmlFor={filterId}>Show:</label>
          <select id={filterId} value={filter} onChange={(e) => onFilter(e.target.value as Filter)}>
            <option value="all">All</option>
            <option value="yes">Geotagged</option>
            <option value="no">Not geotagged</option>
          </select>
        </div>
        <div className="toolbar-group" role="group" aria-label="Time offset">
          <span>Time offset:</span>
          <input id={minId} aria-label="Offset minutes" className="offset-input" type="number" placeholder="Min" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <input id={secId} aria-label="Offset seconds" className="offset-input" type="number" placeholder="Sec" value={seconds} onChange={(e) => setSeconds(e.target.value)} />
          <button type="button" onClick={apply}>Apply to selection</button>
          <button type="button" onClick={reset} title="Reset the selection's offsets (all offsets when nothing is selected)">Reset</button>
        </div>
        <div className="toolbar-group">
          <button type="button" className="primary" disabled={saving} onClick={askSave}>
            {saving ? "Saving…" : `Save times to sidecar${offsets.size ? ` (${offsets.size})` : ""}`}
          </button>
        </div>
      </>
    }>
      <CameraLegend photos={photos} colors={colors} hidden={hidden} onToggle={toggleCamera} />
      <div id="timeline-pane">
        {hist && <TimelineHistogram key={hist.key} histogram={hist.h} onRangeChange={onRange} id="month-hist" />}
      </div>
      <VisTimeline items={items} groups={groups} selection={selected} onSelect={onTimelineSelect}
        onDoubleClick={onTimelineDouble} fit={fit} focus={focus} busy={loading} />
      <div id="bottom-section">
        <div id="grid-pane">
          <TimeSyncGrid photos={filtered} selected={selected} focusedId={focusedId} colors={colors} onActivate={onGridActivate}
            empty={month ? "No photos match the filters" : "Click 'Select Month' to begin"} />
        </div>
        <TimeSyncDetail photo={focused} offset={focused ? offsets.get(focused.id) ?? null : null} />
      </div>
      <StatusBar status={status} />

      {restored && !restored.hidden && restoreProps.remaining > 0 && <RestoreBanner {...restoreProps} />}
      {monthOpen && (
        <MonthPickerDialog onClose={() => setMonthOpen(false)} onError={(m) => say(m, true)}
          onMonth={(y, m) => { setMonthOpen(false); void selectMonth(y, m); }} />
      )}
      {ask && (
        <ConfirmDialog title={ask.title} message={ask.message} confirmLabel={ask.confirmLabel} danger={ask.danger}
          onConfirm={() => { const yes = ask.onYes; setAsk(null); yes(); }} onCancel={() => setAsk(null)} />
      )}
    </AppShell>
  );
}

/** The flat photo grid (no month groups: one month is loaded at a time), each
 *  cell striped in its camera's colour. Cells are buttons; arrows move and
 *  activate like PhotoGrid's, so the grid is the keyboard path to everything
 *  the timeline does by mouse. */
function TimeSyncGrid({ photos, selected, focusedId, colors, onActivate, empty }: {
  photos: readonly Photo[];
  selected: ReadonlySet<number>;
  focusedId: number | null;
  colors: CameraColors;
  onActivate: (idx: number, mod: ClickModifiers) => void;
  empty: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const count = useRef(photos.length);
  count.current = photos.length;
  const onKey = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let target: number | null = null;
    if (e.key === "ArrowRight") target = idx + 1;
    else if (e.key === "ArrowLeft") target = idx - 1;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = count.current - 1;
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ref.current) {
      const el = verticalNeighbour(ref.current, e.currentTarget, e.key === "ArrowDown");
      target = el ? Number(el.dataset.idx) : null;
    }
    if (target === null || target < 0 || target >= count.current) return;
    e.preventDefault();
    ref.current?.querySelector<HTMLElement>(`.thumb-cell[data-idx="${target}"]`)?.focus();
    onActivate(target, { shift: e.shiftKey, toggle: false });
  }, [onActivate]);

  if (!photos.length) return <div id="grid" className="photo-grid"><div className="grid-empty">{empty}</div></div>;
  return (
    <div id="grid" className="photo-grid" ref={ref} role="group" aria-label="Photos">
      {photos.map((p, idx) => (
        <ThumbCell key={p.id} photo={p} idx={idx} selected={selected.has(p.id)} focused={p.id === focusedId}
          onActivate={onActivate} onKey={onKey} stripColor={colors.color(p.camera)} />
      ))}
    </div>
  );
}

/** The focused photo's thumbnail and times, from the loaded list (no fetch). */
function TimeSyncDetail({ photo, offset }: { photo: Photo | null; offset: Offset | null }) {
  if (!photo) {
    return <aside id="detail-pane" aria-label="Photo details"><div id="detail-placeholder">Select a photo to view details</div></aside>;
  }
  // Wall clock stored as a UTC epoch: formatted in UTC, not the browser's zone.
  const original = photo.photo_datetime ? formatWallClock(photo.photo_datetime) : "Unknown";
  const shift = offset?.offset ?? 0;
  return (
    <aside id="detail-pane" aria-label="Photo details" aria-live="polite">
      <img id="detail-img" src={`/api/thumbnail/${photo.id}`} alt={`Preview of ${photo.filename}`} />
      {isRawName(photo.filename) && (
        <button type="button" id="view-fullsize-btn" title="Decode the RAW at full resolution and open it in a new tab"
          onClick={() => nav.open(fullSizeUrl(photo.id))}>🔍 View full size (RAW)</button>
      )}
      <table id="detail-meta">
        <tbody>
          <tr><th scope="row">Filename</th><td>{photo.filename}</td></tr>
          <tr><th scope="row">Camera</th><td>{cameraOf(photo)}</td></tr>
          <tr><th scope="row">Original time</th><td>{original}</td></tr>
          {shift !== 0 && photo.photo_datetime ? (
            <tr><th scope="row">Adjusted time</th><td>{formatWallClock(photo.photo_datetime + shift)} ({signed(shift)}s)</td></tr>
          ) : null}
          <tr><th scope="row">Location</th><td>{photo.lat != null && photo.lng != null ? `${photo.lat.toFixed(6)}, ${photo.lng.toFixed(6)}` : "Not geotagged"}</td></tr>
        </tbody>
      </table>
    </aside>
  );
}
