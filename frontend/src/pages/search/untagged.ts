/* Untagged-face results: local edits after a tagging action, and grouping.
 * Ports of search.js markFaceAssigned / removeFaceFromCandidates /
 * groupCandidatesByMonth. Pure: each returns new candidate objects, so React
 * sees the change (the legacy code mutated in place and re-rendered). */

import { groupByMonth } from "../../photos/PhotoGrid";
import type { Candidate } from "./query";

/** A face got a person: an already-tagged face is renamed (personId null =
 *  unassigned: it stays in its row, unlabelled, as on the legacy page); a
 *  proposed one moves to `tagged`. */
export function markFaceAssigned(cands: readonly Candidate[], faceId: number, personId: number | null, personName: string | null): Candidate[] {
  return cands.map((c) => {
    if (c.tagged.some((t) => t.face_id === faceId)) {
      return { ...c, tagged: c.tagged.map((t) => (t.face_id === faceId ? { ...t, person_name: personName } : t)) };
    }
    if (personId != null && c.proposed.some((p) => p.face_id === faceId)) {
      return {
        ...c,
        proposed: c.proposed.filter((p) => p.face_id !== faceId),
        tagged: [...c.tagged, { face_id: faceId, person_id: personId, person_name: personName }],
      };
    }
    return c;
  });
}

/** Faces that no longer belong in the results (ignored, come back later,
 *  rejected, unassigned). One pass with a set — a batch can be hundreds of
 *  faces, and a per-id pass would be O(candidates) each. */
export function removeFaces(cands: readonly Candidate[], faceIds: Iterable<number>): Candidate[] {
  const gone = new Set(faceIds);
  return cands.map((c) => {
    if (!c.tagged.some((t) => gone.has(t.face_id)) && !c.proposed.some((p) => gone.has(p.face_id))) return c;
    return { ...c, tagged: c.tagged.filter((t) => !gone.has(t.face_id)), proposed: c.proposed.filter((p) => !gone.has(p.face_id)) };
  });
}

/** Every proposed face across the given candidates suggested as `personId`. */
export function proposedFor(cands: readonly Candidate[], personId: number): number[] {
  return cands.flatMap((c) => c.proposed.filter((p) => p.person_id === personId).map((p) => p.face_id));
}

/** Calendar year/month groups (undated last), like the plain grid. The server
 *  returns candidates best-first, so they are date-sorted here first. */
export function groupCandidates(cands: readonly Candidate[]) {
  // Compared, not subtracted: two undated photos would give Infinity - Infinity = NaN.
  const ts = (c: Candidate) => c.photo.photo_datetime || Infinity;
  const sorted = cands.slice().sort((a, b) => (ts(a) === ts(b) ? 0 : ts(a) < ts(b) ? -1 : 1));
  return groupByMonth(sorted, (c) => c.photo.photo_datetime);
}

/** A group's proposed faces by person, for one bulk assign per person. */
export function proposedByPerson(cands: readonly Candidate[]): Map<number, number[]> {
  const by = new Map<number, number[]>();
  for (const c of cands) for (const p of c.proposed) {
    const list = by.get(p.person_id) ?? [];
    list.push(p.face_id);
    by.set(p.person_id, list);
  }
  return by;
}
