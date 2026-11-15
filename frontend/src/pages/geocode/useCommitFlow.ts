import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { ApiError } from "../../api/errors";
import { photoQueryKey } from "../../photos/PhotoPreviewPane";
import {
  batchProblems, commitSummary, patchPhotos, runCommit, undoOutcome, undoPatches,
  type BatchReply, type CommitApi, type PhotoPatch,
} from "./commit";
import { rememberLocation } from "./locations";
import { loadLastCommit, saveLastCommit, type LastCommit, type Snapshot, type StagedGroup } from "./staging";
import type { Staging } from "./useStaging";
import type { WorkspaceStore } from "./useWorkspace";

/* Commit, revert and "Undo last commit" (U2), plus the two writes that don't
 * stage (the preview pane's ignore checkbox and Guess → Apply). Every question
 * the legacy page asked with confirm() is a ConfirmDialog request here
 * (`confirm`, rendered by the page). */

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

/** A /api/geotag[/remove|/undo] reply. The server answers 200 with the
 *  {results, written, failed, not_found} breakdown, or the same body under
 *  502/404 when nothing at all was written; anything else (400/422/500) has no
 *  `written` and throws with the server's detail. */
function readBatch(r: { data?: BatchReply; error?: unknown; response: Response }): BatchReply {
  if (r.data) return r.data;
  const body = r.error as Partial<BatchReply> | undefined;
  if (body && Array.isArray(body.written)) return body as BatchReply;
  throw new ApiError(r.response.status, r.error);
}

export const commitApi: CommitApi & { undo: (previous: Snapshot[]) => Promise<BatchReply> } = {
  geotag: async (ids, lat, lng, accuracy) => readBatch(await api.POST("/api/geotag", { body: { ids, lat, lng, gps_accuracy: accuracy } })),
  remove: async (ids) => readBatch(await api.POST("/api/geotag/remove", { body: { ids } })),
  ignore: async (ids, ignored) => unwrap(await api.POST("/api/geotag/ignore", { body: { ids, ignored } })),
  // The snapshots are opaque: handed back exactly as the server gave them.
  undo: async (previous) => readBatch(await api.POST("/api/geotag/undo", { body: { previous: previous as unknown as Schemas["GeotagSnapshot"][] } })),
};

export function useCommitFlow({ ws, staging, say, onCommitted }: {
  ws: WorkspaceStore;
  staging: Staging;
  say: (msg: string, isError?: boolean) => void;
  /** A commit landed with no failures (the batch flow may roll on). */
  onCommitted: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [lastCommit, setLastCommitState] = useState<LastCommit | null>(loadLastCommit);
  // "Hiding is not forgetting": the U key still undoes until the next commit.
  const [undoHidden, setUndoHidden] = useState(false);
  // Set while a commit's or undo's requests are in flight: a second Commit click
  // (or Enter) would otherwise re-send the same still-staged entries.
  const inFlight = useRef(false);
  const lastRef = useRef(lastCommit);
  const committedRef = useRef(onCommitted);
  committedRef.current = onCommitted;

  const setLastCommit = useCallback((previous: Snapshot[]) => {
    const lc = previous.length ? { previous, at: Date.now() } : null;
    lastRef.current = lc;
    saveLastCommit(lc);
    setLastCommitState(lc);
    setUndoHidden(false);
  }, []);

  const applyPatches = useCallback((patches: Map<number, PhotoPatch>) => {
    // Through view(): a committed photo changes Show bucket, so the filtered set
    // (and the selection kept to it) has to be rebuilt, not just redrawn.
    ws.view({ photos: patchPhotos(ws.ref.current.photos, patches) });
    const focused = ws.ref.current.focusedId;
    if (focused != null && patches.has(focused)) void queryClient.invalidateQueries({ queryKey: photoQueryKey(focused) });
  }, [ws, queryClient]);

  const runGroups = useCallback(async (groups: StagedGroup[]) => {
    inFlight.current = true;
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    say(`Committing ${total} change(s)…`);
    try {
      const out = await runCommit(groups, commitApi, (msg) => say(msg));
      // Only what actually landed leaves the staging area — failed photos (or a
      // failed point) stay staged.
      staging.unstage(out.landed);
      applyPatches(out.patches);
      out.recents.forEach((r) => rememberLocation(r.lat, r.lng, r.accuracy, r.label));
      const s = commitSummary(out);
      say(s.message, s.isError);
      // This commit becomes "the last commit" — only if something landed, so a
      // wholly failed retry doesn't throw away the undo of the one before it.
      if (out.snapshots.length) setLastCommit(out.snapshots);
      if (!out.failures.length) committedRef.current();
    } finally {
      inFlight.current = false;
    }
  }, [say, staging, applyPatches, setLastCommit]);

  /** Commit `groups` (asks first). `what` names them in the question. */
  const commit = useCallback((groups: StagedGroup[], what?: string) => {
    if (inFlight.current) { say("A commit or undo is already in progress…", true); return; }
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    if (!total) { say("Nothing staged to commit.", true); return; }
    setConfirm({
      title: "Commit staged changes",
      message: `Commit ${total} staged change(s)${what ? ` — ${what}` : ""}? This writes them to the photos.`,
      confirmLabel: "✔ Commit",
      onConfirm: () => { setConfirm(null); void runGroups(groups); },
    });
  }, [say, runGroups]);

  /** Throw staged changes away, putting the photos back in the grid. More than
   *  three asks first. */
  const revert = useCallback((groups: StagedGroup[], what?: string) => {
    const ids = groups.flatMap((g) => g.entries.map((e) => e.id));
    if (!ids.length) { say("Nothing staged to revert.", true); return; }
    const go = () => {
      const n = ids.filter((id) => staging.ref.current.has(id)).length;
      staging.unstage(ids);
      if (n) say(`Reverted ${n} staged change(s).`);
    };
    if (ids.length <= 3) { go(); return; }
    setConfirm({
      title: "Discard staged changes",
      message: `Discard ${ids.length} staged change(s)${what ? ` — ${what}` : ""}?`,
      confirmLabel: "↩ Discard",
      danger: true,
      onConfirm: () => { setConfirm(null); go(); },
    });
  }, [say, staging]);

  const runUndo = useCallback(async (snaps: Snapshot[]) => {
    inFlight.current = true;
    say(`Undoing the last commit (${snaps.length} photo(s))…`);
    try {
      const out = await commitApi.undo(snaps);
      applyPatches(undoPatches(out.results));
      const byId = new Map(ws.ref.current.photos.map((p) => [p.id, p]));
      const o = undoOutcome(snaps, out, (id) => byId.get(id)?.filename);
      setLastCommit(o.retry);
      say(o.message, o.isError);
    } catch (e) {
      say("Undo failed: " + (e as Error).message, true);   // record kept: retry with Undo
    } finally {
      inFlight.current = false;
    }
  }, [say, ws, applyPatches, setLastCommit]);

  const undo = useCallback(() => {
    const lc = lastRef.current;
    if (!lc) { say("Nothing to undo.", true); return; }
    if (inFlight.current) { say("A commit or undo is already in progress…", true); return; }
    const snaps = lc.previous;
    setConfirm({
      title: "Undo last commit",
      message: `Undo the last commit? ${snaps.length} photo(s) go back to the location (or no location / ignore mark) they had before it.`,
      confirmLabel: "↶ Undo",
      onConfirm: () => { setConfirm(null); void runUndo(snaps); },
    });
  }, [say, runUndo]);

  /** The preview pane's checkbox: an immediate, one-photo write (un-ignoring is
   *  never bulk — a wrong bulk mark is caught at Commit). False on failure, when
   *  the photo keeps its old flag. */
  const setIgnoredNow = useCallback(async (ids: number[], ignored: boolean): Promise<boolean> => {
    try {
      await commitApi.ignore(ids, ignored);
    } catch (e) {
      say("Ignore for geocoding failed: " + (e as Error).message, true);
      return false;
    }
    applyPatches(new Map(ids.map((id) => [id, { geocode_ignored: ignored }])));
    return true;
  }, [say, applyPatches]);

  /** Guess → Apply: writes straight through, as the legacy page did. */
  const geotagNow = useCallback(async (ids: number[], lat: number, lng: number, accuracy: number | null = null) => {
    say(`Geotagging ${ids.length} photo(s)…`);
    try {
      const out = await commitApi.geotag(ids, lat, lng, accuracy);
      const byId = new Map(out.results.map((r) => [r.id, r]));
      applyPatches(new Map(out.written.map((id) => {
        const r = byId.get(id);
        return [id, { lat: r?.lat ?? lat, lng: r?.lng ?? lng, geotag_source: r?.geotag_source ?? null, gps_accuracy: r?.gps_accuracy ?? null }];
      })));
      const problems = batchProblems(out);
      if (problems) say(`Tagged ${out.written.length} of ${ids.length}; ${problems}`, true);
      else say(`Tagged ${out.written.length} photo(s) at ${lat.toFixed(5)}, ${lng.toFixed(5)}${accuracy ? ` (accuracy: ±${accuracy}m)` : ""}`);
    } catch (e) {
      say("Geotag error: " + (e as Error).message, true);
    }
  }, [say, applyPatches]);

  return useMemo(() => ({
    confirm, cancelConfirm: () => setConfirm(null),
    lastCommit, undoHidden, hideUndo: () => setUndoHidden(true),
    commit, revert, undo, setIgnoredNow, geotagNow,
  }), [confirm, lastCommit, undoHidden, commit, revert, undo, setIgnoredNow, geotagNow]);
}

export type CommitFlow = ReturnType<typeof useCommitFlow>;
