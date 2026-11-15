import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../ui/Dialog";
import "./PersonPickerDialog.css";

/* "Assign to…" typeahead: pick an existing person or create one by name. Port
 * of face-grid.js openPersonPicker, as a Dialog with a combobox + listbox.
 * Matching is case- and accent-insensitive; names starting with the query rank
 * above names merely containing it. The Create row goes at the *end* so the
 * keyboard highlight lands on the first real match — Enter should tag an
 * existing person, not silently mint a new one that differs from it by a typo.
 * Create is offered unless the query *is* an existing name once folded ("jose"
 * next to "José" is a near-duplicate, not a new person).
 *
 * `fuzzy` (the face-tagging pickers) is face-grid.js's full ranking: exact,
 * prefix, every query word prefixing a name word ("jo sm" → John Smith),
 * substring, then typo-distance matches ("Jon" → John) marked "similar". When
 * only similar names match, Enter defaults to Create: a look-alike is a
 * suggestion to look at, not something to tag silently. */

export type PickedPerson = { person_id: number } | { name: string };

export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export type PickerRow =
  | { kind: "person"; id: number; name: string; similar?: boolean }
  | { kind: "create"; name: string };

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

// Match ranks, best first. RANK_FUZZY must stay the largest.
const RANK_FUZZY = 4;

/** Optimal-string-alignment distance (Levenshtein + adjacent swaps), bailing
 *  out once a whole row exceeds `max` — callers only need "within max". */
export function editDistance(a: string, b: string, max: number): number {
  let prev2: number[] | null = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/** How well folded name `name` matches folded query `q`, or null:
 *  0 exact · 1 prefix · 2 every query word prefixes a name word · 3 substring ·
 *  4 within a small edit distance of the name or one of its words. */
export function matchRank(name: string, q: string): number | null {
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  const words = name.split(/[\s\-'.]+/).filter(Boolean);
  const qWords = q.split(/\s+/).filter(Boolean);
  if (qWords.every((w) => words.some((nw) => nw.startsWith(w)))) return 2;
  if (name.includes(q)) return 3;
  if (q.length < 3) return null;
  // One typo per ~4 letters, at most 2 — loose enough for Jon/John, tight
  // enough that short names don't match everything.
  const max = Math.min(2, Math.floor(q.length / 4) + 1);
  const close = (s: string) => Math.abs(s.length - q.length) <= max && editDistance(s, q, max) <= max;
  return close(name) || words.some(close) ? RANK_FUZZY : null;
}

/** The fuzzy rows plus which one Enter takes by default. */
export function fuzzyPickerRows(persons: readonly { id: number; name: string }[], query: string, allowCreate: boolean): { rows: PickerRow[]; defaultIndex: number } {
  const q = fold(query.trim());
  const ranked: { p: { id: number; name: string }; r: number }[] = [];
  for (const p of persons) {
    const r = q ? matchRank(fold(p.name), q) : 2;
    if (r !== null) ranked.push({ p, r });
  }
  ranked.sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name));
  const rows: PickerRow[] = ranked.map(({ p, r }) => ({ kind: "person", id: p.id, name: p.name, ...(r === RANK_FUZZY ? { similar: true } : {}) }));
  const strong = ranked.some((x) => x.r < RANK_FUZZY);
  const offerCreate = !!q && allowCreate && !persons.some((p) => fold(p.name) === q);
  if (offerCreate) rows.push({ kind: "create", name: query.trim() });
  const defaultIndex = !rows.length ? -1 : strong || !offerCreate ? 0 : rows.length - 1;
  return { rows, defaultIndex };
}

export function PersonPickerDialog({
  persons, title = "Assign to…", allowCreate = true, onPick, onClose,
  label = "Person", listLabel = "People", placeholder = "Search people, or type a new name…",
  emptyText = "No people yet — type a name to create one.", createLabel = (q: string) => `➕ Create "${q}"`,
  fuzzy = false, initialQuery = "", id,
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
  /** face-grid.js's ranking with typo-distance matches (see above). */
  fuzzy?: boolean;
  /** Prefill, selected: typing replaces it, Enter takes it as-is. */
  initialQuery?: string;
  /** The dialog box's id (Quick Tag styles its picker as a bottom sheet). */
  id?: string;
}) {
  const uid = useId();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { rows, defaultIndex } = useMemo(() => fuzzy
    ? fuzzyPickerRows(persons, query, allowCreate)
    : { rows: pickerRows(persons, query, allowCreate), defaultIndex: 0 }, [persons, query, allowCreate, fuzzy]);
  const hl = Math.min(active ?? defaultIndex, rows.length - 1);

  useEffect(() => { inputRef.current?.select(); }, []);

  function pick(row: PickerRow) {
    onPick(row.kind === "create" ? { name: row.name } : { person_id: row.id });
  }

  return (
    <Dialog title={title} onClose={onClose} initialFocus={inputRef} id={id}>
      <div className="pp-body">
        <label htmlFor={`${uid}-q`} className="pp-label">{label}</label>
        <input
          ref={inputRef}
          id={`${uid}-q`}
          type="text"
          className="pp-search"
          autoComplete="off"
          autoCapitalize="words"
          placeholder={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-activedescendant={rows.length && hl >= 0 ? `${uid}-opt-${hl}` : undefined}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(null); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (rows.length) setActive((Math.max(hl, 0) + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[hl] ?? rows[0];
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
              title={row.kind === "person" && row.similar ? "Similar spelling to what you typed" : undefined}
              className={`pp-item${row.kind === "create" ? " pp-new" : ""}${row.kind === "person" && row.similar ? " pp-similar" : ""}${i === hl ? " pp-hl" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(row)}
            >
              {row.kind === "create" ? createLabel(row.name) : <span className="pp-name">{row.name}</span>}
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
