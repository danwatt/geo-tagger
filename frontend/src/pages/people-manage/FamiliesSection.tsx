import { useRef, useState } from "react";
import type { Family } from "./PeopleManagePage";

/* Family chips: the name is a button that turns into an inline rename field
 * (Enter or leaving the field saves, Escape cancels), ✕ deletes after a
 * confirm. */

function RenameInput({ family, onDone, onCancel }: {
  family: Family;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  // Blur fires after Enter's blur() and after Escape unmounts it; only the
  // first outcome counts.
  const settled = useRef(false);
  return (
    <input className="family-rename-input" defaultValue={family.name} aria-label={`Rename family ${family.name}`}
      autoFocus onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === "Escape") { e.preventDefault(); settled.current = true; onCancel(); }
      }}
      onBlur={(e) => {
        if (settled.current) return;
        settled.current = true;
        onDone(e.currentTarget.value.trim());
      }} />
  );
}

export function FamiliesSection({ families, onAdd, onRename, onCancelRename, onDelete }: {
  families: readonly Family[];
  onAdd: () => void;
  onRename: (f: Family, name: string) => Promise<void>;
  onCancelRename: () => void;
  onDelete: (f: Family) => void;
}) {
  const [renaming, setRenaming] = useState<number | null>(null);
  return (
    <section id="families-section" aria-labelledby="families-label">
      <div id="families-header">
        <h2 className="section-label" id="families-label">Families</h2>
        <button type="button" id="add-family-btn" onClick={onAdd}>+ Add Family</button>
      </div>
      <div id="family-chips">
        {!families.length && <span className="no-families-hint">No families yet — add one to group people.</span>}
        {families.map((f) => (
          <div key={f.id} className="family-chip">
            {renaming === f.id ? (
              <RenameInput family={f}
                onDone={(name) => { setRenaming(null); void onRename(f, name); }}
                onCancel={() => { setRenaming(null); onCancelRename(); }} />
            ) : (
              <button type="button" className="family-name" title="Click to rename" aria-label={`Rename family ${f.name}`}
                onClick={() => setRenaming(f.id)}>{f.name}</button>
            )}
            <span className="family-count" title={`${f.person_count} people`} aria-label={`${f.person_count} people`}>{f.person_count}</span>
            <button type="button" className="family-del" title="Delete family" aria-label={`Delete family ${f.name}`}
              onClick={() => onDelete(f)}>✕</button>
          </div>
        ))}
      </div>
    </section>
  );
}
