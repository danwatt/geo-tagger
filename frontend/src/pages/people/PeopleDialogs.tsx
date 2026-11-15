import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../../ui/Dialog";
import type { Person } from "./usePeople";

/* The People page's small dialogs: the keyboard shortcuts table and the
 * birth-date editor (the legacy page used prompt() for it). */

const SHORTCUTS: [string, string][] = [
  ["↑ ↓ / k j", "Move focus to prev/next face"],
  ["Shift+↑/↓", "Extend selection range"],
  ["Space", "Toggle selection of focused face"],
  ["Ctrl+A", "Select all faces in view"],
  ["Esc", "Deselect all / close dialog"],
  ["Enter / a", "Assign selection to a person"],
  ["u / Backspace", "Unassign selection"],
  ["x / i", "Ignore (or restore, in Ignored view)"],
  ["b", "Come back later (or restore, in Come Back view)"],
  ["c", "Confirm suggested name"],
  ["o", "Open focused face's photo"],
  ["f", "View focused face full size (RAW)"],
  ["Shift+N", "Nuclear option: wipe faces for selected photo(s)"],
  ["Shift+F10", "Actions menu for the focused face"],
  ["?", "Show this help"],
];

/** "Shift+↑/↓" → <kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>, keeping the separators. */
function Keys({ spec }: { spec: string }) {
  const parts = spec.split(/(\s*\/\s*|\+|\s+)/);
  return <>{parts.map((p, i) => (i % 2 ? <span key={i}>{p}</span> : p ? <kbd key={i}>{p}</kbd> : null))}</>;
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} id="shortcuts-help-modal">
      <table className="sh-table">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}><td><Keys spec={keys} /></td><td>{what}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="sh-foot">Shortcuts are ignored while typing in a text field.</div>
    </Dialog>
  );
}

/** Set or clear a person's birth date (improves age-aware suggestions). */
export function BirthDateDialog({ person, onSave, onClose }: {
  person: Person;
  /** Resolves true once saved; false keeps the dialog open. */
  onSave: (value: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const uid = useId();
  const [value, setValue] = useState(person.birth_date ?? "");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  const valid = !value.trim() || /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const ok = await onSave(value);
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog title={`Birth date for ${person.name}`} onClose={onClose} initialFocus={input}>
      <form onSubmit={(e) => void submit(e)} className="birth-form">
        <label htmlFor={`${uid}-d`}>Birth date (YYYY-MM-DD), or blank to clear</label>
        <input ref={input} id={`${uid}-d`} type="text" inputMode="numeric" placeholder="YYYY-MM-DD" value={value}
          aria-invalid={!valid || undefined} aria-describedby={!valid ? `${uid}-err` : undefined}
          onChange={(e) => setValue(e.target.value)} />
        {!valid && <div id={`${uid}-err`} className="birth-error" role="alert">Use the YYYY-MM-DD format.</div>}
        <div className="confirm-actions">
          <button type="submit" className="primary" disabled={!valid || busy}>{value.trim() ? "Save" : "Clear birth date"}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
