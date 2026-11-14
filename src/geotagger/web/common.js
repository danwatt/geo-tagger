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
  const body = await res.json().catch(() => null);
  const d = body?.detail;
  if (typeof d === "string" && d) return d;
  if (d && typeof d === "object" && !Array.isArray(d) && typeof d.message === "string") return d.message;
  if (Array.isArray(d) && d.length && typeof d[0]?.msg === "string") {
    return `HTTP ${res.status}: ${d[0].msg}`;
  }
  return `HTTP ${res.status}`;
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
