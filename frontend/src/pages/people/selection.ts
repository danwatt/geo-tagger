import type { Face } from "../../faces/faceGrid";

/* Selection rules for the People grid. Port of people-selection.js, as pure
 * functions over (selection, render order) so they can be tested without the
 * page. `order` is the grid's render order (gridModel's `order`). */

export type Sel = { selected: Set<number>; focusedId: number | null; anchorIdx: number };

/** A click on the cell at `idx`. In the guesses view every face starts
 *  selected, so a plain click toggles (deselects a wrong guess) rather than
 *  collapsing the selection. */
export function cellClick(s: Sel, order: readonly Face[], idx: number, mod: { shift: boolean; toggle: boolean }, guesses: boolean): Sel {
  const face = order[idx];
  if (!face) return s;
  const selected = new Set(s.selected);
  if (mod.toggle || (guesses && !mod.shift)) {
    if (selected.has(face.id)) selected.delete(face.id); else selected.add(face.id);
  } else if (mod.shift && s.anchorIdx >= 0) {
    const lo = Math.min(s.anchorIdx, idx), hi = Math.min(Math.max(s.anchorIdx, idx), order.length - 1);
    for (let i = lo; i <= hi; i++) selected.add(order[i]!.id);
  } else {
    selected.clear();
    selected.add(face.id);
  }
  return { selected, focusedId: face.id, anchorIdx: idx };
}

/** j/k: move focus by `delta` and collapse the selection to that face. */
export function moveFocus(s: Sel, order: readonly Face[], delta: number): Sel {
  if (!order.length) return s;
  let idx = order.findIndex((f) => f.id === s.focusedId);
  idx = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
  idx = Math.max(0, Math.min(order.length - 1, idx + delta));
  const id = order[idx]!.id;
  return { selected: new Set([id]), focusedId: id, anchorIdx: idx };
}

/** Shift+j/k: extend from the anchor to `delta` past the focus. */
export function extendFocus(s: Sel, order: readonly Face[], delta: number): Sel {
  if (!order.length) return s;
  const cur = order.findIndex((f) => f.id === s.focusedId);
  const anchor = s.anchorIdx >= 0 ? s.anchorIdx : Math.max(0, cur);
  let idx = cur === -1 ? anchor : cur;
  idx = Math.max(0, Math.min(order.length - 1, idx + delta));
  const selected = new Set(s.selected);
  for (let i = Math.min(anchor, idx); i <= Math.max(anchor, idx); i++) selected.add(order[i]!.id);
  return { selected, focusedId: order[idx]!.id, anchorIdx: idx };
}

/* ── Auto-preselect (Review guesses, the Unlabeled queue) ──
 * Those scopes pre-select faces on load, but the same load also runs after every
 * commit, "not this person", Focus change and filter switch. Re-selecting from
 * scratch each time undid the user's deselections, so the next Assign staged
 * exactly the faces they had rejected (W15). The first load of a scope visit
 * pre-selects everything eligible; later loads keep the selection as shown,
 * re-derive what the user deselected since, and pre-select only eligible faces
 * they haven't deselected (new ones, or ones a filter had hidden). */
export type PreselectMemory = { key: string | null; shown: Set<number>; deselected: Set<number> };

export const freshPreselectMemory = (): PreselectMemory => ({ key: null, shown: new Set(), deselected: new Set() });

export function applyPreselection(
  selected: ReadonlySet<number>, mem: PreselectMemory, key: string,
  visible: readonly Face[], eligible: (f: Face) => boolean, isStaged: (id: number) => boolean,
): { selected: Set<number>; memory: PreselectMemory } {
  let cur: ReadonlySet<number> = selected;
  let m = mem;
  if (m.key !== key) {
    m = { key, shown: new Set(), deselected: new Set() };
    cur = new Set();
  }
  const deselected = new Set(m.deselected);
  // Eligible faces on screen last time and unselected now were deselected by the
  // user; re-selected ones come off the list. Staged faces left by staging.
  for (const id of m.shown) {
    if (isStaged(id)) continue;
    if (cur.has(id)) deselected.delete(id); else deselected.add(id);
  }
  const present = new Set(visible.map((f) => f.id));
  const next = new Set([...cur].filter((id) => present.has(id)));
  const shown = new Set<number>();
  for (const f of visible) {
    if (!eligible(f)) continue;   // never pre-selected, so "unselected" says nothing
    shown.add(f.id);
    if (!deselected.has(f.id)) next.add(f.id);
  }
  return { selected: next, memory: { key, shown, deselected } };
}

/** Keep only selected faces still on screen (reloads of the other scopes). */
export function pruneSelection(selected: ReadonlySet<number>, visible: readonly Face[]): Set<number> {
  const present = new Set(visible.map((f) => f.id));
  return new Set([...selected].filter((id) => present.has(id)));
}
