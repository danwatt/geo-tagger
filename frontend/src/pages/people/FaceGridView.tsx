import { Fragment, memo, useId, useMemo } from "react";
import type { Face } from "../../faces/faceGrid";
import { FaceCrop } from "../../photos/FaceCrop";
import { GroupSection } from "../../photos/GroupHeader";
import type { GridItem, HeaderSpec } from "./gridModel";
import type { PeopleController } from "./usePeople";

/* The main People grid: renders gridModel's items. Port of people-grid.js
 * renderGridInner + people-cells.js. Cells are memoised and their callbacks
 * stable, so a click or arrow key re-renders only the cells whose selection
 * changed — the job paintSelection() did by hand in the legacy page. */

export type CellActions = {
  click: (idx: number, mod: { shift: boolean; toggle: boolean }) => void;
  menu: (face: Face, anchor: HTMLElement) => void;
  confirm: (face: Face, personId: number) => void;
  reject: (face: Face, personId: number, name: string) => void;
  untag: (face: Face) => void;
};

export function cellLabel(face: Face): string {
  const where = face.filename ? `Face in ${face.filename}` : "Face";
  if (face.ignored) return `${where}, ignored`;
  if (face.come_back) return `${where}, come back later`;
  if (face.person_name) return `${where}, ${face.person_name}`;
  if (face.suggestion) return `${where}, looks like ${face.suggestion.person_name ?? "someone"}`;
  return `${where}, unassigned`;
}

/** Space/Enter belong to the page's shortcuts (toggle, assign), not the
 *  button's click; the context-menu key opens the face's actions. */
function cellKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, open: () => void) {
  if (e.key === " " || e.key === "Enter") e.preventDefault();
  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); open(); }
}

export const FaceCell = memo(function FaceCell({ face, idx, selected, tabbable, recent, actions }: {
  face: Face;
  idx: number;
  selected: boolean;
  /** Roving tabindex: only the focused (or first) cell is a tab stop. */
  tabbable: boolean;
  /** Recently tagged: the name chip is a one-click un-tag. */
  recent: boolean;
  actions: CellActions;
}) {
  const alts = face.alternatives ?? [];
  const showChips = !face.ignored && !face.come_back && !face.person_name && !!face.suggestion;
  const cls = "thumb-cell face-cell" + (selected ? " selected" : "") + (face.ignored ? " ignored" : "") +
    (face.come_back ? " come-back" : "") + (showChips && alts.length ? " ambiguous" : "");
  const sug = face.suggestion;
  const suggestChip = sug && (
    <div className="face-suggest" title={`Click to confirm: ${sug.person_name} (${sug.score})`}>
      <button type="button" tabIndex={-1} className="sug-confirm" aria-label={`Confirm ${sug.person_name}`}
        onClick={() => actions.confirm(face, sug.person_id)}>
        <span className="sug-check" aria-hidden="true">✓</span>
        <span className="sug-name">{sug.person_name}?</span>
      </button>
      <button type="button" tabIndex={-1} className="sug-reject" title={`Not ${sug.person_name}`} aria-label={`Not ${sug.person_name}`}
        onClick={() => actions.reject(face, sug.person_id, sug.person_name ?? "")}>✕</button>
    </div>
  );
  return (
    <div className={cls} data-id={face.id}>
      <button type="button" className="face-cell-btn" data-idx={idx} tabIndex={tabbable ? 0 : -1}
        aria-pressed={selected} aria-label={cellLabel(face)}
        onClick={(e) => actions.click(idx, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey })}
        onContextMenu={(e) => { e.preventDefault(); actions.menu(face, e.currentTarget); }}
        onKeyDown={(e) => cellKeyDown(e, () => actions.menu(face, e.currentTarget))}
        onKeyUp={(e) => { if (e.key === " ") e.preventDefault(); }}>
        <FaceCrop face={face} alt="" />
      </button>
      {face.det_score != null && <div className="face-score" aria-hidden="true">{face.det_score.toFixed(2)}</div>}
      {face.ignored ? (
        <div className="face-label ignored-label" aria-hidden="true">Ignored</div>
      ) : face.come_back ? (
        <div className="face-label come-back-label" aria-hidden="true">Come back</div>
      ) : face.person_name && recent ? (
        <button type="button" tabIndex={-1} className="face-untag" title={`Click to un-tag ${face.person_name}`}
          aria-label={`Un-tag ${face.person_name}`} onClick={() => actions.untag(face)}>
          <span className="sug-name">{face.person_name}</span>
          <span className="untag-x" aria-hidden="true">✕</span>
        </button>
      ) : face.person_name ? (
        <div className="face-label" aria-hidden="true">{face.person_name}</div>
      ) : showChips && alts.length ? (
        // Near-tie with another person: flag it and offer a one-click reassign.
        <div className="face-chips">
          {suggestChip}
          {alts.slice(0, 2).map((alt) => (
            <div key={alt.person_id} className="face-alt" title={`Click to tag as ${alt.person_name} instead (${alt.score})`}>
              <button type="button" tabIndex={-1} className="sug-confirm" aria-label={`Tag as ${alt.person_name} instead`}
                onClick={() => actions.confirm(face, alt.person_id)}>
                <span className="alt-arrow" aria-hidden="true">→</span>
                <span className="sug-name">{alt.person_name}?</span>
              </button>
              <button type="button" tabIndex={-1} className="sug-reject" title={`Not ${alt.person_name}`} aria-label={`Not ${alt.person_name}`}
                onClick={() => actions.reject(face, alt.person_id, alt.person_name ?? "")}>✕</button>
            </div>
          ))}
        </div>
      ) : showChips ? suggestChip : null}
    </div>
  );
});

function HeaderButtons({ spec, faces, ctl }: { spec: HeaderSpec; faces: Face[]; ctl: PeopleController }) {
  const a = ctl.actions;
  const ids = () => faces.map((f) => f.id);
  if (spec.kind === "ignore-batch" || spec.kind === "come-back-batch") {
    const ignored = spec.kind === "ignore-batch";
    return (
      <>
        <span className="face-group-scope">this batch:</span>
        <button type="button" title="Add every face in this batch to the current selection" onClick={() => a.addToSelection(faces)}>Select all</button>
        <button type="button" className="primary"
          title={ignored ? "Un-ignore every face in this batch (returns them to the Unlabeled queue)" : "Move every face in this batch back to the Unlabeled queue"}
          onClick={() => void (ignored ? a.ignoreIds(ids(), false) : a.comeBackIds(ids(), false))}>
          Restore all ({faces.length})
        </button>
      </>
    );
  }
  if (spec.kind === "tag-batch") {
    return (
      <>
        <span className="face-group-scope">this batch:</span>
        <button type="button" className="danger" title="Un-tag every face tagged in this batch (returns them to Unlabeled)"
          onClick={() => void a.untagFaces(ids(), spec.who)}>Untag all ({faces.length})</button>
      </>
    );
  }
  const g: Extract<HeaderSpec, { kind: "group" }> = spec;   // narrowed for the callbacks below
  const acceptable = faces.filter((f) => f.suggestion && !f.person_name && !f.ignored);
  const icon = (glyph: string, label: string, title: string, onClick: () => void, kind = "") => (
    <button type="button" className={`icon-btn${kind ? ` ${kind}` : ""}`} title={title} aria-label={label} onClick={onClick}>{glyph}</button>
  );
  return (
    <>
      <span className="face-group-scope">this group:</span>
      {g.openPhotoId != null && icon("🔍", "Open photo", "Open this photo's full face-review page", () => a.openPhotoFaces(g.openPhotoId!))}
      {acceptable.length > 0 && icon("✓", `Accept all (${acceptable.length})`, `Accept all ${acceptable.length} suggestion(s) in this group`,
        () => void a.acceptSuggestionsFor(faces, g.label), "primary")}
      {icon("☑", "Select all", "Add every face in this group to the current selection", () => a.selectGroup(faces, true, g.label))}
      {icon("◉", "Select only", "Select every face in this group and deselect all others", () => a.selectGroup(faces, false, g.label))}
      {icon("☐", "Deselect all", "Remove every face in this group from the current selection", () => a.deselectGroup(faces, g.label))}
      {g.ignoreAll
        ? icon("🚫", "Ignore all", "Ignore every face in this group, regardless of selection", () => void a.ignoreIds(ids(), true), "danger")
        : icon("🚫", "Ignore selected", "Ignore the selected faces in this group", () => {
          const sel = faces.filter((f) => ctl.ref.current.selected.has(f.id)).map((f) => f.id);
          if (!sel.length) { ctl.say(`No selected faces in ${g.label} to ignore.`, true); return; }
          void a.ignoreIds(sel, true);
        }, "danger")}
    </>
  );
}

export function FaceGridView({ ctl, actions }: { ctl: PeopleController; actions: CellActions }) {
  const uid = useId();
  const { state, model } = ctl;
  const idxOf = useMemo(() => new Map(model.order.map((f, i) => [f.id, i])), [model.order]);
  const tabId = state.focusedId != null && idxOf.has(state.focusedId) ? state.focusedId : model.order[0]?.id;
  const recent = state.scope === "recent";
  const cell = (f: Face) => (
    <FaceCell key={f.id} face={f} idx={idxOf.get(f.id) ?? -1} selected={state.selected.has(f.id)}
      tabbable={f.id === tabId} recent={recent} actions={actions} />
  );
  const item = (it: GridItem) => {
    switch (it.type) {
      case "divider":
        return <div key={it.key} className={it.level === "year" ? "grid-year-divider" : "grid-month-divider"} role="heading" aria-level={it.level === "year" ? 3 : 4}>{it.text}</div>;
      case "person-header": {
        const name = state.persons.find((p) => p.id === state.scopePersonId)?.name || "this person";
        return (
          <div key={it.key} className="person-scope-header">
            <span className="person-scope-label">{it.count} tagged photo(s) of {name}</span>
            <button type="button" className="primary" title="Show untagged faces that recognition thinks are this person, so you can confirm them in bulk"
              onClick={() => void ctl.actions.selectScope("suggested", state.scopePersonId)}>🔍 Find more photos of {name}</button>
          </div>
        );
      }
      case "cells":
        return <Fragment key={it.key}>{it.faces.map(cell)}</Fragment>;
      case "group":
        return (
          <GroupSection key={it.key} index={it.index} labelId={`${uid}-${it.key}`} title={it.header.title} meta={it.header.meta || undefined}
            buttons={<HeaderButtons spec={it.header} faces={it.faces} ctl={ctl} />}>
            {it.runs ? (
              <div className="person-runs">
                {it.runs.map((run) => <div key={run[0]!.id} className="person-run">{run.map(cell)}</div>)}
              </div>
            ) : (
              <div className="face-group-cells">{it.faces.map(cell)}</div>
            )}
          </GroupSection>
        );
    }
  };
  return <>{model.items.map(item)}</>;
}
