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
 * Each face may carry a `location: {city, state, country}` resolved by the
 * reverse geocoder, or null when its photo isn't geocoded. `locationKey` is the
 * "City, State, Country" string for one face (missing parts dropped), or null.
 * `locationLabel` summarizes a group: the distinct places among its faces, most
 * common first, with a "+N" suffix when the group spans more than one place;
 * empty string when no face has a resolved location. */
function locationKey(face) {
  const loc = face.location;
  if (!loc) return null;
  return [loc.city, loc.state, loc.country].filter(Boolean).join(", ") || null;
}

function locationLabel(faces) {
  const counts = new Map();
  for (const f of faces) {
    const k = locationKey(f);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) return "";
  const sorted = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  return sorted.length === 1 ? sorted[0] : `${sorted[0]} +${sorted.length - 1}`;
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

  // Assign to an existing person.
  const row = document.createElement("div");
  row.className = "expand-row";
  const sel = document.createElement("select");
  sel.className = "expand-select";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Assign to…";
  sel.appendChild(blank);
  (opts.persons || []).forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  row.appendChild(sel);
  const assignBtn = document.createElement("button");
  assignBtn.className = "expand-btn";
  assignBtn.textContent = "✓";
  assignBtn.title = "Assign to selected person";
  assignBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const pid = parseInt(sel.value);
    if (!pid) return;
    closeQuickActions();
    opts.onAssign(pid);
  });
  row.appendChild(assignBtn);
  panel.appendChild(row);

  if (opts.onAssignNew) {
    const b = document.createElement("button");
    b.className = "expand-btn";
    b.textContent = "+ New person";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = prompt("New person name:");
      if (!name || !name.trim()) return;
      closeQuickActions();
      opts.onAssignNew(name.trim());
    });
    panel.appendChild(b);
  }

  if (opts.onIgnore) {
    const b = document.createElement("button");
    b.className = face.ignored ? "expand-btn" : "danger expand-btn";
    b.textContent = face.ignored ? "↩ Restore" : "🚫 Ignore";
    b.addEventListener("click", run(() => opts.onIgnore(!face.ignored)));
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

function _positionQa(panel, anchor) {
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
  panel.style.position = "fixed";
  panel.style.top = top + "px";
  panel.style.left = left + "px";
}
