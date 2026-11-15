import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client";
import { FaceActionsMenu } from "../../photos/FaceActionsMenu";
import { photoQueryKey, type PhotoDetail } from "../../photos/PhotoPreviewPane";
import { AppShell } from "../../shell/AppShell";
import { StatusBar, type Status } from "../../shell/StatusBar";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { PaneDivider, usePaneLayout } from "../../ui/ResizablePanes";
import type { DateRange } from "../../ui/DateRangePicker";
import { CameraColors } from "./cameraColors";
import { DetailPane } from "./DetailPane";
import { DRAG_MIME, GeocodeMap, type Imprecise } from "./GeocodeMap";
import { GeocodeGrid, type GridHandlers } from "./GeocodeGrid";
import { BatchBanner, CameraLegend, ProposeBar, RestoreBanner, ShortcutsHelp } from "./GridBars";
import { GridPane } from "./GridPane";
import { dayCounts, gridItems, hasTimeline, pinnedPhotos, saveBand, saveToggles, type FilterKey } from "./grouping";
import { MonthPickerDialog } from "./MonthPickerDialog";
import { ScopeFilters } from "./ScopeFilters";
import { groupStaged, type Photo } from "./staging";
import { StagingArea, UndoBar } from "./StagingArea";
import { TagAsDialog } from "./TagAsDialog";
import { useBatchFlow } from "./useBatchFlow";
import { useCommitFlow } from "./useCommitFlow";
import { useGeocodeKeys } from "./useGeocodeKeys";
import { useGridActions } from "./useGridActions";
import { useGuess } from "./useGuess";
import { useMapHandle } from "./useMapHandle";
import { useProposal } from "./useProposal";
import { useScopeLoader } from "./useScopeLoader";
import { useStaging } from "./useStaging";
import { useStartup, type Restored } from "./useStartup";
import { useTagAs } from "./useTagAs";
import { showingText, useWorkspace } from "./useWorkspace";
import { useAreaSelect, useLocationScope, useRestoreBanner } from "./usePageParts";
import { shortDir, workspaceScopeText } from "./scope";
import "../../ui/ui.css";
import "./geocode.css";

/* Geocode: put locations on photos. Pick a scope (a month, a folder, a place, a
 * drawn area, a work-queue batch, a Search hand-off), select photos in the grid,
 * and drop them on the map — or Tag as… a place already in use, or take the
 * propose bar's suggestion. Nothing is written until Commit: every change parks
 * in the staging area (mirrored to sessionStorage, U7), and a committed batch
 * can be taken back with Undo last commit (U2). Originals are never touched —
 * locations go to XMP sidecars. Port of web/geocode.html + app.js. */

const NOOP_KEY = () => {};

export function GeocodePage() {
  const queryClient = useQueryClient();
  const [status, setStatusState] = useState<Status>({ message: "" });
  const say = useCallback((message: string, isError = false) => setStatusState({ message, isError }), []);
  const map = useMapHandle();
  const [colors] = useState(() => new CameraColors());
  const ws = useWorkspace();
  const w = ws.state;
  const staging = useStaging(useCallback((m: string) => say(m, true), [say]));
  const staged = staging.staged;
  const windowRef = useRef("900");
  const [windowSecs, setWindowSecs] = useState("900");
  const [imprecise, setImprecise] = useState<Imprecise>({ on: false, radius: "40233.6" });
  const impreciseRef = useRef(imprecise);
  impreciseRef.current = imprecise;
  const dropAccuracy = useCallback(() => (impreciseRef.current.on ? parseFloat(impreciseRef.current.radius) : null), []);
  const [monthOpen, setMonthOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menu, setMenu] = useState<{ photo: Photo; anchor: HTMLElement; point?: { x: number; y: number } } | null>(null);
  const layout = usePaneLayout("geotagger.workspace.geocode.v1", [30, 44, 26]);
  const mainRef = useRef<HTMLDivElement>(null);

  const places = useQuery({
    queryKey: ["places"],
    // A place whose stored bounds the server can't read can't be drawn or
    // jumped to; Named Places lists it.
    queryFn: async () => unwrap(await api.GET("/api/places", {})).filter((p) => p.bounds_valid !== false),
  });
  // The folder facet is a shortcut; the month picker still works without it.
  const dirs = useQuery({
    queryKey: ["photos", "dirs", 500],
    queryFn: async () => unwrap(await api.GET("/api/photos/dirs", { params: { query: { limit: 500 } } })),
  });

  const exitBatch = useRef<() => void>(() => {});
  const location = useLocationScope();
  const scope = useScopeLoader({
    ws, staging, map, say, windowSecs: () => windowRef.current,
    beforeEnter: (def, keepBatch) => {
      // Picking a scope by hand means the user has stopped being driven by the
      // work queue — the banner would lie about what is loaded, and the batch
      // would read 0 left for members that aren't loaded and auto-advance.
      if (!keepBatch) exitBatch.current();
      location.entered(def);
      setMonthOpen(false);
    },
  });
  const proposal = useProposal(w.selected, w.loading);
  const batch = useBatchFlow({ ws, staging, map, say, load: scope.load, onOpened: proposal.resetDismissed });
  exitBatch.current = batch.exit;
  const commit = useCommitFlow({ ws, staging, say, onCommitted: batch.maybeAdvance });
  const actions = useGridActions({ ws, staging, map, say, dropAccuracy });
  const guess = useGuess({ focusedId: w.focusedId, windowSecs, map, say });
  const tagAs = useTagAs({
    ws, say, fallbackPlaces: () => places.data ?? [],
    onPick: (ids, item) => void actions.stageDrop(ids, item.lat, item.lng, item.accuracy ?? dropAccuracy()),
  });
  const area = useAreaSelect({ map, say, load: scope.load });
  const groups = useMemo(() => groupStaged(staged.values()), [staged]);
  const restore = useRestoreBanner({ staging, map, say, commit });
  useStartup({ map, staging, batch, load: scope.load, say, onRestored: (r: Restored) => restore.show(r) });

  // Staged drops are backed up to this tab's sessionStorage (U7), but that is
  // gone once the tab is closed for good — so still ask before leaving.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!staging.ref.current.size) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [staging]);

  // ── Derived view ──
  const filtered = ws.filtered;
  const items = useMemo(() => gridItems(filtered, (id) => staged.has(id), w.band), [filtered, staged, w.band]);
  const pins = useMemo(() => pinnedPhotos(filtered, w.photos, w.dayOverride, w.isolation), [filtered, w.photos, w.dayOverride, w.isolation]);
  const dates = useMemo(() => dayCounts(w.photos), [w.photos]);
  const timeline = !!w.scope && !["undated", "dir"].includes(w.scope.kind) && hasTimeline(w.photos);
  const focused = useMemo(() => (w.focusedId == null ? null
    : w.photos.find((p) => p.id === w.focusedId) ?? staged.get(w.focusedId)?.photo ?? null), [w.focusedId, w.photos, staged]);
  const busyShown = useDelayed(w.loading);

  // ── View changes (pure presentation of the loaded scope — no reload) ──
  const showing = (deselected: number) => say(showingText(ws.filteredOf(ws.ref.current).length, ws.ref.current.photos.length, deselected));
  function toggleFilter(key: FilterKey) {
    const toggles = { ...ws.ref.current.toggles, [key]: !ws.ref.current.toggles[key] };
    // Saved on a click only — the work queue forcing Not tagged on is for that
    // pass, not a preference.
    saveToggles(toggles);
    showing(ws.view({ toggles }));
  }
  function toggleCamera(camera: string) {
    const hidden = new Set(ws.ref.current.hidden);
    if (hidden.has(camera)) hidden.delete(camera); else hidden.add(camera);
    showing(ws.view({ hidden }));
  }
  // A scrubber drag commits on every pointer move, faster than a grid + map
  // rebuild can finish: coalesce into one rebuild per frame, always of the
  // latest edge (including the one the drag ended on).
  const pendingRange = useRef<DateRange | null>(null);
  const frame = useRef(0);
  function onDateRange(r: DateRange) {
    pendingRange.current = r;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const next = pendingRange.current;
      if (next) showing(ws.view({ dateRange: next }));
    });
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function changeWindow(v: string) {
    windowRef.current = v;
    setWindowSecs(v);
    scope.reload();
  }

  // ── Keyboard ──
  const guessAvailable = () => {
    const id = ws.ref.current.focusedId;
    const d = id == null ? undefined : queryClient.getQueryData<PhotoDetail>(photoQueryKey(id));
    return !!d && d.lat == null && !!d.datetime;
  };
  useGeocodeKeys(() => ({
    helpOpen, busy: ws.ref.current.loading, guessAvailable: guessAvailable(), hasLastCommit: !!commit.lastCommit,
    hasStaged: staging.ref.current.size > 0, batchActive: !!batch.ref.current, drawingArea: area.drawing,
    dayOverride: !!ws.ref.current.dayOverride,
  }), (a) => {
    switch (a.type) {
      case "move": actions.move(a.delta); break;
      case "extend": actions.extend(a.delta); break;
      case "toggle": actions.toggleFocused(); break;
      case "guess": void guess.start(); break;
      case "ignore": actions.stageIgnore(); break;
      case "remove": actions.stageRemove(); break;
      case "undo": commit.undo(); break;
      case "commit": commit.commit(groupStaged(staging.ref.current.values())); break;
      case "tag-as": void tagAs.open(); break;
      case "batch-next": void batch.next(); break;
      case "batch-skip": batch.skip(); break;
      case "help-open": setHelpOpen(true); break;
      case "help-close": setHelpOpen(false); break;
      case "cancel-area": area.cancel(); break;
      case "clear-day": actions.clearDayOnMap(); break;
      case "swallow": break;
    }
  });

  // ── Grid handlers (stable: the cells are memoised) ──
  const latest = useRef({ actions, ws });
  latest.current = { actions, ws };
  const handlers = useMemo<GridHandlers>(() => ({
    onActivate: (idx, mod) => latest.current.actions.activate(idx, mod),
    onKey: NOOP_KEY,
    onDragStart: (e, idx) => {
      const { ws: s } = latest.current;
      const photo = s.filteredOf(s.ref.current)[idx];
      if (!photo) return;
      if (!s.ref.current.selected.has(photo.id)) s.update({ selected: new Set([photo.id]) });
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify([...s.ref.current.selected]));
      e.dataTransfer.effectAllowed = "copy";
    },
    onContextMenu: (e, idx) => {
      e.preventDefault();
      const { ws: s } = latest.current;
      const photo = s.filteredOf(s.ref.current)[idx];
      if (!photo) return;
      // Shift+F10 / the menu key report no pointer position: open under the cell.
      const point = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined;
      setMenu({ photo, anchor: e.currentTarget, point });
    },
    onIsolate: (day) => latest.current.actions.isolateDay(day),
    onZoomDay: (entries) => latest.current.actions.zoomTo(entries.map((x) => ({ lat: x.photo.lat!, lng: x.photo.lng! }))),
    onSelectUntagged: (entries, title) => latest.current.actions.selectUntagged(entries, title),
  }), []);

  function menuItems(photo: Photo) {
    // Right-clicking inside the selection acts on all of it; outside it, on that
    // one photo, leaving the selection alone.
    const ids = w.selected.has(photo.id) ? [...w.selected] : [photo.id];
    const suffix = ids.length > 1 ? ` (${ids.length})` : "";
    const located = actions.locatedIds(ids);
    return [
      { label: `🚫 Ignore location${suffix}`, title: "Stage as needing no location — review and Commit below", onSelect: () => actions.stageIgnore(ids) },
      { label: `📍 Assign location…${suffix}`, title: "Pick from saved places, recent locations and hotspots (same as the L key)", onSelect: () => void tagAs.open(ids) },
      {
        label: `❌ Remove location${located.length > 1 ? ` (${located.length})` : ""}`, disabled: !located.length,
        title: located.length ? "Stage removing the saved location — review and Commit below (same as the Del key)" : "No saved location to remove",
        onSelect: () => actions.stageRemove(located),
      },
      { label: "🗺 Show nearby on map", title: "Put every photo from this photo's day on the map, whatever the Show toggles say", onSelect: () => actions.showDayOnMap(photo) },
    ];
  }

  const selectedCount = w.selected.size;
  const totalWeight = layout.weights.slice(0, layout.visible).reduce((a, b) => a + b, 0);

  return (
    <AppShell active="geocode">
      <ScopeFilters scope={w.scope} locationText={location.text} editing={location.editing}
        onLocationText={location.setText} onLocationEdit={location.edit}
        onLocationPick={(item) => void location.pick(item, async () => (await places.refetch()).data ?? [], scope.load, say)}
        onBuffer={(miles) => scope.reload((d) => (d.kind === "place" ? { ...d, buffer: miles } : d))}
        onSelectMonth={() => setMonthOpen(true)} dirs={dirs.data ?? []}
        onDir={(dir) => void scope.load({ kind: "dir", dir, label: shortDir(dir) })}
        dateRange={w.dateRange} dates={dates} timeline={timeline} generation={w.generation} onDateRange={onDateRange}
        drawing={area.drawing} onSelectArea={area.toggle} onUseMapView={area.useMapView}
        windowSecs={windowSecs} onWindow={changeWindow} />
      <div className="workspace-scope">
        <span id="workspace-scope-text">{workspaceScopeText(w.scope, w.dateRange.label ?? null)}</span>
        <button type="button" id="preview-toggle" aria-expanded={layout.previewVisible} aria-controls="detail-pane" onClick={layout.togglePreview}>
          {layout.previewVisible ? "Hide preview" : "Show preview"}
        </button>
      </div>
      <CameraLegend photos={w.photos} colors={colors} hidden={w.hidden} onToggle={toggleCamera} />

      <div id="main" ref={mainRef} className="workspace-panes" style={{ gridTemplateColumns: layout.columns }}>
        <GeocodeMap map={map} pins={pins} colors={colors} staged={staged} places={places.data ?? []} scope={w.scope}
          focused={focused} guess={guess.guess} onGuessMove={guess.move}
          drawing={area.drawing} onAreaDrawn={area.drawn} onAreaTooSmall={area.tooSmall} onAreaCancel={area.cancelled}
          onPinClick={actions.selectOnly} onStageAt={(ids, lat, lng) => void actions.stageDrop(ids, lat, lng)}
          onStageAtCenter={() => { const c = map.get()?.getCenter(); if (c) void actions.stageDrop([...w.selected], c.lat, c.lng); }}
          selectedCount={selectedCount} imprecise={imprecise} onImprecise={setImprecise} say={say} />
        <PaneDivider index={0} label="Resize map and photos" weight={layout.weights[0]!} onAdjust={layout.adjust}
          containerRef={mainRef} totalWeight={totalWeight} />
        <GridPane
          banner={batch.batch && <BatchBanner batch={batch.batch} selected={selectedCount}
            onSkip={batch.skip} onNext={() => void batch.next()} onExit={batch.exit} />}
          proposal={proposal.proposal && (
            <ProposeBar proposal={proposal.proposal} selected={selectedCount} onDismiss={proposal.dismiss}
              onStage={(lat, lng) => void actions.stageDrop([...ws.ref.current.selected], lat, lng)} />
          )}
          toggles={w.toggles} onToggle={toggleFilter} band={w.band}
          onBand={(secs) => { saveBand(secs); ws.update({ band: secs }); }}
          onNextBatch={() => void batch.next()} selectedCount={selectedCount}
          onTagAs={() => void tagAs.open()} onIgnore={() => actions.stageIgnore()} onRemove={() => actions.stageRemove()}
          onHelp={() => setHelpOpen(true)}>
          <GeocodeGrid items={items} band={w.band} isolation={w.isolation} selected={w.selected} focusedId={w.focusedId}
            colors={colors} busy={w.loading} busyShown={busyShown} handlers={handlers}
            emptyMessage={w.scope && !w.loading && w.photos.length && !items.length ? "No photos match the Show filters." : null} />
          <StagingArea groups={groups} total={staged.size} focusedId={w.focusedId} colors={colors}
            onCommit={commit.commit} onRevert={commit.revert}
            onZoom={(g) => actions.zoomTo(g.entries.flatMap((e) => (e.kind === "drop" ? [{ lat: e.lat, lng: e.lng }] : [])), 60, 15)}
            onPreview={(e) => {
              ws.update({ focusedId: e.id });
              if (e.kind === "drop") map.run((m) => m.panTo([e.lat, e.lng]));
              else if (e.kind === "remove" && e.photo.lat != null && e.photo.lng != null) map.run((m) => m.panTo([e.photo.lat!, e.photo.lng!]));
            }}
            onUnstage={(id) => { staging.unstage([id]); say("Reverted 1 staged change(s)."); }} />
          {commit.lastCommit && !commit.undoHidden && (
            <UndoBar lastCommit={commit.lastCommit} belowStaging={staged.size > 0} onUndo={commit.undo} onHide={commit.hideUndo} />
          )}
        </GridPane>
        {layout.previewVisible && (
          <PaneDivider index={1} label="Resize photos and preview" weight={layout.weights[1]!} onAdjust={layout.adjust}
            containerRef={mainRef} totalWeight={totalWeight} />
        )}
        <DetailPane photoId={w.focusedId} hidden={!layout.previewVisible} guess={guess.guess} guessing={guess.searching}
          onGuess={() => void guess.start()} onDismissGuess={guess.dismiss}
          onApplyGuess={async () => {
            const g = guess.guess;
            if (!g) return;
            // The guess carries the photo it was made for — focus may have moved since.
            await commit.geotagNow([g.photoId], g.lat, g.lng);
            guess.dismiss();
            void queryClient.invalidateQueries({ queryKey: photoQueryKey(g.photoId) });
          }}
          onSetIgnored={(id, ignored) => commit.setIgnoredNow([id], ignored)} />
      </div>

      {restore.visible && <RestoreBanner {...restore.props} />}
      {menu && (
        <FaceActionsMenu anchor={menu.anchor} point={menu.point} label="Photo actions" onClose={() => setMenu(null)}
          heading={w.selected.has(menu.photo.id) && w.selected.size > 1 ? `${w.selected.size} selected photos` : menu.photo.filename}
          items={menuItems(menu.photo)} />
      )}
      {monthOpen && (
        <MonthPickerDialog onClose={() => setMonthOpen(false)} onError={(m) => say(m, true)}
          onMonth={(year, month) => void scope.load({ kind: "month", year, month }, { fitMap: true })}
          onYear={(year) => void scope.load({ kind: "month", year, month: null }, { fitMap: true })}
          onUndated={() => void scope.load({ kind: "undated" }, { fitMap: true })} />
      )}
      {tagAs.dialog && <TagAsDialog {...tagAs.dialog} />}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      {commit.confirm && (
        <ConfirmDialog title={commit.confirm.title} message={commit.confirm.message} confirmLabel={commit.confirm.confirmLabel}
          danger={commit.confirm.danger} onConfirm={commit.confirm.onConfirm} onCancel={commit.cancelConfirm} />
      )}
      <StatusBar status={status} />
    </AppShell>
  );
}

/** A busy flag that only turns on after `ms`, so a fast load doesn't flicker (U4). */
function useDelayed(on: boolean, ms = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return shown;
}

