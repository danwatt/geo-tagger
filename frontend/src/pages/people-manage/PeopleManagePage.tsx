import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { ApiError } from "../../api/errors";
import { faceUndoable, undoFaceToken } from "../../photos/faceUndo";
import { PersonPickerDialog } from "../../photos/PersonPickerDialog";
import { AppShell } from "../../shell/AppShell";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useToasts } from "../../ui/Toast";
import { FamiliesSection } from "./FamiliesSection";
import { PersonRow } from "./PersonRow";
import "./people-manage.css";

/* People Manager — edit names, birth dates, and family groups in one list.
 * Port of web/people-manage.js. Every edit that can change counts reloads both
 * lists (invalidate); date and family edits patch the person in place. */

export type Person = Schemas["PersonListItem"];
export type Family = Schemas["FamilyItem"];

export const PERSONS_KEY = ["persons", "face_counts"] as const;
export const FAMILIES_KEY = ["families"] as const;

// face_counts is opt-in on the server (the People page skips it for speed).
export async function fetchPersons(): Promise<Person[]> {
  return unwrap(await api.GET("/api/persons", { params: { query: { face_counts: true } } }));
}
async function fetchFamilies(): Promise<Family[]> {
  return unwrap(await api.GET("/api/families"));
}

const MERGE_FIELD_LABELS: Record<string, string> = {
  birth_date: "birth date", family_id: "family",
  not_before: "not-before", not_after: "not-after",
};

/** The toast after a merge. Attribute outcomes (see index.merge_persons): empty
 *  target fields filled from the source, date windows widened, differing values
 *  kept as the target's. */
export function mergeSummary(source: string, target: string, s: Schemas["MergePersonResponse"]): string {
  const label = (f: string) => MERGE_FIELD_LABELS[f] || f;
  const notes: string[] = [];
  if (s.filled.length) notes.push(`took ${s.filled.map(label).join(", ")}`);
  if (s.widened.length) notes.push(`widened ${s.widened.map(label).join(", ")}`);
  if (s.conflicts.length) notes.push(`kept ${target}'s ${s.conflicts.map((c) => label(c.field)).join(", ")}`);
  return `Merged "${source}" into "${target}" — ${s.moved_faces} face${s.moved_faces === 1 ? "" : "s"} moved` +
    (notes.length ? ` (${notes.join("; ")})` : "");
}

export function filterPersons(persons: readonly Person[], query: string, familyFilter: string): Person[] {
  const q = query.trim().toLowerCase();
  return persons.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (familyFilter === "__none__") return !p.family_id;
    if (familyFilter) return String(p.family_id) === familyFilter;
    return true;
  });
}

type Ask = { title: string; message: string; confirmLabel: string; danger?: boolean; resolve: (yes: boolean) => void };
type Picker =
  | { kind: "add-person" }
  | { kind: "add-family" }
  | { kind: "merge"; person: Person };

/** True while `on` has held for `ms` — the dimming waits, so fast loads never flicker. */
function useDelayed(on: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return shown;
}

export function PeopleManagePage() {
  const qc = useQueryClient();
  const { toast, undoToast, node: toasts } = useToasts();
  const persons = useQuery({ queryKey: PERSONS_KEY, queryFn: fetchPersons });
  const families = useQuery({ queryKey: FAMILIES_KEY, queryFn: fetchFamilies });
  const [search, setSearch] = useState("");
  const [familyFilter, setFamilyFilter] = useState("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);

  const toastRef = useRef(toast);
  toastRef.current = toast;
  const loadError = persons.error ?? families.error;
  useEffect(() => {
    if (loadError) toastRef.current("Failed to load: " + loadError.message, true);
  }, [loadError]);

  const personList = useMemo(() => persons.data ?? [], [persons.data]);
  const familyList = families.data ?? [];
  const rows = useMemo(() => filterPersons(personList, search, familyFilter), [personList, search, familyFilter]);

  const reload = useCallback(() => Promise.all([
    qc.invalidateQueries({ queryKey: PERSONS_KEY }),
    qc.invalidateQueries({ queryKey: FAMILIES_KEY }),
  ]), [qc]);

  const confirm = useCallback((q: Omit<Ask, "resolve">) =>
    new Promise<boolean>((resolve) => setAsk({ ...q, resolve })), []);

  const patchPerson = useCallback((id: number, fields: Partial<Person>) => {
    qc.setQueryData<Person[]>(PERSONS_KEY, (old) => old?.map((p) => (p.id === id ? { ...p, ...fields } : p)));
  }, [qc]);

  // Every edit reloads the whole list; until it lands the rows are the old
  // ones, so hold them busy (U4) rather than let a click edit a row being
  // replaced. Tab and Escape still work, and so does scrolling.
  const busy = (persons.isFetching || families.isFetching) && !!persons.data;
  const busyShown = useDelayed(busy, 150);
  const swallow = (e: React.SyntheticEvent) => {
    if (!busy) return;
    if (e.type === "keydown" && ["Tab", "Escape"].includes((e as React.KeyboardEvent).key)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** The person's current face count, or null if they're gone. Re-read at
   *  confirm time: the list may have been loaded long before faces were tagged
   *  on the People page in another tab, and understating how many labels a
   *  delete or merge moves is the one thing its confirm must not do. */
  async function freshFaceCount(p: Person): Promise<number | null> {
    const fresh = (await fetchPersons()).find((q) => q.id === p.id);
    return fresh ? (fresh.face_count ?? 0) : null;
  }

  async function mergePerson(p: Person, target: { id: number; name: string }, preface = "") {
    let count: number | null;
    try {
      count = await freshFaceCount(p);
    } catch (e) {
      toast("Could not check face count: " + (e as Error).message, true);
      return;
    }
    if (count === null) {
      toast(`"${p.name}" no longer exists`, true);
      await reload();
      return;
    }
    const faces = `${count} face${count === 1 ? "" : "s"}`;
    const yes = await confirm({
      title: "Merge person",
      message: `${preface}Merge "${p.name}" (${faces}) into "${target.name}"? "${p.name}" will be deleted. This can't be undone.`,
      confirmLabel: "Merge",
      danger: true,
    });
    if (!yes) return;
    try {
      const s = unwrap(await api.POST("/api/persons/{person_id}/merge", {
        params: { path: { person_id: p.id } }, body: { into: target.id },
      }));
      toast(mergeSummary(p.name, target.name, s));
    } catch (e) {
      toast("Merge failed: " + (e as Error).message, true);
    }
    await reload();
  }

  async function renamePerson(p: Person, name: string, revert: () => void) {
    try {
      unwrap(await api.PATCH("/api/persons/{person_id}", { params: { path: { person_id: p.id } }, body: { name } }));
      patchPerson(p.id, { name });
      toast(`Renamed to "${name}"`);
    } catch (e) {
      revert();
      // Renaming onto an existing name is how people try to merge — offer it.
      const detail = e instanceof ApiError && e.status === 409
        ? (e.body as { detail?: { existing_person_id?: number | null } } | null)?.detail : null;
      const targetId = detail && typeof detail === "object" ? detail.existing_person_id : null;
      if (targetId != null) {
        // The target may postdate this page's list (created in another tab).
        const target = personList.find((q) => q.id === targetId) ?? { id: targetId, name };
        await mergePerson(p, target, `A person named "${target.name}" already exists — merge into them? `);
        return;
      }
      toast("Rename failed: " + (e as Error).message, true);
    }
  }

  async function saveDate(p: Person, field: "birth_date" | "not_before" | "not_after", label: string, value: string | null) {
    try {
      unwrap(await api.PATCH("/api/persons/{person_id}", { params: { path: { person_id: p.id } }, body: { [field]: value } }));
    } catch (e) {
      toast("Save failed: " + (e as Error).message, true);
      throw e;
    }
    patchPerson(p.id, { [field]: value });
    toast(value ? `${label} set` : `${label} cleared`);
  }

  async function setFamily(p: Person, familyId: number | null) {
    const before = p.family_id ?? null;
    patchPerson(p.id, { family_id: familyId });
    try {
      unwrap(await api.PATCH("/api/persons/{person_id}", { params: { path: { person_id: p.id } }, body: { family_id: familyId } }));
      // Refresh family member counts silently.
      await qc.invalidateQueries({ queryKey: FAMILIES_KEY });
    } catch (e) {
      patchPerson(p.id, { family_id: before });
      toast("Save failed: " + (e as Error).message, true);
    }
  }

  async function deletePerson(p: Person) {
    let count = p.face_count ?? 0;
    try {
      const fresh = (await fetchPersons()).find((q) => q.id === p.id);
      if (!fresh) {
        toast(`"${p.name}" no longer exists`, true);
        await reload();
        return;
      }
      count = fresh.face_count ?? 0;
      // Keep the Faces column honest if the user cancels.
      if (count !== p.face_count) patchPerson(p.id, { face_count: count });
    } catch (e) {
      toast("Could not check face count: " + (e as Error).message, true);
      return;
    }
    const yes = await confirm({
      title: "Delete person",
      message: count > 0
        ? `Delete "${p.name}"? ${count} tagged face${count === 1 ? "" : "s"} will become unlabeled.`
        : `Delete "${p.name}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!yes) return;
    try {
      const { undo } = unwrap(await api.DELETE("/api/persons/{person_id}", { params: { path: { person_id: p.id } } }));
      await reload();
      // Kept behind the confirm above, and undoable for a few seconds after (U3):
      // the person comes back with the same attributes and labels.
      if (faceUndoable(undo)) {
        undoToast(`Deleted “${p.name}”.`, async () => {
          const r = await undoFaceToken(undo);
          await reload();
          return r;
        });
      } else {
        toast(`Deleted "${p.name}"`);
      }
    } catch (e) {
      toast("Delete failed: " + (e as Error).message, true);
    }
  }

  async function addPerson(name: string) {
    if (!name) return;
    try {
      unwrap(await api.POST("/api/persons", { body: { name } }));
      toast(`"${name}" added`);
      await reload();
    } catch (e) {
      toast("Create failed: " + (e as Error).message, true);
    }
  }

  async function addFamily(name: string) {
    if (!name) return;
    try {
      unwrap(await api.POST("/api/families", { body: { name } }));
      toast(`Family "${name}" created`);
      await reload();
    } catch (e) {
      toast("Create failed: " + (e as Error).message, true);
    }
  }

  async function renameFamily(f: Family, name: string) {
    if (name && name !== f.name) {
      try {
        unwrap(await api.PATCH("/api/families/{family_id}", { params: { path: { family_id: f.id } }, body: { name } }));
        toast(`Family renamed to "${name}"`);
      } catch (e) {
        toast("Rename failed: " + (e as Error).message, true);
      }
    }
    await reload();
  }

  async function deleteFamily(f: Family) {
    const yes = await confirm({
      title: "Delete family",
      message: f.person_count > 0
        ? `Delete family "${f.name}"? Its ${f.person_count} member(s) will become unassigned.`
        : `Delete family "${f.name}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!yes) return;
    try {
      unwrap(await api.DELETE("/api/families/{family_id}", { params: { path: { family_id: f.id } } }));
      toast(`Deleted family "${f.name}"`);
      await reload();
    } catch (e) {
      toast("Delete failed: " + (e as Error).message, true);
    }
  }

  function answer(yes: boolean) {
    ask?.resolve(yes);
    setAsk(null);
  }

  return (
    <AppShell active="people">
      <div id="manage-page">
        <header id="manage-bar">
          <a href="/people.html" id="back-link">‹ People</a>
          <h1 id="manage-title">People Manager</h1>
          <span id="manage-counts">
            {persons.data && families.data ? `${personList.length} people · ${familyList.length} families` : ""}
          </span>
        </header>

        <main id="manage-main">
          <FamiliesSection families={familyList} onAdd={() => setPicker({ kind: "add-family" })}
            onRename={renameFamily} onCancelRename={() => void reload()} onDelete={(f) => void deleteFamily(f)} />

          <section id="persons-section" aria-label="People">
            <div id="persons-toolbar">
              <input id="person-search" type="text" placeholder="Search people…" autoComplete="off"
                aria-label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select id="family-filter-sel" aria-label="Filter by family" value={familyFilter}
                onChange={(e) => setFamilyFilter(e.target.value)}>
                <option value="">All families</option>
                <option value="__none__">No family</option>
                {familyList.map((f) => <option key={f.id} value={String(f.id)}>{f.name}</option>)}
              </select>
              <span id="persons-count" aria-live="polite">{rows.length} of {personList.length}</span>
              <button type="button" id="add-person-btn" onClick={() => setPicker({ kind: "add-person" })}>+ Add Person</button>
            </div>
            <div id="persons-table-wrap" aria-busy={busy || undefined}
              className={busy ? `is-busy${busyShown ? " is-busy-shown" : ""}` : undefined}
              onClickCapture={swallow} onKeyDownCapture={swallow}>
              <table id="persons-table">
                <thead>
                  <tr>
                    <th className="col-name">Name</th>
                    <th className="col-birth">Birth Date</th>
                    <th className="col-not-before">Not Before</th>
                    <th className="col-not-after">Not After</th>
                    <th className="col-family">Family</th>
                    <th className="col-faces">Faces</th>
                    <th className="col-actions"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <PersonRow key={p.id} person={p} families={familyList} canMerge={personList.length >= 2}
                      onRename={(name, revert) => renamePerson(p, name, revert)}
                      onSaveDate={(field, label, value) => saveDate(p, field, label, value)}
                      onIncomplete={(msg) => toast(msg, true)}
                      onFamily={(id) => void setFamily(p, id)}
                      onMerge={() => setPicker({ kind: "merge", person: p })}
                      onDelete={() => void deletePerson(p)} />
                  ))}
                </tbody>
              </table>
              {persons.data && !rows.length && <div id="no-persons">No people match the filter.</div>}
              {persons.isPending && <div className="persons-loading">Loading people…</div>}
            </div>
          </section>
        </main>
      </div>

      {picker?.kind === "add-person" && (
        // Same picker as everywhere a person is named: existing people first,
        // Create as a separate row. Picking an existing person narrows the
        // table to them instead of adding a duplicate.
        <PersonPickerDialog persons={personList} title="Add person" placeholder="Type a name…"
          onClose={() => setPicker(null)}
          onPick={(who) => {
            setPicker(null);
            if (!("person_id" in who)) { void addPerson(who.name.trim()); return; }
            const p = personList.find((q) => q.id === who.person_id);
            if (!p) return;
            setSearch(p.name);
            setFamilyFilter("");
            toast(`"${p.name}" already exists — showing them`);
          }} />
      )}
      {picker?.kind === "add-family" && (
        // The shared typeahead instead of prompt(): existing families show as
        // you type, with Create as its own row. Picking an existing family
        // filters the list to it rather than adding a second one.
        <PersonPickerDialog persons={familyList} title="Add family" label="Family" listLabel="Families"
          placeholder="Type a family name…" emptyText="No families yet — type a name to create one."
          createLabel={(q) => `➕ Create family "${q}"`}
          onClose={() => setPicker(null)}
          onPick={(who) => {
            setPicker(null);
            if (!("person_id" in who)) { void addFamily(who.name.trim()); return; }
            const f = familyList.find((q) => q.id === who.person_id);
            if (!f) return;
            setFamilyFilter(String(f.id));
            toast(`Family "${f.name}" already exists — showing its members`);
          }} />
      )}
      {picker?.kind === "merge" && (
        // No "create" row — merging into a brand-new person is just a rename.
        <PersonPickerDialog persons={personList.filter((q) => q.id !== picker.person.id)}
          title={`Merge "${picker.person.name}" into…`} placeholder="Search people…" allowCreate={false}
          onClose={() => setPicker(null)}
          onPick={(who) => {
            const source = picker.person;
            setPicker(null);
            const target = "person_id" in who ? personList.find((q) => q.id === who.person_id) : undefined;
            if (target) void mergePerson(source, target);
          }} />
      )}
      {ask && (
        <ConfirmDialog title={ask.title} message={ask.message} confirmLabel={ask.confirmLabel} danger={ask.danger}
          onConfirm={() => answer(true)} onCancel={() => answer(false)} />
      )}
      {toasts}
    </AppShell>
  );
}
