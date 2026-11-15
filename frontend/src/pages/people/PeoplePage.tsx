import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Face } from "../../faces/faceGrid";
import { FaceQuickActions, type QuickTarget } from "../../faces/FaceQuickActions";
import { PersonPickerDialog } from "../../photos/PersonPickerDialog";
import { AppShell } from "../../shell/AppShell";
import { StatusBar } from "../../shell/StatusBar";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { RestoreBanner } from "../../ui/RestoreBanner";
import { useToasts } from "../../ui/Toast";
import { isTypingTarget } from "../geocode/keyboard";
import { CrowdsView, DiscoverView } from "./ClusterViews";
import { DetailPane } from "./DetailPane";
import { FaceGridView, type CellActions } from "./FaceGridView";
import { readString, writeString } from "./focus";
import { isFlatGridScope } from "./gridModel";
import { GridNav } from "./GridNav";
import { peopleKeyAction } from "./keyboard";
import { BirthDateDialog, ShortcutsHelp } from "./PeopleDialogs";
import { PeopleList } from "./PeopleList";
import { StagingArea } from "./StagingArea";
import { usePeople } from "./usePeople";
import "./people.css";

/* People: face tagging. Port of web/people.html + people-*.js. Left: the
 * queues and people; centre: the face grid for the chosen scope with the
 * staging area under it; right: the focused face's details. */

/* ── Detail-pane width ──
 * The preview's useful width depends on the monitor and the photo, so the
 * divider moves the grid/detail seam (the list keeps its fixed column) and the
 * width is a per-display preference, kept under the legacy key. The ceiling
 * leaves the list, the divider and ~2 columns of faces; re-clamped on resize. */
export const DETAIL_W_LS_KEY = "geotagger.people.detailWidth";
const DETAIL_W_DEFAULT = 340, DETAIL_W_MIN = 240, PEOPLE_LIST_W = 220, RESIZER_W = 6, GRID_MIN_W = 320;

export function clampDetailWidth(px: number, viewport: number): number {
  const max = Math.max(DETAIL_W_MIN, viewport - PEOPLE_LIST_W - RESIZER_W - GRID_MIN_W);
  return Math.round(Math.max(DETAIL_W_MIN, Math.min(max, px)));
}

function useDetailWidth() {
  const stored = () => {
    const n = parseInt(readString(DETAIL_W_LS_KEY) || "", 10);
    return Number.isFinite(n) ? n : DETAIL_W_DEFAULT;
  };
  const [width, setWidth] = useState(() => clampDetailWidth(stored(), window.innerWidth));
  const set = useCallback((px: number, persist = true) => {
    const w = clampDetailWidth(px, window.innerWidth);
    setWidth(w);
    if (persist) writeString(DETAIL_W_LS_KEY, String(w));
  }, []);
  useEffect(() => {
    // A width saved on a wide monitor shouldn't swallow a narrow one, but the
    // preference comes back when the window grows.
    const onResize = () => set(stored(), false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [set]);
  return [width, set] as const;
}

function DetailResizer({ width, setWidth, onDrag }: { width: number; setWidth: (px: number, persist?: boolean) => void; onDrag: (on: boolean) => void }) {
  const dragging = useRef(false);
  return (
    <div id="detail-resizer" className="pane-divider" role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label="Resize faces grid and preview" title="Drag to resize the preview — double-click to reset"
      aria-valuenow={width} aria-valuemin={DETAIL_W_MIN}
      // Pointer capture keeps the drag alive over the grid's cells and past the window edge.
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onDrag(true); e.preventDefault(); }}
      onPointerMove={(e) => { if (dragging.current) setWidth(window.innerWidth - e.clientX); }}
      onPointerUp={() => { dragging.current = false; onDrag(false); }}
      onLostPointerCapture={() => { dragging.current = false; onDrag(false); }}
      onDoubleClick={() => setWidth(DETAIL_W_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 50 : 10;
        if (e.key === "ArrowLeft") setWidth(width + step);
        else if (e.key === "ArrowRight") setWidth(width - step);
        else if (e.key === "Home") setWidth(DETAIL_W_DEFAULT);
        else return;
        e.preventDefault();
      }} />
  );
}

/** True once `on` has held for `ms`, so a fast load never flickers (U4). */
function useDelayed(on: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return shown;
}

/** The loading pill, centred over the visible part of the grid. */
function BusyPill({ over, label }: { over: React.RefObject<HTMLElement | null>; label: string }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = over.current?.parentElement?.getBoundingClientRect();
    if (!r) return;
    const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
    setPos({ left: r.left + r.width / 2, top: top + (bottom - top) / 2 });
  }, [over]);
  return (
    <div className="busy-pill" role="status" style={pos ?? { visibility: "hidden" }}>
      <span className="spinner" aria-hidden="true" /><span>{label}</span>
    </div>
  );
}

export function PeoplePage() {
  const uid = useId();
  const { toast, undoToast, node: toasts } = useToasts();
  const ctl = usePeople({ toast, undoToast });
  const { state, actions: a } = ctl;
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState<QuickTarget<Face> | null>(null);
  const [detailW, setDetailW] = useDetailWidth();
  const [resizing, setResizing] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const busyShown = useDelayed(!!state.busy, 150);
  const swallowBusy = (e: React.SyntheticEvent) => { if (live.current.state.busy) { e.preventDefault(); e.stopPropagation(); } };

  // Toggle: the same face's menu again closes it.
  const openMenu = useCallback((face: Face, anchor: HTMLElement) => {
    setMenu((m) => (m && m.face.id === face.id ? null : { face, anchor }));
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const cellActions = useMemo<CellActions>(() => ({
    click: a.clickCell,
    menu: openMenu,
    confirm: (f, pid) => void a.confirmFace(f.id, pid),
    reject: (f, pid, name) => void a.rejectSuggestion(f.id, pid, name),
    untag: (f) => void a.untagFaces([f.id]),
  }), [a.clickCell, openMenu, a.confirmFace, a.rejectSuggestion, a.untagFaces]);

  /* ── Keyboard shortcuts (keyboard.ts) ── */
  const live = useRef({ state, help, menu, a });
  live.current = { state, help, menu, a };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { state: s, help: helpOpen, menu: m, a: act } = live.current;
      const t = e.target instanceof Element ? e.target : null;
      const action = peopleKeyAction(e, {
        typing: isTypingTarget(e.target) || !!t?.closest('[role="menu"]'),
        onButton: !!t && t.tagName === "BUTTON" && !t.classList.contains("face-cell-btn"),
        onResizer: t?.id === "detail-resizer",
        helpOpen,
        layerAbove: !!m || !!document.querySelector('.modal [role="dialog"]'),
        flatGrid: isFlatGridScope(s.scope),
        busy: !!s.busy,
        scope: s.scope,
      });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case "help-open": setHelp(true); break;
        case "help-close": setHelp(false); break;
        case "swallow": break;
        case "move": case "extend": {
          const id = act.keyMove(action.delta, action.type === "extend");
          // Keep keyboard focus on the focused cell when it was on a cell.
          const onCell = document.activeElement?.classList.contains("face-cell-btn");
          requestAnimationFrame(() => {
            const cell = id != null ? gridRef.current?.querySelector<HTMLElement>(`.face-cell[data-id="${id}"]`) : null;
            cell?.scrollIntoView({ block: "nearest" });
            if (onCell) cell?.querySelector<HTMLElement>(".face-cell-btn")?.focus({ preventScroll: true });
          });
          break;
        }
        case "toggle": act.toggleFocused(); break;
        case "select-all": act.selectAll(); break;
        case "deselect-all": act.deselectAll(); break;
        case "assign": act.openAssignPicker(); break;
        case "unassign": act.unassignSelected(); break;
        case "ignore": act.ignoreSelected(action.ignored); break;
        case "come-back": act.comeBackSelected(action.comeBack); break;
        case "confirm-suggested": act.acceptSelected(); break;
        case "open-photo": act.openFocusedPhoto(); break;
        case "fullsize": act.openFocusedFullsize(); break;
        case "nuke": void act.nukeSelected(); break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const menuFace = menu?.face;
  const flat = isFlatGridScope(state.scope);
  const gridBody = state.scope === "discover" ? <DiscoverView ctl={ctl} onMenu={openMenu} />
    : state.scope === "crowds" ? <CrowdsView ctl={ctl} />
      : <FaceGridView ctl={ctl} actions={cellActions} />;

  return (
    <AppShell active="people" toolbar={
      <>
        <div className="toolbar-group">
          <a className="button" href="/tag.html" title="Phone/tablet-friendly screen to tag groups of faces fast">📱 Quick Tag</a>
          <a className="button" href="/people-manage.html" title="Edit names, birth dates, and family groups">⚙ Manage</a>
        </div>
        <div className="toolbar-group" id="focus-group">
          <label htmlFor={`${uid}-focus`} title="Narrow the people list, Unlabeled queue, suggestions, Discover and Crowds to one Year's time window. Per-person, All and Recently-tagged views stay full-library.">🕑 Focus:</label>
          <select id={`${uid}-focus`} className={state.focus.start != null ? "focus-active" : undefined} value={state.focusValue}
            title="Pick a Year to focus tagging on its time window" onChange={(e) => void a.changeFocus(e.target.value)}>
            <option value="">All time</option>
            {state.monthOption && <option value={state.monthOption.value}>{state.monthOption.label}</option>}
            {state.focusYears.length > 0 && (
              <optgroup label="Year">
                {state.focusYears.map((y) => <option key={y} value={`y:${y}`}>{y}</option>)}
              </optgroup>
            )}
          </select>
          {state.focus.start != null && (
            <span id="focus-note" title={state.focus.label ? `Focused on ${state.focus.label}` : undefined}>◦ windowing people, Unlabeled, suggestions, Discover &amp; Crowds</span>
          )}
        </div>
        <div className="toolbar-group">
          <button type="button" onClick={a.deselectAll}>Deselect all</button>
          <label id="suggested-only-label" className={state.scope === "unlabeled" ? undefined : "dimmed"}
            title="In the Unlabeled queue, show only faces that have a recognition guess">
            <input type="checkbox" checked={state.suggestedOnly} disabled={state.scope !== "unlabeled"}
              onChange={(e) => a.setSuggestedOnly(e.target.checked)} /> Only suggested
          </label>
        </div>
        <div className="toolbar-spacer" />
        <div className="toolbar-group">
          <button type="button" id="shortcuts-help-btn" className="icon-btn" title="Keyboard shortcuts" aria-label="Keyboard shortcuts"
            aria-expanded={help} onClick={() => setHelp(true)}>?</button>
        </div>
      </>
    }>
      <div id="people-main" className={resizing ? "pane-resizing" : undefined} style={{ "--detail-pane-w": `${detailW}px` } as React.CSSProperties}>
        <PeopleList ctl={ctl} />
        <main id="grid-pane" aria-label="Faces">
          <GridNav ctl={ctl} />
          <div id="grid" ref={gridRef} aria-busy={!!state.busy || undefined}
            className={state.busy ? `is-busy${busyShown ? " is-busy-shown" : ""}` : undefined}
            // A busy grid is the previous view's (U4): clicks on it are swallowed.
            onClickCapture={swallowBusy} onContextMenuCapture={swallowBusy}>
            {gridBody}
          </div>
          {busyShown && state.busy && <BusyPill over={gridRef} label={state.busy} />}
          {flat && <StagingArea ctl={ctl} onMenu={openMenu} />}
        </main>
        <DetailResizer width={detailW} setWidth={setDetailW} onDrag={setResizing} />
        <DetailPane ctl={ctl} />
      </div>
      <StatusBar status={state.status} />
      {toasts}

      {state.restore && ctl.restoreRemaining > 0 && (
        <RestoreBanner remaining={ctl.restoreRemaining} detail={state.restore.detail}
          onReview={a.restoreReview} onCommit={() => void a.restoreCommit()} onDiscard={() => void a.restoreDiscard()} onClose={a.restoreHide} />
      )}
      {menu && menuFace && (
        <FaceQuickActions target={menu} persons={state.persons} onDone={closeMenu}
          handlers={{
            onAssign: (pid) => void a.confirmFace(menuFace.id, pid),
            onIgnore: (ignored) => void a.ignoreIds([menuFace.id], ignored),
            onComeBack: (cb) => void a.comeBackIds([menuFace.id], cb),
            onNotPerson: (pid, name) => void a.rejectSuggestion(menuFace.id, pid, name),
            onOpenPhoto: () => a.openPhoto(menuFace.photo_id),
          }}
          onAssignNew={(name) => void a.assignFaceNew(menuFace.id, name)} />
      )}
      {ctl.picker && (
        <PersonPickerDialog persons={state.persons} title={ctl.picker.title} placeholder={ctl.picker.placeholder}
          initialQuery={ctl.picker.initialQuery} allowCreate={ctl.picker.allowCreate ?? true} fuzzy
          onClose={() => ctl.setPicker(null)}
          onPick={(who) => { const p = ctl.picker!; ctl.setPicker(null); p.onPick(who); }} />
      )}
      {ctl.birthEdit && (
        <BirthDateDialog person={ctl.birthEdit.person} onClose={() => ctl.setBirthEdit(null)}
          onSave={(v) => a.saveBirth(ctl.birthEdit!.person, v)} />
      )}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {ctl.ask && (
        <ConfirmDialog title={ctl.ask.title} message={ctl.ask.message} confirmLabel={ctl.ask.confirmLabel} danger={ctl.ask.danger}
          onConfirm={() => { ctl.ask!.resolve(true); ctl.setAsk(null); }}
          onCancel={() => { ctl.ask!.resolve(false); ctl.setAsk(null); }} />
      )}
    </AppShell>
  );
}
