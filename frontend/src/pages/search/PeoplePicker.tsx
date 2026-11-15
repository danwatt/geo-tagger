import { useState } from "react";
import type { Person } from "./query";

/* People chip picker: chosen people as removable chips, then an "Add a
 * person…" combobox. Port of search.js wirePersonPicker / renderPersonChips.
 * The legacy suggestions were mouse-only; here Up/Down move through them and
 * Enter adds the highlighted one (Enter never runs the search from this box). */

export function personMatches(all: readonly Person[], chosen: readonly Person[], query: string): Person[] {
  const q = query.trim().toLowerCase();
  const taken = new Set(chosen.map((p) => p.id));
  return all.filter((p) => !taken.has(p.id) && (!q || p.name.toLowerCase().includes(q))).slice(0, 20);
}

export function PeoplePicker({ id, all, value, onChange }: {
  id: string;
  all: readonly Person[];
  value: Person[];
  onChange: (persons: Person[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = `${id}-suggest`;
  const matches = open ? personMatches(all, value, query) : [];

  function add(p: Person) {
    onChange([...value, p]);
    setQuery("");
    setOpen(false);
    setActive(-1);
  }

  return (
    <>
      {value.length > 0 && (
        <ul className="person-chips" aria-label="Chosen people">
          {value.map((p) => (
            <li key={p.id} className="person-chip">
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((x) => x.id !== p.id))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <input
        type="text"
        id={id}
        placeholder="Add a person…"
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 && matches[active] ? `${listId}-${matches[active].id}` : undefined}
        value={query}
        onFocus={() => { setOpen(true); setActive(-1); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(-1); }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
          else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
          } else if (e.key === "Enter") {
            // This box's Enter is its own: never the form's search.
            e.preventDefault();
            const p = matches[active] ?? (matches.length === 1 ? matches[0] : undefined);
            if (p) add(p);
          }
        }}
      />
      <div id={listId} className="person-suggest" role="listbox" aria-label="People" hidden={!open}>
        {matches.length === 0
          ? <div className="person-suggest-empty">No matching people</div>
          : matches.map((p, i) => (
            <div key={p.id} id={`${listId}-${p.id}`} role="option" aria-selected={i === active}
              className={`person-suggest-item${i === active ? " hl" : ""}`}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => { e.preventDefault(); add(p); }}>
              {p.name}
            </div>
          ))}
      </div>
    </>
  );
}
