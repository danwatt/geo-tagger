import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderWithQuery } from "../../test/utils";
import { PhotoFacesPage } from "./PhotoFacesPage";
import { counterText, crowdQuery, dragBox, faceSections, parseParams, safeSameOriginPath, stepIndex, type PhotoFace } from "./photoFaces";

const pf = (id: number, over: Partial<PhotoFace> = {}): PhotoFace => ({
  id, bbox: [0.1, 0.1, 0.3, 0.3], det_score: 0.9, source: "detected", person_id: null, person_name: null,
  assigned_at: null, ignored: false, come_back: false, suggestion: null, negatives: [], ...over,
});

describe("photoFaces helpers", () => {
  it("parses the URL contract; crowd mode is opt-in and ?back is same-origin only", () => {
    const p = parseParams("?photo_id=5&mode=crowd&min_faces=20&start_ts=10&back=https://evil.example/x", "http://localhost");
    expect([p.mode, p.photoId, p.minFaces, p.groupGap, p.startTs, p.endTs, p.back]).toEqual(["crowd", 5, 20, 86400, 10, null, "/people.html"]);
    expect(parseParams("?photo_id=5", "http://localhost").mode).toBe("single");
    expect(safeSameOriginPath("/search.html?x=1", "", "http://localhost")).toBe("/search.html?x=1");
    expect(safeSameOriginPath("javascript:alert(1)", "", "http://localhost")).toBe("");
    expect(crowdQuery(p)).toBe("min_faces=20&group_gap=86400&start_ts=10");
  });
  it("walks the playlist, skipping completed photos when asked", () => {
    const list = [{ id: 1, filename: "a", unlabeled_faces: 2 }, { id: 2, filename: "b", unlabeled_faces: 0 }, { id: 3, filename: "c", unlabeled_faces: 1 }];
    expect(stepIndex(list, 0, 1, true)).toBe(2);
    expect(stepIndex(list, 0, 1, false)).toBe(1);
    expect(stepIndex(list, 0, -1, true)).toBe(-1);
    expect(counterText(list, 0, true)).toBe("1 / 3 · 2 remaining");
  });
  it("sorts faces into sections, suggestions by person biggest first", () => {
    const s = faceSections([pf(1, { person_id: 1, person_name: "A" }), pf(2, { ignored: true }), pf(3, { come_back: true }), pf(4),
      pf(5, { suggestion: { person_id: 9, person_name: "Z", score: 0.8 } }), pf(6, { suggestion: { person_id: 8, person_name: "Y", score: 0.8 } }),
      pf(7, { suggestion: { person_id: 8, person_name: "Y", score: 0.7 } })]);
    expect([s.tagged.length, s.ignored.length, s.comeBack.length, s.unknown.length, s.unlabeled]).toEqual([1, 1, 1, 1, 4]);
    expect(s.suggested.map((g) => [g.name, g.faces.length])).toEqual([["Y", 2], ["Z", 1]]);
  });
  it("treats a click as no box", () => {
    expect(dragBox(0.5, 0.5, 0.505, 0.6)).toBeNull();
    expect(dragBox(0.6, 0.6, 0.2, 0.1)).toEqual([0.2, 0.1, 0.6, 0.6]);
  });
});

describe("PhotoFacesPage", () => {
  it("shows one photo's faces and ignores its unlabeled ones with undo", async () => {
    window.history.replaceState(null, "", "/photo-faces.html?photo_id=5");
    let faces = [pf(1, { person_id: 2, person_name: "Ann" }), pf(2)];
    const { calls } = mockApi({
      "GET /api/photos/5": () => ({ id: 5, path: "/p/a.jpg", filename: "a.jpg", datetime: "2021-01-01", camera: "X", dimensions: "10 x 10" }),
      "GET /api/persons": () => [{ id: 2, name: "Ann" }],
      "GET /api/photos/5/faces": () => faces,
      "POST /api/crowds/ignore-unlabeled": () => { faces = [faces[0]!, pf(2, { ignored: true })]; return { ignored: 1, undo: { faces: [{ face_id: 2 }] } }; },
    });
    const user = userEvent.setup();
    renderWithQuery(<PhotoFacesPage />);
    expect(await screen.findByRole("region", { name: /Tagged people/ })).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById("status-bar")!.textContent).toBe("1 tagged · 1 unlabeled · 0 come back · 0 ignored"));
    expect(screen.queryByRole("button", { name: /Prev/ })).not.toBeInTheDocument();   // single mode
    await user.click(screen.getByRole("button", { name: "Ignore unlabeled (1)" }));
    await waitFor(() => expect(document.getElementById("status-bar")!.textContent).toBe("Ignored 1 unlabeled face(s) — this photo is done."));
    expect(screen.getByRole("region", { name: /Ignored/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/crowds/ignore-unlabeled")!.body).toEqual({ photo_ids: [5] });
  });
});
