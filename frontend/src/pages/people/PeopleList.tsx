import type { Scope } from "./gridModel";
import type { Person, PeopleController } from "./usePeople";

/* The left-hand list: the queue scopes with their counts, then people grouped
 * by family (people without one last, under "Other" when families exist).
 * Port of people-list.js renderPeopleList. Each entry is a real button; a
 * person's birth-date and delete controls are buttons beside it. */

type Entry = { label: string; count?: number | null; scope: Scope };

export function familyGroups(persons: readonly Person[]): { name: string | null; persons: Person[] }[] {
  const families = new Map<number, { name: string; persons: Person[] }>();
  const none: Person[] = [];
  for (const p of persons) {
    if (p.family_id) {
      let f = families.get(p.family_id);
      if (!f) { f = { name: p.family_name ?? "", persons: [] }; families.set(p.family_id, f); }
      f.persons.push(p);
    } else none.push(p);
  }
  const sorted: { name: string | null; persons: Person[] }[] = [...families.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (none.length) sorted.push({ name: sorted.length ? "Other" : null, persons: none });
  return sorted;
}

export function PeopleList({ ctl }: { ctl: PeopleController }) {
  const { state, actions: a } = ctl;
  const c = state.counts;
  const entries: Entry[] = [
    { label: "Unlabeled", count: c?.unlabeled_faces ?? 0, scope: "unlabeled" },
    { label: "Discover groups", scope: "discover" },
    { label: "Crowds", scope: "crowds" },
    { label: "Recently tagged", count: c?.tagged_faces ?? 0, scope: "recent" },
    { label: "All faces", count: c?.total_faces ?? 0, scope: "all" },
    { label: "Ignored", count: c?.ignored_faces ?? 0, scope: "ignored" },
    { label: "Come Back", count: c?.come_back_faces ?? 0, scope: "come_back" },
  ];
  const isActive = (scope: Scope, pid: number | null) => scope === state.scope && (scope !== "person" || pid === state.scopePersonId);
  const item = (label: React.ReactNode, scope: Scope, pid: number | null, count?: number | null, extra?: React.ReactNode, key?: string | number) => {
    const active = isActive(scope, pid);
    return (
      <div key={key ?? scope} className={`person-item${active ? " active" : ""}`}>
        <button type="button" className="person-pick" aria-current={active || undefined} onClick={() => void a.selectScope(scope, pid)}>
          <span className="person-name">{label}</span>
          {count != null && <span className="person-count">{count}</span>}
        </button>
        {extra}
      </div>
    );
  };
  return (
    <nav id="people-pane" aria-label="People and queues">
      <div className="people-list" id="people-list">
        {entries.map((e) => item(e.label, e.scope, null, e.count))}
        <div className="people-sep" role="separator" />
        {state.navPersons.length === 0 ? (
          <div className="people-empty">
            {state.focus.start != null || state.focus.end != null
              ? "No tagged people in this time window. Widen the Focus, or tag faces in the Unlabeled queue."
              : "No people yet. Assign a face to create one."}
          </div>
        ) : familyGroups(state.navPersons).map((fam) => (
          <div key={fam.name ?? "__none"} role="group" aria-label={fam.name ?? "People"}>
            {fam.name && <div className="family-group-header" aria-hidden="true">{fam.name}</div>}
            {fam.persons.map((p) => item(
              <>{p.name}{p.birth_date && <span className="person-birth"> b.{p.birth_date.slice(0, 4)}</span>}</>,
              "person", p.id, p.face_count,
              <>
                <button type="button" className="person-edit" title={`Set birth date for ${p.name} (improves age-aware suggestions)`}
                  aria-label={`Set birth date for ${p.name}`} onClick={() => ctl.setBirthEdit({ person: p })}>✎</button>
                <button type="button" className="person-del" title={`Delete ${p.name}`} aria-label={`Delete ${p.name}`}
                  onClick={() => void a.deletePerson(p)}>×</button>
              </>,
              p.id,
            ))}
          </div>
        ))}
      </div>
      <button type="button" id="add-person-btn" className="people-add" onClick={a.addPerson}>＋ Add person</button>
    </nav>
  );
}
