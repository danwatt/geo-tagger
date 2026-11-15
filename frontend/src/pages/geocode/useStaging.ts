import { useCallback, useEffect, useRef, useState } from "react";
import {
  STAGED_SAVE_FAILED_MSG, classifyRestore, loadStagedRecords, recordsToSave, saveStagedRecords, stagingReducer,
  validRecord, type Photo, type RestoreResult, type Staged, type StagedEntry, type StagedRecord, type StagingAction,
} from "./staging";

/* The staging store: the staged map (stagingReducer), mirrored into this tab's
 * sessionStorage on every change (U7), plus the start-up restore.
 *
 * `ref` always holds the latest map, updated synchronously on dispatch, so an
 * async flow (a commit, the batch's "anything left?") reads what it just
 * changed rather than the last render's copy.
 *
 * The mirror is written from an effect, once per render however many entries a
 * bulk stage touched — and effects flush before the browser gets to an unload.
 * While the start-up restore is still checking saved records against the
 * server, they are "carried": written along with any new staging, so staging
 * something during that fetch can't overwrite them. */

export function useStaging(onSaveError: (msg: string) => void) {
  const [staged, setStaged] = useState<Staged>(() => new Map());
  const ref = useRef<Staged>(staged);
  const carry = useRef<StagedRecord[]>([]);
  const saveFailed = useRef(false);
  // Nothing is written until the start-up read has happened: an empty first
  // render must not wipe the records it is about to restore.
  const [loaded, setLoaded] = useState(false);
  const onError = useRef(onSaveError);
  onError.current = onSaveError;

  const dispatch = useCallback((action: StagingAction) => {
    const next = stagingReducer(ref.current, action);
    if (next === ref.current) return;
    ref.current = next;
    setStaged(next);
  }, []);
  const stage = useCallback((entries: StagedEntry[]) => dispatch({ type: "stage", entries }), [dispatch]);
  const unstage = useCallback((ids: readonly number[]) => dispatch({ type: "unstage", ids }), [dispatch]);

  const [carryTick, setCarryTick] = useState(0);
  useEffect(() => {
    if (!loaded) return;
    if (!saveStagedRecords(recordsToSave(staged, carry.current)) && !saveFailed.current) {
      saveFailed.current = true;
      onError.current(STAGED_SAVE_FAILED_MSG);
    }
  }, [staged, loaded, carryTick]);

  /** Read back what an earlier visit left staged and re-check it against the
   *  server (`fetchPhotos`: the current photo dicts for those ids). Restored
   *  entries go back into the staging area; nothing is written until Commit.
   *  Null when there was nothing to restore; `failed` (the records stay carried,
   *  so they're kept for the next reload) when the check itself failed. */
  const restore = useCallback(async (fetchPhotos: (ids: number[]) => Promise<Photo[]>): Promise<
    (RestoreResult & { total: number; failed?: undefined }) | { failed: string; total: number } | null> => {
    const records = loadStagedRecords().filter(validRecord);
    carry.current = records;
    setLoaded(true);
    if (!records.length) return null;
    let photos: Photo[];
    try {
      photos = await fetchPhotos(records.map((r) => r.id));
    } catch (e) {
      return { failed: (e as Error).message, total: records.length };
    }
    const current = new Map(photos.map((p) => [p.id, p]));
    const result = classifyRestore(records, current, (id) => ref.current.has(id));
    stage(result.entries);
    carry.current = [];
    setCarryTick((t) => t + 1);   // re-save without the carry
    return { ...result, total: records.length };
  }, [stage]);

  return { staged, ref, stage, unstage, restore };
}

export type Staging = ReturnType<typeof useStaging>;
