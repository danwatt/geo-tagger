/* Shared date range picker.
 *
 * One trigger field + one popover carrying four ways to pick the same
 * {from, to}: a presets rail, typed YYYY-MM-DD bounds, a monthly histogram
 * scrubber, and twin day calendars. Every surface renders from one draft
 * state; nothing is committed to the caller until Apply.
 *
 * Volume data is a list of {date, count} rows — by default the whole library
 * from /api/stats/dates, but a caller can supply its own via `loadDates` and
 * push updates through `setDates()`. Daily counts give the calendar density
 * dots, the exact in-range total, and — summed per month — the histogram bars,
 * so no round-trip is needed while the panel is open.
 *
 * Two commit modes:
 *   · default — the panel edits a draft, and only Apply calls onChange. Right
 *     for a page with its own Search button.
 *   · live: true — every edit commits immediately and the footer button just
 *     closes. Right for a control that filters an already-loaded set, where
 *     waiting for Apply would feel broken.
 *
 * Dates are handled as plain YYYY-MM-DD strings throughout and compared
 * lexicographically; arithmetic goes through Date.UTC so a local timezone can
 * never shift a day across a boundary.
 */

/* ── Plain-date helpers (UTC-only, no local timezone anywhere) ── */

const DRP_DAY_MS = 86400000;

function drpPad(n) { return String(n).padStart(2, "0"); }
function drpYmd(y, m, d) { return `${y}-${drpPad(m)}-${drpPad(d)}`; }

function drpParse(s) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s || "").trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > drpDaysInMonth(y, m)) return null;
  return { y, m, d };
}

function drpDaysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function drpDow(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function drpIndex(s) { const p = drpParse(s); return p ? Date.UTC(p.y, p.m - 1, p.d) / DRP_DAY_MS : null; }

function drpFromIndex(n) {
  const dt = new Date(n * DRP_DAY_MS);
  return drpYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function drpShift(s, days) { return drpFromIndex(drpIndex(s) + days); }
function drpToday() { const n = new Date(); return drpYmd(n.getFullYear(), n.getMonth() + 1, n.getDate()); }

function drpAddMonths({ y, m }, n) {
  const total = y * 12 + (m - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}

const DRP_MONTHS = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"];

function drpFormat(s, withYear = true) {
  const p = drpParse(s);
  if (!p) return s;
  const month = DRP_MONTHS[p.m - 1].slice(0, 3);
  return withYear ? `${month} ${p.d}, ${p.y}` : `${month} ${p.d}`;
}

/* ── Component ── */

function createDateRangePicker({ root, onChange, compact = false, live = false, loadDates = null } = {}) {
  /* Committed state — what the caller sees. */
  let from = null, to = null, presetKey = null;
  /* Draft state — what the open panel is editing. */
  let dFrom = null, dTo = null, dPreset = null;
  /* Two-click range building: the next calendar click extends rather than restarts. */
  let awaitingEnd = false;
  let leftMonth = null;      // {y, m} of the left calendar
  let cursor = null;         // keyboard cursor date within the calendars
  let open = false;

  /* Volume data, loaded once. */
  let days = [];             // [{date, count}] ascending
  let cum = [];              // cum[i] = photos in days[0..i-1]
  let buckets = [];          // histogram bars: [{start, end, count, days, y}]
  let axisStart = 0;         // day index the histogram's left edge sits on
  let axisDays = 0;          // days the histogram spans (its full width)
  let presets = [];
  let loaded = false, loadError = false;

  const uid = Math.random().toString(36).slice(2, 8);

  /* The trigger and the clear button are siblings inside .drp-control rather
     than nested — a button inside a button is invalid and browsers drop it. */
  root.classList.add("drp");
  if (compact) root.classList.add("drp-compact");
  root.innerHTML = `
    <div class="drp-control">
      <button type="button" class="drp-trigger" aria-expanded="false" aria-haspopup="dialog">
        <span aria-hidden="true">📅</span>
        <span class="drp-value placeholder">Any date</span>
      </button>
      <button type="button" class="drp-clear" title="Clear date range" aria-label="Clear date range" hidden>×</button>
      <span class="drp-caret" aria-hidden="true">▾</span>
    </div>
    <div class="drp-panel" role="dialog" aria-label="Choose a date range" hidden></div>`;

  const control = root.querySelector(".drp-control");
  const trigger = root.querySelector(".drp-trigger");
  const valueEl = root.querySelector(".drp-value");
  const clearBtn = root.querySelector(".drp-clear");
  const panel = root.querySelector(".drp-panel");

  /* ── Volume data ── */

  async function load() {
    try {
      const rows = loadDates ? await loadDates() : await fetchLibraryDates();
      ingest(rows);
      loaded = true;
    } catch (e) {
      loadError = true;
    }
    if (open) renderPanel();
  }

  async function fetchLibraryDates() {
    const res = await fetch("/api/stats/dates");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).dates || [];
  }

  function ingest(rows) {
    days = (rows || []).filter(d => drpParse(d.date)).sort((a, b) => a.date < b.date ? -1 : 1);
    cum = new Array(days.length + 1).fill(0);
    days.forEach((d, i) => { cum[i + 1] = cum[i] + d.count; });
    buildBuckets();
    buildPresets();
  }

  /* Histogram buckets, plus the day-linear axis they are drawn on.
     A short scope (a loaded month or two) gets one bar per day — a single
     month-wide bar says nothing. A long one gets one bar per month, so a
     20-year library doesn't try to draw 7,000 bars into 400px. Gaps are kept
     as zero bars either way, so the axis stays linear in time rather than in
     "periods that happen to have photos". */
  function buildBuckets() {
    buckets = []; axisStart = 0; axisDays = 0;
    if (!days.length) return;
    const first = drpParse(days[0].date), last = drpParse(days[days.length - 1].date);
    const spanMonths = (last.y * 12 + last.m) - (first.y * 12 + first.m) + 1;
    const counts = new Map(days.map(d => [d.date, d.count]));

    if (spanMonths <= 3) {
      axisStart = drpIndex(days[0].date);
      axisDays = drpIndex(days[days.length - 1].date) - axisStart + 1;
      for (let i = 0; i < axisDays; i++) {
        const date = drpFromIndex(axisStart + i);
        buckets.push({ start: date, end: date, count: counts.get(date) || 0, days: 1, y: Number(date.slice(0, 4)) });
      }
      return;
    }

    /* Month mode: the axis spans whole months so every bar is exactly as wide
       as its month, rather than the first and last being clipped. */
    axisStart = drpIndex(drpYmd(first.y, first.m, 1));
    let m = { y: first.y, m: first.m };
    for (;;) {
      const dim = drpDaysInMonth(m.y, m.m);
      const start = drpYmd(m.y, m.m, 1), end = drpYmd(m.y, m.m, dim);
      let count = 0;
      for (let d = 1; d <= dim; d++) count += counts.get(drpYmd(m.y, m.m, d)) || 0;
      buckets.push({ start, end, count, days: dim, y: m.y });
      axisDays += dim;
      if (m.y === last.y && m.m === last.m) break;
      m = drpAddMonths(m, 1);
      if (buckets.length > 4000) break;   // guard against a corrupt timestamp
    }
  }

  /* Calendar months the loaded data spans, however the histogram buckets it. */
  function spanMonths() {
    if (!days.length) return 0;
    const first = drpParse(days[0].date), last = drpParse(days[days.length - 1].date);
    return (last.y * 12 + last.m) - (first.y * 12 + first.m) + 1;
  }

  /* Presets that would match nothing are dropped rather than shown at zero — on
     a working set of one month, "Last 30 days" and "This year" are usually
     empty, and an always-dead button is worse than a shorter rail. */
  function buildPresets() {
    const today = drpToday();
    const thisYear = Number(today.slice(0, 4));
    const relative = [
      { key: "30d", label: "Last 30 days", from: drpShift(today, -29), to: today },
      { key: "12m", label: "Last 12 months", from: drpShift(today, -364), to: today },
      { key: "year", label: "This year", from: drpYmd(thisYear, 1, 1), to: today },
    ].filter(p => rangeTotal(p.from, p.to) > 0);

    const years = [...new Set(days.map(d => Number(d.date.slice(0, 4))))].sort((a, b) => b - a);
    const yearPresets = years.slice(0, 3).map(y => (
      { key: `y${y}`, label: String(y), from: drpYmd(y, 1, 1), to: drpYmd(y, 12, 31) }
    ));

    presets = [{ key: "any", label: "Any date", from: null, to: null }, ...relative];
    /* A single year is the whole set — the same thing "Any date" already says. */
    if (yearPresets.length > 1) presets.push({ key: "sep" }, ...yearPresets);
  }

  /* Photos in [lo, hi] — binary search over the ascending day list. */
  function rangeTotal(lo, hi) {
    if (!days.length) return 0;
    const start = lowerBound(lo || days[0].date);
    const end = hi ? upperBound(hi) : days.length;
    return cum[end] - cum[start];
  }

  function lowerBound(date) {
    let a = 0, b = days.length;
    while (a < b) { const mid = (a + b) >> 1; if (days[mid].date < date) a = mid + 1; else b = mid; }
    return a;
  }

  function upperBound(date) {
    let a = 0, b = days.length;
    while (a < b) { const mid = (a + b) >> 1; if (days[mid].date <= date) a = mid + 1; else b = mid; }
    return a;
  }

  function dayCount(date) {
    const i = lowerBound(date);
    return i < days.length && days[i].date === date ? days[i].count : 0;
  }

  /* ── Trigger ── */

  function label() {
    if (presetKey) {
      const preset = presets.find(p => p.key === presetKey);
      if (preset) return preset.label;
    }
    if (from && to) {
      const sameYear = from.slice(0, 4) === to.slice(0, 4);
      return sameYear ? `${drpFormat(from, false)} – ${drpFormat(to)}` : `${drpFormat(from)} – ${drpFormat(to)}`;
    }
    if (from) return `From ${drpFormat(from)}`;
    if (to) return `Until ${drpFormat(to)}`;
    return null;
  }

  function renderTrigger() {
    const text = label();
    valueEl.textContent = text || "Any date";
    valueEl.classList.toggle("placeholder", !text);
    clearBtn.hidden = !text;
  }

  /* ── Panel ── */

  function renderPanel() {
    if (!loaded && !loadError) { panel.innerHTML = `<div class="drp-main">Loading photo dates…</div>`; return; }

    panel.innerHTML = `
      ${presets.length > 1 ? '<div class="drp-presets"></div>' : ""}
      <div class="drp-main">
        <div class="drp-fields">
          <div class="drp-field" data-field="from">
            <label for="drp-from-${uid}">From</label>
            <input type="text" id="drp-from-${uid}" placeholder="YYYY-MM-DD" inputmode="numeric" autocomplete="off">
          </div>
          <span class="drp-dash">–</span>
          <div class="drp-field" data-field="to">
            <label for="drp-to-${uid}">To</label>
            <input type="text" id="drp-to-${uid}" placeholder="YYYY-MM-DD" inputmode="numeric" autocomplete="off">
          </div>
          <span class="drp-hint"></span>
        </div>
        <div class="drp-hist" role="group" aria-label="Photo volume by month; drag the handles to set the range"></div>
        <div class="drp-cals"></div>
        <div class="drp-foot">
          <span class="drp-count"></span>
          <div class="drp-foot-btns">
            <button type="button" class="drp-reset">↩ Reset</button>
            <button type="button" class="drp-apply primary">${live ? "Done" : "Apply"}</button>
          </div>
        </div>
      </div>`;

    panel.querySelector(".drp-presets")?.addEventListener("click", onPresetClick);
    const fromInput = panel.querySelector(`#drp-from-${uid}`);
    const toInput = panel.querySelector(`#drp-to-${uid}`);
    for (const input of [fromInput, toInput]) {
      input.addEventListener("input", onFieldInput);
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    }
    panel.querySelector(".drp-cals").addEventListener("click", onCalendarClick);
    panel.querySelector(".drp-cals").addEventListener("keydown", onCalendarKey);
    panel.querySelector(".drp-reset").addEventListener("click", () => {
      dFrom = dTo = null; dPreset = "any"; awaitingEnd = false; syncPanel(); afterEdit();
    });
    panel.querySelector(".drp-apply").addEventListener("click", apply);
    bindScrubber();
    syncPanel();
  }

  /* Re-render everything that depends on the draft range. */
  function syncPanel() {
    if (!panel.querySelector(".drp-main")) return;
    renderPresets();
    renderFields();
    renderHist();
    renderCalendars();
    renderFoot();
  }

  function renderPresets() {
    /* A scope with nothing but "Any date" gets no rail — Reset already does
       that job, and an almost-empty 148px column just unbalances the panel. */
    const rail = panel.querySelector(".drp-presets");
    if (!rail) return;
    rail.innerHTML = presets.map(p => {
      if (p.key === "sep") return `<div class="drp-preset-sep"></div>`;
      const n = rangeTotal(p.from, p.to).toLocaleString();
      const active = dPreset === p.key ? " active" : "";
      return `<button type="button" class="drp-preset${active}" data-key="${p.key}">${p.label}<span class="n">${n}</span></button>`;
    }).join("") + (dPreset === "custom"
      ? `<div class="drp-preset-sep"></div><button type="button" class="drp-preset active" data-key="custom">Custom range</button>`
      : "");
  }

  function onPresetClick(e) {
    const btn = e.target.closest(".drp-preset");
    if (!btn || btn.dataset.key === "custom") return;
    const preset = presets.find(p => p.key === btn.dataset.key);
    if (!preset) return;
    dFrom = preset.from; dTo = preset.to; dPreset = preset.key; awaitingEnd = false;
    if (dFrom) leftMonth = { y: Number(dFrom.slice(0, 4)), m: Number(dFrom.slice(5, 7)) };
    cursor = dFrom;
    syncPanel();
    afterEdit();
  }

  /* ── Typed bounds ── */

  function renderFields() {
    const fromInput = panel.querySelector(`#drp-from-${uid}`);
    const toInput = panel.querySelector(`#drp-to-${uid}`);
    if (document.activeElement !== fromInput) fromInput.value = dFrom || "";
    if (document.activeElement !== toInput) toInput.value = dTo || "";
    validate();
  }

  /* Returns true when the draft is committable. Marks the offending field
     otherwise — an inverted range is never silently swapped, since which bound
     the user meant is a guess. */
  function validate() {
    const fromField = panel.querySelector('[data-field="from"]');
    const toField = panel.querySelector('[data-field="to"]');
    const hint = panel.querySelector(".drp-hint");
    const fromRaw = fromField.querySelector("input").value.trim();
    const toRaw = toField.querySelector("input").value.trim();
    const fromBad = fromRaw && !drpParse(fromRaw);
    const toBad = toRaw && !drpParse(toRaw);
    const inverted = !fromBad && !toBad && fromRaw && toRaw && fromRaw > toRaw;

    fromField.classList.toggle("invalid", !!fromBad);
    toField.classList.toggle("invalid", !!(toBad || inverted));
    hint.classList.toggle("error", !!(fromBad || toBad || inverted));

    if (fromBad || toBad) hint.textContent = "Use YYYY-MM-DD";
    else if (inverted) hint.textContent = "End is before start";
    else if (dFrom && dTo) {
      const n = drpIndex(dTo) - drpIndex(dFrom) + 1;
      hint.textContent = `${n.toLocaleString()} day${n === 1 ? "" : "s"}`;
    } else hint.textContent = "";

    const ok = !fromBad && !toBad && !inverted;
    panel.querySelector(".drp-apply").disabled = !ok;
    return ok;
  }

  function onFieldInput(e) {
    const which = e.target.closest(".drp-field").dataset.field;
    const parsed = drpParse(e.target.value);
    if (parsed || !e.target.value.trim()) {
      const value = parsed ? drpYmd(parsed.y, parsed.m, parsed.d) : null;
      if (which === "from") dFrom = value; else dTo = value;
      dPreset = matchPreset();
      awaitingEnd = false;
      if (parsed) { anchorOn(value, which); cursor = value; }
      renderPresets(); renderHist(); renderCalendars(); renderFoot();
    }
    validate();
    afterEdit();
  }

  /* Park a bound in view. An end date goes on the RIGHT calendar so the start
     usually stays visible on the left, rather than scrolling itself off. */
  function anchorOn(date, edge) {
    const p = drpParse(date);
    if (!p) return;
    leftMonth = edge === "to" ? drpAddMonths({ y: p.y, m: p.m }, -1) : { y: p.y, m: p.m };
  }

  function matchPreset() {
    const hit = presets.find(p => p.key !== "sep" && p.from === dFrom && p.to === dTo);
    return hit ? hit.key : (dFrom || dTo ? "custom" : "any");
  }

  /* ── Histogram scrubber ── */

  function renderHist() {
    const hist = panel.querySelector(".drp-hist");
    if (!buckets.length) {
      hist.innerHTML = `<div class="drp-count" style="padding:6px 2px">No dated photos in this view.</div>`;
      return;
    }
    /* Bars are flex-weighted by their day count, so the axis stays linear in
       time even when months of different lengths sit side by side. */
    const peak = Math.max(...buckets.map(b => b.count), 1);
    const bars = buckets.map(b => {
      const h = Math.max(b.count ? 4 : 0, Math.round((b.count / peak) * 100));
      return `<i class="${bucketInDraft(b) ? "in" : ""}" style="flex:${b.days} 0 0;height:${h}%"></i>`;
    }).join("");

    /* Handles are drawn even with no range set — parked at the full span — so
       the scrubber looks draggable before it has been touched. */
    const lo = dFrom ? posOf(dFrom) : 0;
    const hi = dTo ? posOf(drpShift(dTo, 1)) : 1;
    const band = `<div class="drp-band" style="left:${lo * 100}%;width:${Math.max(0, hi - lo) * 100}%"></div>
      <span class="drp-handle" data-edge="from" role="slider" tabindex="0" aria-label="Range start"
        aria-valuetext="${dFrom ? drpFormat(dFrom) : "the earliest photo"}" style="left:${lo * 100}%"></span>
      <span class="drp-handle" data-edge="to" role="slider" tabindex="0" aria-label="Range end"
        aria-valuetext="${dTo ? drpFormat(dTo) : "the latest photo"}" style="left:${hi * 100}%"></span>`;

    hist.innerHTML = `<div class="drp-track"><div class="drp-bars">${bars}</div>${band}</div>
                      <div class="drp-ticks">${axisTicks()}</div>`;
  }

  /* Move the band and handles without replacing any nodes. A drag re-renders on
     every pointermove, and rebuilding .drp-track would destroy the element
     holding the pointer capture — the drag would die after one move. */
  function updateHistInPlace() {
    const track = panel.querySelector(".drp-track");
    if (!track || !buckets.length) return;
    const lo = dFrom ? posOf(dFrom) : 0;
    const hi = dTo ? posOf(drpShift(dTo, 1)) : 1;
    const band = track.querySelector(".drp-band");
    if (band) {
      band.style.left = `${lo * 100}%`;
      band.style.width = `${Math.max(0, hi - lo) * 100}%`;
    }
    const fromHandle = track.querySelector('.drp-handle[data-edge="from"]');
    const toHandle = track.querySelector('.drp-handle[data-edge="to"]');
    if (fromHandle) {
      fromHandle.style.left = `${lo * 100}%`;
      fromHandle.setAttribute("aria-valuetext", dFrom ? drpFormat(dFrom) : "the earliest photo");
    }
    if (toHandle) {
      toHandle.style.left = `${hi * 100}%`;
      toHandle.setAttribute("aria-valuetext", dTo ? drpFormat(dTo) : "the latest photo");
    }
    const bars = track.querySelectorAll(".drp-bars i");
    buckets.forEach((b, i) => bars[i]?.classList.toggle("in", bucketInDraft(b)));
  }

  /* Axis labels: months when the scope is short enough to be bucketed by day,
     otherwise years. Either way only every Nth is labelled — a 20-year library
     packs 20 ticks into ~400px — and the unlabelled dividers carry the scale. */
  function axisTicks() {
    const byDay = buckets.length > 0 && buckets[0].days === 1;
    const spans = [];
    for (const b of buckets) {
      const key = byDay ? b.start.slice(0, 7) : String(b.y);
      const last = spans[spans.length - 1];
      if (last && last.key === key) last.n += b.days;
      else spans.push({ key, n: b.days, label: byDay ? DRP_MONTHS[Number(key.slice(5, 7)) - 1] : key });
    }
    const every = Math.max(1, Math.ceil(spans.length / 8));
    /* A label needs roughly a month of width to sit in without colliding. */
    const minDays = byDay ? 10 : 120;
    return spans.map((s, i) => {
      const show = i % every === 0 && s.n >= minDays;
      return `<span style="flex:${s.n} 0 0">${show ? s.label : ""}</span>`;
    }).join("");
  }

  function bucketInDraft(b) {
    return (!dFrom || dFrom <= b.end) && (!dTo || dTo >= b.start);
  }

  /* Date → 0..1 across the histogram, linear in days. */
  function posOf(date) {
    if (!axisDays) return 0;
    const idx = drpIndex(date);
    if (idx === null) return 0;
    return Math.max(0, Math.min(1, (idx - axisStart) / axisDays));
  }

  /* 0..1 → date, clamped to the histogram's own span. */
  function dateAt(pos) {
    if (!axisDays) return null;
    const offset = Math.round(Math.max(0, Math.min(1, pos)) * axisDays);
    return drpFromIndex(axisStart + Math.min(offset, axisDays - 1));
  }

  function bindScrubber() {
    const hist = panel.querySelector(".drp-hist");
    hist.addEventListener("pointerdown", e => {
      if (!buckets.length || !hist.querySelector(".drp-track")) return;
      const rect = hist.querySelector(".drp-track").getBoundingClientRect();
      const posAt = ev => (ev.clientX - rect.left) / rect.width;

      /* Grab the handle under the cursor, else the nearer of the two — so a
         bare click on the track moves the closest edge rather than resetting. */
      let edge = e.target.closest(".drp-handle")?.dataset.edge;
      if (!edge) {
        const pos = posAt(e);
        const loPos = dFrom ? posOf(dFrom) : 0;
        const hiPos = dTo ? posOf(drpShift(dTo, 1)) : 1;
        edge = Math.abs(pos - loPos) <= Math.abs(pos - hiPos) ? "from" : "to";
      }
      e.preventDefault();

      /* Dragging on a still-unset range has no band or handles to grab yet:
         seed it to the full span and rebuild the track BEFORE capturing the
         pointer, since renderHist() replaces the element we capture on. */
      if (!dFrom && !dTo) {
        dFrom = days[0]?.date || null;
        dTo = days[days.length - 1]?.date || null;
        renderHist();
      }
      const track = hist.querySelector(".drp-track");
      if (!track) return;
      /* Capture keeps the drag alive past the panel's edge, but it is only an
         improvement — move/up are bound to window, so a browser that refuses
         the capture still drags correctly. */
      try { track.setPointerCapture(e.pointerId); } catch { /* not fatal */ }

      const move = ev => {
        const date = dateAt(posAt(ev));
        if (!date) return;
        if (edge === "from") {
          dFrom = date;
          if (dTo && dFrom > dTo) dFrom = dTo;
        } else {
          dTo = date;
          if (dFrom && dTo < dFrom) dTo = dFrom;
        }
        dPreset = matchPreset();
        awaitingEnd = false;
        anchorOn(edge === "from" ? dFrom : dTo, edge);
        /* Everything outside .drp-hist is safe to rebuild mid-drag. */
        updateHistInPlace();
        renderPresets(); renderFields(); renderCalendars(); renderFoot();
        afterEdit();
      };
      move(e);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });

    /* Handles are real sliders: arrows nudge a day, PageUp/PageDown a month. */
    hist.addEventListener("keydown", e => {
      const handle = e.target.closest(".drp-handle");
      if (!handle) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -30, PageDown: 30 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      const edge = handle.dataset.edge;
      const base = edge === "from" ? (dFrom || days[0]?.date) : (dTo || days[days.length - 1]?.date);
      if (!base) return;
      const next = drpShift(base, step);
      if (edge === "from") dFrom = dTo && next > dTo ? dTo : next;
      else dTo = dFrom && next < dFrom ? dFrom : next;
      dPreset = matchPreset();
      anchorOn(edge === "from" ? dFrom : dTo, edge);
      syncPanel();
      afterEdit();
      panel.querySelector(`.drp-handle[data-edge="${edge}"]`)?.focus();
    });
  }

  /* ── Calendars ── */

  function renderCalendars() {
    if (!leftMonth) {
      /* A short scope (a loaded month or year) reads from its start; a long one
         — the whole library — opens on its most recent months instead, since
         its first month is usually decades of scrolling away from anything
         you want. */
      const scopeStart = spanMonths() <= 24 ? days[0]?.date : days[days.length - 1]?.date;
      const anchor = dFrom || dTo || scopeStart || drpToday();
      leftMonth = { y: Number(anchor.slice(0, 4)), m: Number(anchor.slice(5, 7)) };
    }
    const right = drpAddMonths(leftMonth, 1);
    panel.querySelector(".drp-cals").innerHTML =
      renderMonth(leftMonth, "left") + renderMonth(right, "right");
  }

  function renderMonth({ y, m }, side) {
    const today = drpToday();
    const dim = drpDaysInMonth(y, m);
    const lead = drpDow(y, m, 1);
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<button type="button" class="drp-day blank" tabindex="-1" aria-hidden="true"></button>`);
    for (let d = 1; d <= dim; d++) {
      const date = drpYmd(y, m, d);
      const count = dayCount(date);
      const cls = ["drp-day"];
      if (!count) cls.push("empty");
      if (dFrom && dTo && date > dFrom && date < dTo) cls.push("in-range");
      if (date === dFrom) cls.push("edge", "start");
      if (date === dTo) cls.push("edge", "end");
      if (date === today) cls.push("today");
      const focusable = date === (cursor || dFrom) ? "0" : "-1";
      const aria = count ? `${drpFormat(date)}, ${count} photo${count === 1 ? "" : "s"}` : `${drpFormat(date)}, no photos`;
      cells.push(`<button type="button" class="${cls.join(" ")}" data-date="${date}" tabindex="${focusable}"
        aria-label="${aria}">${d}${count ? '<span class="drp-dot"></span>' : ""}</button>`);
    }
    while (cells.length % 7) cells.push(`<button type="button" class="drp-day blank" tabindex="-1" aria-hidden="true"></button>`);

    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(`<div class="drp-week">${cells.slice(i, i + 7).join("")}</div>`);

    /* Only the outer arrow of each calendar moves; the pair always stays
       adjacent, so the inner arrow would be a no-op. */
    const prev = side === "left"
      ? `<button type="button" class="drp-nav" data-step="-1" aria-label="Previous month">‹</button>`
      : `<button type="button" class="drp-nav" disabled aria-label="Previous month">‹</button>`;
    const next = side === "right"
      ? `<button type="button" class="drp-nav" data-step="1" aria-label="Next month">›</button>`
      : `<button type="button" class="drp-nav" disabled aria-label="Next month">›</button>`;

    return `<div class="drp-cal">
      <div class="drp-cal-head">${prev}<span class="drp-cal-title">${DRP_MONTHS[m - 1]} ${y}</span>${next}</div>
      <div class="drp-dow"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      ${weeks.join("")}
    </div>`;
  }

  function onCalendarClick(e) {
    const nav = e.target.closest(".drp-nav");
    if (nav && !nav.disabled) {
      leftMonth = drpAddMonths(leftMonth, Number(nav.dataset.step));
      renderCalendars();
      return;
    }
    const day = e.target.closest(".drp-day");
    if (!day || !day.dataset.date) return;
    pickDate(day.dataset.date);
  }

  /* Two-click range building: the first click restarts the range, the second
     closes it on whichever side the click falls. */
  function pickDate(date) {
    if (!awaitingEnd || !dFrom) {
      dFrom = date; dTo = null; awaitingEnd = true;
    } else {
      if (date < dFrom) { dTo = dFrom; dFrom = date; } else { dTo = date; }
      awaitingEnd = false;
    }
    cursor = date;
    dPreset = matchPreset();
    syncPanel();
    afterEdit();
    panel.querySelector(`.drp-day[data-date="${date}"]`)?.focus();
  }

  function onCalendarKey(e) {
    const day = e.target.closest(".drp-day");
    if (!day || !day.dataset.date) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      moveCursor(drpShift(day.dataset.date, step));
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const p = drpParse(day.dataset.date);
      const m = drpAddMonths({ y: p.y, m: p.m }, e.key === "PageUp" ? -1 : 1);
      moveCursor(drpYmd(m.y, m.m, Math.min(p.d, drpDaysInMonth(m.y, m.m))));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickDate(day.dataset.date);
    }
  }

  /* Scroll the twin calendars to keep the cursor visible, then focus it. */
  function moveCursor(date) {
    cursor = date;
    const p = drpParse(date);
    const rightMonth = drpAddMonths(leftMonth, 1);
    const cursorIdx = p.y * 12 + p.m - 1;
    const leftIdx = leftMonth.y * 12 + leftMonth.m - 1;
    if (cursorIdx < leftIdx) leftMonth = { y: p.y, m: p.m };
    else if (cursorIdx > rightMonth.y * 12 + rightMonth.m - 1) leftMonth = drpAddMonths({ y: p.y, m: p.m }, -1);
    renderCalendars();
    panel.querySelector(`.drp-day[data-date="${date}"]`)?.focus();
  }

  /* ── Footer ── */

  function renderFoot() {
    const total = rangeTotal(dFrom, dTo);
    const all = rangeTotal(null, null);
    const count = panel.querySelector(".drp-count");
    /* Deliberately does not name the scope — the same control describes the
       whole library on Search and a single loaded month on Geocode. */
    if (loadError) count.textContent = "Photo counts unavailable.";
    else if (!dFrom && !dTo) count.innerHTML = `<b>${all.toLocaleString()}</b> dated photo${all === 1 ? "" : "s"}`;
    else count.innerHTML = `<b>${total.toLocaleString()}</b> photo${total === 1 ? "" : "s"} in range`;
  }

  /* ── Open / close / commit ── */

  function openPanel() {
    if (open) return;
    open = true;
    dFrom = from; dTo = to; dPreset = presetKey || matchPreset();
    awaitingEnd = false;
    cursor = dFrom;
    leftMonth = dFrom ? { y: Number(dFrom.slice(0, 4)), m: Number(dFrom.slice(5, 7)) } : null;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    renderPanel();
    /* Flip to the trigger's right edge when the panel would run off-screen. */
    panel.classList.remove("align-right");
    if (panel.getBoundingClientRect().right > window.innerWidth - 8) panel.classList.add("align-right");
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onDocKey, true);
  }

  function closePanel({ focusTrigger = true } = {}) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onDocKey, true);
    if (focusTrigger) trigger.focus();
  }

  function commit() {
    from = dFrom; to = dTo;
    presetKey = dPreset && dPreset !== "custom" && dPreset !== "any" ? dPreset : null;
    renderTrigger();
    onChange?.({ from, to });
  }

  /* Called after every draft edit. In live mode that edit *is* the commit; in
     draft mode it only refreshes what the panel shows. */
  function afterEdit() {
    if (live && validate()) commit();
  }

  /* Footer button: "Apply" commits and closes; in live mode it is "Done" and
     only closes, since the range already took effect. */
  function apply() {
    if (!live) {
      if (!validate()) return;
      commit();
    }
    closePanel();
  }

  function onDocPointer(e) { if (!root.contains(e.target)) closePanel({ focusTrigger: false }); }

  function onDocKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); closePanel(); }
  }

  /* Clicks anywhere in the field open the panel — including the caret, which is
     inert so it never steals the click from the trigger. */
  control.addEventListener("click", e => {
    if (trigger.disabled || e.target.closest(".drp-clear")) return;
    open ? closePanel() : openPanel();
  });

  clearBtn.addEventListener("click", () => {
    from = to = presetKey = null;
    renderTrigger();
    closePanel({ focusTrigger: false });
    onChange?.({ from, to });
  });

  renderTrigger();
  load();

  return {
    getRange: () => ({ from, to }),
    setRange(nextFrom, nextTo) {
      from = nextFrom || null; to = nextTo || null;
      presetKey = null;
      renderTrigger();
    },
    clear() { from = to = presetKey = null; renderTrigger(); },
    reload: load,
    /* Swap in a new working set (a different month, place, or search result).
       The old range described the old set, so it is dropped rather than carried
       over; the caller resets its own filter state to match. */
    setDates(rows) {
      ingest(rows);
      loaded = true; loadError = false;
      from = to = presetKey = null;
      dFrom = dTo = null; dPreset = "any"; awaitingEnd = false;
      leftMonth = null; cursor = null;
      renderTrigger();
      if (open) renderPanel();
    },
    /* True when there is anything to pick from — callers disable their control
       when the loaded set has no dated photos. */
    hasDates: () => days.length > 0,
    setEnabled(on, title) {
      trigger.disabled = !on;
      root.classList.toggle("drp-disabled", !on);
      control.title = title || "";
      if (!on) closePanel({ focusTrigger: false });
    },
  };
}
