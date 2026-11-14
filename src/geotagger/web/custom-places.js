/* Custom Places screen — draw/manage saved rectangles & circles.
   These are stored in our own DB (separate from GeoNames/OSM) via /api/places
   and selectable as jump targets on the Geocode page. */

let map;

// State
let places = [];            // loaded from /api/places
let placeShapes = {};       // place_id -> L.Rectangle | L.Circle
let selectedPlaceId = null; // highlighted in sidebar
let placeFilter = "all";    // all | with-photo | without-photo — sidebar list only
let placeQuery = "";        // free-text name filter, sidebar list only
let placeSort = "name";     // name | count | recent | created
// Compact by default: a 320px sidebar fits two gallery cards and eight compact
// rows, and finding the place you meant is the common task, not admiring it.
let placeDense = localStorage.getItem("placeDense") !== "gallery";

let drawingMode = null;     // null | "rectangle" | "circle"
let drawingShape = null;    // temporary shape being drawn
let drawStartLatLng = null;

// Basemap definitions + switcher (and correctWorldWrap) live in basemaps.js.

/* ── Init ── */
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindToolbar();
  bindDialogs();
  loadPlaces();
  loadSuggestion();
});

function initMap() {
  // World view is only the starting point; restoreView() (or the first place
  // load) moves off it as soon as we know where this library's places are.
  map = L.map("map").setView([20, 0], 2);
  setBasemap("street");
  addBasemapControl();
  map.on("moveend", correctWorldWrap);
  map.on("moveend", onMapMovedForHotspots);
  map.on("moveend", saveView);
  map.on("zoomend", () => applyPlaceLabels());
  restoreView();
}

/* ── Where the map opens ──
 * Opening on the whole world means panning to your own places every visit. So:
 * the view you left last, else a fit around every place you have, else world.
 * Remembered per browser, not on the server — it's a scroll position, not data. */

const VIEW_KEY = "customPlacesView";
let viewRestored = false;        // a saved view outranks the auto-fit below

function saveView() {
  const c = map.getCenter();
  localStorage.setItem(VIEW_KEY, JSON.stringify({
    lat: c.lat, lng: c.lng, zoom: map.getZoom(),
  }));
}

function restoreView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    if (!v || typeof v.lat !== "number" || typeof v.lng !== "number") return;
    map.setView([v.lat, v.lng], v.zoom ?? 13, { animate: false });
    viewRestored = true;
  } catch (err) {
    // A corrupt entry is not worth a broken page — fall through to the auto-fit.
  }
}

// Frames every place so a new library opens on its own contents instead of the
// mid-Atlantic. Runs on the first load only — every later loadPlaces() is a
// rename, a delete or a shape you just drew, and re-framing the map under any of
// those would be a jump you didn't ask for.
let initialViewDone = false;

function fitToPlaces() {
  if (initialViewDone) return;
  initialViewDone = true;
  if (viewRestored) return;
  const shapes = Object.values(placeShapes);
  if (!shapes.length) return;
  const bounds = shapes.reduce((acc, s) => acc.extend(s.getBounds()), L.latLngBounds([]));
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 14 });
}

/* ── Toolbar ── */
function bindToolbar() {
  document.getElementById("draw-rectangle-btn").addEventListener("click", () => startDrawing("rectangle"));
  document.getElementById("draw-circle-btn").addEventListener("click", () => startDrawing("circle"));

  const filter = document.getElementById("place-filter");
  filter.addEventListener("change", () => {
    placeFilter = filter.value;
    renderSidebar();
  });

  const search = document.getElementById("place-search");
  // "input", not "change": the list is already in memory, so filtering keystroke
  // by keystroke costs nothing and beats waiting for Enter.
  search.addEventListener("input", () => {
    placeQuery = search.value.trim().toLowerCase();
    renderSidebar();
  });

  // Named apart from the hotspot `sort`/`chk` locals further down — same scope.
  const placeSortSel = document.getElementById("place-sort");
  placeSortSel.addEventListener("change", () => {
    placeSort = placeSortSel.value;
    renderSidebar();
  });

  const density = document.getElementById("place-density-btn");
  density.addEventListener("click", () => {
    placeDense = !placeDense;
    localStorage.setItem("placeDense", placeDense ? "compact" : "gallery");
    renderSidebar();
  });

  const chk = document.getElementById("show-hotspots-chk");
  const controls = document.getElementById("hotspot-controls");
  const sort = document.getElementById("hotspot-sort");
  const inView = document.getElementById("hotspot-in-view-chk");
  chk.addEventListener("change", () => {
    showHotspots = chk.checked;
    controls.style.display = showHotspots ? "" : "none";
    if (showHotspots) loadHotspots(); else clearHotspots();
  });
  sort.addEventListener("change", () => {
    hotspotSort = sort.value;
    if (showHotspots) loadHotspots();
  });
  inView.addEventListener("change", () => {
    hotspotInView = inView.checked;
    if (showHotspots) loadHotspots();
  });

  document.getElementById("suggest-place-zoom-btn").addEventListener("click", () => {
    if (suggestedPlace) zoomToSuggestion();
  });
  document.getElementById("suggest-place-name-btn").addEventListener("click", () => {
    if (suggestedPlace) savePlaceFromHotspot(suggestedPlace);
  });
  document.getElementById("suggest-place-dismiss-btn").addEventListener("click", () => {
    if (suggestedPlace) dismissSuggestion(hotspotKey(suggestedPlace));
    suggestedPlace = null;
    renderSuggestion();
  });

  document.getElementById("rep-picker-close").addEventListener("click", closeRepPicker);
  document.getElementById("rep-picker-done").addEventListener("click", closeRepPicker);
  document.getElementById("rep-picker-modal").addEventListener("click", (e) => {
    if (e.target.id === "rep-picker-modal") closeRepPicker();
  });
  document.getElementById("rep-picker-clear").addEventListener("click", () => {
    const place = repPickerPlace;
    closeRepPicker();
    if (place) clearRepresentative(place);
  });
  // One Escape handler for every layer. Innermost first, and only one closes per
  // press, so Escape out of a dialog opened over the picker doesn't shut both.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (placeDialogDone) closePlaceDialog(null);
    else if (confirmDialogDone) closeConfirmDialog(false);
    else closeRepPicker();
  });
}

/* ── API ── */
async function loadPlaces() {
  // A reload after an edit keeps the old rows up until the reply lands — hold
  // the list busy meanwhile (U4) so a click can't open a place being replaced.
  const release = setBusy(document.getElementById("place-list"), true, "Loading places…");
  try {
    // stats=true adds photo_count and last_ts — a spatial query per place, so
    // only this page asks for them.
    const res = await fetch("/api/places?stats=true");
    if (!res.ok) throw new Error(await httpErrorMessage(res));
    places = await res.json();
    renderSidebar();
    renderPlaces();
    fitToPlaces();
  } catch (e) {
    setStatus("Failed to load places: " + e.message, true);
  } finally {
    release();
  }
}

/* ── Rendering ── */
// The filter, search and sort narrow and order the sidebar only — the map keeps
// every place drawn in `places` order, so hiding a row never hides the shape you
// are about to drag.
function filteredPlaces() {
  let out = places;
  if (placeFilter === "with-photo") out = out.filter(p => p.representative_photo_id);
  else if (placeFilter === "without-photo") out = out.filter(p => !p.representative_photo_id);
  if (placeQuery) out = out.filter(p => p.name.toLowerCase().includes(placeQuery));
  return sortPlaces(out);
}

// Sorts a copy: `places` is what renderPlaces() walks, so reordering it in place
// would reshuffle map layers for a sidebar-only choice. Name breaks every tie so
// the order is stable when counts or dates match (or are missing).
function sortPlaces(list) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const desc = (key) => (a, b) => ((b[key] || 0) - (a[key] || 0)) || byName(a, b);
  const cmp = {
    name: byName,
    count: desc("photo_count"),
    recent: desc("last_ts"),
    created: desc("created_at"),
  }[placeSort] || byName;
  return [...list].sort(cmp);
}

// "12 photos · last 3/2/2019 · 250 m" — the same facts a hotspot row carries, so
// a named place can be judged against the unnamed ones below it. photo_count is
// absent only if the stats query failed; the row then just says less.
function placeMeta(p) {
  const bits = [];
  if (typeof p.photo_count === "number") {
    bits.push(p.photo_count === 1 ? "1 photo" : `${p.photo_count} photos`);
  }
  if (p.last_ts) bits.push(`last ${formatWallClockDate(p.last_ts)}`);
  bits.push(p.type === "circle" ? formatRadius(circleRadius(p)) : "rectangle");
  // Time-neighbour inference, not a spatial count — see index.get_place_stats.
  // Worth a callout because it's the backlog this place could clear in one sitting.
  if (p.untagged_nearby_count) {
    bits.push(`~${p.untagged_nearby_count} untagged nearby`);
  }
  return bits.join(" · ");
}

function renderSidebar() {
  const list = document.getElementById("place-list");
  const countEl = document.getElementById("place-count");
  const densityBtn = document.getElementById("place-density-btn");
  list.classList.toggle("compact", placeDense);
  densityBtn.textContent = placeDense ? "▤" : "▥";
  densityBtn.title = placeDense ? "Switch to gallery rows" : "Switch to compact rows";

  // The hint is re-created rather than hidden and kept: it lives *inside* the
  // list, so the innerHTML reset below destroys it, and a second render would
  // otherwise reach for a node that no longer exists.
  list.innerHTML = "";
  if (!places.length) {
    countEl.textContent = "";
    list.innerHTML = `<div id="no-places-hint">No places yet — draw a rectangle
      or circle on the map.</div>`;
    return;
  }
  const shown = filteredPlaces();
  // "8 of 63" only while something is narrowing the list, so the plain count
  // isn't dressed up as a filtered one.
  countEl.textContent = shown.length < places.length
    ? `${shown.length} of ${places.length}` : `${places.length}`;

  if (!shown.length) {
    list.innerHTML = placeQuery
      ? `<div id="no-places-hint">No place name matches “${escapeHtml(placeQuery)}”.</div>`
      : `<div id="no-places-hint">No places ${
          placeFilter === "with-photo" ? "have" : "are missing"} a representative photo.</div>`;
    return;
  }
  shown.forEach(p => {
    const div = document.createElement("div");
    div.className = "place-item" + (p.id === selectedPlaceId ? " selected" : "");
    div.dataset.id = p.id;

    // Representative photo shown as a thumbnail, with a Clear action when
    // present. The thumbnail is also the way into the picker — this page is the
    // only place a representative is chosen.
    const repThumb = p.representative_photo_id
      ? `<img class="place-rep-thumb" src="/api/thumbnail/${p.representative_photo_id}"
             alt="Representative photo" title="Click to choose a different photo"/>`
      : `<button class="rep-empty" title="Choose a representative photo from the photos taken here">
           <span class="rep-empty-icon">🖼</span><span class="rep-empty-text">Choose a photo</span>
         </button>`;
    const clearRepBtn = p.representative_photo_id
      ? `<button class="icon-btn clear-rep-btn" title="Remove representative photo">🚫</button>`
      : "";
    // A place is a search filter (Search's "nearby a saved place"), but until now
    // there was no way from here to the photos it stands for. Anchor, not a
    // button, so middle-click and "open in new tab" work. The count is already in
    // placeMeta above, so this is just the way there, not a second place to read it.
    const photosLink = p.photo_count
      ? `<a class="icon-btn photos-btn" href="/search.html?place_id=${p.id}"
            title="Search the ${p.photo_count} photo${p.photo_count === 1 ? "" : "s"} taken here">📷</a>`
      : "";

    div.innerHTML = `
      <div class="place-item-main">
        ${repThumb}
        <div class="place-item-body">
          <div class="place-item-name">${escapeHtml(p.name)}</div>
          <div class="place-item-meta">${escapeHtml(placeMeta(p))}</div>
        </div>
      </div>
      <div class="place-item-actions">
        ${photosLink}
        <button class="icon-btn zoom-btn" title="Zoom to this place">🔍</button>
        <button class="icon-btn rename-btn" title="Rename">✏️</button>
        ${clearRepBtn}
        <button class="icon-btn delete-btn" title="Delete">🗑️</button>
      </div>`;

    // The thumbnail (or its placeholder button) is the way into the picker.
    div.querySelector(".place-rep-thumb, .rep-empty").addEventListener("click", (e) => {
      e.stopPropagation();
      openRepPicker(p);
    });

    div.querySelector(".zoom-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectPlace(p.id);
    });
    div.querySelector(".rename-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      renamePlace(p);
    });
    div.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeletePlace(p);
    });
    const clearBtn = div.querySelector(".clear-rep-btn");
    if (clearBtn) clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearRepresentative(p);
    });
    // Row ↔ shape hover, so a row can be matched to its area without clicking —
    // the sidebar is a list of names and the map is a field of identical blue
    // rings, and neither alone says which is which.
    div.addEventListener("mouseenter", () => highlightPlace(p.id, true));
    div.addEventListener("mouseleave", () => highlightPlace(p.id, false));

    div.addEventListener("click", () => selectPlace(p.id));
    list.appendChild(div);
  });
}

/* ── Row ↔ shape highlight ── */

const PLACE_STYLE = { color: "#4a90d9", weight: 2, fillOpacity: 0.1 };
const PLACE_STYLE_HOVER = { color: "#7ab8f5", weight: 4, fillOpacity: 0.3 };

// `fromMap` distinguishes the two directions: hovering a row must not re-enter
// through the shape's own handler and hovering a shape must not fight the row's.
function highlightPlace(placeId, on, fromMap = false) {
  const shape = placeShapes[placeId];
  if (shape) {
    shape.setStyle(on ? PLACE_STYLE_HOVER : PLACE_STYLE);
    if (on && shape.bringToFront) shape.bringToFront();
  }
  if (!fromMap) return;
  document.querySelectorAll(".place-item").forEach(el => {
    if (parseInt(el.dataset.id) === placeId) el.classList.toggle("hover", on);
  });
}

function renderPlaces() {
  Object.values(placeShapes).forEach(shape => map.removeLayer(shape));
  placeShapes = {};

  places.forEach(p => {
    const bounds = JSON.parse(p.bounds);
    let shape;

    // No `draggable` here: core Leaflet ignores it on a path. Both shapes are
    // moved/resized by the marker handles below instead.
    if (p.type === "rectangle") {
      shape = L.rectangle([[bounds.south, bounds.west], [bounds.north, bounds.east]],
                          { ...PLACE_STYLE });
    } else if (p.type === "circle") {
      shape = L.circle([bounds.lat, bounds.lng], { radius: bounds.radius, ...PLACE_STYLE });
    }

    if (shape) {
      shape.on("click", () => selectPlace(p.id));
      shape.on("mouseover", () => highlightPlace(p.id, true, true));
      shape.on("mouseout", () => highlightPlace(p.id, false, true));
      shape.addTo(map);
      placeShapes[p.id] = shape;
    }
  });

  // Forced: the shapes are new and carry no tooltip yet, so the "permanence
  // hasn't changed" shortcut would leave every one of them unlabelled.
  applyPlaceLabels(true);

  // The shapes were just rebuilt, so the old handles point at layers that are
  // no longer on the map.
  clearShapeHandles();
  const selected = places.find(p => p.id === selectedPlaceId);
  if (selected) showShapeHandles(selected);
}

/* ── Map labels ──
 * Zoomed out, a name on every place is a wall of text over the tiles — and the
 * shapes are specks anyway. Zoomed in, the shapes are what you're working with
 * and the hover tooltip means the map can't be read without the mouse. So the
 * same tooltip is permanent past LABEL_ZOOM and hover-only below it; Leaflet
 * fixes permanence at bind time, hence the rebind. */

const LABEL_ZOOM = 12;
let labelsArePermanent = null;    // null = nothing bound yet

function applyPlaceLabels(force = false) {
  const permanent = map.getZoom() >= LABEL_ZOOM;
  if (!force && permanent === labelsArePermanent) return;
  labelsArePermanent = permanent;
  places.forEach(p => {
    const shape = placeShapes[p.id];
    if (!shape) return;
    shape.unbindTooltip();
    shape.bindTooltip(escapeHtml(p.name), {
      permanent, direction: "top", className: "place-label",
    });
  });
}

function selectPlace(placeId) {
  selectedPlaceId = placeId;
  // Clicking a shape on the map is a request to work on that place, so its row
  // has to be reachable — if the filter or the search box is hiding it, clear
  // both rather than silently selecting something the user can't see or edit.
  if (!filteredPlaces().some(p => p.id === placeId)) {
    placeFilter = "all";
    placeQuery = "";
    const sel = document.getElementById("place-filter");
    if (sel) sel.value = "all";
    const search = document.getElementById("place-search");
    if (search) search.value = "";
    renderSidebar();
  }
  let row = null;
  document.querySelectorAll(".place-item").forEach(el => {
    const isIt = parseInt(el.dataset.id) === placeId;
    el.classList.toggle("selected", isIt);
    if (isIt) row = el;
  });
  // `nearest` so a row already on screen doesn't jump the list around under a
  // sidebar click; only an off-screen one scrolls.
  if (row) row.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const shape = placeShapes[placeId];
  if (!shape) return;
  if (shape.getBounds) {
    map.fitBounds(shape.getBounds().pad(0.2), { maxZoom: 15 });
  }
  showShapeHandles(places.find(p => p.id === placeId));
}

/* ── Moving and resizing a place shape ──
 * The selected shape gets draggable markers — core Leaflet only drags markers;
 * `draggable: true` on a path needs the Leaflet.Path.Drag plugin, which this app
 * doesn't load. A circle gets a centre (move) and an east-edge (radius) handle;
 * a rectangle gets one handle per corner, each dragging that corner while its
 * diagonal opposite stays put.
 *
 * Every handle writes through updatePlaceBounds, which reads the live shape, so
 * there's one save path however the shape got where it is. */

const MIN_RADIUS_M = 2;          // same floor the draw tool enforces
const METERS_PER_DEG_LAT = 111320;

let moveHandle = null;
let radiusHandle = null;
let rectHandles = {};   // corner key ("nw"/"ne"/"se"/"sw") -> marker

function circleRadius(place) {
  try {
    const b = JSON.parse(place.bounds);
    return typeof b.radius === "number" ? b.radius : 0;
  } catch (err) {
    return 0;
  }
}

function formatRadius(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 2)} km`;
  return `${Math.round(m)} m`;
}


// Due east of the centre at `radius` metres. The cosine is floored so a place
// near a pole can't divide the offset up to infinity.
function edgeLatLng(center, radius) {
  const cos = Math.max(1e-6, Math.cos(center.lat * Math.PI / 180));
  return L.latLng(center.lat, center.lng + radius / (METERS_PER_DEG_LAT * cos));
}

function clearShapeHandles() {
  clearCircleHandles();
  clearRectHandles();
}

function showShapeHandles(place) {
  if (!place) return;
  if (place.type === "circle") showCircleHandles(place);
  else if (place.type === "rectangle") showRectangleHandles(place);
}

function clearCircleHandles() {
  [moveHandle, radiusHandle].forEach(h => { if (h) map.removeLayer(h); });
  moveHandle = null;
  radiusHandle = null;
}

function showCircleHandles(place) {
  clearShapeHandles();
  if (!place || place.type !== "circle") return;
  const shape = placeShapes[place.id];
  if (!shape || !shape.getRadius) return;

  const handle = (latlng, className, tooltip, direction) => L.marker(latlng, {
    draggable: true,
    icon: L.divIcon({ className, html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
    zIndexOffset: 1000,
  }).addTo(map).bindTooltip(tooltip, { direction });

  moveHandle = handle(shape.getLatLng(), "move-handle", "Drag to move", "left");
  radiusHandle = handle(edgeLatLng(shape.getLatLng(), shape.getRadius()),
                        "radius-handle", formatRadius(shape.getRadius()), "right");

  // Move: the circle follows the centre handle, and the edge handle rides along
  // so the radius it reports doesn't lie mid-drag.
  moveHandle.on("drag", () => {
    const c = moveHandle.getLatLng();
    shape.setLatLng(c);
    radiusHandle.setLatLng(edgeLatLng(c, shape.getRadius()));
  });
  moveHandle.on("dragend", () => updatePlaceBounds(place));

  // Resize: dragging anywhere works — it's the distance from the centre that
  // counts, not staying on the ring — so the handle only snaps back due east
  // once released. The centre is read live, since the move handle may have
  // shifted it since this listener was wired.
  radiusHandle.on("drag", () => {
    const c = shape.getLatLng();
    const r = Math.max(MIN_RADIUS_M, c.distanceTo(radiusHandle.getLatLng()));
    shape.setRadius(r);
    // The handle tooltip is the only live size readout now — the sidebar row
    // shows the name and photo, nothing about geometry.
    radiusHandle.setTooltipContent(formatRadius(r));
  });
  radiusHandle.on("dragend", async () => {
    radiusHandle.setLatLng(edgeLatLng(shape.getLatLng(), shape.getRadius()));
    await updatePlaceBounds(place);
  });
}

// Corner key -> opposite corner key. Dragging a corner resizes around the one
// diagonally across from it, same as the browser's own resize handles.
const RECT_OPPOSITE_CORNER = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

// Same floor onDrawEnd uses for a freshly-drawn rectangle (~3.3m at the equator).
const MIN_RECT_DEG = 0.00003;

function rectCorner(bounds, key) {
  return L.latLng(
    key[0] === "n" ? bounds.getNorth() : bounds.getSouth(),
    key[1] === "e" ? bounds.getEast() : bounds.getWest(),
  );
}

function clearRectHandles() {
  Object.values(rectHandles).forEach(h => { if (h) map.removeLayer(h); });
  rectHandles = {};
}

function showRectangleHandles(place) {
  clearShapeHandles();
  if (!place || place.type !== "rectangle") return;
  const shape = placeShapes[place.id];
  if (!shape || !shape.getBounds) return;

  Object.keys(RECT_OPPOSITE_CORNER).forEach(key => {
    const marker = L.marker(rectCorner(shape.getBounds(), key), {
      draggable: true,
      icon: L.divIcon({ className: "rect-handle", html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
      zIndexOffset: 1000,
    }).addTo(map).bindTooltip("Drag to resize", { direction: "top" });

    // The dragged corner and its fixed diagonal opposite define the new
    // rectangle; the other two corners (and their handles) follow along.
    marker.on("drag", () => {
      const fixed = rectCorner(shape.getBounds(), RECT_OPPOSITE_CORNER[key]);
      let dragged = marker.getLatLng();
      if (Math.abs(dragged.lat - fixed.lat) < MIN_RECT_DEG) {
        dragged = L.latLng(fixed.lat + Math.sign(dragged.lat - fixed.lat || 1) * MIN_RECT_DEG, dragged.lng);
      }
      if (Math.abs(dragged.lng - fixed.lng) < MIN_RECT_DEG) {
        dragged = L.latLng(dragged.lat, fixed.lng + Math.sign(dragged.lng - fixed.lng || 1) * MIN_RECT_DEG);
      }
      shape.setBounds(L.latLngBounds(fixed, dragged));
      const b = shape.getBounds();
      Object.entries(rectHandles).forEach(([k, m]) => m.setLatLng(rectCorner(b, k)));
    });
    marker.on("dragend", async () => {
      // Snap every handle back onto the saved shape's actual corners, same as
      // the circle's radius handle does after a drag that hit the size floor.
      const b = shape.getBounds();
      Object.entries(rectHandles).forEach(([k, m]) => m.setLatLng(rectCorner(b, k)));
      await updatePlaceBounds(place);
    });
    rectHandles[key] = marker;
  });
}

async function updatePlaceBounds(place) {
  const shape = placeShapes[place.id];
  if (!shape) return;

  let boundsData;
  if (place.type === "rectangle") {
    const b = shape.getBounds();
    boundsData = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  } else if (place.type === "circle") {
    const c = shape.getLatLng();
    boundsData = { lat: c.lat, lng: c.lng, radius: shape.getRadius() };
  }

  try {
    const res = await fetch(`/api/places/${place.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bounds: JSON.stringify(boundsData) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.bounds = JSON.stringify(boundsData);
    setStatus(place.type === "circle"
      ? `Updated "${place.name}" — radius ${formatRadius(boundsData.radius)}`
      : `Updated "${place.name}"`);
  } catch (err) {
    setStatus("Failed to update place: " + err.message, true);
    await loadPlaces();  // snap shape back to saved bounds
  }
}

async function renamePlace(place) {
  const answer = await openPlaceDialog({
    title: `Rename “${place.name}”`,
    name: place.name,
    submitLabel: "Rename",
    excludeId: place.id,          // its own name is not a clash
  });
  if (!answer) return;                     // cancelled
  const trimmed = answer.name;
  if (trimmed === place.name) return;

  try {
    const res = await fetch(`/api/places/${place.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.name = trimmed;
    setStatus(`Renamed to "${trimmed}"`);
    renderSidebar();
    renderPlaces();
  } catch (err) {
    setStatus("Failed to rename place: " + err.message, true);
  }
}

/* ── Representative photo picker ──
 * A place's representative photo is picked from the photos taken inside it —
 * that's the whole candidate set, so the picker is just those photos in a grid.
 * Newest first: the most recent visit is usually the one you remember.
 *
 * Bounds are the box the R*Tree query understands; a circle then gets an exact
 * distance pass client-side, since its bounding box overshoots the corners by
 * ~40%, which at a 5 km place is a lot of photos from down the road. */

const REP_PICKER_LIMIT = 200;

let repPickerPlace = null;

function placeBbox(place) {
  const b = JSON.parse(place.bounds);
  if (place.type === "rectangle") {
    return { min_lat: b.south, max_lat: b.north, min_lng: b.west, max_lng: b.east };
  }
  const latOff = b.radius / METERS_PER_DEG_LAT;
  const lngOff = b.radius / (METERS_PER_DEG_LAT * Math.max(1e-6, Math.cos(b.lat * Math.PI / 180)));
  return {
    min_lat: b.lat - latOff, max_lat: b.lat + latOff,
    min_lng: b.lng - lngOff, max_lng: b.lng + lngOff,
  };
}

function photosInsidePlace(place, photosList) {
  if (place.type !== "circle") return photosList;
  const b = JSON.parse(place.bounds);
  const center = L.latLng(b.lat, b.lng);
  return photosList.filter(p => center.distanceTo(L.latLng(p.lat, p.lng)) <= b.radius);
}

// Latest-only (common.js): open place A's picker, close it and open B's, and A's
// slower photo list must not fill B's grid. closeRepPicker cancels it too.
const openRepPicker = latestOnly(async (signal, place) => {
  repPickerPlace = place;
  const modal = document.getElementById("rep-picker-modal");
  const grid = document.getElementById("rep-picker-grid");
  document.getElementById("rep-picker-title").textContent = `Representative photo — ${place.name}`;
  document.getElementById("rep-picker-clear").style.display =
    place.representative_photo_id ? "" : "none";
  grid.innerHTML = `<div class="rep-picker-empty">Loading photos taken here…</div>`;
  modal.style.display = "";

  const box = placeBbox(place);
  // geotagged=yes + window=0: only photos actually located here, not the untagged
  // time-neighbours by-bounds folds in for the geocode page's benefit.
  const params = new URLSearchParams({ ...box, geotagged: "yes", window: "0" });
  try {
    const res = await fetch(`/api/photos/by-bounds?${params}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const found = await res.json();
    if (signal.aborted) return;
    const inside = photosInsidePlace(place, found);
    inside.reverse();                      // the endpoint sorts oldest-first
    renderRepPicker(inside.slice(0, REP_PICKER_LIMIT), inside.length);
  } catch (err) {
    if (signal.aborted) return;
    grid.innerHTML = `<div class="rep-picker-empty">Couldn't load photos: ${escapeHtml(err.message)}</div>`;
  }
});

function renderRepPicker(shown, total) {
  const grid = document.getElementById("rep-picker-grid");
  grid.innerHTML = "";
  if (!shown.length) {
    grid.innerHTML = `<div class="rep-picker-empty">No geotagged photos inside this place yet.
      Tag some on the Geocode page, or widen the circle.</div>`;
    return;
  }

  shown.forEach(photo => {
    const cell = document.createElement("button");
    cell.className = "rep-picker-cell" +
      (photo.id === repPickerPlace.representative_photo_id ? " selected" : "");
    cell.title = photo.filename;
    cell.innerHTML = `<img src="/api/thumbnail/${photo.id}" loading="lazy" alt=""/>`;
    cell.addEventListener("click", () => setRepresentative(repPickerPlace, photo.id));
    grid.appendChild(cell);
  });

  if (total > shown.length) {
    const note = document.createElement("div");
    note.className = "rep-picker-note";
    note.textContent = `Showing the ${shown.length} most recent of ${total} photos here.`;
    grid.appendChild(note);
  }
}

function closeRepPicker() {
  openRepPicker.cancel();
  document.getElementById("rep-picker-modal").style.display = "none";
  repPickerPlace = null;
}

async function setRepresentative(place, photoId) {
  try {
    const res = await fetch(`/api/places/${place.id}/representative`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_id: photoId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.representative_photo_id = photoId;
    setStatus(`Set the representative photo for "${place.name}"`);
    closeRepPicker();
    renderSidebar();
  } catch (err) {
    setStatus("Failed to set representative: " + err.message, true);
  }
}

async function clearRepresentative(place) {
  try {
    const res = await fetch(`/api/places/${place.id}/representative`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_id: null }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    place.representative_photo_id = null;
    setStatus(`Cleared representative photo for "${place.name}"`);
    renderSidebar();
  } catch (err) {
    setStatus("Failed to clear representative: " + err.message, true);
  }
}

async function confirmDeletePlace(place) {
  const ok = await confirmDialog({
    title: `Delete “${place.name}”?`,
    message: typeof place.photo_count === "number" && place.photo_count
      ? `The ${place.photo_count} photo${place.photo_count === 1 ? "" : "s"} taken here keep `
        + "their coordinates — only the name and the shape go."
      : "Only the name and the shape go; no photo is changed.",
    confirmLabel: "Delete place",
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/places/${place.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Place "${place.name}" deleted`);
    if (selectedPlaceId === place.id) selectedPlaceId = null;
    await loadPlaces();
    // Whatever this place was covering is an unnamed hotspot again.
    if (showHotspots) await loadHotspots();
  } catch (err) {
    setStatus("Error deleting place: " + err.message, true);
  }
}

/* ── Hotspots ──
 * The places you keep tagging at but never named. /api/geotag/hotspots mines
 * them from the coordinates already on the photos and clusters them, so drops a
 * few hundred feet apart at one real place count as one entry. Shown here only
 * on request, because they are noise once the ones worth keeping are named.
 *
 * A hotspot is already the shape of a named place — a point you come back to —
 * so promoting one is a name away, and beats redrawing it by hand. It saves as
 * a circle at the server's own cluster merge radius: any smaller and drops the
 * server considers the same place would fall outside the shape.
 *
 * hide_named=true means a hotspot a saved place already covers isn't returned,
 * so naming one makes it leave this list on the next load — that disappearance
 * is the confirmation. */

let hotspots = [];
let hotspotShapes = [];
let hotspotSort = "count";
let showHotspots = false;
let hotspotInView = false;    // narrow the list to the map's current view
let hotspotTotal = 0;         // how many matched before the server's limit slice
let hotspotMoveTimer = null;
let selectedHotspotKey = null;   // highlighted row, identified by its coordinate
let hotspotLoading = false;      // guards the Load-more button against double-fire

const hotspotKey = (h) => `${h.lat.toFixed(5)},${h.lng.toFixed(5)}`;
// Overwritten from the API's own merge_meters, so the drawn shape can't drift
// out of step with the clustering it came from.
let hotspotRadius = 100;

const HOTSPOT_LIMIT = 60;

/* ── Suggest a new place ──
 * The Hotspots list above is opt-in — accurate, but easy to never look at. This
 * is the same data (/api/geotag/hotspots, hide_named=true) surfaced without
 * asking: the single busiest coordinate the propose bar keeps landing on that
 * still has no name, shown as a standing banner once it clears a minimum photo
 * count. Dismissing one is remembered per browser by coordinate, same as
 * placeDense — it comes back only if that hotspot keeps growing after a refresh
 * and a fresh candidate takes its place, since a genuinely dismissed spot stays
 * hidden until it's named or a bigger one displaces it in the API's own order. */

const SUGGEST_MIN_COUNT = 10;
const SUGGEST_DISMISS_KEY = "dismissedPlaceSuggestions";

let suggestedPlace = null;

function dismissedSuggestions() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SUGGEST_DISMISS_KEY) || "[]"));
  } catch (err) {
    return new Set();
  }
}

function dismissSuggestion(key) {
  const set = dismissedSuggestions();
  set.add(key);
  try {
    localStorage.setItem(SUGGEST_DISMISS_KEY, JSON.stringify([...set]));
  } catch (err) {
    // Private-mode/blocked storage: the dismiss just won't stick across reloads.
  }
}

async function loadSuggestion() {
  try {
    // A handful of candidates, not just one — the top hit might be a dismissed
    // spot, and the next one down is still worth surfacing.
    const params = new URLSearchParams({ limit: "5", hide_named: "true", sort: "count" });
    const res = await fetch(`/api/geotag/hotspots?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const dismissed = dismissedSuggestions();
    suggestedPlace = (data.hotspots || []).find(
      h => h.count >= SUGGEST_MIN_COUNT && !dismissed.has(hotspotKey(h))) || null;
    // Shared with the Hotspots overlay's own circles — same clustering, same radius.
    if (data.merge_meters) hotspotRadius = data.merge_meters;
  } catch (err) {
    suggestedPlace = null;
  }
  renderSuggestion();
}

function zoomToSuggestion() {
  if (!suggestedPlace) return;
  // getBounds() needs the circle on the map to know its projection — added and
  // immediately removed, since this is a one-shot fit, not a drawn shape.
  const circle = L.circle([suggestedPlace.lat, suggestedPlace.lng], { radius: hotspotRadius }).addTo(map);
  map.fitBounds(circle.getBounds().pad(0.6), { maxZoom: 17 });
  map.removeLayer(circle);
}

function renderSuggestion() {
  const banner = document.getElementById("suggest-place-banner");
  if (!suggestedPlace) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "";
  document.getElementById("suggest-place-label").textContent = suggestedPlace.label;
  document.getElementById("suggest-place-meta").textContent =
    `${suggestedPlace.count} photos here — no place named yet`;
}

// The map's view as the API's four bounds, or null for "don't filter". Leaflet
// reports longitudes outside ±180 once you pan past the antimeridian, so they're
// wrapped back — a view straddling it then arrives as min_lng > max_lng, which
// hotspots_service.in_bbox reads as a wrapped box.
function viewBbox() {
  const b = map.getBounds();
  if (b.getEast() - b.getWest() >= 360) return null;   // whole world in view
  const wrap = (lng) => ((lng + 180) % 360 + 360) % 360 - 180;
  return {
    min_lat: Math.max(-90, b.getSouth()),
    max_lat: Math.min(90, b.getNorth()),
    min_lng: wrap(b.getWest()),
    max_lng: wrap(b.getEast()),
  };
}

// `append` asks the server for the page after what's already loaded instead of
// the first one — the list is a queue to work through, and 2000 hotspots at 60
// a go is otherwise unreachable past the first screen.
//
// Latest-only (common.js): every settled pan, sort change and Load-more starts
// one, and a slower earlier answer (a different view or sort) must not replace
// the newer list. clearHotspots cancels it when the overlay is switched off.
const loadHotspots = latestOnly(async (signal, { append = false } = {}) => {
  const list = document.getElementById("hotspot-list");
  document.getElementById("hotspot-section").style.display = "";
  if (!append && !hotspots.length) list.innerHTML = `<div class="hotspot-empty">Loading…</div>`;

  const params = new URLSearchParams({
    limit: String(HOTSPOT_LIMIT), hide_named: "true", sort: hotspotSort,
    offset: String(append ? hotspots.length : 0),
  });
  const box = hotspotInView ? viewBbox() : null;
  if (box) Object.entries(box).forEach(([k, v]) => params.set(k, v));

  hotspotLoading = true;
  let failure = null;
  // U4: a refresh (pan, sort) over rows already listed holds them busy until the
  // new page lands; an append keeps them live (its Load-more button says it's
  // loading). A superseded call's release is a no-op (setBusy hold tokens), and
  // cancel() aborts this call, whose finally then releases.
  const release = !append && hotspots.length ? setBusy(list, true, "Loading hotspots…") : () => {};
  try {
    const res = await fetch(`/api/geotag/hotspots?${params}`, { signal });
    if (!res.ok) throw new Error(await httpErrorMessage(res));
    const data = await res.json();
    if (signal.aborted) return;   // the newer call owns hotspotLoading and the list
    const page = data.hotspots || [];
    hotspots = append ? hotspots.concat(page) : page;
    hotspotTotal = data.total ?? hotspots.length;
    if (data.merge_meters) hotspotRadius = data.merge_meters;
  } catch (err) {
    if (signal.aborted) return;
    failure = err;
  } finally {
    release();
  }
  // Cleared before rendering, not in a `finally` after it: the Load-more button
  // reads this flag to decide whether it draws itself disabled.
  hotspotLoading = false;

  if (!failure) { renderHotspots(); return; }
  // A failed *next* page leaves what's already loaded alone — losing the rows
  // you were working through would be a worse answer than a missing page.
  if (append) {
    setStatus("Couldn't load more hotspots: " + failure.message, true);
    renderHotspots();
    return;
  }
  hotspots = [];
  renderHotspotShapes();
  list.innerHTML = `<div class="hotspot-empty">Couldn't load hotspots: ${escapeHtml(failure.message)}</div>`;
  document.getElementById("hotspot-count").textContent = "";
});

// Panning is continuous and the query is a full clustering pass, so the refresh
// waits for the map to settle rather than firing on every frame of a drag.
function onMapMovedForHotspots() {
  if (!showHotspots || !hotspotInView) return;
  clearTimeout(hotspotMoveTimer);
  hotspotMoveTimer = setTimeout(loadHotspots, 350);
}

function clearHotspots() {
  // A load still in flight would redraw the overlay we're switching off.
  clearTimeout(hotspotMoveTimer);
  loadHotspots.cancel();
  hotspotLoading = false;
  hotspots = [];
  renderHotspotShapes();
  document.getElementById("hotspot-section").style.display = "none";
}

function renderHotspots() {
  renderHotspotShapes();
  renderHotspotSidebar();
}

function renderHotspotShapes() {
  hotspotShapes.forEach(s => map.removeLayer(s));
  hotspotShapes = [];
  if (!showHotspots) return;

  hotspots.forEach((h, i) => {
    // L.circle, not L.circleMarker — the ring is metres on the ground, and it is
    // exactly the shape the place would be saved as.
    const circle = L.circle([h.lat, h.lng], {
      radius: hotspotRadius,
      color: "#e0a040", weight: 2, fillOpacity: 0.12, dashArray: "5,4",
    });
    circle.bindTooltip(`${escapeHtml(h.label)} ·${h.count} photo${h.count !== 1 ? "s" : ""}`,
                       { direction: "top" });
    circle.on("click", () => selectHotspot(i));
    circle.addTo(map);
    hotspotShapes.push(circle);
  });
}

function renderHotspotSidebar() {
  const list = document.getElementById("hotspot-list");
  const count = document.getElementById("hotspot-count");
  list.innerHTML = "";
  // "40 of 112" when the server's limit cut the list short, so a short list in a
  // busy area doesn't read as the whole truth.
  count.textContent = !hotspots.length ? ""
    : (hotspotTotal > hotspots.length ? `${hotspots.length} of ${hotspotTotal}` : `${hotspots.length}`)
      + (hotspotInView ? " in view" : "");

  if (!hotspots.length) {
    list.innerHTML = hotspotInView
      ? `<div class="hotspot-empty">No unnamed hotspots in this view — pan or zoom out,
         or untick "Only in view".</div>`
      : `<div class="hotspot-empty">Nothing unnamed left — every recurring
         spot in your photos is already covered by a place above.</div>`;
    return;
  }

  hotspots.forEach((h, i) => {
    const div = document.createElement("div");
    div.className = "hotspot-item";
    div.dataset.idx = i;

    const thumb = h.sample_photo_id
      ? `<img class="hotspot-thumb" src="/api/thumbnail/${h.sample_photo_id}"
             alt="" title="A photo tagged here"/>`
      : "";

    div.innerHTML = `
      ${thumb}
      <div class="hotspot-body">
        <div class="hotspot-label">${escapeHtml(h.label)}</div>
        <div class="hotspot-meta">${h.count} photo${h.count !== 1 ? "s" : ""}${
          h.last_ts ? ` · last ${formatWallClockDate(h.last_ts)}` : ""}</div>
        <div class="hotspot-actions">
          <button class="zoom-btn">Zoom</button>
          <button class="name-btn primary">✏️ Name it…</button>
        </div>
      </div>`;

    div.querySelector(".zoom-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectHotspot(i);
    });
    div.querySelector(".name-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      savePlaceFromHotspot(h);
    });
    div.addEventListener("click", () => selectHotspot(i));
    list.appendChild(div);
  });

  // The tail of a long list. Appends the next page rather than replacing the
  // list, so rows already scrolled past stay where they were.
  if (hotspots.length < hotspotTotal) {
    const more = document.createElement("button");
    more.id = "hotspot-more-btn";
    more.textContent = hotspotLoading
      ? "Loading…"
      : `Load ${Math.min(HOTSPOT_LIMIT, hotspotTotal - hotspots.length)} more`;
    more.disabled = hotspotLoading;
    more.addEventListener("click", () => {
      if (hotspotLoading) return;
      more.disabled = true;
      // The footer spinner (U4): an append leaves the rows above live.
      more.innerHTML = `<span class="spinner" aria-hidden="true"></span> Loading…`;
      loadHotspots({ append: true });
    });
    list.appendChild(more);
  }

  markSelectedHotspot();
}

function selectHotspot(idx) {
  const h = hotspots[idx];
  // Zooming fires moveend, which in "only in view" mode reloads and re-renders
  // the list — so the highlight is remembered by coordinate, not by row index.
  selectedHotspotKey = h ? hotspotKey(h) : null;
  markSelectedHotspot();
  const shape = hotspotShapes[idx];
  if (shape) map.fitBounds(shape.getBounds().pad(0.6), { maxZoom: 17 });
}

function markSelectedHotspot() {
  document.querySelectorAll(".hotspot-item").forEach(el => {
    const h = hotspots[Number(el.dataset.idx)];
    el.classList.toggle("selected", !!h && hotspotKey(h) === selectedHotspotKey);
  });
}

// The geocoded label is only a suggestion — it names the neighbourhood, not the
// place ("Elm St, Springfield" for what you'd call "Mom's house"), so the dialog
// starts there, selected, and expects to be typed over.
async function savePlaceFromHotspot(h) {
  const answer = await openPlaceDialog({
    title: "Name this place",
    name: h.label,
    // Offered rather than imposed: the merge radius is the smallest circle that
    // covers the cluster, but a driveway and a state park are both one hotspot.
    radius: hotspotRadius,
    submitLabel: "Save place",
  });
  if (!answer) return;                       // cancelled
  const trimmed = answer.name;

  const bounds = { lat: h.lat, lng: h.lng, radius: answer.radius };
  try {
    const res = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed, type: "circle", bounds: JSON.stringify(bounds) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPlaces();
    // Dropped locally rather than by refetching: a refetch would restart at page
    // one and throw away however many pages you had loaded to get here. The
    // server would suppress this hotspot anyway on the next real load.
    if (showHotspots) {
      const key = hotspotKey(h);
      hotspots = hotspots.filter(x => hotspotKey(x) !== key);
      hotspotTotal = Math.max(hotspots.length, hotspotTotal - 1);
      renderHotspots();
    }
    // The just-named spot no longer qualifies (hide_named drops it server-side);
    // a smaller one might now be the top candidate.
    await loadSuggestion();
    setStatus(`Saved "${trimmed}" as a place (${Math.round(answer.radius)} m radius).`);
  } catch (err) {
    setStatus("Could not save place: " + err.message, true);
  }
}

/* ── Dialogs ──
 * window.prompt/confirm can only ask one question and can't answer back, so a
 * place had to be named blind and resized afterwards, and a clashing name went
 * unnoticed until the list showed two rows with the same label. These take the
 * name and the radius together and check the name against the existing places
 * while it's being typed.
 *
 * Both return a promise that settles when the user chooses, so the call sites
 * stay in the same straight-line shape they had around prompt(). */

let placeDialogDone = null;      // resolver for the open place dialog, if any
let confirmDialogDone = null;
let placeDialogExcludeId = null; // the place being renamed, exempt from the clash check

// `radius` null hides that field — renaming has the map's drag handles for
// geometry, so only creation asks for a size.
function openPlaceDialog({ title, name = "", radius = null, submitLabel = "Save", excludeId = null }) {
  const modal = document.getElementById("place-dialog");
  const nameInput = document.getElementById("place-dialog-name");
  const radiusField = document.getElementById("place-dialog-radius-field");
  const radiusInput = document.getElementById("place-dialog-radius");
  const hint = document.getElementById("place-dialog-hint");

  document.getElementById("place-dialog-title").textContent = title;
  document.getElementById("place-dialog-save").textContent = submitLabel;
  nameInput.value = name;
  radiusField.hidden = radius === null;
  if (radius !== null) radiusInput.value = String(Math.round(radius));
  hint.textContent = radius === null
    ? "" : "Photos inside this radius count as taken here.";
  placeDialogExcludeId = excludeId;
  checkDuplicateName();

  modal.style.display = "";
  nameInput.focus();
  nameInput.select();

  return new Promise(resolve => { placeDialogDone = resolve; });
}

// A warning, not a block: two houses called "Home" in different towns is a
// reasonable thing to want, and only the user knows whether this is that.
function checkDuplicateName() {
  const value = document.getElementById("place-dialog-name").value.trim().toLowerCase();
  const dupe = document.getElementById("place-dialog-dupe");
  const clash = value && places.some(p =>
    p.id !== placeDialogExcludeId && p.name.trim().toLowerCase() === value);
  dupe.hidden = !clash;
  if (clash) dupe.textContent = `Another place is already called “${
    document.getElementById("place-dialog-name").value.trim()}”.`;
  document.getElementById("place-dialog-save").disabled = !value;
}

function closePlaceDialog(result) {
  document.getElementById("place-dialog").style.display = "none";
  const done = placeDialogDone;
  placeDialogDone = null;
  if (done) done(result);
}

function submitPlaceDialog() {
  const name = document.getElementById("place-dialog-name").value.trim();
  if (!name) return;                                  // Save is disabled anyway
  const radiusField = document.getElementById("place-dialog-radius-field");
  let radius = null;
  if (!radiusField.hidden) {
    radius = Number(document.getElementById("place-dialog-radius").value);
    if (!isFinite(radius) || radius < MIN_RADIUS_M) radius = MIN_RADIUS_M;
  }
  closePlaceDialog({ name, radius });
}

function confirmDialog({ title, message, confirmLabel = "Delete" }) {
  document.getElementById("confirm-dialog-title").textContent = title;
  document.getElementById("confirm-dialog-body").textContent = message;
  document.getElementById("confirm-dialog-ok").textContent = confirmLabel;
  document.getElementById("confirm-dialog").style.display = "";
  document.getElementById("confirm-dialog-ok").focus();
  return new Promise(resolve => { confirmDialogDone = resolve; });
}

function closeConfirmDialog(result) {
  document.getElementById("confirm-dialog").style.display = "none";
  const done = confirmDialogDone;
  confirmDialogDone = null;
  if (done) done(result);
}

function bindDialogs() {
  const nameInput = document.getElementById("place-dialog-name");
  nameInput.addEventListener("input", checkDuplicateName);
  // Enter anywhere in the form saves; the dialog has no <form>, so this is the
  // keyboard path a form would have given for free.
  document.getElementById("place-dialog-content").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitPlaceDialog(); }
  });
  document.getElementById("place-dialog-save").addEventListener("click", submitPlaceDialog);
  document.getElementById("place-dialog-cancel").addEventListener("click", () => closePlaceDialog(null));
  document.getElementById("place-dialog").addEventListener("click", (e) => {
    if (e.target.id === "place-dialog") closePlaceDialog(null);
  });

  document.getElementById("confirm-dialog-ok").addEventListener("click", () => closeConfirmDialog(true));
  document.getElementById("confirm-dialog-cancel").addEventListener("click", () => closeConfirmDialog(false));
  document.getElementById("confirm-dialog").addEventListener("click", (e) => {
    if (e.target.id === "confirm-dialog") closeConfirmDialog(false);
  });
}

/* ── Drawing (click-drag rectangle/circle) ── */
function startDrawing(type) {
  if (drawingMode) stopDrawing();

  drawingMode = type;
  document.getElementById(`draw-${type}-btn`).classList.add("active");
  setStatus(`Drawing ${type}… click, hold and drag to set size, then release`);
  map.getContainer().style.cursor = "crosshair";
  map.dragging.disable();
  map.once("mousedown", onDrawStart);
}

function stopDrawing() {
  document.querySelectorAll("#draw-rectangle-btn, #draw-circle-btn")
    .forEach(b => b.classList.remove("active"));
  drawingMode = null;
  map.getContainer().style.cursor = "";
  map.off("mousedown", onDrawStart);
  map.off("mousemove", onDrawMove);
  map.off("mouseup", onDrawEnd);
  map.dragging.enable();
  if (drawingShape) { map.removeLayer(drawingShape); drawingShape = null; }
}

function onDrawStart(e) {
  drawStartLatLng = e.latlng;
  if (drawingMode === "rectangle") {
    drawingShape = L.rectangle([e.latlng, e.latlng], {
      color: "#e0a040", weight: 2, fillOpacity: 0.2,
    }).addTo(map);
  } else if (drawingMode === "circle") {
    drawingShape = L.circle(e.latlng, {
      radius: 0, color: "#e0a040", weight: 2, fillOpacity: 0.2,
    }).addTo(map);
  }
  map.on("mousemove", onDrawMove);
  map.once("mouseup", onDrawEnd);
}

function onDrawMove(e) {
  if (!drawingShape || !drawStartLatLng) return;
  if (drawingMode === "rectangle") {
    drawingShape.setBounds([drawStartLatLng, e.latlng]);
  } else if (drawingMode === "circle") {
    drawingShape.setRadius(drawStartLatLng.distanceTo(e.latlng));
  }
}

async function onDrawEnd(e) {
  map.off("mousemove", onDrawMove);

  if (!drawingShape || !drawStartLatLng) { stopDrawing(); return; }

  // Minimum size guard
  let tooSmall = false;
  if (drawingMode === "rectangle") {
    const b = drawingShape.getBounds();
    const width = Math.abs(b.getEast() - b.getWest());
    const height = Math.abs(b.getNorth() - b.getSouth());
    tooSmall = width < 0.00003 || height < 0.00003;  // ~3.3m at equator
  } else if (drawingMode === "circle") {
    tooSmall = drawingShape.getRadius() < 2;  // 2m minimum
  }
  if (tooSmall) {
    // A status line, not an alert(): nothing was created, so there is nothing to
    // acknowledge — the drag just didn't take.
    setStatus("That shape is too small — drag further to set its size.", true);
    stopDrawing();
    return;
  }

  const type = drawingMode;  // stopDrawing() clears drawingMode
  // The shape stays on the map behind the dialog, so the name is chosen with the
  // area in sight.
  const answer = await openPlaceDialog({
    title: `Name this ${type}`,
    radius: type === "circle" ? drawingShape.getRadius() : null,
    submitLabel: "Save place",
  });
  if (!answer) { stopDrawing(); return; }
  const name = answer.name;

  let boundsData;
  if (type === "rectangle") {
    const b = drawingShape.getBounds();
    boundsData = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  } else {
    const c = drawingShape.getLatLng();
    // The dialog's radius wins over the drag: it's the later, more deliberate
    // number, and it is what the field showed when Save was pressed.
    boundsData = { lat: c.lat, lng: c.lng, radius: answer.radius };
  }

  try {
    const res = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type, bounds: JSON.stringify(boundsData) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Place "${name}" saved`);
    stopDrawing();
    await loadPlaces();
  } catch (err) {
    setStatus("Error saving place: " + err.message, true);
    stopDrawing();
  }
}

/* ── Helpers ── */
function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.className = isError ? "error" : "";
}
