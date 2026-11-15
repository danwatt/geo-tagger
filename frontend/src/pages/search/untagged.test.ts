import { describe, expect, it } from "vitest";
import type { Candidate } from "./query";
import { groupCandidates, markFaceAssigned, proposedByPerson, proposedFor, removeFaces } from "./untagged";

const JAN = Date.UTC(2020, 0, 10) / 1000;
const MAR = Date.UTC(2020, 2, 10) / 1000;

function cand(photoId: number, ts: number | null, proposed: [number, number][], tagged: [number, number][] = []): Candidate {
  return {
    photo: { id: photoId, filename: `p${photoId}.jpg`, photo_datetime: ts, geocode_ignored: false },
    tagged: tagged.map(([face_id, person_id]) => ({ face_id, person_id, person_name: `P${person_id}` })),
    proposed: proposed.map(([face_id, person_id]) => ({ face_id, person_id, person_name: `P${person_id}`, score: 0.6 })),
  };
}

describe("untagged candidate edits", () => {
  const cands = [cand(1, MAR, [[100, 7], [101, 8]]), cand(2, JAN, [[200, 7]], [[201, 8]])];

  it("moves a confirmed proposal to tagged without touching the others", () => {
    const next = markFaceAssigned(cands, 100, 7, "Ann");
    expect(next[0]!.proposed.map((p) => p.face_id)).toEqual([101]);
    expect(next[0]!.tagged).toEqual([{ face_id: 100, person_id: 7, person_name: "Ann" }]);
    expect(next[1]).toBe(cands[1]);
    expect(cands[0]!.proposed).toHaveLength(2); // inputs untouched
  });

  it("renames a tagged face, or blanks it on unassign", () => {
    expect(markFaceAssigned(cands, 201, 9, "Bea")[1]!.tagged[0]!.person_name).toBe("Bea");
    expect(markFaceAssigned(cands, 201, null, null)[1]!.tagged[0]!.person_name).toBeNull();
  });

  it("removes faces in one pass", () => {
    const next = removeFaces(cands, [101, 200, 201]);
    expect(next[0]!.proposed.map((p) => p.face_id)).toEqual([100]);
    expect(next[1]!.proposed).toEqual([]);
    expect(next[1]!.tagged).toEqual([]);
  });

  it("collects proposals by person", () => {
    expect(proposedFor(cands, 7)).toEqual([100, 200]);
    expect([...proposedByPerson(cands)]).toEqual([[7, [100, 200]], [8, [101]]]);
  });

  it("groups best-first candidates by date, undated last", () => {
    const groups = groupCandidates([cand(3, null, []), ...cands]);
    expect(groups.map((g) => g.items.map((x) => x.item.photo.id))).toEqual([[2], [1], [3]]);
  });
});
