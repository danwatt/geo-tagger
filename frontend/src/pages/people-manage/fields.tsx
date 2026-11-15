import { useEffect, useRef } from "react";

/* The table's inline-edit cells: they look like text until focused (CSS) and
 * save on their own. Uncontrolled inputs synced from the saved value whenever
 * it changes and the field isn't being edited, so a background reload (after
 * any edit elsewhere) never yanks a half-typed value or the focus. */

// <input type="date"> fires `change` on every keystroke that leaves a complete
// date, so typing the year 2019 saved 0002, 0020 and 0201 on the way — and
// blanking one segment mid-edit fires it with value "", which saved a clear.
// Save once typing pauses (or at once on blur), and only a plausible complete
// date or a deliberately emptied field; a half-typed one reverts on blur.
export const DATE_SAVE_DEBOUNCE_MS = 1000;

/** A date the field must not save yet. badInput: some segments filled, some
 *  not (value reads ""). A year below 1000 is a 4-digit year still being typed. */
export function isIncompleteDate(value: string, badInput: boolean): boolean {
  return badInput || (!!value && Number(value.slice(0, 4)) < 1000);
}

function useSyncedValue(saved: string) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.value = saved;
  }, [saved]);
  return ref;
}

/** Name: Enter saves (via blur), Escape reverts. A blank name reverts. */
export function NameField({ saved, label, onSave }: {
  saved: string;
  label: string;
  /** Resolves once the save settled (the caller reports success or failure). */
  onSave: (name: string, revert: () => void) => Promise<void>;
}) {
  const ref = useSyncedValue(saved);
  const revert = () => { if (ref.current) ref.current.value = saved; };
  return (
    <input ref={ref} className="edit-input" defaultValue={saved} aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { revert(); e.currentTarget.blur(); }
      }}
      onBlur={(e) => {
        const name = e.currentTarget.value.trim();
        if (!name) { revert(); return; }
        if (name === saved) return;
        void onSave(name, revert);
      }} />
  );
}

export function DateField({ saved, label, fieldLabel, title, onSave, onIncomplete }: {
  saved: string | null | undefined;
  /** Accessible name, e.g. "Birth date of Ann". */
  label: string;
  /** The field's name in toasts, e.g. "Birth date". */
  fieldLabel: string;
  title: string;
  /** Throws on failure; the field then reverts. */
  onSave: (value: string | null) => Promise<void>;
  onIncomplete: (msg: string) => void;
}) {
  const savedStr = saved || "";
  const ref = useSyncedValue(savedStr);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The value a save is already under way for: the debounce and a blur right
  // after it must not send it twice.
  const inFlight = useRef<string | null>(null);
  const savedRef = useRef(savedStr);
  savedRef.current = savedStr;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function flush(final: boolean) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const el = ref.current;
    if (!el) return;
    const v = el.value;
    if (isIncompleteDate(v, el.validity.badInput)) {
      if (final) {
        el.value = savedRef.current;
        onIncomplete(`${fieldLabel} not saved — enter a full date (YYYY-MM-DD).`);
      }
      return;
    }
    if (v === savedRef.current || v === inFlight.current) return;
    inFlight.current = v;
    try {
      await onSave(v || null);
    } catch {
      if (ref.current) ref.current.value = savedRef.current;
    } finally {
      inFlight.current = null;
    }
  }

  return (
    <input ref={ref} type="date" className="edit-input" defaultValue={savedStr} title={title} aria-label={label}
      onChange={() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(false), DATE_SAVE_DEBOUNCE_MS);
      }}
      onBlur={() => void flush(true)} />
  );
}
