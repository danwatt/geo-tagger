import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Schemas } from "../../api/client";
import { httpErrorText } from "../../api/errors";
import type { ScopeDef } from "./scope";
import { wallClockDay } from "./scope";
import { addSkipped, batchRemaining, loadSkipped, skipParam } from "./skipList";
import type { Photo } from "./staging";
import type { MapHandle } from "./useMapHandle";
import { fitToPhotos } from "./useScopeLoader";
import type { Staging } from "./useStaging";
import type { WorkspaceStore } from "./useWorkspace";

/* ── Batch mode (the Home work queue, driven from here) ──
 * A batch is one outing or one scanned folder: the queue picks it, this loads
 * its scope, selects its still-untagged members and lets the propose bar fire.
 * The queue itself is computed server-side and never stored, so nothing here
 * has to be kept in sync — a batch that gets tagged simply stops being
 * returned. Port of app.js's batch mode. */

export type BatchDetail = Schemas["BatchDetail"];

const ADVANCE_DELAY_MS = 2000;

export function useBatchFlow({ ws, staging, map, say, load, onOpened }: {
  ws: WorkspaceStore;
  staging: Staging;
  map: MapHandle;
  say: (msg: string, isError?: boolean) => void;
  load: (def: ScopeDef, opts: { keepBatch: boolean }) => Promise<Photo[] | null>;
  /** A batch's photos landed and its members are selected (a new batch is a
   *  new question for the propose bar). */
  onOpened: () => void;
}) {
  const [batch, setBatchState] = useState<BatchDetail | null>(null);
  const ref = useRef<BatchDetail | null>(null);
  const setBatch = (b: BatchDetail | null) => { ref.current = b; setBatchState(b); };
  // Batches passed over with "Next" this visit. Separate from the skip list: the
  // user said "not this one, now", not "not this one, ever" — so it lives in
  // memory and is forgotten on reload. Without it, Next on an untouched batch
  // would fetch the same queue head straight back and look broken.
  const passedOver = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deps = useRef({ load, say, onOpened });
  deps.current = { load, say, onOpened };

  const cancelAdvance = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  // Any click is "I'm still looking at this" — it stops the auto-advance.
  useEffect(() => {
    document.addEventListener("click", cancelAdvance, true);
    return () => { document.removeEventListener("click", cancelAdvance, true); cancelAdvance(); };
  }, [cancelAdvance]);

  /** Stop being driven by the queue. Leaves the photos loaded — the user asked
   *  to stop, not to lose the scope they were looking at. */
  const exit = useCallback(() => {
    cancelAdvance();
    if (!ref.current) return;
    setBatch(null);
    ws.update({ selected: new Set(), anchorId: null });
    history.replaceState(null, "", window.location.pathname);
  }, [cancelAdvance, ws]);

  const open = useCallback(async (b: BatchDetail) => {
    cancelAdvance();
    setBatch(b);
    // Keep the URL honest so a reload (or the back button) lands on this batch.
    history.replaceState(null, "", `?batch=${encodeURIComponent(b.id)}`);
    const def: ScopeDef = b.kind === "folder" && b.dir
      ? { kind: "dir", dir: b.dir, label: b.title }
      : { kind: "range", from: wallClockDay(b.start_ts ?? 0), to: wallClockDay(b.end_ts ?? 0), label: b.title };
    const photos = await deps.current.load(def, { keepBatch: true });
    if (!photos || ref.current !== b) return;
    // The batch is untagged photos by definition; anything else on screen is
    // context, so the one filter that must be on is "Not tagged". (A pass-only
    // flip: not saved as the viewer's preference.)
    const w = ws.ref.current;
    if (!w.toggles.untagged) ws.view({ toggles: { ...w.toggles, untagged: true } });
    // Only what is actually on screen — a member tagged between the queue build
    // and now, or one a camera/Screenshots filter hides, would otherwise sit in
    // the selection invisibly.
    const shown = ws.filteredOf(ws.ref.current);
    const visible = new Set(shown.map((p) => p.id));
    ws.update({ selected: new Set(b.photo_ids.filter((id) => visible.has(id) && !staging.ref.current.has(id))), anchorId: null });
    deps.current.onOpened();
    if (b.proposal) map.run((m) => m.setView([b.proposal!.lat, b.proposal!.lng], 14));
    else map.run((m) => fitToPhotos(m, shown));   // no guess: the tagged photos in the span are the clue
  }, [cancelAdvance, ws, staging, map]);

  const next = useCallback(async (passOver = true): Promise<void> => {
    cancelAdvance();
    const { say } = deps.current;
    // Move past whatever is on screen. A finished batch is already gone from the
    // queue; an unfinished one has to be stepped over explicitly.
    if (ref.current && passOver) passedOver.current.add(ref.current.id);
    say("Finding the next batch…");
    let res: Response;
    try {
      res = await fetch(`/api/work-queue/next?skip=${encodeURIComponent(skipParam(loadSkipped(), passedOver.current))}`);
    } catch (e) {
      say("Work queue error: " + (e as Error).message, true);
      return;
    }
    if (res.status === 404) {
      // Everything left was passed over rather than skipped — wrap to the top
      // instead of pretending the queue is empty.
      if (passedOver.current.size) {
        passedOver.current = new Set();
        say("Back to the top of the queue.");
        return next(false);   // don't re-add the current one on the way round
      }
      exit();
      say("No batches left — everything is either tagged or too small to batch.");
      return;
    }
    if (!res.ok) { say(`Work queue failed: HTTP ${res.status}`, true); return; }
    await open(await res.json() as BatchDetail);
  }, [cancelAdvance, exit, open]);

  /** ?batch=<id> from Home's work queue. */
  const enter = useCallback(async (id: string) => {
    const { say } = deps.current;
    say("Loading batch…");
    let res: Response;
    try {
      res = await fetch(`/api/work-queue/batch/${encodeURIComponent(id)}`);
    } catch (e) {
      say("Batch load error: " + (e as Error).message, true);
      return;
    }
    if (res.status === 404) {
      // Tagged (or ignored) since the link was made — go straight to what's next.
      say("That batch is already done — loading the next one…");
      await next();
      return;
    }
    if (!res.ok) {
      say(`Batch load failed: ${httpErrorText(await res.json().catch(() => null), res.status)}`, true);
      return;
    }
    await open(await res.json() as BatchDetail);
  }, [next, open]);

  /** Skip: remembered in this browser (Home counts and clears the list). */
  const skip = useCallback(() => {
    if (!ref.current) return;
    addSkipped(ref.current.id);
    void next();
  }, [next]);

  /** After a clean commit: when nothing in the batch is left, roll on. The delay
   *  is there to be interrupted — any click cancels it, so "one more look" wins. */
  const maybeAdvance = useCallback(() => {
    const b = ref.current;
    if (!b) return;
    if (batchRemaining(b.photo_ids, ws.ref.current.photos, (id) => staging.ref.current.has(id)) > 0) return;
    deps.current.say("Batch done — loading the next one…");
    cancelAdvance();
    timer.current = setTimeout(() => { timer.current = null; void next(); }, ADVANCE_DELAY_MS);
  }, [ws, staging, cancelAdvance, next]);

  return useMemo(() => ({ batch, ref, enter, next, skip, exit, maybeAdvance }), [batch, enter, next, skip, exit, maybeAdvance]);
}

export type BatchFlow = ReturnType<typeof useBatchFlow>;
