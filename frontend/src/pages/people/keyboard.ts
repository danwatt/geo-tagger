/* The People page's keyboard map, as a pure function of the key and the page
 * state. Port of people-selection.js bindKeyboardShortcuts (the table in the
 * shortcuts help, ShortcutsHelp.tsx, lists the same keys):
 *
 *   ↑ ↓ / k j        move focus to the previous / next face
 *   Shift+↑/↓        extend the selection range
 *   Space            toggle the focused face's selection
 *   Ctrl+A           select every face in view
 *   Esc              deselect all
 *   Enter / a        assign the selection to a person
 *   u / Backspace    unassign the selection
 *   x / i            ignore (restore, in the Ignored view)
 *   b                come back later (restore, in the Come Back view)
 *   c                confirm the suggested names
 *   o                open the focused face's photo
 *   f                view the focused face full size (RAW)
 *   Shift+N          nuclear option for the selected photos
 *   ?                the shortcuts help
 *
 * Shortcuts are ignored while typing in a field or inside a dialog, and on
 * focused buttons (other than face cells) Space/Enter stay that button's own. */

export type PeopleKeyInput = { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean };

export type PeopleKeyCtx = {
  /** A field, contenteditable, or anything inside a dialog / menu has the key. */
  typing: boolean;
  /** The target is a button that isn't a face cell. */
  onButton: boolean;
  /** The pane divider has focus: its arrows resize. */
  onResizer: boolean;
  helpOpen: boolean;
  /** Something modal is up (picker, confirm, menu). */
  layerAbove: boolean;
  /** One of the flat face grids (not Discover / Crowds). */
  flatGrid: boolean;
  /** The grid is being replaced (U4): its cells are the previous view's. */
  busy: boolean;
  /** In the Ignored / Come Back views x/i and b restore. */
  scope: string;
};

export type PeopleKeyAction =
  | { type: "move"; delta: number } | { type: "extend"; delta: number }
  | { type: "toggle" } | { type: "select-all" } | { type: "deselect-all" }
  | { type: "assign" } | { type: "unassign" }
  | { type: "ignore"; ignored: boolean } | { type: "come-back"; comeBack: boolean }
  | { type: "confirm-suggested" } | { type: "open-photo" } | { type: "fullsize" } | { type: "nuke" }
  | { type: "help-open" } | { type: "help-close" }
  | { type: "swallow" };

export function peopleKeyAction(e: PeopleKeyInput, ctx: PeopleKeyCtx): PeopleKeyAction | null {
  if (e.isComposing) return null;
  if (ctx.helpOpen) return e.key === "?" ? { type: "help-close" } : null;   // Escape: the Dialog's own
  if (ctx.typing || ctx.onResizer || ctx.layerAbove) return null;
  if (e.key === "?") return { type: "help-open" };
  if (!ctx.flatGrid) return null;
  if (ctx.onButton && (e.key === " " || e.key === "Enter")) return null;
  if (ctx.busy) {
    // Swallow grid keys while the grid is replaced; leave chords and Escape be.
    return !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== "Escape" ? { type: "swallow" } : null;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") return { type: "select-all" };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;   // browser / OS chords
  switch (e.key) {
    case "ArrowDown": case "j": return e.shiftKey ? { type: "extend", delta: 1 } : { type: "move", delta: 1 };
    case "ArrowUp": case "k": return e.shiftKey ? { type: "extend", delta: -1 } : { type: "move", delta: -1 };
    case " ": return { type: "toggle" };
    case "Escape": return { type: "deselect-all" };
    case "Enter": case "a": return { type: "assign" };
    case "u": case "Backspace": return { type: "unassign" };
    case "x": case "i": return { type: "ignore", ignored: ctx.scope !== "ignored" };
    case "b": return { type: "come-back", comeBack: ctx.scope !== "come_back" };
    case "c": return { type: "confirm-suggested" };
    case "o": return { type: "open-photo" };
    case "f": return { type: "fullsize" };
    case "N": return e.shiftKey ? { type: "nuke" } : null;
  }
  return null;
}
