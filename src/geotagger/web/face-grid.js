/* Shared face-grid primitives used by the People, Crowd Review, and Quick Tag
 * pages. Plain <script> (no modules) — every page links this BEFORE its own
 * script, so these globals are available to the page code. */

/* ── Face crop image ──
 * The single source for the per-face thumbnail <img>. */
function faceCropImg(face, opts = {}) {
  const alt = opts.alt || face.filename || "face";

  // opts.reuse: hand back the same <img> node this face had last render. A
  // fresh lazy <img> re-enters the whole loading pipeline (intersection check,
  // fetch — cached or not — then decode) and paints empty until it lands, so a
  // full grid rebuild reads as every face flashing white and coming back. An
  // already-decoded node paints the instant it is re-parented. Only safe for
  // callers that treat the image as inert: reused nodes keep any class or
  // listener a caller put on them, so anything that decorates the <img> itself
  // must keep building fresh ones.
  if (opts.reuse) {
    const hit = _cropImgCache.get(face.id);
    // Still in the document = in use by another view; moving it would tear it
    // out of there, so fall through and build a second one.
    // (Callers build cells into detached containers, so this can't catch the
    // same face being asked for twice within one render — callers must not do
    // that. The People grid and its staging area are disjoint by construction.)
    if (hit && !hit.isConnected) {
      hit.alt = alt;
      if (opts.title) hit.title = opts.title;
      _cropImgCacheSet(face.id, hit);   // refresh: a hit is a use, so it's LRU not FIFO
      return hit;
    }
  }

  const img = document.createElement("img");
  img.src = `/api/faces/${face.id}/crop`;
  img.loading = "lazy";
  img.alt = alt;
  if (opts.title) img.title = opts.title;
  if (opts.reuse) _cropImgCacheSet(face.id, img);
  return img;
}

// Detached <img> nodes held for reuse, keyed by face id. Bounded: a long people
// session can walk through far more faces than any one view shows, and each
// entry pins a decoded bitmap. The bound must never fall below what one render
// can show, though: a rebuild walks the faces in order, so a cap smaller than
// the grid evicts each entry just before the rebuild reaches it and every image
// is recreated (LRU degenerates to 0% hits on a cyclic scan). Pages that reuse
// call sizeCropImgCache() with their page size; the floor covers the rest.
const _cropImgCache = new Map();
const CROP_IMG_CACHE_FLOOR = 3000;
let _cropImgCacheMax = CROP_IMG_CACHE_FLOOR;

// Fit the cache to a page that can show up to `maxShown` reusable faces at once.
// 1.5× headroom: the People staging area can still hold faces staged from an
// earlier scope on top of a full grid of the current one.
function sizeCropImgCache(maxShown) {
  _cropImgCacheMax = Math.max(CROP_IMG_CACHE_FLOOR, Math.ceil((maxShown || 0) * 1.5));
}

function _cropImgCacheSet(id, img) {
  _cropImgCache.delete(id);   // re-insert so Map order stays least-recent-first
  _cropImgCache.set(id, img);
  while (_cropImgCache.size > _cropImgCacheMax) {
    _cropImgCache.delete(_cropImgCache.keys().next().value);
  }
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
 * Both timestamps are epoch seconds. Falls back to "Undated" with no start.
 * Formatted in UTC: these are photo_datetime values, which hold the camera's
 * wall clock stored as if it were UTC (see the note above dayKey in app.js), so
 * local formatting would slide a late-evening photo onto the next/previous day
 * depending on where the *viewer* is. */
function formatDateRange(startTs, endTs) {
  if (!startTs) return "Undated";
  const opts = { year: "numeric", month: "short", day: "numeric" };
  const sStr = formatWallClockDate(startTs, opts);
  const eStr = formatWallClockDate(endTs || startTs, opts);
  if (sStr === eStr) return sStr;
  return `${formatWallClockDate(startTs, { month: "short", day: "numeric" })} – ${eStr}`;
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
// The single directory a group of faces shares, or the most common one when
// they straddle folders — null only when nothing in the group has a dir. The
// counterpart to primaryLocationKey for the "Folder" sort.
function primaryDirKey(items) {
  const counts = new Map();
  for (const it of items) {
    if (it.dir) counts.set(it.dir, (counts.get(it.dir) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))[0];
}

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
 * The caller supplies `keyFn(group)` returning { date, count, place, dir }:
 *   date  — epoch seconds, or null/0 when undated
 *   count — number of photos in the group
 *   place — location string, or null when the group has no geocoded photo
 *   dir   — full directory path, or null when the group has no folder in common
 * Modes:
 *   "date"     — chronological, undated last (every grid's original order)
 *   "count"    — most photos first, ties chronological
 *   "location" — place name A→Z with un-located groups last, ties chronological
 *   "dir"      — folder path A→Z with folderless groups last, ties chronological
 * Returns a new array; the input is left alone. */
const GROUP_SORT_MODES = ["date", "count", "location", "dir"];

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
    // Sorted on the full path, not the leaf name, so sibling folders of a
    // scanned batch ("…/Scans/1985 Box", "…/Scans/1986 Box") stay adjacent
    // instead of scattering among same-named leaves under other parents.
    dir: (a, b) => {
      const da = keys.get(a).dir, db = keys.get(b).dir;
      if (da && db && da !== db) return da.localeCompare(db);
      if (da !== db) return da ? -1 : 1;   // groups with no common folder last
      return byDate(a, b);
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
// `scopeLabel` (optional) prefixes the button row with a small static chip
// ("this group:"). It exists so a header's buttons can't be mistaken for the
// page's selection toolbar when the two end up side by side — see the People
// page, where a sticky selection bar sits directly above these headers.
function faceGroupHeader({ title, meta, buttons = [], extraClass = "", scopeLabel = "" }) {
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
    if (scopeLabel) {
      const scope = document.createElement("span");
      scope.className = "face-group-scope";
      scope.textContent = scopeLabel;
      btns.appendChild(scope);
    }
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
 *   onNotPersonAll, // (personId, personName) => any  optional — same rejection,
 *                //   applied to every face the caller's current batch suggests
 *                //   for that person
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

  // Bulk form of the above: reject this suggestion everywhere it appears in the
  // batch the caller has on screen, not just on this one face.
  if (opts.onNotPersonAll && face.suggestion) {
    const b = document.createElement("button");
    b.className = "danger expand-btn";
    b.textContent = `⛔ Not ${face.suggestion.person_name} — Any`;
    b.title = `Mark every face currently suggested as ${face.suggestion.person_name} as definitely not them`;
    b.addEventListener("click", run(() =>
      opts.onNotPersonAll(face.suggestion.person_id, face.suggestion.person_name)));
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

/* ── Typeahead picker modal ──
 * The one typeahead picker for "assign this to a named thing", used by the
 * People toolbar, the People detail pane, the quick-action popup above (which
 * itself is used by People/Crowd Review/Quick Tag context menus), and the
 * geocode page's location picker. Small centered modal — deliberately not the
 * Quick Tag bottom sheet, which is sized for touch; this is desktop-density text.
 *
 * openEntityPicker(items, {
 *   title,        // header text, e.g. "Assign 3 face(s) to…"
 *   placeholder,  // search box placeholder
 *   emptyText,    // shown when there is nothing to pick from at all
 *   wide,         // widen the modal — for rows carrying a thumbnail + meta line
 *   allowCreate,  // default true — offer "Create “name”" for unmatched text
 *   createLabel,  // (query) => string   label for that create row
 *   onPick,       // (item, label) => void                            REQUIRED
 *                 //   item is the caller's own object, or {__new:true, name}
 *   onClose,      // () => void — DISMISSED without picking (Esc, ✕, backdrop)
 * })
 *
 * Item shape: { name, count?, meta?, group?, thumb?, … } — anything else on the
 * item is the caller's and comes back untouched in onPick. `group` splits the
 * list into labelled sections, in first-appearance order; `meta` is a second
 * line under the name and is searched alongside it.
 *
 * openPersonPicker(persons, opts) is the person-shaped wrapper — same modal,
 * with onPick handing back {person_id} | {name} as its callers expect
 * (opts: title, placeholder, allowCreate, onPick, onClose). */
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
  const items = persons.map((p) => ({
    id: p.id, name: p.name, count: p.face_count, person: p,
  }));
  openEntityPicker(items, {
    title: opts.title || "Assign to…",
    placeholder: opts.placeholder || "Search people, or type a new name…",
    emptyText: "No people yet — type a name to create one.",
    allowCreate: opts.allowCreate ?? true,
    createLabel: (q) => `➕ Create "${q}"`,
    onClose: opts.onClose,
    onPick: (item, label) =>
      opts.onPick(item.__new ? { name: item.name } : { person_id: item.id }, label),
  });
}

function openEntityPicker(items, opts) {
  closePersonPicker();
  _ppOnClose = opts.onClose || null;

  const backdrop = document.createElement("div");
  backdrop.className = "pp-backdrop";
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePersonPicker(); });

  const modal = document.createElement("div");
  modal.className = "pp-modal" + (opts.wide ? " pp-wide" : "");

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
  search.placeholder = opts.placeholder || "Search…";
  modal.appendChild(search);

  const list = document.createElement("div");
  // Cards mode: thumbnail on top, name beneath it, tiled — the location picker
  // is picked by *looking* at the photo, so the 28px strip on the left was the
  // wrong emphasis. The person list stays a plain vertical list.
  list.className = "pp-list" + (opts.cards ? " pp-cards" : "");
  modal.appendChild(list);

  const allowCreate = opts.allowCreate ?? true;

  function pick(who, label) {
    _ppOnClose = null;   // a pick is not a dismissal
    closePersonPicker();
    opts.onPick(who, label);
  }

  // Grouped items keep the order the caller gave them — the groups are already
  // ranked (recent before saved before mined, say), and re-sorting would throw
  // that away. Ungrouped items sort by name, as the person list always has.
  const grouped = items.some((it) => it.group);

  function renderList(q) {
    list.innerHTML = "";
    const ql = q.trim().toLowerCase();
    const hit = (it) =>
      it.name.toLowerCase().includes(ql) ||
      (it.meta || "").toLowerCase().includes(ql);
    let matches = items.filter(hit);
    if (!grouped) matches = matches.slice().sort((a, b) => a.name.localeCompare(b.name));

    const offerCreate = ql && allowCreate && !items.some((it) => it.name.toLowerCase() === ql);

    let lastGroup = null;
    matches.forEach((it) => {
      if (grouped && it.group !== lastGroup) {
        lastGroup = it.group;
        const head = document.createElement("div");
        head.className = "pp-group";
        head.textContent = it.group || "";
        list.appendChild(head);
      }
      list.appendChild(makeItemRow(it));
    });

    // Create goes at the *end* of the list so the keyboard highlight lands on
    // the first real match — Enter should tag an existing person, not silently
    // mint a new one that differs from it by a typo.
    if (offerCreate) {
      const row = document.createElement("button");
      row.className = "pp-item pp-new";
      row.textContent = opts.createLabel ? opts.createLabel(q.trim()) : `➕ Create "${q.trim()}"`;
      row.addEventListener("click", () => pick({ __new: true, name: q.trim() }, q.trim()));
      list.appendChild(row);
    }

    // The create row is itself an answer to an unmatched query — don't stack a
    // "no matches" note under it.
    if (!matches.length && !offerCreate) {
      const empty = document.createElement("div");
      empty.className = "pp-empty";
      empty.textContent = ql ? "No matches." : (opts.emptyText || "Nothing to pick.");
      list.appendChild(empty);
    }

    _ppHighlightIdx = list.querySelectorAll(".pp-item").length ? 0 : -1;
    _ppUpdateHighlight(list);
  }

  function makeItemRow(it) {
    const row = document.createElement("button");
    row.className = "pp-item";

    if (it.thumb) {
      const img = document.createElement("img");
      img.className = "pp-thumb";
      img.src = it.thumb;
      img.loading = "lazy";
      img.alt = "";
      row.appendChild(img);
    } else if (opts.cards) {
      // Keeps the tile the same height as its neighbours, so names line up.
      const ph = document.createElement("span");
      ph.className = "pp-thumb pp-thumb-empty";
      ph.textContent = "📍";
      row.appendChild(ph);
    }

    const main = document.createElement("span");
    main.className = "pp-item-main";
    const nameEl = document.createElement("span");
    nameEl.className = "pp-name";
    nameEl.textContent = it.name;
    main.appendChild(nameEl);
    if (it.meta) {
      const metaEl = document.createElement("span");
      metaEl.className = "pp-meta";
      metaEl.textContent = it.meta;
      main.appendChild(metaEl);
    }
    row.appendChild(main);

    if (it.count !== undefined && it.count !== null) {
      const countEl = document.createElement("span");
      countEl.className = "pp-count";
      countEl.textContent = it.count;
      row.appendChild(countEl);
    }

    if (it.title) row.title = it.title;
    row.addEventListener("click", () => pick(it, it.name));
    return row;
  }

  search.addEventListener("input", (e) => renderList(e.target.value));

  // Arrow keys move a highlight over the (search-filtered) list; Enter picks
  // whichever row is highlighted (defaults to the top match) without requiring
  // the mouse — mirrors the up/down + Enter pattern used on the People grid.
  search.addEventListener("keydown", (e) => {
    // Only the pickable rows — group headers and the empty note are in the list
    // too, and the highlight must step straight over them.
    const rows = Array.from(list.querySelectorAll(".pp-item"));
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!rows.length) return;
      _ppHighlightIdx = Math.min(rows.length - 1, _ppHighlightIdx + 1);
      _ppUpdateHighlight(list);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      _ppHighlightIdx = Math.max(0, _ppHighlightIdx - 1);
      _ppUpdateHighlight(list);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = rows[_ppHighlightIdx] || rows[0];
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
  const rows = Array.from(list.querySelectorAll(".pp-item"));
  rows.forEach((el, i) => el.classList.toggle("pp-hl", i === _ppHighlightIdx));
  if (_ppHighlightIdx >= 0 && rows[_ppHighlightIdx]) {
    rows[_ppHighlightIdx].scrollIntoView({ block: "nearest" });
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
