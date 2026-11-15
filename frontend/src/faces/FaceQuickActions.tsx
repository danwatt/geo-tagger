import { useEffect, useState } from "react";
import { FaceActionsMenu } from "../photos/FaceActionsMenu";
import { PersonPickerDialog, type PickedPerson } from "../photos/PersonPickerDialog";
import { quickActionItems, type QuickActionHandlers, type QuickFace } from "./quickActions";

/* The quick-action menu for one face, with its "Assign to…" person picker.
 * Port of face-grid.js openQuickActions: a popup next to the face, or a bottom
 * sheet on narrow viewports (≤ 640px, Quick Tag on a phone). Picking "Assign
 * to…" swaps the menu for the shared typeahead picker; picking a person calls
 * onAssign (existing) or onAssignNew (a typed name). Render it only while open;
 * onDone fires once the menu (and picker) are gone. */

export type QuickTarget<F extends QuickFace = QuickFace> = { anchor: HTMLElement; face: F; point?: { x: number; y: number } };

export function isNarrowViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= 640;
}

export function FaceQuickActions({ target, persons, handlers, onAssignNew, onDone, sheet, label = "Face actions" }: {
  target: QuickTarget;
  persons: readonly { id: number; name: string }[];
  handlers: Omit<QuickActionHandlers, "onPickPerson">;
  /** Offers "Create …" in the picker when given. */
  onAssignNew?: (name: string) => void;
  onDone: () => void;
  /** Force the bottom sheet; default by viewport width. */
  sheet?: boolean;
  label?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(true);
  const [picker, setPicker] = useState(false);

  // Both flags change in the same click (the menu closes as an item is picked),
  // so by this render a "nothing left open" really means done.
  useEffect(() => {
    if (!menuOpen && !picker) onDone();
  }, [menuOpen, picker, onDone]);

  const items = quickActionItems(target.face, { ...handlers, onPickPerson: () => setPicker(true) });

  function picked(who: PickedPerson) {
    setPicker(false);
    if ("person_id" in who) handlers.onAssign(who.person_id);
    else onAssignNew?.(who.name);
  }

  return (
    <>
      {menuOpen && (
        <FaceActionsMenu anchor={target.anchor} point={target.point} label={label} items={items}
          sheet={sheet ?? isNarrowViewport()} onClose={() => setMenuOpen(false)} />
      )}
      {picker && (
        <PersonPickerDialog persons={persons} title="Assign to…" allowCreate={!!onAssignNew} fuzzy
          onPick={picked}
          onClose={() => {
            setPicker(false);
            if (target.anchor.isConnected) target.anchor.focus();
          }} />
      )}
    </>
  );
}
