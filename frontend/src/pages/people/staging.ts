import type { Face } from "../../faces/faceGrid";
import { stagedWorkStore } from "../../lib/stagedWork";

/* ── Staging area ── Port of people-staging.js.
 * Non-destructive decisions on the flat grids don't hit the server as you make
 * them: the face leaves the main grid and is parked under the destination it
 * was sent to (a person, Ignored, Come Back, …). The staging area under the
 * grid shows one section per destination with its own Commit / Revert, plus a
 * bar that commits or reverts everything. Only a Commit writes. The nuclear
 * option and "not this person" stay immediate: the first is explicitly
 * destructive, the second exists to re-rank the remaining guesses at once. */

export type PendingKind = "assign" | "unassign" | "ignore" | "unignore" | "come_back" | "uncome_back";
export const PENDING_KIND_ORDER: readonly PendingKind[] = ["assign", "come_back", "unassign", "ignore", "unignore", "uncome_back"];
const PENDING_KINDS = new Set<string>(PENDING_KIND_ORDER);

export type Change = { kind: PendingKind; personId?: number | null; name?: string | null };
export type PendingEntry = Change & { face: Face };
export type Pending = ReadonlyMap<number, PendingEntry>;

type PersonLookup = readonly { id: number; name: string }[];
const nameOf = (persons: PersonLookup, id: number | null | undefined) => persons.find((p) => p.id === id)?.name;

export function pendingGroupKey(e: Change): string {
  if (e.kind !== "assign") return e.kind;
  return e.personId != null ? `person:${e.personId}` : `name:${e.name}`;
}

export function pendingGroupLabel(e: Change, persons: PersonLookup): string {
  switch (e.kind) {
    case "assign":
      return e.personId != null ? (nameOf(persons, e.personId) || e.name || "Unknown person") : `${e.name} (new person)`;
    case "unassign": return "Unassign";
    case "ignore": return "Ignore";
    case "unignore": return "Un-ignore";
    case "come_back": return "Come Back";
    case "uncome_back": return "Back to Unlabeled";
  }
}

/** Short label for the chip on a staged face. */
export function pendingCellLabel(e: Change, persons: PersonLookup): string {
  if (e.kind !== "assign") return pendingGroupLabel(e, persons);
  return e.personId != null ? (nameOf(persons, e.personId) || e.name || "Unknown") : `＋ ${e.name}`;
}

export type PendingGroup = {
  key: string; kind: PendingKind; personId: number | null; name: string | null; label: string; entries: PendingEntry[];
};

/** One group per destination: assigns first (people A→Z), then the rest in
 *  PENDING_KIND_ORDER. */
export function groupPendingEntries(entries: Iterable<PendingEntry>, persons: PersonLookup): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const e of entries) {
    const key = pendingGroupKey(e);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind: e.kind, personId: e.personId ?? null, name: e.name ?? null, label: pendingGroupLabel(e, persons), entries: [] };
      groups.set(key, g);
    }
    g.entries.push(e);
  }
  return [...groups.values()].sort((a, b) =>
    PENDING_KIND_ORDER.indexOf(a.kind) - PENDING_KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label));
}

/** Endpoint + body for one staged group: one request per group, so a person's
 *  batch lands in one assign call (and one ignored_at / come_back_at stamp,
 *  which the Ignored / Come Back batch headers group on). */
export function pendingRequest(g: Pick<PendingGroup, "kind" | "personId" | "name">, ids: number[]):
  ["/api/faces/assign", { face_ids: number[]; person_id?: number; name?: string; clear?: boolean }]
  | ["/api/faces/ignore", { face_ids: number[]; ignored: boolean }]
  | ["/api/faces/come-back", { face_ids: number[]; come_back: boolean }] {
  switch (g.kind) {
    case "assign":
      return ["/api/faces/assign", g.personId != null ? { face_ids: ids, person_id: g.personId } : { face_ids: ids, name: g.name ?? "" }];
    case "unassign": return ["/api/faces/assign", { face_ids: ids, clear: true }];
    case "ignore": return ["/api/faces/ignore", { face_ids: ids, ignored: true }];
    case "unignore": return ["/api/faces/ignore", { face_ids: ids, ignored: false }];
    case "come_back": return ["/api/faces/come-back", { face_ids: ids, come_back: true }];
    case "uncome_back": return ["/api/faces/come-back", { face_ids: ids, come_back: false }];
  }
}

/* ── Restore after a reload or crash (U7) ──
 * Every change to the staged set is mirrored to sessionStorage (ids + intended
 * values + a `was` snapshot, never whole faces) under the legacy page's key, so
 * work staged before the port restores too. On load the records are re-checked
 * against the server: a face deleted since, or already in its staged state, is
 * dropped; an assign to a person deleted since is dropped (the server would 404
 * it); a face changed elsewhere is kept but called out. Nothing is written until
 * the user commits. */
export type PendingRecord = {
  id: number; kind: PendingKind; personId: number | null; name: string | null;
  was: { p: number | null; i: boolean; c: boolean };
};

export const peopleStore = () => stagedWorkStore<PendingRecord>("people", 1);

export function pendingRecord(e: PendingEntry): PendingRecord {
  const f = e.face;
  return {
    id: f.id, kind: e.kind, personId: e.personId ?? null, name: e.name ?? null,
    was: { p: f.person_id ?? null, i: !!f.ignored, c: !!f.come_back },
  };
}

export function validRecord(r: { kind?: unknown }): r is PendingRecord {
  return typeof r.kind === "string" && PENDING_KINDS.has(r.kind);
}

/** The records to write: the live entries plus any still-unvalidated carry. */
export function recordsToSave(pending: Pending, carry: readonly PendingRecord[]): PendingRecord[] {
  const records = [...pending.values()].map(pendingRecord);
  const live = new Set(records.map((r) => r.id));
  for (const r of carry) if (!live.has(r.id)) records.push(r);
  return records;
}

/** Is `face` (current server state) already where record `r` would put it? */
export function stagedAlreadyApplied(r: Pick<PendingRecord, "kind" | "personId" | "name">, face: Face): boolean {
  switch (r.kind) {
    case "assign":
      return r.personId != null ? face.person_id === r.personId : face.person_id != null && face.person_name === r.name;
    case "unassign": return face.person_id == null;
    case "ignore": return face.ignored;
    case "unignore": return !face.ignored;
    case "come_back": return face.come_back;
    case "uncome_back": return !face.come_back;
  }
}

export type RestoreOutcome = { entries: PendingEntry[]; gone: number; applied: number; orphaned: number; changed: number };

export function classifyRestore(
  records: readonly PendingRecord[], current: ReadonlyMap<number, Face>, personIds: ReadonlySet<number>,
  loaded: ReadonlyMap<number, Face>, alreadyStaged: (id: number) => boolean,
): RestoreOutcome {
  const out: RestoreOutcome = { entries: [], gone: 0, applied: 0, orphaned: 0, changed: 0 };
  for (const r of records) {
    if (alreadyStaged(r.id)) continue;   // re-staged during the check: the newer decision wins
    const face = current.get(r.id);
    if (!face) { out.gone++; continue; }
    if (r.kind === "assign" && r.personId != null && !personIds.has(r.personId)) { out.orphaned++; continue; }
    if (stagedAlreadyApplied(r, face)) { out.applied++; continue; }
    const was = r.was ?? { p: null, i: false, c: false };
    if ((was.p ?? null) !== face.person_id || !!was.i !== face.ignored || !!was.c !== face.come_back) out.changed++;
    // Prefer the grid's own object when the face is loaded: it carries the suggestion.
    out.entries.push({ face: loaded.get(r.id) ?? face, kind: r.kind, personId: r.personId ?? null, name: r.name ?? null });
  }
  return out;
}

export function droppedNote(o: Pick<RestoreOutcome, "gone" | "applied" | "orphaned">): string {
  const dropped: string[] = [];
  if (o.gone) dropped.push(`${o.gone} face(s) no longer exist`);
  if (o.applied) dropped.push(`${o.applied} already saved`);
  if (o.orphaned) dropped.push(`${o.orphaned} for a person who was deleted`);
  return dropped.length ? `Dropped: ${dropped.join(", ")}.` : "";
}
