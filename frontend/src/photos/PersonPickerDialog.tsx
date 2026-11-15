import { useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../ui/Dialog";
import "./PersonPickerDialog.css";

/* "Assign to…" typeahead: pick an existing person or create one by name. Port
 * of face-grid.js openPersonPicker, as a Dialog with a combobox + listbox.
 * Matching is case- and accent-insensitive; names starting with the query rank
 * above names merely containing it. The Create row goes at the *end* so the
 * keyboard highlight lands on the first real match — Enter should tag an
 * existing person, not silently mint a new one that differs from it by a typo.
 * Create is offered unless the query *is* an existing name once folded ("jose"
 * next to "José" is a near-duplicate, not a new person). */

export type PickedPerson = { person_id: number } | { name: string };

export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export type PickerRow = { kind: "person"; id: number; name: string } | { kind: "create"; name: string };

export function pickerRows(persons: readonly { id: number; name: string }[], query: string, allowCreate: boolean): PickerRow[] {
  const q = fold(query.trim());
  const ranked = persons
    .map((p) => {
      const n = fold(p.name);
      const rank = !q ? 2 : n.startsWith(q) ? 0 : n.includes(q) ? 1 : null;
      return { p, rank };
    })
    .filter((x): x is { p: { id: number; name: string }; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name));
  const rows: PickerRow[] = ranked.map(({ p }) => ({ kind: "person", id: p.id, name: p.name }));
  if (q && allowCreate && !persons.some((p) => fold(p.name) === q)) rows.push({ kind: "create", name: query.trim() });
  return rows;
}

export function PersonPickerDialog({
  persons, title = "Assign to…", allowCreate = true, onPick, onClose,
  label = "Person", listLabel = "People", placeholder = "Search people, or type a new name…",
  emptyText = "No people yet — type a name to create one.", createLabel = (q: string) => `➕ Create "${q}"`,
}: {
  persons: readonly { id: number; name: string }[];
  title?: string;
  allowCreate?: boolean;
  /** The rest re-word the picker for other entities (People Manager's families). */
  label?: string;
  listLabel?: string;
  placeholder?: string;
  emptyText?: string;
  createLabel?: (query: string) => string;
  onPick: (who: PickedPerson) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => pickerRows(persons, query, allowCreate), [persons, query, allowCreate]);
  const hl = Math.min(active, rows.length - 1);

  function pick(row: PickerRow) {
    onPick(row.kind === "create" ? { name: row.name } : { person_id: row.id });
  }

  return (
    <Dialog title={title} onClose={onClose} initialFocus={inputRef}>
      <div className="pp-body">
        <label htmlFor={`${uid}-q`} className="pp-label">{label}</label>
        <input
          ref={inputRef}
          id={`${uid}-q`}
          type="text"
          className="pp-search"
          autoComplete="off"
          placeholder={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-activedescendant={rows.length ? `${uid}-opt-${hl}` : undefined}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (rows.length) setActive((hl + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[hl];
              if (row) pick(row);
            }
          }}
        />
        <div id={`${uid}-list`} className="pp-list" role="listbox" aria-label={listLabel}>
          {rows.map((row, i) => (
            <div
              key={row.kind === "person" ? row.id : "create"}
              id={`${uid}-opt-${i}`}
              role="option"
              aria-selected={i === hl}
              className={`pp-item${row.kind === "create" ? " pp-new" : ""}${i === hl ? " pp-hl" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(row)}
            >
              {row.kind === "create" ? createLabel(row.name) : row.name}
            </div>
          ))}
          {!rows.length && (
            <div className="pp-empty">{query.trim() ? "No matches." : emptyText}</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
