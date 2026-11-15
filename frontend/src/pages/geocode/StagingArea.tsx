import { memo, useId } from "react";
import { GroupHeader } from "../../photos/GroupHeader";
import type { CameraColors } from "../../photos/cameraColors";
import { groupPointCount, stagedChip, type LastCommit, type StagedEntry, type StagedGroup } from "./staging";

/* The staging area under the grid: photos dropped on the map (or marked, or
 * staged for removal) parked under the resolved place until committed or
 * reverted, each group with its own Commit / Revert, and the summary bar pinned
 * to the pane's bottom edge so "N staged, nothing saved" stays visible. The
 * grid and the staging area are two views of one photo list — a staged photo
 * leaves one and appears in the other. Styling is theme.css's shared staging
 * shell (#pending-pane, .pending-cell). Then the "Undo last commit" bar (U2). */

const plural = (n: number, w: string) => `${n} ${w}${n !== 1 ? "s" : ""}`;

function groupTitles(g: StagedGroup) {
  const n = g.entries.length;
  if (g.kind === "ignore") return { commit: `Mark these ${n} photo(s) as needing no location`, revert: "Discard these staged marks and put the photos back in the grid" };
  if (g.kind === "remove") return { commit: `Remove the saved location from these ${n} photo(s)`, revert: "Keep these photos' locations and put them back in the grid" };
  return { commit: `Write just this place's ${n} location(s) to the photos`, revert: "Discard this place's staged locations and put the photos back in the grid" };
}

const StagedCell = memo(function StagedCell({ e, focused, color, onPreview, onUnstage }: {
  e: StagedEntry;
  focused: boolean;
  color: string;
  onPreview: (e: StagedEntry) => void;
  onUnstage: (id: number) => void;
}) {
  const chip = stagedChip(e);
  return (
    <div className={`thumb-cell pending-cell${focused ? " focused" : ""}`} data-id={e.id}>
      {/* Previews the photo and pans to where it would land (a staged removal pans
          to the location it is about to lose; an ignore mark just previews). */}
      <button type="button" className="pending-preview" title={`${e.photo.filename} → ${e.label}`}
        aria-label={`${e.photo.filename}, staged: ${chip}`} onClick={() => onPreview(e)}>
        <span className="cam-strip" style={{ background: color }} aria-hidden="true" />
        <img src={`/api/thumbnail/${e.id}`} loading="lazy" alt="" />
        <span className="face-label pending-label" aria-hidden="true">{chip}</span>
      </button>
      <button type="button" className="pending-undo" aria-label={`Revert ${e.photo.filename}`}
        title="Revert this photo (back to the grid, location unchanged)" onClick={() => onUnstage(e.id)}>✕</button>
    </div>
  );
});

export function StagingArea({ groups, total, focusedId, colors, onCommit, onRevert, onZoom, onPreview, onUnstage }: {
  groups: StagedGroup[];
  total: number;
  focusedId: number | null;
  colors: CameraColors;
  onCommit: (groups: StagedGroup[], what?: string) => void;
  onRevert: (groups: StagedGroup[], what?: string) => void;
  onZoom: (g: StagedGroup) => void;
  onPreview: (e: StagedEntry) => void;
  onUnstage: (id: number) => void;
}) {
  const uid = useId();
  if (!total) return null;
  return (
    <section id="pending-pane" aria-label="Staged changes">
      <div id="pending-groups">
        {groups.map((g, i) => {
          const points = groupPointCount(g);
          const t = groupTitles(g);
          return (
            <section key={g.label} className={`face-group-section pending-group group-tint-${i % 6}${g.kind !== "drop" ? " pending-ignore-group" : ""}`}
              aria-labelledby={`${uid}-g${i}`}>
              <GroupHeader id={`${uid}-g${i}`} title={g.label} variant="amber"
                meta={`· ${plural(g.entries.length, "photo")}` + (points > 1 ? ` · ${points} drop points` : "")}>
                {g.kind === "drop" && (
                  <button type="button" className="icon-btn" aria-label="Zoom to these photos" title="Fit the map to this group's staged point(s)"
                    onClick={() => onZoom(g)}>⛶</button>
                )}
                <button type="button" className="primary" title={t.commit} onClick={() => onCommit([g], g.label)}>✔ Commit ({g.entries.length})</button>
                <button type="button" className="danger" title={t.revert} onClick={() => onRevert([g], g.label)}>↩ Revert</button>
              </GroupHeader>
              <div className="face-group-cells">
                {g.entries.map((e) => (
                  <StagedCell key={e.id} e={e} focused={e.id === focusedId} color={colors.color(e.photo.camera)}
                    onPreview={onPreview} onUnstage={onUnstage} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <div id="pending-bar">
        <span id="pending-summary">{total} staged change(s) in {groups.length} group(s) — not saved yet</span>
        <div id="pending-bar-btns">
          <button type="button" className="primary" title="Write every staged location to the photos" onClick={() => onCommit(groups)}>✔ Commit all</button>
          <button type="button" className="danger" title="Throw away every staged location and put the photos back in the grid" onClick={() => onRevert(groups)}>↩ Revert all</button>
        </div>
      </div>
    </section>
  );
}

/** Shown once a commit lands, until the next one, an undo or a dismiss. Both
 *  bars stick to the pane's bottom edge; while something is staged this one
 *  drops into flow below the staging bar instead of covering it. */
export function UndoBar({ lastCommit, belowStaging, onUndo, onHide }: {
  lastCommit: LastCommit;
  belowStaging: boolean;
  onUndo: () => void;
  onHide: () => void;
}) {
  const n = lastCommit.previous.length;
  const when = new Date(lastCommit.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div id="undo-commit-bar" role="status" className={belowStaging ? "below-staging" : undefined}>
      <span id="undo-commit-summary">Last commit: {n.toLocaleString()} photo{n !== 1 ? "s" : ""} at {when}.</span>
      <div id="undo-commit-btns">
        <button type="button" title="Put every photo in the last commit back the way it was (asks to confirm)" onClick={onUndo}>
          ↶ Undo last commit <kbd>U</kbd>
        </button>
        <button type="button" className="icon-btn" aria-label="Hide undo" title="Hide this bar (the commit stays)" onClick={onHide}>✕</button>
      </div>
    </div>
  );
}
