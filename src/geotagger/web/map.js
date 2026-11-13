/* Places DB map — plots the GeoNames reference data (the populated places
 * geocode.py reverse-geocodes photo coordinates against), not photos. Lets
 * you check what place name a location in your library would resolve to.
 *
 * The GeoNames cities500 set has ~200k entries worldwide, so nothing is
 * fetched until the map is zoomed in past MIN_ZOOM_FOR_MARKERS; below that a
 * hint is shown instead. Once zoomed in, places within the current viewport
 * are fetched from /api/geocode/places and plotted with Leaflet.markercluster.
 * The server caps how many it returns per request and, when capped, prefers
 * the largest places by population so the view stays representative.
 *
 * Past MIN_ZOOM_FOR_VORONOI, /api/geocode/voronoi additionally supplies each
 * place's cell — the area a coordinate must fall in to reverse-geocode to that
 * place — drawn as a translucent colored polygon underneath the markers so you
 * can see where the boundary between two places actually falls. With the
 * population-weighted lookup on (the default) those boundaries are curved and
 * the server traces them off a grid, so a cell can come back as more than one
 * ring; `cell.polygons` carries them all.
 *
 * Past MIN_ZOOM_FOR_OSM, /api/geocode/osm-places additionally supplies real
 * OSM boundaries (cities, parks, stadiums, campuses, neighborhoods, named
 * buildings) as a GeoJSON FeatureCollection, rendered with Leaflet's built-in
 * L.geoJSON() layer (no extra plugin needed — GeoJSON support is core Leaflet).
 *
 * Past MIN_ZOOM_FOR_CENSUS, /api/geocode/census-places can overlay US Census place
 * boundaries (incorporated places + CDPs) — the source consulted after OSM and
 * before the GeoNames nearest-place estimate. Off by default: these tile the map
 * wall-to-wall, so they're drawn dashed and unfilled and only when asked for.
 *
 * /api/geocode/zctas is the same deal for ZIP code areas (past MIN_ZOOM_FOR_ZCTA),
 * the step below Census places in that chain. Each polygon is labeled with its code
 * and mailing city, since a ZIP boundary is invisible on the basemap underneath.
 *
 * All four boundary overlays are toggled from Leaflet's own layers control (top
 * right); the basemap switcher is a separate custom control in the opposite corner.
 * Whether an overlay is on is read straight off map.hasLayer() rather than tracked
 * alongside it, and toggling one triggers that overlay's viewport fetch — nothing is
 * requested for a layer you haven't turned on.
 *
 * Named buildings vastly outnumber every other OSM category and are only
 * meaningful once you can see individual rooftops, so they're held back
 * behind their own, deeper MIN_ZOOM_FOR_BUILDINGS threshold — the osm-places
 * request omits them (buildings=false) below that zoom, rather than fetching
 * and then hiding them.
 */

const MIN_ZOOM_FOR_MARKERS = 8;
const MIN_ZOOM_FOR_VORONOI = 11;
const MIN_ZOOM_FOR_OSM = 11;
const MIN_ZOOM_FOR_CENSUS = 9;   // whole-place polygons, readable further out than OSM's features
// ZIP areas are a metro-scale layer: a labeled polygon per ZIP is unreadable (and a
// large payload) once the view spans several states. Leaflet zoom z is
// ~156543*cos(lat)/2^z metres per pixel, so at Houston's latitude a ~1400px-wide
// window covers roughly 370 km at z9, 185 km at z10, 95 km at z11 — z10 is the
// "whole metro, ~50 mile radius" view, and anything wider stays blank rather than
// fetching.
const MIN_ZOOM_FOR_ZCTA = 10;
const MIN_ZOOM_FOR_BUILDINGS = 17;
const REFRESH_DEBOUNCE_MS = 250;

// Distinct color per OSM place category so a stadium vs. a park vs. a campus
// reads at a glance. Keep in sync with build_osm_places.classify categories.
const OSM_CATEGORY_COLORS = {
  city: "#4f8cff",
  neighbourhood: "#00b3a4",
  park: "#3fbf5f",
  venue: "#ff8c42",
  campus: "#a06bff",
  attraction: "#ff5fa2",
  building: "#9aa0a6",
};

let map;
let markerCluster = null;
let voronoiLayer = null;
let osmLayer = null;
let censusLayer = null;
let zctaLayer = null;
let probeSeq = 0;
let refreshTimer = null;
let fetchSeq = 0;
let voronoiFetchSeq = 0;
let osmFetchSeq = 0;
let censusFetchSeq = 0;
let zctaFetchSeq = 0;

// Basemap definitions + switcher (and correctWorldWrap) live in basemaps.js.

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  fitToLibrary();
});

function initMap() {
  map = L.map("map").setView([20, 0], 2);
  setBasemap("street");
  addBasemapControl();

  // Added before the marker layer so cell polygons render underneath markers.
  // osmLayer is added after voronoiLayer so its outlines draw over the
  // translucent Voronoi fills; both stay under the marker pane.
  voronoiLayer = L.layerGroup().addTo(map);
  // interactive:false so clicks fall through to the map's own click handler
  // (probePoint) everywhere — including inside an OSM polygon — instead of the
  // polygon swallowing the click. The polygon's name still surfaces: probePoint
  // reverse-geocodes the clicked point, and the containing city/feature come back
  // as the geocode result.
  osmLayer = L.geoJSON(null, { style: osmFeatureStyle, interactive: false }).addTo(map);
  // Census place boundaries, drawn dashed so they read as a different source than
  // the OSM outlines they sit next to (and often overlap). Not added to the map:
  // these tile the country wall-to-wall, so they start off in the layers control.
  censusLayer = L.geoJSON(null, { style: censusFeatureStyle, interactive: false });
  // ZIP areas get a label per polygon (the code is the whole point of the layer, and
  // unlike a place name it isn't guessable from the map underneath). Also off by default.
  zctaLayer = L.geoJSON(null, {
    style: zctaFeatureStyle,
    interactive: false,
    onEachFeature: addZctaLabel,
  });
  markerCluster = L.markerClusterGroup({ maxClusterRadius: 60 });
  map.addLayer(markerCluster);

  addOverlayControl();

  map.on("moveend", correctWorldWrap);
  map.on("moveend zoomend", scheduleRefresh);
  map.on("click", probePoint);
}

// Each overlay's data is fetched per viewport, so toggling one on has to kick off
// its own fetch rather than just revealing already-drawn geometry — hence the
// refresh per entry, keyed by the control's own label.
const OVERLAY_REFRESH = {
  "Place boundaries": refreshVoronoi,
  "OSM places": refreshOsm,
  "Census places": refreshCensus,
  "ZIP areas": refreshZctas,
};

function addOverlayControl() {
  L.control.layers(null, {
    "Place boundaries": voronoiLayer,
    "OSM places": osmLayer,
    "Census places": censusLayer,
    "ZIP areas": zctaLayer,
  }, { collapsed: true, position: "topright" }).addTo(map);

  // map.hasLayer() is the single source of truth for whether an overlay is on —
  // the control mutates that directly, so there are no parallel enabled flags to
  // drift out of sync with it.
  map.on("overlayadd overlayremove", (e) => {
    const refresh = OVERLAY_REFRESH[e.name];
    if (refresh) refresh();
    updateZoomHint();  // the layer may be one this zoom is too far out to draw
  });
}

async function fitToLibrary() {
  try {
    const res = await fetch("/api/stats/bounds");
    const data = await res.json();
    if (data.has_data) {
      map.fitBounds(
        [[data.min_lat, data.min_lng], [data.max_lat, data.max_lng]],
        { padding: [40, 40] }
      );
    }
  } catch (e) {
    // keep default world view
  }
  refreshMarkers();
  refreshVoronoi();
  refreshOsm();
  refreshCensus();
  refreshZctas();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshMarkers();
    refreshVoronoi();
    refreshOsm();
    refreshCensus();
    refreshZctas();
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshMarkers() {
  const zoom = map.getZoom();
  if (zoom < MIN_ZOOM_FOR_MARKERS) {
    markerCluster.clearLayers();
    showHint("Zoom in to see reverse-geocode places");
    setStatus("");
    return;
  }
  hideHint();

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++fetchSeq;
  setStatus("Loading places…");
  try {
    const res = await fetch(`/api/geocode/places?bbox=${encodeURIComponent(bbox)}`);
    if (res.status === 503) {
      markerCluster.clearLayers();
      showHint("GeoNames data not installed — run scripts/get_geonames.py");
      setStatus("");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== fetchSeq) return; // a newer request superseded this one
    renderMarkers(data.places);
    updateZoomHint();
    const shown = data.places.length.toLocaleString();
    setStatus(data.truncated
      ? `Showing ${shown} largest of ${data.total.toLocaleString()} places in view — zoom in for the rest`
      : `${shown} place${data.places.length === 1 ? "" : "s"} in view`);
  } catch (e) {
    if (seq === fetchSeq) setStatus("Error loading places: " + e.message, true);
  }
}

// Each overlay only draws past its own zoom threshold, so an overlay switched on
// from too far out would silently show nothing and read as broken. Say so instead.
// Below MIN_ZOOM_FOR_MARKERS the hint belongs to refreshMarkers, which is a stronger
// message ("nothing at all is loaded here") — don't fight it for the element.
function updateZoomHint() {
  const zoom = map.getZoom();
  if (zoom < MIN_ZOOM_FOR_MARKERS) return;
  const waiting = [
    [voronoiLayer, MIN_ZOOM_FOR_VORONOI, "place boundaries"],
    [osmLayer, MIN_ZOOM_FOR_OSM, "OSM places"],
    [censusLayer, MIN_ZOOM_FOR_CENSUS, "Census places"],
    [zctaLayer, MIN_ZOOM_FOR_ZCTA, "ZIP areas"],
  ].filter(([layer, min]) => map.hasLayer(layer) && zoom < min).map(([, , label]) => label);
  if (waiting.length) showHint(`Zoom in further to see ${waiting.join(", ")}`);
  else hideHint();
}

async function refreshVoronoi() {
  const zoom = map.getZoom();
  if (!map.hasLayer(voronoiLayer) || zoom < MIN_ZOOM_FOR_VORONOI) {
    voronoiLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++voronoiFetchSeq;
  try {
    const res = await fetch(`/api/geocode/voronoi?bbox=${encodeURIComponent(bbox)}`);
    if (!res.ok) return; // the marker fetch already surfaces load errors in the status bar
    const data = await res.json();
    if (seq !== voronoiFetchSeq) return; // a newer request superseded this one
    renderVoronoi(data.cells);
  } catch (e) {
    // best-effort visual overlay; the marker fetch already reports errors
  }
}

async function refreshOsm() {
  const zoom = map.getZoom();
  if (!map.hasLayer(osmLayer) || zoom < MIN_ZOOM_FOR_OSM) {
    osmLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const buildings = zoom >= MIN_ZOOM_FOR_BUILDINGS;
  const seq = ++osmFetchSeq;
  try {
    const res = await fetch(
      `/api/geocode/osm-places?bbox=${encodeURIComponent(bbox)}&buildings=${buildings}`
    );
    if (res.status === 503) {
      osmLayer.clearLayers();
      setStatus("OSM places DB not built — run scripts/build_osm_places.py <region>.osm.pbf", true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();
    if (seq !== osmFetchSeq) return; // a newer request superseded this one
    osmLayer.clearLayers();
    osmLayer.addData(geojson);
  } catch (e) {
    if (seq === osmFetchSeq) setStatus("Error loading OSM places: " + e.message, true);
  }
}

async function refreshCensus() {
  const zoom = map.getZoom();
  if (!map.hasLayer(censusLayer) || zoom < MIN_ZOOM_FOR_CENSUS) {
    censusLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++censusFetchSeq;
  try {
    const res = await fetch(`/api/geocode/census-places?bbox=${encodeURIComponent(bbox)}`);
    if (res.status === 503) {
      censusLayer.clearLayers();
      setStatus("Census places DB not built — run scripts/get_census_places.py", true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();
    if (seq !== censusFetchSeq) return; // a newer request superseded this one
    censusLayer.clearLayers();
    censusLayer.addData(geojson);
  } catch (e) {
    if (seq === censusFetchSeq) setStatus("Error loading Census places: " + e.message, true);
  }
}

// style/onEachFeature callbacks for the osmLayer L.geoJSON() instance (created
// once in initMap; refreshOsm just swaps the data via clearLayers()/addData()).
function osmFeatureStyle(feature) {
  const color = OSM_CATEGORY_COLORS[feature.properties.category] || "#888";
  return { color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.12 };
}

async function refreshZctas() {
  const zoom = map.getZoom();
  if (!map.hasLayer(zctaLayer) || zoom < MIN_ZOOM_FOR_ZCTA) {
    zctaLayer.clearLayers();
    return;
  }

  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const seq = ++zctaFetchSeq;
  try {
    const res = await fetch(`/api/geocode/zctas?bbox=${encodeURIComponent(bbox)}`);
    if (res.status === 503) {
      zctaLayer.clearLayers();
      const body = await res.json().catch(() => ({}));
      setStatus(body.detail || "Census ZIP areas not built — run scripts/get_census_places.py", true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();
    if (seq !== zctaFetchSeq) return; // a newer request superseded this one
    zctaLayer.clearLayers();
    zctaLayer.addData(geojson);
  } catch (e) {
    if (seq === zctaFetchSeq) setStatus("Error loading ZIP areas: " + e.message, true);
  }
}

// ZIP areas: solid outline in their own hue, plus a permanent centroid label —
// "77070" alone means nothing on a map, and the mailing city next to it is exactly
// what the geocoder would fall back to for a photo inside this polygon.
//
// Magenta because every other hue on this map is taken or camouflaged: blue reads as
// water (and is OSM's city color), green as parks, yellow/orange are the Census place
// outlines these sit directly on top of. Keep in sync with .zcta-label in map.css.
const ZCTA_COLOR = "#ff3ecb";

function zctaFeatureStyle() {
  return { color: ZCTA_COLOR, weight: 2, opacity: 0.95, fill: false };
}

function addZctaLabel(feature, layer) {
  const { zip, city } = feature.properties;
  layer.bindTooltip(escapeHtml(city ? `${zip} · ${city}` : zip), {
    permanent: true,
    direction: "center",
    className: "zcta-label",
  });
}

// Census places: one color, dashed, no fill — they tile the map wall-to-wall, so a
// fill would bury everything under it, and the dashes distinguish a CDP boundary
// from the OSM city boundary it may sit on top of.
function censusFeatureStyle(feature) {
  const isCdp = feature.properties.kind === "CDP";
  return {
    color: isCdp ? "#ffd166" : "#f4a259",
    weight: 2,
    opacity: 0.95,
    dashArray: "6 4",
    fill: false,
  };
}

// Click anywhere on the map to reverse-geocode that exact point the way a photo
// taken there would be, and show what would be persisted. Opens a popup with a
// loading state, then fills it in once /api/geocode/lookup responds.
async function probePoint(e) {
  const { lat, lng } = e.latlng;
  const popup = L.popup({ className: "map-popup-wrap" })
    .setLatLng(e.latlng)
    .setContent(`<div class="map-popup"><div class="map-popup-meta">Geocoding…</div></div>`)
    .openOn(map);
  const seq = ++probeSeq;
  try {
    const res = await fetch(`/api/geocode/lookup?lat=${lat}&lng=${lng}`);
    if (res.status === 503) {
      if (seq === probeSeq) popup.setContent(probeMessage("No geocode data installed"));
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== probeSeq) return; // superseded by a newer click
    popup.setContent(renderProbe(data));
  } catch (err) {
    if (seq === probeSeq) popup.setContent(probeMessage("Error: " + err.message));
  }
}

function probeMessage(msg) {
  return `<div class="map-popup"><div class="map-popup-meta">${escapeHtml(msg)}</div></div>`;
}

// Header = the resolved place name; the labeled rows below are the exact fields
// that would be written to a photo geotagged at this point (city + OSM
// sub-location, plus GeoNames state/county/country).
function renderProbe(data) {
  const loc = data.location;
  const coords = `${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}`;
  const name = loc && (loc.city || loc.sublocation) ? (loc.city || loc.sublocation) : "(no place resolves here)";
  const fields = loc ? [
    ["Sub-location", loc.sublocation],
    ["City", loc.city],
    ["ZIP", loc.postal_code],
    ["County", loc.county],
    ["State", loc.state],
    ["Country", loc.country],
    ["Country code", loc.country_code],
  ].filter(([, v]) => v) : [];
  const rows = fields.map(([k, v]) =>
    `<div class="map-popup-field"><span class="map-popup-field-key">${k}</span>${escapeHtml(v)}</div>`
  ).join("");
  return `<div class="map-popup map-popup-probe">
    <div class="map-popup-name">${escapeHtml(name)}</div>
    <div class="map-popup-probe-label">Would be saved for a photo here:</div>
    ${rows || `<div class="map-popup-meta">(nothing — no location)</div>`}
    ${renderProbeSources(data.sources, loc)}
    <div class="map-popup-meta">${coords}</div>
  </div>`;
}

// Which source produced the city, and what the others said — the whole point of the
// OSM -> Census place -> ZCTA -> GeoNames chain is that you can't tell from the
// result alone which step answered.
function renderProbeSources(sources, loc) {
  if (!sources) return "";
  const zcta = sources.zcta;
  const candidates = [
    ["OSM", sources.osm && sources.osm.city],
    ["Census place", sources.census && sources.census.city],
    ["ZIP city", zcta && zcta.postal_city],
    ["GeoNames", sources.geonames && sources.geonames.city],
  ].filter(([, v]) => v);
  if (!candidates.length) return "";
  const winner = loc && loc.city;
  const rows = candidates.map(([k, v]) => {
    const won = v === winner ? " map-popup-source-win" : "";
    return `<div class="map-popup-field${won}">
      <span class="map-popup-field-key">${k}</span>${escapeHtml(v)}</div>`;
  }).join("");
  return `<div class="map-popup-probe-label">City candidates, best first:</div>${rows}`;
}

function renderVoronoi(cells) {
  voronoiLayer.clearLayers();
  cells.forEach((cell) => {
    const color = cellColor(cell.city || `${cell.lat},${cell.lng}`);
    // One L.polygon per ring rather than one multi-ring polygon: Leaflet reads
    // trailing rings as holes, which is wrong for the disjoint pieces a
    // grid-traced weighted cell can break into.
    (cell.polygons || [cell.polygon]).forEach((ring) => {
      L.polygon(ring, {
        color,
        weight: 1.5,
        opacity: 0.8,
        fillColor: color,
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(voronoiLayer);
    });
  });
}

// Deterministic color per place name/coordinate, so the same place gets the
// same hue across refreshes (helps eyeballing a cell's shape as you pan).
function cellColor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function renderMarkers(places) {
  markerCluster.clearLayers();
  places.forEach((place) => {
    const marker = L.marker([place.lat, place.lng], { icon: placeIcon() });
    marker.bindPopup(renderPopup(place), { className: "map-popup-wrap" });
    markerCluster.addLayer(marker);
  });
}

function placeIcon() {
  return L.divIcon({
    html: `<span class="place-dot"></span>`,
    className: "",
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -6],
  });
}

function renderPopup(place) {
  const region = [place.county, place.state].filter(Boolean).join(", ");
  return `<div class="map-popup">
    <div class="map-popup-name">${escapeHtml(place.city || "(unnamed)")}</div>
    ${region ? `<div class="map-popup-region">${escapeHtml(region)}</div>` : ""}
    <div class="map-popup-country">${escapeHtml(place.country || place.country_code || "")}</div>
    <div class="map-popup-meta">Population: ${place.population.toLocaleString()}</div>
    <div class="map-popup-meta">${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}</div>
  </div>`;
}

function showHint(msg) {
  const el = document.getElementById("map-hint");
  el.textContent = msg;
  el.classList.add("visible");
}

function hideHint() {
  document.getElementById("map-hint").classList.remove("visible");
}

function setStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.className = isError ? "error" : "";
}
