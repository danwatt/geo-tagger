import { locationKey, type Face } from "../../faces/faceGrid";

/* Quick Tag's queue logic, pure. Port of web/tag.js: the clustering endpoint's
 * person-groups are split into chunks tight in both time and place, and the
 * page walks them one at a time. Every group carries a stable id: completions
 * find their group by id, never by a captured index — by the time a POST
 * returns, Skip, an earlier completion or a reload may have shifted what sits
 * at any index. */

export type Suggestion = { person_id: number; person_name?: string | null; score: number };
export type TagGroup = { id: number; suggestion: Suggestion | null; faces: Face[]; start: number; place: string | null };
export type Queue = { groups: TagGroup[]; pos: number };

/* ── Settings (persisted, the legacy page's keys) ── */
export const SETTINGS_KEY = "quicktag_settings";
export const PREV_PERSON_KEY = "quicktag_prev_person";
export type Settings = { threshold: number; windowDays: number };
export const DEFAULTS: Settings = { threshold: 0.65, windowDays: 30 };
export const WINDOW_OPTIONS: [number, string][] = [[7, "1 week"], [14, "2 weeks"], [30, "1 month"], [60, "2 months"], [90, "3 months"]];

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") as Partial<Settings> | null;
    return { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* not remembered */ }
}
export type PrevPerson = { id: number; name: string };
export function loadPrevPerson(): PrevPerson | null {
  try {
    const v = JSON.parse(localStorage.getItem(PREV_PERSON_KEY) || "null") as PrevPerson | null;
    return v && typeof v.id === "number" ? v : null;
  } catch {
    return null;
  }
}
export function savePrevPerson(p: PrevPerson): void {
  try { localStorage.setItem(PREV_PERSON_KEY, JSON.stringify(p)); } catch { /* not remembered */ }
}

/** Break one cluster into groups tight in BOTH time and place: faces sorted by
 *  time; a new chunk starts when a face is more than the window after the
 *  chunk's first face, or comes from a different known location. Undated faces
 *  and faces with no location never force a split — they join the current chunk. */
export function splitGroups(cluster: { sample: readonly Face[]; suggestion?: Suggestion | null }, windowSeconds: number, nextId: () => number): TagGroup[] {
  const faces = cluster.sample.slice().sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
  const groups: TagGroup[] = [];
  let cur: TagGroup | null = null;
  for (const f of faces) {
    const ts = f.photo_datetime || 0;
    const place = locationKey(f);
    const newWindow = !cur || ts - cur.start > windowSeconds;
    const newPlace = !!cur && !!cur.place && !!place && place !== cur.place;
    if (newWindow || newPlace) {
      cur = { id: nextId(), suggestion: cluster.suggestion ?? null, faces: [], start: ts, place };
      groups.push(cur);
    }
    cur!.faces.push(f);
    if (!cur!.place && place) cur!.place = place;   // the first located face sets the chunk's place
  }
  return groups;
}

/** Remove a group by id (no-op if gone), keeping `pos` on the group on screen. */
export function dropGroup(q: Queue, groupId: number): Queue {
  const i = q.groups.findIndex((g) => g.id === groupId);
  if (i < 0) return q;
  return { groups: q.groups.filter((g) => g.id !== groupId), pos: i < q.pos ? q.pos - 1 : q.pos };
}

/** One face split out of its group (a per-face action); an emptied group goes. */
export function removeFace(q: Queue, groupId: number, faceId: number): Queue {
  const g = q.groups.find((x) => x.id === groupId);
  if (!g) return q;
  const faces = g.faces.filter((f) => f.id !== faceId);
  if (!faces.length) return dropGroup(q, groupId);
  return { ...q, groups: q.groups.map((x) => (x.id === groupId ? { ...x, faces } : x)) };
}

/** Undo put `faces` back: into their group if it's still queued, else the group
 *  returns (with just those faces) as the one on screen. */
export function restoreToQueue(q: Queue, group: TagGroup, faces: readonly Face[]): Queue {
  if (!faces.length) return q;
  const byTime = (list: Face[]) => list.sort((a, b) => (a.photo_datetime || 0) - (b.photo_datetime || 0));
  const live = q.groups.find((g) => g.id === group.id);
  if (live) {
    const have = new Set(live.faces.map((f) => f.id));
    const merged = { ...live, faces: byTime([...live.faces, ...faces.filter((f) => !have.has(f.id))]) };
    const groups = q.groups.map((g) => (g.id === group.id ? merged : g));
    return { groups, pos: groups.indexOf(merged) };
  }
  const back = { ...group, faces: byTime(faces.slice()) };
  const groups = q.groups.slice();
  const at = Math.min(q.pos, groups.length);
  groups.splice(at, 0, back);
  return { groups, pos: at };
}
