/* The Geocode page's keyboard map, as a pure function of the key and the page
 * state so the guards can be tested without a DOM. Port of app.js's three
 * document keydown handlers (grid shortcuts, the "l" picker key, the batch N/S
 * keys) plus the two Escape handlers.
 *
 *   ↑ ↓ / k j (also ← →)  move focus to the previous / next photo
 *   Shift + the above      extend the selection range
 *   Space                  toggle the focused photo's selection
 *   l                      Tag selection as… (saved places, recents, hotspots)
 *   i                      stage the selection as needing no location
 *   Delete                 stage removing the selection's saved location
 *   g                      guess the focused photo's location
 *   Enter                  commit everything staged
 *   u                      undo the last commit
 *   n / s                  next / skip batch (work-queue mode only)
 *   ?                      this list
 *   Escape                 cancel Select Area, or drop "Show nearby on map" */

export type KeyInput = { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean };

export type KeyCtx = {
  /** The keystroke belongs to a field or a dialog (isTypingTarget). */
  typing: boolean;
  /** The target is a button other than a grid cell: Space/Enter is its click. */
  onButton: boolean;
  /** The target is a grid cell: Enter is its own click (activate). */
  onCell: boolean;
  /** A dialog, menu or popover is stacked over the page. */
  layerAbove: boolean;
  helpOpen: boolean;
  /** A new scope is loading (U4): the cells and selection are the old scope's. */
  busy: boolean;
  guessAvailable: boolean;
  hasLastCommit: boolean;
  hasStaged: boolean;
  batchActive: boolean;
  drawingArea: boolean;
  dayOverride: boolean;
};

export type KeyAction =
  | { type: "move"; delta: number }
  | { type: "extend"; delta: number }
  | { type: "toggle" } | { type: "guess" } | { type: "ignore" } | { type: "remove" }
  | { type: "undo" } | { type: "commit" } | { type: "tag-as" }
  | { type: "batch-next" } | { type: "batch-skip" }
  | { type: "help-open" } | { type: "help-close" }
  | { type: "cancel-area" } | { type: "clear-day" }
  /** Eaten (preventDefault) but does nothing — a grid key while the grid is busy. */
  | { type: "swallow" };

// Keys that act on the grid's cells or selection — ignored while a scope loads.
const BUSY_KEYS = new Set(["j", "k", "g", "i", " ", "arrowdown", "arrowup", "arrowleft", "arrowright", "delete", "l"]);

export function gridKeyAction(e: KeyInput, ctx: KeyCtx): KeyAction | null {
  if (e.isComposing) return null;
  // Escape only acts when nothing stacked above the map wants it: the dialog,
  // menu or date popover closes on this same press, and must not also drop the
  // drawing (the caller reads layerAbove in the capture phase, before they go).
  if (e.key === "Escape") {
    if (ctx.layerAbove) return null;
    if (ctx.drawingArea) return { type: "cancel-area" };
    if (ctx.dayOverride) return { type: "clear-day" };
    return null;
  }
  // The help sheet takes "?" to close before the field check: its own focus is
  // inside it, which would otherwise count as typing.
  if (ctx.helpOpen) return e.key === "?" ? { type: "help-close" } : null;
  // Fields first: "?" typed into the place search is a character (W7).
  if (ctx.typing) return null;
  if (e.key === "?") return ctx.layerAbove ? null : { type: "help-open" };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (ctx.layerAbove) return null;
  const key = e.key.toLowerCase();
  // The batch keys work from anywhere outside a field — including right after
  // clicking the banner's own Skip / Next buttons.
  if (ctx.batchActive && key === "n") return { type: "batch-next" };
  if (ctx.batchActive && key === "s") return { type: "batch-skip" };
  // Space/Enter on a focused button is that button's click, not a grid key.
  if (ctx.onButton) return null;
  if (ctx.busy && BUSY_KEYS.has(key)) return { type: "swallow" };

  switch (key) {
    case "arrowdown": case "arrowright": case "j":
      return e.shiftKey ? { type: "extend", delta: 1 } : { type: "move", delta: 1 };
    case "arrowup": case "arrowleft": case "k":
      return e.shiftKey ? { type: "extend", delta: -1 } : { type: "move", delta: -1 };
    case " ": return { type: "toggle" };
    case "g": return ctx.guessAvailable ? { type: "guess" } : null;
    case "i": return { type: "ignore" };
    case "delete": return { type: "remove" };
    case "l": return { type: "tag-as" };
    case "u": return ctx.hasLastCommit ? { type: "undo" } : null;
    // On a focused cell Enter is that cell's own click.
    case "enter": return ctx.hasStaged && !ctx.onCell ? { type: "commit" } : null;
  }
  return null;
}

/** isTypingTarget (common.js): a text-like field, contenteditable, or anything
 *  inside an open dialog belongs to itself, not to the page behind it. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if ((t as HTMLElement).isContentEditable) return true;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return !!t.closest('.modal, dialog[open], [role="dialog"]');
}

/** Whether a dialog, menu or the date popover is up. */
export function layerAbove(): boolean {
  return !!document.querySelector('.modal, [role="dialog"], [role="menu"], .drp-panel:not([hidden])');
}
