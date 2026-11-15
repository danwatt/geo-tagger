import { useEffect, useRef } from "react";
import { gridKeyAction, isTypingTarget, layerAbove, type KeyAction, type KeyCtx } from "./keyboard";

/* Wires the keyboard map (keyboard.ts) to the document. Whether something was
 * stacked above the page is read in the capture phase, before any handler runs:
 * the shortcuts sheet, a dialog, the photo menu or the date popover close on
 * this same press, and by the bubble phase they're already gone — so one Escape
 * would shut them AND drop the area drawing. */

export function useGeocodeKeys(state: () => Omit<KeyCtx, "typing" | "onButton" | "onCell" | "layerAbove">, act: (a: KeyAction) => void) {
  const fns = useRef({ state, act });
  fns.current = { state, act };

  useEffect(() => {
    let hadLayer = false;
    const capture = (e: KeyboardEvent) => { hadLayer = layerAbove(); void e; };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented && e.key !== "Escape") return;
      const t = e.target instanceof Element ? e.target : null;
      const cell = !!t?.closest(".thumb-cell");
      const ctx: KeyCtx = {
        ...fns.current.state(),
        typing: isTypingTarget(e.target),
        onButton: !!t && t.tagName === "BUTTON" && !t.classList.contains("thumb-cell"),
        onCell: cell && t?.tagName === "BUTTON",
        layerAbove: e.key === "Escape" ? hadLayer : layerAbove(),
      };
      const action = gridKeyAction(e, ctx);
      if (!action) return;
      e.preventDefault();
      fns.current.act(action);
    };
    document.addEventListener("keydown", capture, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", capture, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
}
