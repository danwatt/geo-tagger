import { describe, expect, it } from "vitest";
import { gridKeyAction, type KeyCtx } from "./keyboard";

const ctx = (extra: Partial<KeyCtx> = {}): KeyCtx => ({
  typing: false, onButton: false, onCell: false, layerAbove: false, helpOpen: false, busy: false, guessAvailable: false,
  hasLastCommit: false, hasStaged: false, batchActive: false, drawingArea: false, dayOverride: false, ...extra,
});

describe("gridKeyAction", () => {
  it("maps the grid keys", () => {
    expect(gridKeyAction({ key: "j" }, ctx())).toEqual({ type: "move", delta: 1 });
    expect(gridKeyAction({ key: "ArrowUp" }, ctx())).toEqual({ type: "move", delta: -1 });
    expect(gridKeyAction({ key: "ArrowDown", shiftKey: true }, ctx())).toEqual({ type: "extend", delta: 1 });
    expect(gridKeyAction({ key: "K", shiftKey: true }, ctx())).toEqual({ type: "extend", delta: -1 });
    expect(gridKeyAction({ key: " " }, ctx())).toEqual({ type: "toggle" });
    expect(gridKeyAction({ key: "i" }, ctx())).toEqual({ type: "ignore" });
    expect(gridKeyAction({ key: "Delete" }, ctx())).toEqual({ type: "remove" });
    expect(gridKeyAction({ key: "L" }, ctx())).toEqual({ type: "tag-as" });
    expect(gridKeyAction({ key: "?" }, ctx())).toEqual({ type: "help-open" });
  });

  it("only offers keys whose action is possible", () => {
    expect(gridKeyAction({ key: "g" }, ctx())).toBeNull();
    expect(gridKeyAction({ key: "g" }, ctx({ guessAvailable: true }))).toEqual({ type: "guess" });
    expect(gridKeyAction({ key: "u" }, ctx())).toBeNull();
    expect(gridKeyAction({ key: "u" }, ctx({ hasLastCommit: true }))).toEqual({ type: "undo" });
    expect(gridKeyAction({ key: "Enter" }, ctx())).toBeNull();
    expect(gridKeyAction({ key: "Enter" }, ctx({ hasStaged: true }))).toEqual({ type: "commit" });
    // On a focused cell Enter is the cell's own click.
    expect(gridKeyAction({ key: "Enter" }, ctx({ hasStaged: true, onCell: true }))).toBeNull();
    expect(gridKeyAction({ key: "n" }, ctx())).toBeNull();
    expect(gridKeyAction({ key: "N" }, ctx({ batchActive: true }))).toEqual({ type: "batch-next" });
    expect(gridKeyAction({ key: "s" }, ctx({ batchActive: true }))).toEqual({ type: "batch-skip" });
  });

  it("never steals a keystroke from a field, a button, a dialog or a modifier chord", () => {
    expect(gridKeyAction({ key: "?" }, ctx({ typing: true }))).toBeNull();
    expect(gridKeyAction({ key: "j" }, ctx({ typing: true }))).toBeNull();
    expect(gridKeyAction({ key: " " }, ctx({ onButton: true }))).toBeNull();
    expect(gridKeyAction({ key: "i" }, ctx({ layerAbove: true }))).toBeNull();
    expect(gridKeyAction({ key: "l", ctrlKey: true }, ctx())).toBeNull();
    expect(gridKeyAction({ key: "j", isComposing: true }, ctx())).toBeNull();
  });

  it("swallows grid keys while a scope loads (U4)", () => {
    expect(gridKeyAction({ key: "j" }, ctx({ busy: true }))).toEqual({ type: "swallow" });
    expect(gridKeyAction({ key: "l" }, ctx({ busy: true }))).toEqual({ type: "swallow" });
    expect(gridKeyAction({ key: "u" }, ctx({ busy: true, hasLastCommit: true }))).toEqual({ type: "undo" });
  });

  it("gives the help sheet its own ? and Escape only to what is on top", () => {
    expect(gridKeyAction({ key: "?" }, ctx({ helpOpen: true, typing: true }))).toEqual({ type: "help-close" });
    expect(gridKeyAction({ key: "j" }, ctx({ helpOpen: true }))).toBeNull();
    expect(gridKeyAction({ key: "Escape" }, ctx({ drawingArea: true, dayOverride: true }))).toEqual({ type: "cancel-area" });
    expect(gridKeyAction({ key: "Escape" }, ctx({ dayOverride: true }))).toEqual({ type: "clear-day" });
    expect(gridKeyAction({ key: "Escape" }, ctx({ dayOverride: true, layerAbove: true }))).toBeNull();
  });
});
