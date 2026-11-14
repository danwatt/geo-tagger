/* Shared helpers loaded by every page before its own scripts.
 *
 * escapeHtml is the single defence against XSS from data we didn't author:
 * camera strings and filenames come from EXIF / the filesystem, place and
 * person names from the user's data and OSM extracts. Anything interpolated
 * into an innerHTML template, an HTML attribute value, or a Leaflet
 * tooltip/popup string (Leaflet treats those as HTML) must go through it.
 * Prefer textContent when no markup is needed.
 */

/** Escape text for use in HTML element content AND quoted attribute values. */
function escapeHtml(value) {
  // Quotes matter: the result is often placed inside title="…" / data-x="…".
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Full month names, index 0 = January. */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

/* ── Wall-clock timestamps ──
 * photo_datetime — and every value derived from it (a group's last_ts, a
 * histogram bucket's ts, a date-picker day turned into a bound) — is the
 * camera's wall clock stored *as if* it were UTC (see timeutil.py). It is not an
 * instant: reading it with the local-zone Date API (getFullYear, getMonth,
 * toLocaleString without a timeZone, new Date(y, m, d)) shifts it by the
 * viewer's UTC offset, so west of UTC a photo taken 1 Jan 00:30 lands under the
 * previous December. Everything here goes through getUTC* / Date.UTC /
 * timeZone "UTC", which hands back exactly what the camera wrote, and matches
 * the backend (strftime(..., 'unixepoch'), calendar.timegm date filters).
 * Genuine instants (Date.now(), assigned_at, job times) are NOT wall-clock
 * values and keep the local-zone API.
 * Month numbers: `month` in wallClockParts is 0-based (like MONTH_NAMES and
 * getUTCMonth); wallClockTs / daysInMonth take a 1-based month (like the API's
 * year/month params). */

/** {year, month (0-11), day, hour, minute, second, weekday} of a wall-clock
 *  epoch, or null when undated (null/0; negative = pre-1970, a real date). */
function wallClockParts(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** Wall-clock epoch (seconds) for a calendar date/time; month is 1-based. */
function wallClockTs(year, month, day = 1, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/** "YYYY-MM-DD" day key of a wall-clock epoch (the API's date_from/date_to form). */
function wallClockDay(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Wall-clock epoch of a "YYYY-MM-DD" day's midnight. Parsed with an explicit
 *  Z: a date-only string parses as UTC but "YYYY-MM-DDT00:00" as *local*, so
 *  never hand a date-picker value straight to new Date(). */
function parseWallClockDay(s) {
  return Date.parse(`${s}T00:00:00Z`) / 1000;
}

/** Days in a month (1-based month). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Locale formatting of a wall-clock epoch; `opts` are Intl options (timeZone
 *  is forced to UTC). Date+time, date only, time only. */
function formatWallClock(ts, opts = {}) {
  return new Date(ts * 1000).toLocaleString(undefined, { ...opts, timeZone: "UTC" });
}
function formatWallClockDate(ts, opts = {}) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}
function formatWallClockTime(ts, opts = {}) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { ...opts, timeZone: "UTC" });
}

/** localStorage key for the work-queue batches skipped on the Geocode page
 *  (written by app.js, counted/cleared by home.js). */
const SKIPPED_BATCHES_KEY = "geotagger.workqueue.skipped";

/* ── JSON fetch helpers ──
 * FastAPI reports errors as {"detail": …}: a string for our own HTTPExceptions,
 * a list for 422 validation errors, and occasionally {message, …} (e.g. the
 * semantic scan's 503). httpErrorMessage turns any failed response into one
 * line for a status bar; fetchJson / postJson are the "check res.ok, then
 * parse" pair so callers can't forget the check (a 4xx body parsed as data is
 * how state ends up undefined). */
async function httpErrorMessage(res) {
  return httpErrorText(await res.json().catch(() => null), res.status);
}

/** The one-line message for an already-parsed error body (null when it wasn't
 *  JSON) — for callers that also need the body itself (e.g. a 409's detail). */
function httpErrorText(body, status) {
  const d = body?.detail;
  if (typeof d === "string" && d) return d;
  if (d && typeof d === "object" && !Array.isArray(d) && typeof d.message === "string") return d.message;
  if (Array.isArray(d) && d.length && typeof d[0]?.msg === "string") {
    // A 422 validation list: the first problem, with where it was ("body → name").
    const loc = Array.isArray(d[0].loc) ? d[0].loc.filter(x => x !== "body").join(" → ") : "";
    return `${loc ? loc + ": " : ""}${d[0].msg}`;
  }
  return `HTTP ${status}`;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await httpErrorMessage(res));
  return res.json();
}

function postJson(url, body, opts = {}) {
  return fetchJson(url, {
    ...opts,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: JSON.stringify(body),
  });
}

/* ── Latest-only loaders ──
 * A loader triggered by navigation (pick a month, press j, click Next) can be
 * called again before its previous fetch returns, and responses don't come back
 * in order — so without a guard, the slower, older one lands last and paints its
 * data over the newer view. latestOnly(loader) returns a wrapper where:
 *   - each call gets a fresh AbortController and aborts the previous call's, so
 *     the superseded request is cancelled in flight (pass `signal` to fetch);
 *   - `signal.aborted` doubles as the "am I still the latest call?" token. A
 *     fetch that already resolved isn't un-resolved by abort(), so the loader
 *     must check `if (signal.aborted) return;` after every await, before it
 *     touches shared state or the DOM, and in its catch (an aborted fetch
 *     rejects with AbortError, which is not a user-facing failure);
 *   - a superseded call resolves to LATEST_ONLY_STALE instead of the loader's
 *     return value, and its errors are swallowed;
 *   - wrapper.cancel() aborts the in-flight call without starting a new one
 *     (e.g. the view it would fill was closed).
 * Usage:
 *   const loadThing = latestOnly(async (signal, id) => {
 *     const res = await fetch(`/api/thing/${id}`, { signal });
 *     if (!res.ok) throw new Error(`HTTP ${res.status}`);
 *     const data = await res.json();
 *     if (signal.aborted) return;
 *     render(data);
 *   });
 * Calls that share one piece of state (several loaders all filling the same
 * grid) must share one wrapper, or they won't supersede each other. */
const LATEST_ONLY_STALE = Symbol("latestOnly.stale");

function latestOnly(loader) {
  let controller = null;
  const run = async (...args) => {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const result = await loader(mine.signal, ...args);
      return mine.signal.aborted ? LATEST_ONLY_STALE : result;
    } catch (err) {
      if (mine.signal.aborted) return LATEST_ONLY_STALE;
      throw err;
    } finally {
      if (controller === mine) controller = null;
    }
  };
  run.cancel = () => {
    controller?.abort();
    controller = null;
  };
  return run;
}

/* ── Keyboard shortcut guard ──
 * Every document-level shortcut handler calls isTypingTarget(e) FIRST, before it
 * looks at any key (including "?"): a keystroke typed into a field, or into a
 * modal dialog stacked over the page, belongs to that field/dialog, not to the
 * page behind it. "Typing" means a text-like field (any <input>, <textarea>,
 * <select>, contenteditable), an IME composition in progress, or any target
 * inside an open modal (.modal, <dialog>, role="dialog").
 * Handlers that deliberately act everywhere (Escape to close the innermost
 * layer, Shift tracking) don't use it. anyModalOpen() covers the other case:
 * focus is on the page but a modal is showing, so page shortcuts stay off. */
function isTypingTarget(e) {
  if (e.isComposing) return true;
  const t = e.target;
  if (!(t instanceof Element)) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return !!t.closest('.modal, dialog[open], [role="dialog"]');
}

/** True when any page modal (.modal with an inline display other than none) is up. */
function anyModalOpen() {
  return [...document.querySelectorAll(".modal")].some(m => m.style.display !== "none");
}

/* ── Per-viewer view preferences ──
 * Small remembered UI choices (a Show toggle, a "hide completed" checkbox) in
 * this browser's localStorage. Never fatal: blocked or full storage, or a
 * stored value that fails `valid`, just yields `fallback`. Keys are versioned
 * by the caller ("geotagger.<page>.<thing>.v1") so a change of shape bumps the
 * key instead of misreading old data. */
function loadViewPref(key, fallback, valid = () => true) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveViewPref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* not remembered */ }
}

/** Reduce an untrusted URL (query param, stored value) to a same-origin
 *  path+query+hash, or return `fallback`. Guards `location.href = <param>`
 *  against javascript:/data: URLs and off-site redirects: anything that does
 *  not resolve to this origin over http(s) is rejected. Parsing against
 *  location.origin also normalises `//evil.com` and `/\evil.com` (browsers
 *  treat `\` as `/`), so those resolve off-origin and fail the check. */
function safeSameOriginPath(raw, fallback) {
  if (!raw) return fallback;
  try {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return fallback;
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.pathname + url.search + url.hash;
  } catch (_) {
    return fallback;
  }
}

/* ── Large-array min/max ──
 * Math.min(...arr) passes every element as a call argument, and engines cap the
 * argument count (V8 throws RangeError somewhere past ~100k), so a library-sized
 * timestamp list breaks it. A plain loop has no such limit. Empty input gives
 * [Infinity, -Infinity], the same as the spread form. */
function minMaxOf(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Smallest value of `values` (Infinity when empty). */
function minOf(values) {
  return minMaxOf(values)[0];
}

/* ── Batch-loop stall guard ──
 * The client batch loops (POST a batch, read `remaining`, repeat until 0) trust
 * the server to make progress. It usually does, but not always: a photo whose
 * lookup throws stays queued and is picked again next batch, so a batch made
 * entirely of such rows leaves `remaining` unchanged and the loop would spin
 * forever. stallGuard(label) returns check(remaining), called once per batch;
 * it throws after `maxStalls` consecutive batches that didn't lower `remaining`
 * against the previous one. Compared to the previous batch rather than the
 * best seen, so a count that jumps up (a scan added photos meanwhile) and then
 * drains again isn't mistaken for a stall. */
function stallGuard(label, maxStalls = 3) {
  let prev = Infinity, stalls = 0;
  return (remaining) => {
    if (remaining < prev) stalls = 0;
    else if (++stalls >= maxStalls) {
      throw new Error(`${label} stopped: ${maxStalls} batches in a row made no progress ` +
                      `(${Number(remaining).toLocaleString()} still left). Check the server log.`);
    }
    prev = remaining;
  };
}

/* ── Staged work that survives a reload (U7) ──
 * The People, Geocode and Time Sync pages stage edits in memory until Commit /
 * Save, so a crash, an accidental reload or a closed tab used to lose a whole
 * tagging pass. Each page now mirrors its staged set into sessionStorage on
 * every change and offers it back on the next load.
 *
 * Why sessionStorage, not localStorage: it is per tab, so two People tabs never
 * overwrite each other's staging area, yet it survives a reload, a tab or
 * window reopened with Ctrl+Shift+T, and the browser's restore-after-crash —
 * the losses the audit traced. What it can't survive is opening the app fresh
 * in a new tab after the old one is gone; the beforeunload prompt on each page
 * still covers that.
 *
 * What is stored: ids plus the intended values (and a small `was` snapshot of
 * the server state at staging time, to spot items changed elsewhere since) —
 * never DOM or whole server objects. On load the page re-fetches the current
 * state of those ids and drops anything deleted or already applied, so a
 * restore never commits by itself and never resurrects stale objects.
 *
 * The schema version is in the key (and the value): bumping it orphans old
 * records rather than misreading them, and load() sweeps other versions of the
 * same page's key. Every storage call is wrapped — private mode, blocked site
 * data or a full quota just means the backup is skipped (save() returns false;
 * StagedMap reports that once), never that staging stops working. */
const STAGED_WORK_PREFIX = "geotagger.staged.";

function stagedWorkStore(page, version) {
  const key = `${STAGED_WORK_PREFIX}${page}.v${version}`;
  return {
    key,
    /** The saved records (array of plain objects with an integer `id`), or []. */
    load() {
      try {
        // Sweep records an older (or newer) build of this page wrote.
        const stem = `${STAGED_WORK_PREFIX}${page}.v`;
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(stem) && k !== key) sessionStorage.removeItem(k);
        }
        const raw = sessionStorage.getItem(key);
        if (!raw) return [];
        const data = JSON.parse(raw);
        if (!data || data.v !== version || !Array.isArray(data.entries)) return [];
        return data.entries.filter(r => r && Number.isInteger(r.id));
      } catch (_) {
        return [];
      }
    },
    /** Replace the saved set; an empty list removes the key. False on failure. */
    save(records) {
      try {
        if (!records.length) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify({ v: version, savedAt: Date.now(), entries: records }));
        return true;
      } catch (_) {
        return false;
      }
    },
    clear() {
      try { sessionStorage.removeItem(key); } catch (_) { /* storage blocked */ }
    },
  };
}

/* A Map of staged entries (id → entry) that mirrors itself into a
 * stagedWorkStore. Every set/delete/clear schedules one write on a microtask, so
 * a bulk stage of thousands of ids costs a single serialisation, and it still
 * lands before any unload (microtasks drain before the next task). Pages keep
 * using it exactly like the plain Map they had — every existing call site
 * (stage, revert, commit's per-id delete on success) is covered without
 * touching it, which is what makes "only the written ids leave the backup" hold.
 *
 * `toRecord(entry)` turns an entry into its stored record ({id, …}).
 * holdCarry(records) parks records read back at startup that are still being
 * validated: they're written along with the live entries until dropCarry(), so
 * staging something during the restore fetch can't overwrite them.
 * onSaveError() runs once, the first time a write fails; onChange() after every
 * flush (the restore banner uses it to follow its count down). */
class StagedMap extends Map {
  constructor(store, toRecord) {
    super();
    this.store = store;
    this.toRecord = toRecord;
    this.carry = [];
    this.flushQueued = false;
    this.saveFailed = false;
    this.onSaveError = null;
    this.onChange = null;
  }
  set(key, value) { super.set(key, value); this.queueFlush(); return this; }
  delete(key) {
    const had = super.delete(key);
    if (had) this.queueFlush();
    return had;
  }
  clear() {
    const had = this.size > 0;
    super.clear();
    if (had) this.queueFlush();
  }
  queueFlush() {
    if (this.flushQueued || !this.store) return;
    this.flushQueued = true;
    queueMicrotask(() => { this.flushQueued = false; this.flush(); });
  }
  flush() {
    let records;
    try {
      records = [...this.values()].map(this.toRecord);
    } catch (err) {
      console.warn("Staged work: could not serialise an entry", err);
      return;
    }
    const live = new Set(records.map(r => r.id));
    this.carry.forEach(r => { if (!live.has(r.id)) records.push(r); });
    if (!this.store.save(records) && !this.saveFailed) {
      this.saveFailed = true;
      this.onSaveError?.();
    }
    this.onChange?.();
  }
  holdCarry(records) { this.carry = records.slice(); }
  dropCarry() { this.carry = []; this.queueFlush(); }
}

const STAGED_SAVE_FAILED_MSG =
  "Couldn't back up the staged changes in this tab (browser storage is full or blocked). " +
  "They're still staged, but a reload or crash before you commit will lose them.";

/* The non-blocking "uncommitted changes from your last visit" bar: a fixed card
 * under the nav, so it doesn't reflow the page's workspace panes. Each handler
 * may return (a promise of) false to keep the banner up — e.g. Commit when the
 * confirm() was cancelled or some items failed. `remaining()` is how many of
 * the restored items are still staged; refresh() re-reads it, updating the
 * count and removing the bar once it reaches 0. Returns { hide, refresh }. */
function showStagedRestoreBanner({ remaining, detail = "", noun = "change",
                                   onReview, onCommit, onDiscard }) {
  document.getElementById("staged-restore-banner")?.remove();
  const bar = document.createElement("div");
  bar.id = "staged-restore-banner";
  bar.className = "staged-restore-banner";
  bar.setAttribute("role", "status");
  bar.innerHTML = `
    <div class="srb-text">
      <b class="srb-count"></b>
      ${detail ? `<span class="srb-detail">${escapeHtml(detail)}</span>` : ""}
    </div>
    <div class="srb-btns">
      <button type="button" data-act="review" title="Show the restored changes. Nothing is saved until you commit">Review</button>
      <button type="button" data-act="commit" class="primary" title="Write the restored changes now (asks to confirm)">Commit</button>
      <button type="button" data-act="discard" class="danger" title="Throw the restored changes away">Discard</button>
      <button type="button" data-act="close" class="srb-close" title="Hide this banner. The changes stay staged">✕</button>
    </div>`;
  let busy = false;
  const api = {
    hide() { bar.remove(); },
    refresh() {
      if (!bar.isConnected) return;
      const n = remaining();
      if (!n) { bar.remove(); return; }
      bar.querySelector(".srb-count").textContent =
        `You have ${n.toLocaleString()} uncommitted ${noun}${n !== 1 ? "s" : ""} from your last visit.`;
    },
  };
  const handlers = { review: onReview, commit: onCommit, discard: onDiscard, close: () => true };
  bar.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || busy) return;
    busy = true;
    bar.querySelectorAll("button").forEach(b => { b.disabled = true; });
    try {
      const keep = (await handlers[btn.dataset.act]?.()) === false;
      if (keep) api.refresh();
      else api.hide();
    } finally {
      busy = false;
      bar.querySelectorAll("button").forEach(b => { b.disabled = false; });
    }
  });
  document.body.appendChild(bar);
  api.refresh();
  return api;
}

/* GET /api/photos?ids=… in URL-sized chunks (a restored staging area can hold
 * thousands of ids). Resolves to the photo dicts found; ids that no longer
 * exist are simply absent. */
async function fetchPhotosByIds(ids, chunk = 400) {
  const out = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    out.push(...await fetchJson(`/api/photos?ids=${part.join(",")}`));
  }
  return out;
}

/* ── Undo toast (U3) ──
 * One-click destructive actions (unassign a face, ignore a group, delete a
 * person, …) act at once and then offer this toast instead of a confirm():
 * showUndoToast(message, undoFn, {timeoutMs}). undoFn is async and returns the
 * outcome to show — a string, or {message, isError} — so a partial or refused
 * undo says so rather than reading as success.
 *
 * Persistent enough to reach: 9 s by default, and the countdown pauses while
 * the pointer is over the toast or focus is inside it. Keyboard: Tab reaches the
 * Undo button like any other, and Ctrl/Cmd+Z triggers it from anywhere on the
 * page except a text field or an open modal (isTypingTarget / anyModalOpen) —
 * there it belongs to the field's own undo.
 *
 * One at a time: a new action's toast replaces the previous one, and the
 * previous action simply stays applied (no hidden stack — what you can undo is
 * always exactly what the toast on screen says). Escape or ✕ dismisses it the
 * same way the timeout does: the action stands. */
let _undoToast = null;   // { el, undoFn, remaining, startedAt, timer, busy, done }

function _undoToastEl() {
  let el = document.getElementById("undo-toast");
  if (el) return el;
  el = document.createElement("div");
  el.id = "undo-toast";
  el.className = "undo-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  el.innerHTML = `<span class="ut-msg"></span>
    <button type="button" class="ut-undo" title="Undo (Ctrl+Z)">Undo</button>
    <button type="button" class="ut-close" aria-label="Dismiss" title="Dismiss — keep the change">✕</button>`;
  el.querySelector(".ut-undo").addEventListener("click", () => runUndoToast());
  el.querySelector(".ut-close").addEventListener("click", () => hideUndoToast());
  // Pause while the user is reading or about to click; resume on the way out.
  el.addEventListener("mouseenter", () => _undoToastPause());
  el.addEventListener("mouseleave", () => { if (!el.contains(document.activeElement)) _undoToastResume(); });
  el.addEventListener("focusin", () => _undoToastPause());
  el.addEventListener("focusout", (e) => { if (!el.contains(e.relatedTarget) && !el.matches(":hover")) _undoToastResume(); });
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); hideUndoToast(); } });
  document.body.appendChild(el);
  return el;
}

function _undoToastPause() {
  const t = _undoToast;
  if (!t || t.timer == null) return;
  clearTimeout(t.timer);
  t.timer = null;
  t.remaining -= Date.now() - t.startedAt;
}

function _undoToastResume() {
  const t = _undoToast;
  if (!t || t.timer != null || t.busy) return;
  t.startedAt = Date.now();
  t.timer = setTimeout(() => { if (_undoToast === t) hideUndoToast(); }, Math.max(t.remaining, 1500));
}

function showUndoToast(message, undoFn, { timeoutMs = 9000 } = {}) {
  if (_undoToast?.timer != null) clearTimeout(_undoToast.timer);
  const el = _undoToastEl();
  el.classList.remove("ut-result", "err");
  el.querySelector(".ut-msg").textContent = message;
  const btn = el.querySelector(".ut-undo");
  btn.hidden = false;
  btn.disabled = false;
  btn.textContent = "Undo";
  el.hidden = false;
  _undoToast = { el, undoFn, remaining: timeoutMs, startedAt: Date.now(), timer: null,
                 busy: false, done: false };
  // Already under the pointer / holding focus (a quick second action): stay paused.
  if (!el.matches(":hover") && !el.contains(document.activeElement)) _undoToastResume();
}

function hideUndoToast() {
  const t = _undoToast;
  if (!t) return;
  if (t.timer != null) clearTimeout(t.timer);
  _undoToast = null;
  t.el.hidden = true;
}

/** Run the toast's undo (button or Ctrl+Z). No-op without a live toast. */
async function runUndoToast() {
  const t = _undoToast;
  if (!t || t.busy || t.done) return;
  t.busy = true;
  _undoToastPause();
  const btn = t.el.querySelector(".ut-undo");
  btn.disabled = true;
  btn.textContent = "Undoing…";
  let result;
  try {
    result = await t.undoFn();
  } catch (err) {
    result = { message: "Undo failed: " + err.message, isError: true };
  }
  if (_undoToast !== t) return;   // replaced by a newer action meanwhile
  const r = typeof result === "string" ? { message: result } : (result || { message: "Undone." });
  t.busy = false;
  t.done = true;
  t.el.classList.add("ut-result");
  t.el.classList.toggle("err", !!r.isError);
  t.el.querySelector(".ut-msg").textContent = r.message;
  btn.hidden = true;
  // The outcome stays long enough to read, then goes; hovering still holds it.
  t.remaining = r.isError ? 7000 : 3500;
  if (!t.el.matches(":hover")) _undoToastResume();
}

document.addEventListener("keydown", (e) => {
  if (!_undoToast || _undoToast.done) return;
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
  if (isTypingTarget(e) || anyModalOpen()) return;
  e.preventDefault();
  runUndoToast();
});

/* ── Face undo tokens ──
 * Every one-click face/person write (POST /api/faces/assign, /faces/{id}/assign,
 * /faces/ignore, /faces/come-back, /crowds/ignore-unlabeled, DELETE
 * /api/persons/{id}) replies with an `undo` token; POST /api/faces/undo takes it
 * back verbatim (face_undo_service.py). These two turn a token into a toast
 * undoFn and its reply into the toast's outcome line. */
function faceUndoable(token) {
  return !!token && (token.faces?.length > 0 || !!token.person || token.created_person_id != null);
}

/** POST the token; resolves to {out, message, isError} (out = the server reply). */
async function undoFaceToken(token) {
  const out = await postJson("/api/faces/undo", token);
  const n = out.restored.length, c = out.conflicts.length + out.not_found.length;
  const total = n + c;
  const faces = (k) => `${k} face${k === 1 ? "" : "s"}`;
  let message;
  if (token.person) {
    message = `Restored “${token.person.name}”` + (n ? ` with ${faces(n)}` : "");
    if (c) message += ` — ${faces(c)} changed since and stayed as they are`;
    if (out.family_dropped) message += " (their family was deleted, so none)";
    message += ".";
  } else if (!total) {
    message = "Undone.";
  } else if (!c) {
    message = total === 1 ? "Undone." : `Undone for ${faces(n)}.`;
  } else if (n) {
    message = `Undone for ${n} of ${faces(total)} — ${c} changed since and stayed as they are.`;
  } else {
    message = `Not undone — ${total === 1 ? "that face has" : "those faces have"} changed since.`;
  }
  return { out, message, isError: !token.person && n === 0 && c > 0 };
}

/* ── Loading state (U4) ──
 * A latest-only loader that replaces a grid or list used to leave the old one
 * on screen and fully live until the reply landed: no sign anything was
 * happening, and a click or shortcut on the stale cells acted on data that was
 * about to be thrown away. setBusy(el, true, label) marks the container for the
 * length of the load:
 *   - at once: aria-busy="true", and pointer/keyboard activation inside it is
 *     swallowed by capture-phase listeners, so the stale content can't be
 *     acted on. Scrolling (wheel and scrollbar) and Tab still work — which is
 *     why this isn't pointer-events:none (the wheel would fall through to the
 *     parent) or `inert` (that would yank focus out of a focused cell and drop
 *     it on <body>);
 *   - after `delayMs` (150 ms): the container dims and a small spinner pill
 *     with `label` sits over the visible part of it. Loads faster than that
 *     never flicker.
 * It returns release(), to call in the loader's finally. Holds are tokens: a
 * newer setBusy on the same element supersedes the older hold, so the older
 * (superseded) call's release() is a no-op and can't clear the newer call's
 * busy state — which is exactly the latestOnly ordering, without the loader
 * having to look at its signal. release() is idempotent; setBusy(el, false)
 * force-clears whatever hold is current.
 *   const release = setBusy(grid, true, "Loading faces…");
 *   try { … } finally { release(); }
 * Document-level shortcut handlers that act on the container's contents check
 * isBusy(el) first and ignore the key while it's loading. */
const _busyHolds = new WeakMap();   // el → { token, timer, pill }
let _busyToken = 0;

function _busySwallow(e) {
  if (!_busyHolds.has(e.currentTarget)) return;
  // Tab / Shift+Tab move focus and Escape closes things; neither acts on content.
  if (e.type === "keydown" && (e.key === "Tab" || e.key === "Escape")) return;
  // A press on the container itself is its scrollbar (cells cover the content).
  if (e.type === "mousedown" && e.target === e.currentTarget) return;
  e.preventDefault();
  e.stopPropagation();
}

function _busyPlacePill(el, pill) {
  // Centre the pill on the part of the container that is actually on screen —
  // a tall scrolled grid's own centre is often far off the viewport.
  const r = el.getBoundingClientRect();
  const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
  const left = Math.max(r.left, 0), right = Math.min(r.right, window.innerWidth);
  if (bottom - top < 24 || right - left < 24) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.style.top = `${Math.round(top + Math.min(80, (bottom - top) / 2))}px`;
  pill.style.left = `${Math.round((left + right) / 2)}px`;
}

function setBusy(el, busy, label = "Loading…", { delayMs = 150 } = {}) {
  if (!el) return () => {};
  const prev = _busyHolds.get(el);
  if (prev) { clearTimeout(prev.timer); prev.pill?.remove(); }
  if (!busy) {
    _busyHolds.delete(el);
    el.removeAttribute("aria-busy");
    el.classList.remove("is-busy", "is-busy-shown");
    return () => {};
  }
  if (!el._busyListeners) {
    el._busyListeners = true;
    for (const type of ["click", "dblclick", "contextmenu", "keydown", "mousedown", "dragstart"]) {
      el.addEventListener(type, _busySwallow, true);
    }
  }
  const hold = { token: ++_busyToken, timer: null, pill: null };
  _busyHolds.set(el, hold);
  el.setAttribute("aria-busy", "true");
  el.classList.add("is-busy");
  hold.timer = setTimeout(() => {
    if (_busyHolds.get(el) !== hold) return;
    el.classList.add("is-busy-shown");
    const pill = document.createElement("div");
    pill.className = "busy-pill";
    pill.setAttribute("role", "status");
    pill.innerHTML = `<span class="spinner" aria-hidden="true"></span><span></span>`;
    pill.lastChild.textContent = label;
    document.body.appendChild(pill);
    hold.pill = pill;
    _busyPlacePill(el, pill);
  }, delayMs);
  return () => { if (_busyHolds.get(el) === hold) setBusy(el, false); };
}

/** True while `el` is held by setBusy (its stale content is being replaced). */
function isBusy(el) {
  return !!el && _busyHolds.has(el);
}

/* ── Toast (U9) ──
 * The one transient message pill (#toast, bottom-centre; theme.css) for pages
 * that report outcomes as toasts rather than in a status bar:
 * showToast(msg, {kind, timeoutMs}). kind is "info" (default), "success" or
 * "error". Errors are styled distinctly, announced assertively (role="alert"),
 * stay 6 s instead of 2.5 s — long enough to read a server message — and carry
 * a ✕ to dismiss early; hovering any toast holds it. Server errors should reach
 * it already readable: fetchJson / postJson / httpErrorMessage turn FastAPI's
 * {"detail": …} into one line, never raw JSON.
 * The Undo toast (showUndoToast) stays separate: it is interactive, lives
 * bottom-left so the two never overlap, and has its own pause/Ctrl+Z rules. */
let _toastTimer = null;

function showToast(msg, { kind = "info", timeoutMs } = {}) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.hidden = true;
    document.body.appendChild(t);
  }
  if (!t._toastBound) {
    t._toastBound = true;
    t.addEventListener("mouseenter", () => clearTimeout(_toastTimer));
    t.addEventListener("mouseleave", () => {
      if (t.hidden) return;
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(hideToast, 1500);
    });
    t.addEventListener("click", (e) => { if (e.target.closest(".toast-close")) hideToast(); });
  }
  const isErr = kind === "error";
  t.className = isErr ? "err" : kind === "success" ? "ok" : "";
  t.setAttribute("role", isErr ? "alert" : "status");
  t.setAttribute("aria-live", isErr ? "assertive" : "polite");
  t.innerHTML = `<span class="toast-msg"></span>` +
    (isErr ? `<button type="button" class="toast-close" aria-label="Dismiss" title="Dismiss">✕</button>` : "");
  t.firstChild.textContent = msg;
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, timeoutMs ?? (isErr ? 6000 : 2500));
}

function hideToast() {
  clearTimeout(_toastTimer);
  const t = document.getElementById("toast");
  if (t) t.hidden = true;
}
