/* Shared face-grid primitives used by the People, Crowd Review, and Quick Tag
 * pages. Plain <script> (no modules) — every page links this BEFORE its own
 * script, so these globals are available to the page code. */

/* ── Face crop image ──
 * The single source for the per-face thumbnail <img>. */
function faceCropImg(face, opts = {}) {
  const img = document.createElement("img");
  img.src = `/api/faces/${face.id}/crop`;
  img.loading = "lazy";
  img.alt = opts.alt || face.filename || "face";
  if (opts.title) img.title = opts.title;
  return img;
}

/* ── Bbox overlay geometry ──
 * Normalized bbox [x1,y1,x2,y2] → CSS percentage box. Used by every page that
 * overlays a face box on a full photo. */
function bboxStyle(bbox) {
  const [x1, y1, x2, y2] = bbox;
  return {
    left:   (x1 * 100) + "%",
    top:    (y1 * 100) + "%",
    width:  ((x2 - x1) * 100) + "%",
    height: ((y2 - y1) * 100) + "%",
  };
}
function applyBbox(el, bbox) {
  const s = bboxStyle(bbox);
  el.style.left = s.left;
  el.style.top = s.top;
  el.style.width = s.width;
  el.style.height = s.height;
}

/* ── Date-range label for a group of faces ──
 * Both timestamps are epoch seconds. Falls back to "Undated" with no start. */
function formatDateRange(startTs, endTs) {
  if (!startTs) return "Undated";
  const opts = { year: "numeric", month: "short", day: "numeric" };
  const s = new Date(startTs * 1000);
  const e = new Date((endTs || startTs) * 1000);
  const sStr = s.toLocaleDateString(undefined, opts);
  const eStr = e.toLocaleDateString(undefined, opts);
  if (sStr === eStr) return sStr;
  return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${eStr}`;
}

/* ── Location label for a group of faces ──
 * Each face may carry a `location: {city, sublocation, state, country}` resolved
 * by the reverse geocoder, or null when its photo isn't geocoded. `locationKey` is
 * the "City, Sublocation, State, Country" string for one face (missing parts
 * dropped), or null. `locationLabel` summarizes a group: the most common place
 * among its faces, plus " (and N other)" when the group spans more than one
 * place; empty string when no face has a resolved location. */
function locationKey(face) {
  const loc = face.location;
  if (!loc) return null;
  return [loc.city, loc.sublocation, loc.state, loc.country].filter(Boolean).join(", ") || null;
}

// Last path segment of a face's containing directory (its `dir` field, the
// photo's parent folder) — the fallback grouping key when there's no resolved
// location, e.g. undated scanned photos with no GPS. "Unknown folder" if the
// photo somehow carries no directory at all.
function dirLabel(face) {
  const d = face.dir;
  if (!d) return "Unknown folder";
  const parts = d.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || d;
}

function locationLabel(faces) {
  const counts = new Map();
  for (const f of faces) {
    const k = locationKey(f);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) return "";
  const sorted = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  if (sorted.length === 1) return sorted[0];
  const n = sorted.length - 1;
  return `${sorted[0]} (and ${n} other${n > 1 ? "s" : ""})`;
}

// The single most common place among a group of faces (or crowd photos), or
// null when none of them is geocoded. Unlike locationLabel() this returns a raw
// key suitable for sorting/comparing rather than a display string.
function primaryLocationKey(items) {
  const counts = new Map();
  for (const it of items) {
    const k = locationKey(it);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))[0];
}

/* ── Group sorting ──
 * Shared by every grid that renders *groups* of faces/photos (Discover clusters,
 * Crowd groups, the Unlabeled month→location buckets, the guesses event groups).
 * The caller supplies `keyFn(group)` returning { date, count, place }:
 *   date  — epoch seconds, or null/0 when undated
 *   count — number of photos in the group
 *   place — location string, or null when the group has no geocoded photo
 * Modes:
 *   "date"     — chronological, undated last (every grid's original order)
 *   "count"    — most photos first, ties chronological
 *   "location" — place name A→Z with un-located groups last, ties chronological
 * Returns a new array; the input is left alone. */
const GROUP_SORT_MODES = ["date", "count", "location"];

function sortGroups(groups, mode, keyFn) {
  const keys = new Map(groups.map(g => [g, keyFn(g)]));
  // Undated sorts after everything dated, in every mode.
  const byDate = (a, b) =>
    (keys.get(a).date || Infinity) - (keys.get(b).date || Infinity);
  const cmp = {
    date: byDate,
    count: (a, b) => (keys.get(b).count - keys.get(a).count) || byDate(a, b),
    location: (a, b) => {
      const pa = keys.get(a).place, pb = keys.get(b).place;
      if (pa && pb && pa !== pb) return pa.localeCompare(pb);
      if (pa !== pb) return pa ? -1 : 1;   // un-located groups last
      return byDate(a, b);                 // same place (or both unknown) → by date
    },
  }[mode] || byDate;
  return [...groups].sort(cmp);
}

/* ── Group header ──
 * Canonical "title + meta + action buttons" header for a section of faces.
 *   title      — main label text
 *   meta       — optional secondary text (caller includes its own "· " etc.)
 *   buttons    — [{ label, icon, kind: "primary"|"danger"|"", title,
 *                   disabled, ref, onClick }]
 *                When `icon` is set the button shows that glyph instead of the
 *                text label; `label` then serves as the tooltip / aria-label.
 *                `disabled` sets the initial disabled state; `ref(btnEl)` hands
 *                the created <button> back to the caller (e.g. to toggle it
 *                later as related state changes).
 *   extraClass — optional tint variant ("green"|"blue"|"grey"|"amber") or any
 *                page-specific class.
 * Returns a .face-group-header element (styled in face-grid.css). */
function faceGroupHeader({ title, meta, buttons = [], extraClass = "" }) {
  const header = document.createElement("div");
  header.className = "face-group-header" + (extraClass ? " " + extraClass : "");

  const label = document.createElement("span");
  label.className = "face-group-label";
  label.textContent = title;
  if (meta) {
    const m = document.createElement("span");
    m.className = "face-group-meta";
    m.textContent = " " + meta;
    label.appendChild(m);
  }
  header.appendChild(label);

  const visible = buttons.filter(Boolean);
  if (visible.length) {
    const btns = document.createElement("div");
    btns.className = "face-group-btns";
    visible.forEach((b) => {
      const btn = document.createElement("button");
      if (b.kind) btn.classList.add(b.kind);
      if (b.icon) {
        btn.classList.add("icon-btn");
        btn.textContent = b.icon;
        btn.title = b.title || b.label || "";
        if (b.label) btn.setAttribute("aria-label", b.label);
      } else {
        btn.textContent = b.label;
        if (b.title) btn.title = b.title;
      }
      if (b.disabled) btn.disabled = true;
      btn.addEventListener("click", (e) => { e.stopPropagation(); b.onClick(e); });
      if (b.ref) b.ref(btn);
      btns.appendChild(btn);
    });
    header.appendChild(btns);
  }
  return header;
}

/* ── Quick-action popup ──
 * A single floating menu (or bottom sheet on narrow viewports) for acting on one
 * face: confirm a suggestion, assign to an existing/new person, ignore/restore,
 * open the source photo. Pages supply the data + callbacks; this owns the DOM,
 * positioning, toggle, and outside-click close.
 *
 * openQuickActions(anchorEl, face, {
 *   persons,                       // [{id, name}]
 *   onAssign,    // (personId|null) => any   (null = unassign)   REQUIRED
 *   onAssignNew, // (name) => any            optional
 *   onIgnore,    // (ignored:boolean) => any optional
 *   onComeBack,  // (come_back:boolean) => any optional
 *   onNotPerson, // (personId, personName) => any  optional — rejects face.suggestion
 *   onOpenPhoto, // () => void               optional
 *   showConfirm, // override; default = face.suggestion && !face.person_name
 *   sheet,       // force bottom-sheet; default = auto by viewport width
 * }) */
let _qaPanel = null;
let _qaBackdrop = null;
let _qaFaceId = null;

function closeQuickActions() {
  document.removeEventListener("click", _qaOutside);
  if (_qaPanel) _qaPanel.remove();
  if (_qaBackdrop) _qaBackdrop.remove();
  _qaPanel = _qaBackdrop = null;
  _qaFaceId = null;
}

function _qaOutside(e) {
  if (_qaPanel && _qaPanel.contains(e.target)) return;
  closeQuickActions();
}

function openQuickActions(anchor, face, opts) {
  // Clicking the same face again toggles the popup closed.
  if (_qaPanel && _qaFaceId === face.id) { closeQuickActions(); return; }
  closeQuickActions();
  _qaFaceId = face.id;

  const asSheet = opts.sheet ?? (window.innerWidth <= 640);
  const panel = document.createElement("div");
  panel.className = "face-expand" + (asSheet ? " as-sheet" : "");
  panel.dataset.faceId = String(face.id);

  // Run a callback then tear down the popup (callbacks usually re-render).
  const run = (fn) => (e) => { e.stopPropagation(); closeQuickActions(); fn(); };

  const showConfirm = opts.showConfirm ?? (face.suggestion && !face.person_name);
  if (showConfirm && face.suggestion) {
    const b = document.createElement("button");
    b.className = "primary expand-btn";
    b.textContent = `✓ ${face.suggestion.person_name}`;
    b.addEventListener("click", run(() => opts.onAssign(face.suggestion.person_id)));
    panel.appendChild(b);
  }

  if (face.person_name) {
    const b = document.createElement("button");
    b.className = "danger expand-btn";
    b.textContent = "× Unassign";
    b.addEventListener("click", run(() => opts.onAssign(null)));
    panel.appendChild(b);
  }

  if (opts.onNotPerson && face.suggestion) {
    const b = document.createElement("button");
    b.className = "danger expand-btn";
    b.textContent = `⛔ Not ${face.suggestion.person_name}`;
    b.addEventListener("click", run(() =>
      opts.onNotPerson(face.suggestion.person_id, face.suggestion.person_name)));
    panel.appendChild(b);
  }

  // Assign to an existing or new person — opens the shared typeahead picker.
  const assignBtn = document.createElement("button");
  assignBtn.className = "expand-btn";
  assignBtn.textContent = "Assign to…";
  assignBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeQuickActions();
    openPersonPicker(opts.persons || [], {
      title: "Assign to…",
      allowCreate: !!opts.onAssignNew,
      onPick: (who) => {
        if (who.person_id) opts.onAssign(who.person_id);
        else if (who.name) opts.onAssignNew(who.name);
      },
    });
  });
  panel.appendChild(assignBtn);

  if (opts.onIgnore) {
    const b = document.createElement("button");
    b.className = face.ignored ? "expand-btn" : "danger expand-btn";
    b.textContent = face.ignored ? "↩ Restore" : "🚫 Ignore";
    b.addEventListener("click", run(() => opts.onIgnore(!face.ignored)));
    panel.appendChild(b);
  }

  if (opts.onComeBack) {
    const b = document.createElement("button");
    b.className = "expand-btn";
    b.textContent = face.come_back ? "↩ Restore" : "🕒 Come back later";
    b.addEventListener("click", run(() => opts.onComeBack(!face.come_back)));
    panel.appendChild(b);
  }

  // Only offered for hand-drawn faces (source 'manual'); a detected face would
  // just come back on the next scan, so those get Ignore instead.
  if (opts.onDelete && face.source === "manual") {
    const b = document.createElement("button");
    b.className = "danger expand-btn";
    b.textContent = "🗑 Delete box";
    b.addEventListener("click", run(() => opts.onDelete()));
    panel.appendChild(b);
  }

  if (opts.onOpenPhoto) {
    const b = document.createElement("button");
    b.className = "expand-btn";
    b.textContent = "Open photo ↗";
    b.addEventListener("click", run(() => opts.onOpenPhoto()));
    panel.appendChild(b);
  }

  if (asSheet) {
    const backdrop = document.createElement("div");
    backdrop.className = "face-qa-backdrop";
    document.body.appendChild(backdrop);
    _qaBackdrop = backdrop;
    document.body.appendChild(panel);
    _qaPanel = panel;
  } else {
    panel.style.visibility = "hidden";
    document.body.appendChild(panel);
    _qaPanel = panel;
    _positionQa(panel, anchor);
    panel.style.visibility = "";
  }

  // Defer the outside-close listener so the opening click doesn't trip it.
  setTimeout(() => document.addEventListener("click", _qaOutside), 0);
}

/* ── Person picker modal ──
 * The one typeahead-with-create-new picker for "assign to a person", used by
 * the People toolbar, the People detail pane, and the quick-action popup above
 * (which itself is used by People/Crowd Review/Quick Tag context menus). Small
 * centered modal — deliberately not the Quick Tag bottom sheet, which is sized
 * for touch; this is desktop-density text.
 *
 * openPersonPicker(persons, {
 *   title,        // header text, e.g. "Assign 3 face(s) to…"
 *   allowCreate,  // default true — offer "Create “name”" for unmatched text
 *   onPick,       // ({person_id} | {name}, label) => void            REQUIRED
 *   onClose,      // () => void — DISMISSED without picking (Esc, ✕, backdrop)
 * }) */
let _ppBackdrop = null;
let _ppOnClose = null;

function isPersonPickerOpen() {
  return _ppBackdrop !== null;
}

function closePersonPicker() {
  document.removeEventListener("keydown", _ppEscape);
  if (_ppBackdrop) _ppBackdrop.remove();
  _ppBackdrop = null;
  // Cleared before firing so an onClose that reopens a picker isn't re-entered.
  const cb = _ppOnClose;
  _ppOnClose = null;
  if (cb) cb();
}

function _ppEscape(e) {
  if (e.key === "Escape") closePersonPicker();
}

function openPersonPicker(persons, opts) {
  closePersonPicker();
  _ppOnClose = opts.onClose || null;

  const backdrop = document.createElement("div");
  backdrop.className = "pp-backdrop";
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePersonPicker(); });

  const modal = document.createElement("div");
  modal.className = "pp-modal";

  const head = document.createElement("div");
  head.className = "pp-head";
  const title = document.createElement("span");
  title.textContent = opts.title || "Assign to…";
  head.appendChild(title);
  const close = document.createElement("button");
  close.className = "pp-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closePersonPicker);
  head.appendChild(close);
  modal.appendChild(head);

  const search = document.createElement("input");
  search.type = "text";
  search.className = "pp-search";
  search.autocomplete = "off";
  search.placeholder = "Search people, or type a new name…";
  modal.appendChild(search);

  const list = document.createElement("div");
  list.className = "pp-list";
  modal.appendChild(list);

  const allowCreate = opts.allowCreate ?? true;

  function pick(who, label) {
    _ppOnClose = null;   // a pick is not a dismissal
    closePersonPicker();
    opts.onPick(who, label);
  }

  function renderList(q) {
    list.innerHTML = "";
    const ql = q.trim().toLowerCase();
    const matches = persons
      .filter((p) => p.name.toLowerCase().includes(ql))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (ql && allowCreate && !persons.some((p) => p.name.toLowerCase() === ql)) {
      const row = document.createElement("button");
      row.className = "pp-item pp-new";
      row.textContent = `➕ Create "${q.trim()}"`;
      row.addEventListener("click", () => pick({ name: q.trim() }, q.trim()));
      list.appendChild(row);
    }

    matches.forEach((p) => {
      const row = document.createElement("button");
      row.className = "pp-item";
      const nameEl = document.createElement("span");
      nameEl.textContent = p.name;
      row.appendChild(nameEl);
      if (p.face_count !== undefined && p.face_count !== null) {
        const countEl = document.createElement("span");
        countEl.className = "pp-count";
        countEl.textContent = p.face_count;
        row.appendChild(countEl);
      }
      row.addEventListener("click", () => pick({ person_id: p.id }, p.name));
      list.appendChild(row);
    });

    if (!matches.length && !ql) {
      const empty = document.createElement("div");
      empty.className = "pp-empty";
      empty.textContent = "No people yet — type a name to create one.";
      list.appendChild(empty);
    }

    _ppHighlightIdx = list.querySelectorAll(".pp-item").length ? 0 : -1;
    _ppUpdateHighlight(list);
  }

  search.addEventListener("input", (e) => renderList(e.target.value));

  // Arrow keys move a highlight over the (search-filtered) list; Enter picks
  // whichever row is highlighted (defaults to the top match) without requiring
  // the mouse — mirrors the up/down + Enter pattern used on the People grid.
  search.addEventListener("keydown", (e) => {
    const items = Array.from(list.children);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!items.length) return;
      _ppHighlightIdx = Math.min(items.length - 1, _ppHighlightIdx + 1);
      _ppUpdateHighlight(list);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      _ppHighlightIdx = Math.max(0, _ppHighlightIdx - 1);
      _ppUpdateHighlight(list);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = items[_ppHighlightIdx] || items[0];
      if (target) target.click();
    }
  });

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  _ppBackdrop = backdrop;
  renderList("");
  search.focus();
  document.addEventListener("keydown", _ppEscape);
}

let _ppHighlightIdx = -1;

function _ppUpdateHighlight(list) {
  const items = Array.from(list.children);
  items.forEach((el, i) => el.classList.toggle("pp-hl", i === _ppHighlightIdx));
  if (_ppHighlightIdx >= 0 && items[_ppHighlightIdx]) {
    items[_ppHighlightIdx].scrollIntoView({ block: "nearest" });
  }
}

function _positionQa(panel, anchor) {
  // Fixed-position (and off-flow) *before* measuring, else the panel is still
  // a static block-level div spanning the full body width, and pr.width comes
  // back huge — tripping the overflow clamp below and pinning it to the left
  // edge no matter where the anchor is.
  panel.style.position = "fixed";
  const cr = anchor.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = cr.bottom + 6;
  if (top + pr.height > vh - 10) top = cr.top - pr.height - 6;
  top = Math.max(6, top);
  let left = cr.left;
  if (left + pr.width > vw - 10) left = vw - pr.width - 10;
  left = Math.max(6, left);
  panel.style.top = top + "px";
  panel.style.left = left + "px";
}
