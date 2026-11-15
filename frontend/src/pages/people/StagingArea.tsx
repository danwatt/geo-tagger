import { useId } from "react";
import type { Face } from "../../faces/faceGrid";
import { FaceCrop } from "../../photos/FaceCrop";
import { GroupHeader } from "../../photos/GroupHeader";
import { photoCountLabel } from "./grouping";
import type { PendingEntry, PendingGroup } from "./staging";
import type { PeopleController } from "./usePeople";

/* The staging area under the grid: one amber section per destination with its
 * own Commit / Revert, each staged face with a per-face revert, and a sticky
 * bar that commits or reverts everything. Port of people-staging.js
 * renderPending. Clicking a staged face previews it; its context menu
 * re-targets it (another stage call). */

export function StagingArea({ ctl, onMenu }: { ctl: PeopleController; onMenu: (face: Face, anchor: HTMLElement) => void }) {
  const { state, actions: a } = ctl;
  if (!state.pending.size) return null;
  const groups = a.groupsOfPending();
  return (
    <section id="pending-pane" aria-label="Staged changes">
      <div id="pending-groups">
        {groups.map((g, i) => <PendingSection key={g.key} g={g} index={i} ctl={ctl} onMenu={onMenu} />)}
      </div>
      <div id="pending-bar">
        <span id="pending-summary" aria-live="polite">{state.pending.size} staged change(s) in {groups.length} group(s) — not saved yet</span>
        <div id="pending-bar-btns">
          <button type="button" className="primary" title="Save every staged change to the database" onClick={() => void a.commitAll()}>✔ Commit all</button>
          <button type="button" className="danger" title="Throw away every staged change and put the faces back in the grid" onClick={() => void a.revertAll()}>↩ Revert all</button>
        </div>
      </div>
    </section>
  );
}

function PendingSection({ g, index, ctl, onMenu }: { g: PendingGroup; index: number; ctl: PeopleController; onMenu: (face: Face, anchor: HTMLElement) => void }) {
  const id = useId();
  const a = ctl.actions;
  return (
    <section className={`face-group-section pending-group group-tint-${index % 6}`} aria-labelledby={id}>
      <GroupHeader id={id} title={g.label} variant="amber" meta={`· ${g.entries.length} face(s) · ${photoCountLabel(g.entries.map((e) => e.face))}`}>
        <button type="button" className="primary" title={`Save just this group's ${g.entries.length} change(s) to the database`}
          onClick={() => void a.commitPending([g], g.label)}>✔ Commit ({g.entries.length})</button>
        <button type="button" className="danger" title="Discard this group's staged changes and put the faces back in the grid"
          onClick={() => void a.revertPending([g], g.label)}>↩ Revert</button>
      </GroupHeader>
      <div className="face-group-cells">
        {g.entries.map((e) => <PendingCell key={e.face.id} e={e} ctl={ctl} onMenu={onMenu} />)}
      </div>
    </section>
  );
}

function PendingCell({ e, ctl, onMenu }: { e: PendingEntry; ctl: PeopleController; onMenu: (face: Face, anchor: HTMLElement) => void }) {
  const face = e.face;
  const label = ctl.actions.cellLabel(e);
  const focused = face.id === ctl.state.focusedId;
  return (
    <div className={`thumb-cell pending-cell${focused ? " focused" : ""}`} data-id={face.id}>
      <button type="button" className="face-cell-btn" aria-current={focused || undefined}
        aria-label={`Face in ${face.filename ?? "photo"}, staged: ${label}`}
        onClick={() => ctl.actions.focusFace(face.id)}
        onContextMenu={(ev) => { ev.preventDefault(); ctl.actions.focusFace(face.id); onMenu(face, ev.currentTarget); }}
        onKeyDown={(ev) => {
          if (ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey)) { ev.preventDefault(); ctl.actions.focusFace(face.id); onMenu(face, ev.currentTarget); }
        }}>
        <FaceCrop face={face} alt="" />
      </button>
      <div className="face-label pending-label" aria-hidden="true">{label}</div>
      <button type="button" className="pending-undo" title="Revert this face (back to the grid, unchanged)" aria-label="Revert this face"
        onClick={() => ctl.actions.unstage([face.id])}>✕</button>
    </div>
  );
}
