import { api, unwrap, type Schemas } from "../api/client";

/* ── Face undo tokens ── Port of common.js faceUndoable / undoFaceToken.
 * Every one-click face/person write (POST /api/faces/assign, /faces/{id}/assign,
 * /faces/ignore, /faces/come-back, /crowds/ignore-unlabeled, DELETE
 * /api/persons/{id}) replies with an `undo` token; POST /api/faces/undo takes it
 * back verbatim (face_undo_service.py). These turn a token into an undo
 * toast's action and its reply into the toast's outcome line. */

export type FaceUndoToken = { [key: string]: unknown };

type TokenShape = { faces?: unknown[]; person?: { name?: string } | null; created_person_id?: number | null };

export function faceUndoable(token: FaceUndoToken | null | undefined): token is FaceUndoToken {
  const t = token as TokenShape | null | undefined;
  return !!t && ((t.faces?.length ?? 0) > 0 || !!t.person || t.created_person_id != null);
}

export type FaceUndoResult = { message: string; isError: boolean; out: Schemas["UndoFacesResponse"] };

/** POST the token; resolves to the outcome line (and whether it's a failure),
 *  plus the server's reply (`out.restored`: the faces actually put back). */
export async function undoFaceToken(token: FaceUndoToken): Promise<FaceUndoResult> {
  // The token is opaque here and validated by the server on the way back in.
  const body = token as never;
  const out = unwrap(await api.POST("/api/faces/undo", { body }));
  const t = token as TokenShape;
  const n = out.restored.length, c = out.conflicts.length + out.not_found.length;
  const total = n + c;
  const faces = (k: number) => `${k} face${k === 1 ? "" : "s"}`;
  let message: string;
  if (t.person) {
    message = `Restored “${t.person.name}”` + (n ? ` with ${faces(n)}` : "");
    if (c) message += ` — ${faces(c)} changed since and stayed as they are`;
    if (out.family_dropped) message += " (their family was deleted, so none)";
    message += ".";
  } else if (!total) {
    message = "Undone.";
  } else if (!c) {
    message = total === 1 ? "Undone." : `Undone for ${faces(n)}.`;
  } else if (n) {
    message = `Undone for ${n} of ${faces(total)} — ${c} changed since and stayed as they are.`;
  } else {
    message = `Not undone — ${total === 1 ? "that face has" : "those faces have"} changed since.`;
  }
  return { message, isError: !t.person && n === 0 && c > 0, out };
}
