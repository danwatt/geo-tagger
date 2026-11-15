import { useEffect, useId, useRef, useState } from "react";
import { api, unwrap, type Schemas } from "../../api/client";
import { MONTH_NAMES } from "../../lib/format";
import { Dialog } from "../../ui/Dialog";
import { formatGuess } from "./query";

/* The selection toolbar's two date dialogs. Ports of search.js's Assign-date
 * and Guess-dates modals; their alert()/confirm() prompts are inline now.
 *
 * Both act on the ids captured when they opened, not whatever the selection
 * holds by the time Apply / Commit is pressed: a search or Clear selection
 * behind the dialog must not turn the request into an empty (or different)
 * photo_ids list. */

export type DateSnapshot = Schemas["PreviousDate"];

export function precisionLabel(year: number, month: number | null): string {
  return month ? `${MONTH_NAMES[month - 1]} ${year}` : `${year} (year only)`;
}

export function AssignDateDialog({ ids, onClose, onAssigned }: {
  ids: number[];
  onClose: () => void;
  onAssigned: (updated: number) => void;
}) {
  const uid = useId();
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ year: number; month: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const yearRef = useRef<HTMLInputElement>(null);
  const n = ids.length;

  function ask() {
    // Already posting (Enter in a field can fire while Assign is disabled).
    if (busy) return;
    const y = parseInt(year, 10);
    if (!year || Number.isNaN(y)) {
      setError("Please enter a year.");
      yearRef.current?.focus();
      return;
    }
    setError(null);
    setConfirming({ year: y, month: month ? parseInt(month, 10) : null });
  }

  async function apply() {
    if (!confirming || busy) return;
    setBusy(true);
    try {
      const r = unwrap(await api.POST("/api/photos/assign-date", { body: { photo_ids: ids, year: confirming.year, month: confirming.month } }));
      onAssigned(r.updated);
    } catch (e) {
      setError(`Assign date failed: ${(e as Error).message}`);
      setConfirming(null);
      setBusy(false);
    }
  }

  // Enter in a field asks (then confirms), like pressing the button.
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask();
  };

  return (
    <Dialog title="Assign approximate date" onClose={onClose} initialFocus={yearRef} id="assign-date-modal">
      <p className="dialog-summary">Assigning an approximate date to {n} selected photo{n === 1 ? "" : "s"}.</p>
      <div className="search-field">
        <label htmlFor={`${uid}-year`}>Year</label>
        <input ref={yearRef} type="number" id={`${uid}-year`} min={1826} step={1} value={year}
          aria-invalid={!!error && !year} aria-describedby={error ? `${uid}-err` : undefined}
          onChange={(e) => { setYear(e.target.value); setConfirming(null); }} onKeyDown={onEnter} />
      </div>
      <div className="search-field">
        <label htmlFor={`${uid}-month`}>Month (optional — leave blank for year-only precision)</label>
        <select id={`${uid}-month`} value={month} onChange={(e) => { setMonth(e.target.value); setConfirming(null); }} onKeyDown={onEnter}>
          <option value="">— Year only —</option>
          {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
        </select>
      </div>
      {error && <p id={`${uid}-err`} className="dialog-error" role="alert">{error}</p>}
      {confirming ? (
        <div className="inline-confirm dialog-confirm" role="alertdialog" aria-labelledby={`${uid}-confirm`}>
          <p id={`${uid}-confirm`}>
            Assign approximate date “{precisionLabel(confirming.year, confirming.month)}” to {n} photo(s)? This overwrites any existing date on these photos.
          </p>
          <button type="button" className="primary" disabled={busy} autoFocus onClick={() => void apply()}>
            {busy ? "Assigning…" : "Yes, assign"}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(null)}>Back</button>
        </div>
      ) : (
        <div className="search-field search-field-actions">
          <button type="button" className="primary" onClick={ask}>Assign</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      )}
    </Dialog>
  );
}

export function GuessDatesDialog({ ids, onClose, onCommitted }: {
  ids: number[];
  onClose: () => void;
  onCommitted: (updated: number, previous: DateSnapshot[]) => void;
}) {
  const [guesses, setGuesses] = useState<Schemas["PhotoDateGuess"][] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = unwrap(await api.POST("/api/photos/guess-dates", { body: { photo_ids: ids } }));
        if (!live) return;
        setGuesses(r.guesses);
        // Every row with a guess starts checked; the user unchecks what's wrong.
        setChecked(new Set(r.guesses.flatMap((g, i) => (g.guess ? [i] : []))));
      } catch (e) {
        if (live) setLoadError((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [ids]);

  async function commit() {
    if (!guesses || busy) return;
    const rows = guesses.filter((g, i) => checked.has(i) && g.guess);
    if (!rows.length) { setError("No guesses selected to commit."); return; }
    setError(null);
    setBusy(true);
    try {
      const entries = rows.map((g) => ({
        photo_id: g.photo_id, year: g.guess!.year, month: g.guess!.month ?? null,
        day: g.guess!.day ?? null, precision: g.guess!.precision ?? null,
      }));
      const r = unwrap(await api.POST("/api/photos/commit-guessed-dates", { body: { entries } }));
      onCommitted(r.updated, r.previous);
    } catch (e) {
      setError(`Commit failed: ${(e as Error).message}`);
      setBusy(false);
    }
  }

  const found = guesses?.filter((g) => g.guess).length ?? 0;
  return (
    <Dialog title="Guess dates from filename/folder" onClose={onClose} wide id="guess-dates-modal">
      <p className="dialog-summary" aria-live="polite">
        {loadError ? `Failed to guess dates: ${loadError}`
          : !guesses ? `Checking filenames and folder names for ${ids.length} selected photo(s)…`
          : `Found a guess for ${found} of ${guesses.length} photo(s). Review, uncheck any you don't want, then Commit. Photos with no guess are skipped.`}
      </p>
      {guesses && (
        <div className="guess-dates-table-wrap">
          <table className="guess-dates-table">
            <thead><tr><th scope="col"><span className="visually-hidden">Commit</span></th><th scope="col">Filename</th><th scope="col">Guessed date</th><th scope="col">Source</th></tr></thead>
            <tbody>
              {guesses.map((g, i) => (
                <tr key={g.photo_id} className={g.guess ? undefined : "no-guess"}>
                  <td>
                    <input type="checkbox" checked={checked.has(i)} disabled={!g.guess}
                      aria-label={`Commit the guess for ${g.filename}`}
                      onChange={(e) => setChecked((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(i); else next.delete(i);
                        return next;
                      })} />
                  </td>
                  <td>{g.filename}</td>
                  <td>{formatGuess(g.guess, MONTH_NAMES)}</td>
                  <td className="guess-source">{g.guess?.source ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="search-field search-field-actions dialog-actions">
        <button type="button" className="primary" disabled={!guesses || busy} onClick={() => void commit()}>{busy ? "Committing…" : "Commit"}</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}
