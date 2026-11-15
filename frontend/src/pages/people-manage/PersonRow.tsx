import { DateField, NameField } from "./fields";
import type { Family, Person } from "./PeopleManagePage";

type DateKey = "birth_date" | "not_before" | "not_after";

const DATE_COLS: { field: DateKey; cls: string; label: string; title: string }[] = [
  { field: "birth_date", cls: "col-birth", label: "Birth date", title: "YYYY-MM-DD" },
  { field: "not_before", cls: "col-not-before", label: "Not-before date", title: "No photos of this person before this date (YYYY-MM-DD)" },
  { field: "not_after", cls: "col-not-after", label: "Not-after date", title: "No photos of this person after this date (YYYY-MM-DD)" },
];

export function PersonRow({ person: p, families, canMerge, onRename, onSaveDate, onIncomplete, onFamily, onMerge, onDelete }: {
  person: Person;
  families: readonly Family[];
  canMerge: boolean;
  onRename: (name: string, revert: () => void) => Promise<void>;
  onSaveDate: (field: DateKey, label: string, value: string | null) => Promise<void>;
  onIncomplete: (msg: string) => void;
  onFamily: (familyId: number | null) => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td className="col-name">
        <NameField saved={p.name} label={`Name of ${p.name}`} onSave={onRename} />
      </td>
      {DATE_COLS.map((c) => (
        <td key={c.field} className={c.cls}>
          <DateField saved={p[c.field]} label={`${c.label} of ${p.name}`} fieldLabel={c.label} title={c.title}
            onSave={(v) => onSaveDate(c.field, c.label, v)} onIncomplete={onIncomplete} />
        </td>
      ))}
      <td className="col-family">
        <select className="family-sel" aria-label={`Family of ${p.name}`}
          value={p.family_id != null ? String(p.family_id) : ""}
          onChange={(e) => onFamily(e.target.value ? parseInt(e.target.value, 10) : null)}>
          <option value="">— No family —</option>
          {families.map((f) => <option key={f.id} value={String(f.id)}>{f.name}</option>)}
        </select>
      </td>
      <td className="col-faces">{p.face_count ?? "—"}</td>
      <td className="col-actions">
        <button type="button" className="merge-btn" disabled={!canMerge} onClick={onMerge}
          title={`Move all of ${p.name}'s faces to another person, then delete ${p.name}`}
          aria-label={`Merge ${p.name} into…`}>Merge into…</button>
        <button type="button" className="del-btn" onClick={onDelete} aria-label={`Delete ${p.name}`}>Delete</button>
      </td>
    </tr>
  );
}
