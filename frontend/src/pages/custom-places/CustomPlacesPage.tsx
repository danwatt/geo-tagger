import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { latLngBounds, type Map as LeafletMap } from "leaflet";
import { api, unwrap, type Schemas } from "../../api/client";
import { AppShell } from "../../shell/AppShell";
import { StatusBar, type Status } from "../../shell/StatusBar";
import type { ShapeHandles } from "../../map/shapeHandles";
import { formatRadius, parseShape, serializeShape, shapeLatLngBounds, type Shape, type ShapeType } from "../../map/shapes";
import { DeletePlaceDialog, PlaceDialog, RepPicker, type PlaceAnswer } from "./PlaceDialogs";
import { PlaceControls, PlaceList, PlaceListHeader, type Hover } from "./PlaceList";
import { HotspotSection, SuggestionBanner } from "./HotspotPanel";
import { PlacesMap } from "./PlacesMap";
import {
  DEFAULT_HOTSPOT_RADIUS, HOTSPOT_LIMIT, HOTSPOT_MOVE_DEBOUNCE_MS, hotspotKey, loadDismissed, pickSuggestion,
  saveDismissed, viewBbox, type Hotspot, type HotspotSort,
} from "./hotspots";
import { visiblePlaces, type Place, type PlaceFilter, type PlaceSort } from "./places";
import "./custom-places.css";

/* Named Places (custom-places.html) — draw and manage saved rectangles and
 * circles. They are stored in our own DB (separate from GeoNames/OSM) via
 * /api/places, and are jump targets on the Geocode page and a filter on Search.
 * Port of web/custom-places.js. */

// stats=true adds photo_count / last_ts / untagged_nearby_count — a spatial
// query per place, so only this page asks for them.
export const PLACES_KEY = ["places", "stats"] as const;
const SUGGESTION_KEY = ["hotspot-suggestion"] as const;
const HOTSPOTS_KEY = "custom-places-hotspots";

/* ── Where the map opens ──
 * Opening on the whole world means panning to your own places every visit. So:
 * the view you left last, else a fit around every place you have, else world.
 * Remembered per browser, not on the server — it's a scroll position, not data. */
const VIEW_KEY = "customPlacesView";
// Compact by default: a 320px sidebar fits two gallery cards and eight compact
// rows, and finding the place you meant is the common task, not admiring it.
const DENSE_KEY = "placeDense";

function readSavedView(): { lat: number; lng: number; zoom: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null") as { lat?: unknown; lng?: unknown; zoom?: unknown } | null;
    if (!v || typeof v.lat !== "number" || typeof v.lng !== "number") return null;
    return { lat: v.lat, lng: v.lng, zoom: typeof v.zoom === "number" ? v.zoom : 13 };
  } catch {
    return null;   // a corrupt entry is not worth a broken page — fall through to the auto-fit
  }
}

function storeSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* blocked storage: just won't stick */ }
}

type DialogState =
  | { kind: "name-shape"; shape: Shape }
  | { kind: "name-hotspot"; hotspot: Hotspot }
  | { kind: "rename"; place: Place }
  | { kind: "delete"; place: Place }
  | { kind: "rep"; place: Place }
  | null;

type HotspotsPage = Schemas["HotspotsResponse"];

export function CustomPlacesPage() {
  const qc = useQueryClient();
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [status, setStatusState] = useState<Status>({ message: "" });
  const setStatus = useCallback((message: string, isError = false) => setStatusState({ message, isError }), []);

  // ── Places list state ──
  const [filter, setFilter] = useState<PlaceFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PlaceSort>("name");
  const [dense, setDense] = useState(() => {
    try { return localStorage.getItem(DENSE_KEY) !== "gallery"; } catch { return true; }
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const [hover, setHover] = useState<Hover>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [drawMode, setDrawMode] = useState<ShapeType | null>(null);
  const handlesRef = useRef<ShapeHandles | null>(null);

  const placesQ = useQuery({
    queryKey: PLACES_KEY,
    queryFn: async () => unwrap(await api.GET("/api/places", { params: { query: { stats: true } } })),
  });
  const places = useMemo(() => placesQ.data ?? [], [placesQ.data]);
  const shown = useMemo(() => visiblePlaces(places, filter, query, sort), [places, filter, query, sort]);
  useEffect(() => {
    if (placesQ.isError) setStatus("Failed to load places: " + placesQ.error.message, true);
  }, [placesQ.isError, placesQ.error, setStatus]);

  const patchPlace = (id: number, patch: Partial<Place>) =>
    qc.setQueryData<Place[]>(PLACES_KEY, (old) => old?.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  // ── Hotspots overlay state ──
  const [showHotspots, setShowHotspots] = useState(false);
  const [hotspotSort, setHotspotSort] = useState<HotspotSort>("count");
  const [inView, setInView] = useState(false);
  const [viewBox, setViewBox] = useState<ReturnType<typeof viewBbox>>(null);
  const [selectedHotspot, setSelectedHotspot] = useState<string | null>(null);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hotspotsKey = [HOTSPOTS_KEY, hotspotSort, inView ? viewBox : null] as const;
  // Paged with offset: the list is a queue to work through, and 2000 hotspots
  // at 60 a go would otherwise be unreachable past the first screen. A new sort
  // or view is a new key, which aborts the superseded request (latest-only).
  const hotspotsQ = useInfiniteQuery({
    queryKey: hotspotsKey,
    enabled: showHotspots,
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async ({ pageParam, signal }) => unwrap(await api.GET("/api/geotag/hotspots", {
      params: { query: {
        limit: HOTSPOT_LIMIT, hide_named: true, sort: hotspotSort, offset: pageParam,
        ...(inView && viewBox ? viewBox : {}),
      } },
      signal,
    })),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.hotspots.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const hotspotPages = showHotspots ? hotspotsQ.data?.pages : undefined;
  const hotspots = useMemo(() => hotspotPages?.flatMap((p) => p.hotspots) ?? [], [hotspotPages]);
  const hotspotTotal = hotspotPages?.at(-1)?.total ?? hotspots.length;
  // A failed *next* page leaves what's already loaded alone — losing the rows
  // you were working through would be a worse answer than a missing page.
  const hotspotError = showHotspots && hotspotsQ.isError && !hotspotsQ.isFetchNextPageError ? hotspotsQ.error.message : null;

  // ── Suggested place ──
  const [dismissed, setDismissed] = useState(loadDismissed);
  const suggestionQ = useQuery({
    queryKey: SUGGESTION_KEY,
    retry: false,
    // A handful of candidates, not just one — the top hit might be a dismissed
    // spot, and the next one down is still worth surfacing.
    queryFn: async () => unwrap(await api.GET("/api/geotag/hotspots", {
      params: { query: { limit: 5, hide_named: true, sort: "count" } },
    })),
  });
  const suggested = suggestionQ.data ? pickSuggestion(suggestionQ.data.hotspots, dismissed) : null;
  // Shared by the rings, the suggestion and a named hotspot's circle — same
  // clustering, same radius.
  const hotspotRadius = hotspotPages?.[0]?.merge_meters ?? suggestionQ.data?.merge_meters ?? DEFAULT_HOTSPOT_RADIUS;

  // ── Map view: restore, save, first fit ──
  const viewRestored = useRef(false);
  const initialFitDone = useRef(false);
  useEffect(() => {
    if (!map) return;
    const v = readSavedView();
    if (v) {
      map.setView([v.lat, v.lng], v.zoom, { animate: false });
      viewRestored.current = true;
    }
  }, [map]);
  // Frames every place so a new library opens on its own contents instead of
  // the mid-Atlantic. First load only — every later change is a rename, a
  // delete or a shape you just drew, and re-framing the map under any of those
  // would be a jump you didn't ask for.
  useEffect(() => {
    if (!map || !placesQ.data || initialFitDone.current) return;
    initialFitDone.current = true;
    if (viewRestored.current) return;
    const boxes = placesQ.data.flatMap((p) => {
      const s = p.bounds_valid === false ? null : parseShape(p.type, p.bounds);
      return s ? [shapeLatLngBounds(s)] : [];
    });
    if (!boxes.length) return;
    const bounds = boxes.reduce((acc, b) => acc.extend(b), latLngBounds(boxes[0]!));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 14 });
  }, [map, placesQ.data]);

  const showRef = useRef({ showHotspots, inView });
  showRef.current = { showHotspots, inView };
  const onMoveEnd = useCallback((m: LeafletMap) => {
    const c = m.getCenter();
    storeSet(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: m.getZoom() }));
    if (!showRef.current.showHotspots || !showRef.current.inView) return;
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => setViewBox(boxOf(m)), HOTSPOT_MOVE_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => { if (moveTimer.current) clearTimeout(moveTimer.current); }, []);

  // ── Selecting a place ──
  const selectPlace = (id: number) => {
    setSelectedId(id);
    // Clicking a shape on the map is a request to work on that place, so its
    // row has to be reachable — if the filter or the search box is hiding it,
    // clear both rather than silently selecting something you can't see or edit.
    if (!visiblePlaces(places, filter, query, sort).some((p) => p.id === id)) {
      setFilter("all");
      setQuery("");
    }
    setScrollTick((n) => n + 1);
    const place = places.find((p) => p.id === id);
    const shape = place && place.bounds_valid !== false ? parseShape(place.type, place.bounds) : null;
    if (map && shape) map.fitBounds(latLngBounds(shapeLatLngBounds(shape)).pad(0.2), { maxZoom: 15 });
  };

  // ── Mutations ──
  const createPlace = useMutation({
    mutationFn: async (body: { name: string; type: ShapeType; bounds: string }) => unwrap(await api.POST("/api/places", { body })),
  });
  const updatePlace = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: { name?: string; bounds?: string } }) =>
      unwrap(await api.PATCH("/api/places/{place_id}", { params: { path: { place_id: id } }, body })),
  });
  const deletePlace = useMutation({
    mutationFn: async (id: number) => unwrap(await api.DELETE("/api/places/{place_id}", { params: { path: { place_id: id } } })),
  });
  const setRep = useMutation({
    mutationFn: async ({ id, photoId }: { id: number; photoId: number | null }) =>
      unwrap(await api.PUT("/api/places/{place_id}/representative", { params: { path: { place_id: id } }, body: { photo_id: photoId } })),
  });

  async function commitBounds(place: Place, shape: Shape) {
    const bounds = serializeShape(shape);
    try {
      const res = await updatePlace.mutateAsync({ id: place.id, body: { bounds } });
      patchPlace(place.id, { bounds: res.bounds });
      setStatus(shape.type === "circle"
        ? `Updated "${place.name}" — radius ${formatRadius(shape.bounds.radius)}`
        : `Updated "${place.name}"`);
    } catch (e) {
      setStatus("Failed to update place: " + (e as Error).message, true);
      setRevision((n) => n + 1);      // snap the shape back to its saved bounds
      void qc.invalidateQueries({ queryKey: PLACES_KEY });
    }
  }

  async function rename(place: Place, answer: PlaceAnswer) {
    setDialog(null);
    if (answer.name === place.name) return;
    try {
      await updatePlace.mutateAsync({ id: place.id, body: { name: answer.name } });
      patchPlace(place.id, { name: answer.name });
      setStatus(`Renamed to "${answer.name}"`);
    } catch (e) {
      setStatus("Failed to rename place: " + (e as Error).message, true);
    }
  }

  async function remove(place: Place) {
    setDialog(null);
    try {
      await deletePlace.mutateAsync(place.id);
      setStatus(`Place "${place.name}" deleted`);
      if (selectedId === place.id) setSelectedId(null);
      await qc.invalidateQueries({ queryKey: PLACES_KEY });
      // Whatever this place was covering is an unnamed hotspot again.
      if (showHotspots) await qc.invalidateQueries({ queryKey: [HOTSPOTS_KEY] });
    } catch (e) {
      setStatus("Error deleting place: " + (e as Error).message, true);
    }
  }

  async function pickRep(place: Place, photoId: number | null) {
    try {
      await setRep.mutateAsync({ id: place.id, photoId });
      patchPlace(place.id, { representative_photo_id: photoId });
      if (photoId == null) setStatus(`Cleared representative photo for "${place.name}"`);
      else setStatus(`Set the representative photo for "${place.name}"`);
      if (dialog?.kind === "rep") setDialog(null);
    } catch (e) {
      setStatus(`Failed to ${photoId == null ? "clear" : "set"} representative: ` + (e as Error).message, true);
    }
  }

  // ── Drawing ──
  const stopDrawing = () => setDrawMode(null);
  function startDrawing(type: ShapeType) {
    // The armed button again is a stop, not a re-arm.
    if (drawMode === type) {
      stopDrawing();
      setStatus("Drawing cancelled");
      return;
    }
    setDrawMode(type);
    setStatus(`Drawing ${type}… click, hold and drag to set size, then release (Esc cancels)`);
  }

  async function saveDrawn(shape: Shape, answer: PlaceAnswer) {
    setDialog(null);
    // The dialog's radius wins over the drag: it's the later, more deliberate
    // number, and it is what the field showed when Save was pressed.
    const final: Shape = shape.type === "circle" && answer.radius != null
      ? { type: "circle", bounds: { ...shape.bounds, radius: answer.radius } }
      : shape;
    try {
      await createPlace.mutateAsync({ name: answer.name, type: final.type, bounds: serializeShape(final) });
      setStatus(`Place "${answer.name}" saved`);
      stopDrawing();
      await qc.invalidateQueries({ queryKey: PLACES_KEY });
    } catch (e) {
      setStatus("Error saving place: " + (e as Error).message, true);
      stopDrawing();
    }
  }

  async function saveHotspot(h: Hotspot, answer: PlaceAnswer) {
    setDialog(null);
    const radius = answer.radius ?? hotspotRadius;
    const shape: Shape = { type: "circle", bounds: { lat: h.lat, lng: h.lng, radius } };
    try {
      await createPlace.mutateAsync({ name: answer.name, type: "circle", bounds: serializeShape(shape) });
      await qc.invalidateQueries({ queryKey: PLACES_KEY });
      // Dropped locally rather than by refetching: a refetch would restart at
      // page one and throw away however many pages you had loaded to get here.
      // The server would suppress this hotspot anyway on the next real load.
      const key = hotspotKey(h);
      qc.setQueriesData<InfiniteData<HotspotsPage, number>>({ queryKey: [HOTSPOTS_KEY] }, (old) => old && {
        ...old,
        pages: old.pages.map((p) => {
          const kept = p.hotspots.filter((x) => hotspotKey(x) !== key);
          return { ...p, hotspots: kept, total: Math.max(0, p.total - 1) };
        }),
      });
      // The just-named spot no longer qualifies (hide_named drops it); a
      // smaller one might now be the top candidate.
      await qc.invalidateQueries({ queryKey: SUGGESTION_KEY });
      setStatus(`Saved "${answer.name}" as a place (${Math.round(radius)} m radius).`);
    } catch (e) {
      setStatus("Could not save place: " + (e as Error).message, true);
    }
  }

  // ── Hotspot actions ──
  const fitCircle = (lat: number, lng: number) => {
    if (!map) return;
    map.fitBounds(latLngBounds(shapeLatLngBounds({ type: "circle", bounds: { lat, lng, radius: hotspotRadius } })).pad(0.6), { maxZoom: 17 });
  };
  const selectHotspot = (h: Hotspot) => {
    // Zooming fires moveend, which in "only in view" mode reloads the list — so
    // the highlight is remembered by coordinate, not by row index.
    setSelectedHotspot(hotspotKey(h));
    fitCircle(h.lat, h.lng);
  };
  function dismissSuggestion(h: Hotspot) {
    const next = new Set(dismissed);
    next.add(hotspotKey(h));
    saveDismissed(next);
    setDismissed(next);
  }
  async function loadMoreHotspots() {
    const r = await hotspotsQ.fetchNextPage();
    if (r.isFetchNextPageError) setStatus("Couldn't load more hotspots: " + (r.error?.message ?? "error"), true);
  }
  function toggleHotspots(on: boolean) {
    setShowHotspots(on);
    if (on && inView && map) setViewBox(boxOf(map));
    if (!on && moveTimer.current) clearTimeout(moveTimer.current);
  }
  function toggleInView(on: boolean) {
    setInView(on);
    if (on && map) setViewBox(boxOf(map));
  }

  // ── Escape: a handle drag first (it's under the pointer), then an armed or
  // half-drawn shape. Dialogs handle their own Escape and stop it there, so
  // Escape out of a dialog doesn't also cancel what's behind it.
  const escRef = useRef({ drawMode, dialog });
  escRef.current = { drawMode, dialog };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (handlesRef.current?.cancelDrag()) setStatus("Edit cancelled");
      else if (escRef.current.drawMode && !escRef.current.dialog) {
        setDrawMode(null);
        setStatus("Drawing cancelled");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setStatus]);

  const placesBusy = placesQ.isFetching && !!placesQ.data;
  const hotspotsBusy = hotspotsQ.isFetching && !hotspotsQ.isFetchingNextPage && hotspots.length > 0;

  const toolbar = (
    <>
      <div className="toolbar-spacer" />
      <div className="toolbar-group">
        {(["rectangle", "circle"] as const).map((type) => (
          <button
            key={type} type="button" id={`draw-${type}-btn`}
            className={drawMode === type ? "active" : undefined} aria-pressed={drawMode === type}
            title={`Draw ${type === "rectangle" ? "Rectangle" : "Circle"}`}
            onClick={() => startDrawing(type)}
          >
            {type === "rectangle" ? "📐 Rectangle" : "⭕ Circle"}
          </button>
        ))}
      </div>
      <div className="toolbar-group">
        <label title="Show the recurring spots mined from your already-geotagged photos, so you can name the ones worth keeping">
          <input type="checkbox" id="show-hotspots-chk" checked={showHotspots} onChange={(e) => toggleHotspots(e.target.checked)} />
          🔥 Hotspots
        </label>
        {showHotspots && (
          <span id="hotspot-controls">
            <select id="hotspot-sort" aria-label="Rank hotspots by" title="How to rank the hotspots" value={hotspotSort}
              onChange={(e) => setHotspotSort(e.target.value as HotspotSort)}>
              <option value="count">Most tagged</option>
              <option value="recent">Most recent</option>
            </select>
            <label title="Limit the list to hotspots inside the map's current view, and follow it as you pan">
              <input type="checkbox" id="hotspot-in-view-chk" checked={inView} onChange={(e) => toggleInView(e.target.checked)} />
              Only in view
            </label>
          </span>
        )}
      </div>
    </>
  );

  return (
    <AppShell active="custom-places" toolbar={toolbar}>
      <div id="main">
        <aside id="sidebar" aria-label="Places">
          <PlaceListHeader shown={shown.length} total={places.length} dense={dense}
            onToggleDense={() => { const next = !dense; setDense(next); storeSet(DENSE_KEY, next ? "compact" : "gallery"); }} />
          {/* Proactive nudge: the busiest unnamed hotspot, shown without asking
              you to flip the Hotspots overlay on first. */}
          {suggested && (
            <SuggestionBanner
              hotspot={suggested}
              onZoom={() => fitCircle(suggested.lat, suggested.lng)}
              onName={() => setDialog({ kind: "name-hotspot", hotspot: suggested })}
              onDismiss={() => dismissSuggestion(suggested)}
            />
          )}
          <PlaceControls query={query} sort={sort} filter={filter} onQuery={setQuery} onSort={setSort} onFilter={setFilter} />
          {placesQ.data && (
            <PlaceList
              places={places} shown={shown} query={query} filter={filter} dense={dense}
              selectedId={selectedId} hover={hover} busy={placesBusy} scrollTick={scrollTick}
              onSelect={selectPlace}
              onHover={(id) => setHover(id == null ? null : { id, fromMap: false })}
              onRename={(place) => setDialog({ kind: "rename", place })}
              onDelete={(place) => setDialog({ kind: "delete", place })}
              onPickRep={(place) => setDialog({ kind: "rep", place })}
              onClearRep={(place) => void pickRep(place, null)}
            />
          )}
          {showHotspots && (
            <HotspotSection
              hotspots={hotspots} total={hotspotTotal} inView={inView} selectedKey={selectedHotspot}
              loading={hotspotsQ.isPending} error={hotspotError} busy={hotspotsBusy}
              loadingMore={hotspotsQ.isFetchingNextPage}
              onSelect={selectHotspot}
              onName={(h) => setDialog({ kind: "name-hotspot", hotspot: h })}
              onLoadMore={() => void loadMoreHotspots()}
            />
          )}
        </aside>
        <PlacesMap
          mapRef={setMap} places={places} revision={revision} selectedId={selectedId} hover={hover}
          onSelect={selectPlace}
          onHover={(id) => setHover(id == null ? null : { id, fromMap: true })}
          onBoundsCommit={(place, shape) => void commitBounds(place, shape)}
          handlesRef={handlesRef}
          hotspots={hotspotError ? [] : hotspots} hotspotRadius={hotspotRadius}
          onHotspotClick={selectHotspot}
          drawMode={drawMode}
          onDrawn={(shape) => setDialog({ kind: "name-shape", shape })}
          onTooSmall={() => {
            // A status line, not an alert(): nothing was created, so there is
            // nothing to acknowledge — the drag just didn't take.
            setStatus("That shape is too small — drag further to set its size.", true);
            stopDrawing();
          }}
          onDrawCancel={() => { stopDrawing(); setStatus("Drawing cancelled"); }}
          onMoveEnd={onMoveEnd}
        />
      </div>
      {dialog?.kind === "name-shape" && (
        // The drawn shape stays on the map behind the dialog, so the name is
        // chosen with the area in sight.
        <PlaceDialog
          title={`Name this ${dialog.shape.type}`}
          radius={dialog.shape.type === "circle" ? dialog.shape.bounds.radius : null}
          submitLabel="Save place" places={places}
          onCancel={() => { setDialog(null); stopDrawing(); setStatus("Drawing cancelled"); }}
          onSubmit={(a) => void saveDrawn(dialog.shape, a)}
        />
      )}
      {dialog?.kind === "name-hotspot" && (
        // The geocoded label is only a suggestion, and the merge radius is
        // offered rather than imposed: it's the smallest circle that covers the
        // cluster, but a driveway and a state park are both one hotspot.
        <PlaceDialog
          title="Name this place" initialName={dialog.hotspot.label} radius={hotspotRadius}
          submitLabel="Save place" places={places}
          onCancel={() => setDialog(null)}
          onSubmit={(a) => void saveHotspot(dialog.hotspot, a)}
        />
      )}
      {dialog?.kind === "rename" && (
        <PlaceDialog
          title={`Rename “${dialog.place.name}”`} initialName={dialog.place.name}
          submitLabel="Rename" places={places} excludeId={dialog.place.id}
          onCancel={() => setDialog(null)}
          onSubmit={(a) => void rename(dialog.place, a)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeletePlaceDialog place={dialog.place} onCancel={() => setDialog(null)} onConfirm={() => void remove(dialog.place)} />
      )}
      {dialog?.kind === "rep" && (
        <RepPicker
          place={places.find((p) => p.id === dialog.place.id) ?? dialog.place}
          onPick={(photoId) => void pickRep(dialog.place, photoId)}
          onClear={() => { setDialog(null); void pickRep(dialog.place, null); }}
          onClose={() => setDialog(null)}
        />
      )}
      <StatusBar status={status} />
    </AppShell>
  );
}

function boxOf(m: LeafletMap) {
  const b = m.getBounds();
  return viewBbox({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() });
}
