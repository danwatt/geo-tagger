/* Grid selection rules, shared by every photo grid (port of search.js
 * handleThumbClick). Indices are positions in the list the grid draws, so a
 * shift-range covers exactly the cells between the two clicks on screen. */

export type ClickModifiers = { shift: boolean; toggle: boolean };

/** The selection after clicking the cell at `idx`:
 *  - shift (with an anchor): add the range from the last click to this one;
 *  - ctrl/cmd: toggle this one;
 *  - plain: select only this one. */
export function clickSelection(
  selected: ReadonlySet<number>, ids: readonly number[], idx: number, lastIdx: number, mod: ClickModifiers,
): Set<number> {
  const id = ids[idx];
  if (id === undefined) return new Set(selected);
  if (mod.shift && lastIdx >= 0) {
    const next = new Set(selected);
    const lo = Math.min(lastIdx, idx), hi = Math.min(Math.max(lastIdx, idx), ids.length - 1);
    for (let i = lo; i <= hi; i++) next.add(ids[i]!);
    return next;
  }
  if (mod.toggle) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }
  return new Set([id]);
}
