/* ══════════════════════════════════════════════════════════════════════
   Road Trip mode — geocode page.

   Trace the route you drove, pick how wide a corridor around it counts, and
   the server returns the photos already tagged inside that corridor plus the
   untagged photos taken between them, each with a predicted spot on the road
   (services/roadtrip_service.py does the interpolation).

   Kept in its own file — it owns a drawing mode, its own map layers and its
   own panel, and app.js is long enough. It leans on app.js's globals rather
   than duplicating them: `map`, `photos`, `setStatus`, `camColor`,
   `renderLegend`, `buildHistogram`, `applyFilters`, `stageDrop`. Those are
   top-level bindings in app.js, which is loaded first, so they're visible
   here; nothing in app.js knows about this file.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  const METERS_PER_MILE = 1609.344;
  const WIDTHS = [
    [0.5, "½ mile"],
    [1, "1 mile"],
    [5, "5 miles"],
    [10, "10 miles"],
  ];
  const CONF_COLOR = { high: "#5cb85c", medium: "#e0a040", low: "#d9534f" };

  // Predictions are staged in coordinate buckets rather than one photo at a
  // time: each stageDrop is a reverse-geocode plus a full grid re-render, and a
  // long trip can predict hundreds of photos. 3 decimal places is ~110 m, well
  // inside the ±accuracy a prediction carries anyway.
  const STAGE_BUCKET_DP = 3;

  let active = false;          // Road Trip mode engaged
  let drawing = false;         // currently tracing vertices
  let points = [];             // [[lat, lng], …]
  let radiusM = 1 * METERS_PER_MILE;

  let routeLine = null;        // the traced polyline itself
  let corridorLine = null;     // same geometry, drawn as a wide translucent band
  let previewLine = null;      // rubber band from last vertex to the cursor
  let handleLayer = null;      // draggable vertex + midpoint handles
  let predictionLayer = null;  // ghost pins for the predicted positions
  let endpointLayer = null;    // the two photos the trip was started/ended from

  let lastResult = null;
  let activeTimeframe = null;  // { from, to, label } captured when the query ran

  // Set while a trip is being bracketed from the grid: the photo the user
  // right-clicked "start here" on, waiting for the one they end on.
  let tripStart = null;
  // The window between the two endpoint photos. Outranks the page's own date
  // range once a trip is bracketed — the two photos *are* the timeframe.
  let tripWindow = null;
  // { start, end } photo dicts once both ends are named — drawn as A/B pins.
  let endpoints = null;

  let toggleBtn, panel, statusLine, summaryLine, widthSelect, confSelect;
  let drawBtn, undoBtn, clearBtn, loadBtn, stageBtn, timeframeRow, timeframeToggle;

  /* ── Control + panel ── */

  function buildControl() {
    const RoadTripControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const wrap = L.DomUtil.create("div", "roadtrip-control");
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);

        toggleBtn = L.DomUtil.create("button", "roadtrip-toggle", wrap);
        toggleBtn.textContent = "🛣 Road Trip";
        toggleBtn.title = "Tag photos along a route you drove";
        L.DomEvent.on(toggleBtn, "click", () => setActive(!active));

        panel = L.DomUtil.create("div", "roadtrip-panel", wrap);
        panel.style.display = "none";
        panel.innerHTML = `
          <div class="rt-step">
            <div class="rt-step-title">1 · Trace the route</div>
            <div class="rt-btn-row">
              <button id="rt-draw">✏️ Draw</button>
              <button id="rt-undo" title="Remove the last point (Backspace)">↩ Undo</button>
              <button id="rt-clear">✕ Clear</button>
            </div>
            <div class="rt-hint" id="rt-status">Draw the route by clicking the map (double-click or Esc to finish), or
              right-click a photo in the grid → “Start road trip here”, then another → “End road trip here”.
              Drag a point to move it, a hollow midpoint to bend a leg, right-click a point to remove it.</div>
          </div>
          <div class="rt-step">
            <div class="rt-step-title">2 · Corridor width</div>
            <select id="rt-width">
              ${WIDTHS.map(([mi, label]) =>
                `<option value="${mi}"${mi === 1 ? " selected" : ""}>± ${label}</option>`).join("")}
            </select>
          </div>
          <div class="rt-step">
            <div class="rt-step-title">3 · Load photos</div>
            <label class="rt-check" id="rt-timeframe-row" style="display:none">
              <input type="checkbox" id="rt-timeframe" checked/>
              <span id="rt-timeframe-label"></span>
            </label>
            <button id="rt-load" class="primary">🔍 Find photos along route</button>
            <div class="rt-summary" id="rt-summary"></div>
            <div class="rt-btn-row" id="rt-predict-row" style="display:none">
              <select id="rt-conf" title="Which predictions to show and stage">
                <option value="all">All predictions</option>
                <option value="medium" selected>High + medium confidence</option>
                <option value="high">High confidence only</option>
              </select>
              <button id="rt-stage">📍 Stage predictions</button>
            </div>
          </div>`;

        statusLine = panel.querySelector("#rt-status");
        summaryLine = panel.querySelector("#rt-summary");
        widthSelect = panel.querySelector("#rt-width");
        confSelect = panel.querySelector("#rt-conf");
        drawBtn = panel.querySelector("#rt-draw");
        undoBtn = panel.querySelector("#rt-undo");
        clearBtn = panel.querySelector("#rt-clear");
        loadBtn = panel.querySelector("#rt-load");
        stageBtn = panel.querySelector("#rt-stage");
        timeframeRow = panel.querySelector("#rt-timeframe-row");
        timeframeToggle = panel.querySelector("#rt-timeframe");

        drawBtn.addEventListener("click", () => (drawing ? stopDrawing() : startDrawing()));
        undoBtn.addEventListener("click", undoPoint);
        clearBtn.addEventListener("click", clearRoute);
        loadBtn.addEventListener("click", loadRoutePhotos);
        stageBtn.addEventListener("click", stagePredictions);
        confSelect.addEventListener("change", renderPredictions);
        widthSelect.addEventListener("change", () => {
          radiusM = parseFloat(widthSelect.value) * METERS_PER_MILE;
          drawCorridor();
          if (lastResult) loadRoutePhotos();   // the corridor moved — re-ask
        });

        return wrap;
      },
    });
    new RoadTripControl().addTo(map);
  }

  function setActive(on, autoDraw = true) {
    active = on;
    panel.style.display = on ? "block" : "none";
    if (toggleBtn) toggleBtn.classList.toggle("on", on);
    if (on) {
      refreshTimeframeRow();
      drawRoute();
      renderPredictions();
      renderEndpoints();
      if (autoDraw && !points.length) startDrawing();
    } else {
      // Leaving the mode leaves the loaded photos alone — only this mode's own
      // layers go away, so the corridor doesn't sit on top of normal tagging.
      stopDrawing();
      [routeLine, corridorLine, handleLayer, predictionLayer, endpointLayer]
        .forEach((l) => l && l.remove());
      routeLine = corridorLine = handleLayer = predictionLayer = endpointLayer = null;
    }
  }

  /* ── Bracketing a trip from the grid ──
   *
   * Right-click the photo you left from, right-click the one you got back on,
   * and the server proposes the drive between them: a straight line if nothing
   * else is tagged in that window, bent through the clusters of what is. The
   * route is editable from there — that's what the handles are for. */

  // Called by app.js's openPhotoContextMenu; `add(label, title, onClick, disabled)`
  // appends one entry. Exported on window because app.js loads first.
  window.roadtripContextItems = function (photo, add) {
    // Truthy, not `> 0`: a pre-1970 (negative) timestamp is a usable endpoint.
    const usable = photo.lat != null && !!photo.photo_datetime;
    const why = photo.lat == null
      ? "This photo has no location yet — a trip endpoint needs one"
      : "This photo has no timestamp — a trip endpoint needs one";

    if (!tripStart) {
      add("🛣 Start road trip here",
          usable ? "Mark this photo as where the trip began" : why,
          () => beginTrip(photo), !usable);
      if (active) {
        add("✕ End road trip mode", "Leave Road Trip mode and clear the route", () => endTripMode());
      }
      return;
    }

    if (photo.id === tripStart.id) {
      add("✕ Cancel road trip start",
          `Currently starting at ${tripStart.filename}`,
          () => { tripStart = null; renderEndpoints(); setStatus("Road trip start cleared."); });
      return;
    }
    add("🏁 End road trip here",
        usable ? `Build the route from ${tripStart.filename} to this photo` : why,
        () => completeTrip(photo), !usable);
    add("✕ End road trip mode", "Leave Road Trip mode and clear the route", () => endTripMode());
  };

  function beginTrip(photo) {
    tripStart = photo;
    if (!active) setActive(true, false);
    stopDrawing();
    renderEndpoints();
    map.panTo([photo.lat, photo.lng]);
    setStatus(`Road trip starts at ${photo.filename}. Right-click the photo you finished at → “End road trip here”.`);
    setPanelStatus(`Start: ${photo.filename}. Now pick the end photo in the grid.`);
  }

  async function completeTrip(endPhoto) {
    const startPhoto = tripStart;
    setPanelStatus("Building the route…");
    try {
      const res = await fetch("/api/roadtrip/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_id: startPhoto.id, end_id: endPhoto.id }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();

      points = data.points;
      tripStart = null;
      // The endpoints define the window; the page's own date range doesn't get
      // a say once you've named both ends of the trip.
      tripWindow = { from: data.from_ts, to: data.to_ts,
                     label: `${fmtDay(data.from_ts)} → ${fmtDay(data.to_ts)}` };
      endpoints = { start: data.start, end: data.end };

      if (!active) setActive(true, false);
      drawRoute();
      renderEndpoints();
      refreshTimeframeRow();
      setPanelStatus(
        `Route from ${data.cluster_count} tagged cluster(s) between the two photos. ` +
        `Drag the handles onto the roads you took, then search.`);
      await loadRoutePhotos();
    } catch (err) {
      setPanelStatus("Could not build the route: " + err.message, true);
      setStatus("Road trip: " + err.message, true);
    }
  }

  function endTripMode() {
    tripStart = null;
    tripWindow = null;
    endpoints = null;
    clearRoute();
    setActive(false);
    setStatus("Road trip mode off.");
  }

  function renderEndpoints() {
    if (endpointLayer) { endpointLayer.remove(); endpointLayer = null; }
    if (!active) return;
    const pins = [];
    const pin = (photo, label, color) => {
      if (!photo || photo.lat == null) return;
      const m = L.marker([photo.lat, photo.lng], {
        icon: L.divIcon({ className: "rt-endpoint", html: `<span style="background:${color}">${label}</span>`,
                          iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: 1000,
      });
      m.bindTooltip(`${label === "A" ? "Trip start" : "Trip end"}: ${escapeHtml(photo.filename)}`,
                    { direction: "top", opacity: 0.95 });
      pins.push(m);
    };
    if (tripStart) pin(tripStart, "A", "#5cb85c");
    if (endpoints) { pin(endpoints.start, "A", "#5cb85c"); pin(endpoints.end, "B", "#d9534f"); }
    if (pins.length) endpointLayer = L.layerGroup(pins).addTo(map);
  }

  /* ── Drawing the route ── */

  function startDrawing() {
    drawing = true;
    drawBtn.textContent = "✓ Finish";
    drawBtn.classList.add("on");
    map.getContainer().style.cursor = "crosshair";
    // Otherwise the double-click that ends the route also zooms the map.
    map.doubleClickZoom.disable();
    drawHandles();   // clears them: handles would eat the clicks that add points
    map.on("click", onMapClick);
    map.on("mousemove", onMapMove);
    map.on("dblclick", stopDrawing);
    document.addEventListener("keydown", onKey);
    setPanelStatus("Click along the roads you took. Double-click or Esc to finish.");
  }

  function stopDrawing() {
    if (!drawing) return;
    drawing = false;
    // A double-click finish lands two clicks on the same spot; drop the twin so
    // the route doesn't end in a zero-length segment.
    if (points.length >= 2) {
      const a = L.latLng(points[points.length - 1]);
      const b = L.latLng(points[points.length - 2]);
      if (a.distanceTo(b) < 1) { points.pop(); drawRoute(); }
    }
    drawBtn.textContent = "✏️ Draw";
    drawBtn.classList.remove("on");
    map.getContainer().style.cursor = "";
    map.doubleClickZoom.enable();
    map.off("click", onMapClick);
    map.off("mousemove", onMapMove);
    map.off("dblclick", stopDrawing);
    document.removeEventListener("keydown", onKey);
    if (previewLine) { previewLine.remove(); previewLine = null; }
    drawHandles();   // tracing is over — the route becomes editable
    setPanelStatus(points.length >= 2
      ? `Route: ${points.length} points, ${fmtDistance(routeLengthM())}.`
      : "A route needs at least two points.");
  }

  function onKey(e) {
    if (e.key === "Escape") { stopDrawing(); }
    else if (e.key === "Backspace" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      undoPoint();
    }
  }

  function onMapClick(e) {
    points.push([e.latlng.lat, e.latlng.lng]);
    drawRoute();
    setPanelStatus(`${points.length} point${points.length === 1 ? "" : "s"} · ${fmtDistance(routeLengthM())}`);
  }

  function onMapMove(e) {
    if (!points.length) return;
    const last = points[points.length - 1];
    const seg = [last, [e.latlng.lat, e.latlng.lng]];
    if (previewLine) previewLine.setLatLngs(seg);
    else previewLine = L.polyline(seg, {
      color: "#7ab8f5", weight: 2, dashArray: "6,6", opacity: 0.8, interactive: false,
    }).addTo(map);
  }

  function undoPoint() {
    if (!points.length) return;
    points.pop();
    drawRoute();
    setPanelStatus(points.length ? `${points.length} point(s) · ${fmtDistance(routeLengthM())}` : "Route cleared.");
  }

  function clearRoute() {
    points = [];
    lastResult = null;
    tripStart = null;
    tripWindow = null;
    endpoints = null;
    drawRoute();
    renderPredictions();
    renderEndpoints();
    summaryLine.textContent = "";
    panel.querySelector("#rt-predict-row").style.display = "none";
    setPanelStatus("Route cleared.");
  }

  function drawRoute() {
    if (routeLine) { routeLine.remove(); routeLine = null; }
    if (points.length >= 2) {
      routeLine = L.polyline(points, {
        color: "#7ab8f5", weight: 3, opacity: 0.95, interactive: false,
      }).addTo(map);
    }
    drawHandles();
    drawCorridor();
  }

  /* ── Editable route: drag a vertex to move it, drag a midpoint to bend the
        leg there into two, right-click a vertex to drop it. A suggested route
        starts as a straight line (or a line through the clusters of what was
        already tagged), and this is how you pull it onto the actual roads. ── */

  function handleIcon(cls) {
    return L.divIcon({ className: cls, iconSize: [12, 12] });
  }

  function drawHandles() {
    if (handleLayer) { handleLayer.remove(); handleLayer = null; }
    // While tracing, every click adds a point — handles would swallow those
    // clicks and fight the drawing gesture.
    if (drawing || !points.length) return;

    handleLayer = L.layerGroup().addTo(map);

    points.forEach((p, i) => {
      const m = L.marker(p, {
        icon: handleIcon("rt-handle rt-handle-vertex"),
        draggable: true,
        keyboard: false,
        zIndexOffset: 900,
      });
      m.bindTooltip(`Point ${i + 1} · drag to move, right-click to remove`,
                    { direction: "top", opacity: 0.9 });
      m.on("drag", (e) => {
        points[i] = [e.latlng.lat, e.latlng.lng];
        liveUpdate();
      });
      m.on("dragend", () => finishHandleDrag());
      m.on("contextmenu", (e) => {
        L.DomEvent.stop(e);
        if (points.length <= 2) { setPanelStatus("A route needs at least two points.", true); return; }
        points.splice(i, 1);
        drawRoute();
        setPanelStatus(`${points.length} points · ${fmtDistance(routeLengthM())}`);
      });
      handleLayer.addLayer(m);
    });

    for (let i = 1; i < points.length; i++) {
      const mid = [(points[i - 1][0] + points[i][0]) / 2, (points[i - 1][1] + points[i][1]) / 2];
      const m = L.marker(mid, {
        icon: handleIcon("rt-handle rt-handle-mid"),
        draggable: true,
        keyboard: false,
        zIndexOffset: 800,
      });
      m.bindTooltip("Drag to bend this leg", { direction: "top", opacity: 0.9 });
      // The new vertex is inserted the moment the drag starts, so the rest of
      // the gesture is just an ordinary vertex drag.
      let insertedAt = null;
      m.on("dragstart", () => { insertedAt = i; points.splice(i, 0, mid); });
      m.on("drag", (e) => {
        if (insertedAt === null) return;
        points[insertedAt] = [e.latlng.lat, e.latlng.lng];
        liveUpdate();
      });
      m.on("dragend", () => { insertedAt = null; finishHandleDrag(); });
      handleLayer.addLayer(m);
    }
  }

  // Mid-drag: move the lines only. Rebuilding the handles here would destroy
  // the marker Leaflet is currently dragging.
  function liveUpdate() {
    if (routeLine) routeLine.setLatLngs(points);
    if (corridorLine) corridorLine.setLatLngs(points);
  }

  function finishHandleDrag() {
    drawRoute();
    setPanelStatus(lastResult
      ? `Route edited · ${points.length} points, ${fmtDistance(routeLengthM())}. Re-run the search to refresh.`
      : `${points.length} points · ${fmtDistance(routeLengthM())}`);
  }

  // The corridor is drawn as the route stroked at its real width rather than as
  // a computed buffer polygon: a round-capped, round-joined stroke *is* the set
  // of points within r of the line, so the only work is converting meters to
  // pixels — and redoing it whenever the zoom changes.
  function drawCorridor() {
    if (corridorLine) { corridorLine.remove(); corridorLine = null; }
    if (points.length < 2) return;
    corridorLine = L.polyline(points, {
      color: "#4a90d9",
      weight: corridorPixels(),
      opacity: 0.18,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(map);
    corridorLine.bringToBack();
  }

  function corridorPixels() {
    const c = map.getCenter();
    const mpp = 40075016.686 * Math.cos((c.lat * Math.PI) / 180) / Math.pow(2, map.getZoom() + 8);
    // Capped: zoomed right in, a 10-mile corridor is tens of thousands of pixels
    // wide, and the band is meaningless there anyway.
    return Math.min(6000, Math.max(2, (2 * radiusM) / mpp));
  }

  /* ── Query ── */

  // The timeframe the page is currently looking at, so a route driven twice
  // doesn't blend both trips into one impossible timeline.
  function currentTimeframe() {
    // Two named endpoint photos are a sharper answer than any page-level filter.
    if (tripWindow) return tripWindow;
    if (dateRangeMin !== dateRangeMax && (dateFilterLo > dateRangeMin || dateFilterHi < dateRangeMax)) {
      return { from: Math.floor(dateFilterLo), to: Math.ceil(dateFilterHi),
               label: `${fmtDay(dateFilterLo)} – ${fmtDay(dateFilterHi)}` };
    }
    if (selectedYear && selectedMonth) {
      const from = Date.UTC(selectedYear, selectedMonth - 1, 1) / 1000;
      const to = Date.UTC(selectedYear, selectedMonth, 1) / 1000 - 1;
      return { from, to, label: `${selectedYear}-${String(selectedMonth).padStart(2, "0")}` };
    }
    if (selectedYear) {
      return { from: Date.UTC(selectedYear, 0, 1) / 1000,
               to: Date.UTC(selectedYear + 1, 0, 1) / 1000 - 1,
               label: String(selectedYear) };
    }
    return null;
  }

  function refreshTimeframeRow() {
    // Once a route has been loaded the page's own month/range selection is gone,
    // so the timeframe the query ran with is kept and offered back.
    const tf = currentTimeframe() || activeTimeframe;
    if (!tf) { timeframeRow.style.display = "none"; return; }
    timeframeRow.style.display = "flex";
    panel.querySelector("#rt-timeframe-label").textContent = `Limit to ${tf.label}`;
    return tf;
  }

  async function loadRoutePhotos() {
    if (points.length < 2) { setPanelStatus("Draw at least two points first.", true); return; }
    stopDrawing();

    const tf = refreshTimeframeRow();
    const useTf = tf && timeframeToggle.checked;
    activeTimeframe = useTf ? tf : null;

    loadBtn.disabled = true;
    setPanelStatus("Searching the corridor…");
    setStatus("Loading photos along the route…");
    try {
      const res = await fetch("/api/roadtrip/photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points,
          radius_m: radiusM,
          from_ts: useTf ? tf.from : null,
          to_ts: useTf ? tf.to : null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lastResult = data;
      adoptResult(data);
    } catch (err) {
      setPanelStatus("Load failed: " + err.message, true);
      setStatus("Route load error: " + err.message, true);
    } finally {
      loadBtn.disabled = false;
    }
  }

  // Hand the result to the page's normal machinery: the corridor becomes the
  // loaded scope, so the grid, legend, timeline, selection, drag-drop and
  // staging all work on it exactly as they do for a month or an area.
  function adoptResult(data) {
    // Merged, not appended: the grid groups by *runs* of the same day, so two
    // separately-sorted blocks (tagged, then predicted) would render the trip's
    // days twice, out of order.
    const merged = data.photos.concat(data.candidates).sort((a, b) =>
      (a.photo_datetime || 0) - (b.photo_datetime || 0) || a.filename.localeCompare(b.filename));

    // A new scope invalidates the other selectors, same as picking an area does —
    // app.js's enterScope/setScopePhotos clear them and the per-scope state
    // (date filter, selection, shift-click anchor) in one place.
    enterScope("roadtrip",
      activeTimeframe ? `Road trip · ${activeTimeframe.label}` : "Road trip");
    document.getElementById("selected-area-label").textContent =
      `Route: ${fmtDistance(data.route_length_m)} ± ${widthSelect.selectedOptions[0].textContent.replace("± ", "")}`;
    // No fitMap: fit the route, not the photos — the corridor is the thing being
    // worked on, and untagged photos have no coordinates to fit to anyway.
    setScopePhotos(merged);
    renderPredictions();
    if (routeLine) map.flyToBounds(routeLine.getBounds(), { padding: [50, 50], duration: 1.0 });

    const counts = { high: 0, medium: 0, low: 0 };
    data.candidates.forEach((c) => counts[c.predicted.confidence]++);
    summaryLine.innerHTML =
      `<b>${data.photos.length}</b> tagged in corridor · <b>${data.anchor_count}</b> anchors<br>` +
      `<b>${data.candidates.length}</b> predicted ` +
      `(<span class="rt-conf-high">${counts.high} high</span>, ` +
      `<span class="rt-conf-medium">${counts.medium} med</span>, ` +
      `<span class="rt-conf-low">${counts.low} low</span>)` +
      (data.truncated ? "<br><i>truncated — narrow the timeframe</i>" : "");
    panel.querySelector("#rt-predict-row").style.display = data.candidates.length ? "flex" : "none";
    setPanelStatus(data.anchor_count
      ? `Done. ${data.candidates.length} photo(s) placed on the route.`
      : "No tagged photos in this corridor for that timeframe — nothing to interpolate from.", !data.anchor_count);
  }

  /* ── Predicted positions ── */

  function visiblePredictions() {
    if (!lastResult) return [];
    const mode = confSelect.value;
    return lastResult.candidates.filter((c) => {
      const conf = c.predicted.confidence;
      if (mode === "high") return conf === "high";
      if (mode === "medium") return conf === "high" || conf === "medium";
      return true;
    });
  }

  function renderPredictions() {
    if (predictionLayer) { predictionLayer.remove(); predictionLayer = null; }
    const list = visiblePredictions();
    if (!list.length) return;

    predictionLayer = L.layerGroup(list.map((c) => {
      const p = c.predicted;
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 5,
        color: CONF_COLOR[p.confidence],
        fillColor: CONF_COLOR[p.confidence],
        fillOpacity: 0.55,
        weight: 1.5,
        dashArray: p.method === "extrapolated" ? "3,3" : null,
      });
      m.bindTooltip(
        `${escapeHtml(c.filename)}<br>${fmtTime(c.photo_datetime)}<br>` +
        `${p.method} · ±${fmtDistance(p.accuracy_m)} · gap ${fmtDuration(p.gap_sec)}`,
        { direction: "top", opacity: 0.95 });
      m.on("click", () => {
        if (typeof showDetail === "function") showDetail(c.id);
      });
      return m;
    })).addTo(map);
  }

  async function stagePredictions() {
    const list = visiblePredictions();
    if (!list.length) return;

    // Bucket by rounded coordinate so one stageDrop (one reverse-geocode, one
    // re-render) covers every photo predicted to roughly the same spot.
    const buckets = new Map();
    list.forEach((c) => {
      const p = c.predicted;
      const key = `${p.lat.toFixed(STAGE_BUCKET_DP)},${p.lng.toFixed(STAGE_BUCKET_DP)}`;
      let b = buckets.get(key);
      if (!b) { b = { ids: [], lat: 0, lng: 0, acc: 0, n: 0 }; buckets.set(key, b); }
      b.ids.push(c.id);
      b.lat += p.lat; b.lng += p.lng; b.n++;
      b.acc = Math.max(b.acc, p.accuracy_m);
    });

    stageBtn.disabled = true;
    let done = 0;
    for (const b of buckets.values()) {
      // Accuracy is the prediction's own uncertainty; the drop is deliberately
      // imprecise, which is what the ± circle on the map will show.
      await stageDrop(b.ids, b.lat / b.n, b.lng / b.n, Math.round(b.acc));
      done += b.ids.length;
      setPanelStatus(`Staged ${done}/${list.length}…`);
    }
    stageBtn.disabled = false;
    setPanelStatus(`Staged ${done} prediction(s). Review at the bottom of the grid, then Commit.`);
  }

  /* ── Formatting helpers ── */

  function routeLengthM() {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += L.latLng(points[i - 1]).distanceTo(L.latLng(points[i]));
    }
    return total;
  }

  function fmtDistance(m) {
    const mi = m / METERS_PER_MILE;
    return mi < 0.2 ? `${Math.round(m)} m` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }

  function fmtDuration(sec) {
    if (sec < 90) return `${Math.round(sec)}s`;
    if (sec < 5400) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  }

  function fmtDay(ts) {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  // UTC on purpose — photo_datetime is the camera's wall clock stored as UTC
  // (see the note above dayKey in app.js), so local formatting would shift it.
  function fmtTime(ts) {
    return ts ? new Date(ts * 1000).toLocaleString(undefined, { timeZone: "UTC" }) : "no timestamp";
  }

  function setPanelStatus(msg, isError = false) {
    statusLine.textContent = msg;
    statusLine.classList.toggle("rt-error", !!isError);
  }

  /* ── Init: after app.js's own DOMContentLoaded handler, so `map` exists ── */
  document.addEventListener("DOMContentLoaded", () => {
    if (typeof map === "undefined" || !map) return;   // not the geocode page
    buildControl();
    map.on("zoomend", () => { if (corridorLine) corridorLine.setStyle({ weight: corridorPixels() }); });
  });
})();
