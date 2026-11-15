import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/* Toasts. Port of common.js showToast (U9) and showUndoToast (U3); the look is
 * theme.css's #toast and .undo-toast.
 *
 * toast(msg, isErr): a bottom-centre pill. Successes go after 2.5 s; errors
 * get a red edge, stay 6 s and carry a ✕. Hovering holds either.
 *
 * undoToast(msg, undoFn): one-click destructive actions act at once and then
 * offer this instead of a confirm(). Persistent enough to reach: 9 s, paused
 * while the pointer is over it or focus is inside it. Ctrl/Cmd+Z runs it from
 * anywhere except a text field or an open dialog (there it belongs to the
 * field's own undo). One at a time: a new action's toast replaces the previous
 * one, and the previous action simply stays applied — what you can undo is
 * always exactly what the toast on screen says. undoFn resolves to the outcome
 * line (a string, or {message, isError}) so a partial or refused undo says so. */

export type UndoOutcome = string | { message: string; isError?: boolean };

type Plain = { id: number; message: string; isError: boolean };
type Undo = { id: number; message: string; undoFn: () => Promise<UndoOutcome>; busy: boolean; done: boolean; isError: boolean };

let nextId = 1;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export function useToasts() {
  const [plain, setPlain] = useState<Plain | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const plainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Undo countdown: `remaining` ms left, counting from `startedAt` while running.
  const undoClock = useRef<{ id: number; remaining: number; startedAt: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const undoRef = useRef<Undo | null>(null);
  undoRef.current = undo;
  const undoEl = useRef<HTMLDivElement>(null);

  const hidePlain = useCallback(() => {
    if (plainTimer.current) clearTimeout(plainTimer.current);
    setPlain(null);
  }, []);
  const armPlain = useCallback((ms: number) => {
    if (plainTimer.current) clearTimeout(plainTimer.current);
    plainTimer.current = setTimeout(() => setPlain(null), ms);
  }, []);

  const toast = useCallback((message: string, isError = false) => {
    setPlain({ id: nextId++, message, isError });
    armPlain(isError ? 6000 : 2500);
  }, [armPlain]);

  const hideUndo = useCallback(() => {
    const c = undoClock.current;
    if (c?.timer) clearTimeout(c.timer);
    undoClock.current = null;
    setUndo(null);
  }, []);
  const pauseUndo = useCallback(() => {
    const c = undoClock.current;
    if (!c || c.timer == null) return;
    clearTimeout(c.timer);
    c.timer = null;
    c.remaining -= Date.now() - c.startedAt;
  }, []);
  const resumeUndo = useCallback(() => {
    const c = undoClock.current;
    if (!c || c.timer != null || undoRef.current?.busy) return;
    c.startedAt = Date.now();
    const id = c.id;
    c.timer = setTimeout(() => { if (undoClock.current?.id === id) hideUndo(); }, Math.max(c.remaining, 1500));
  }, [hideUndo]);

  const undoToast = useCallback((message: string, undoFn: () => Promise<UndoOutcome>, timeoutMs = 9000) => {
    if (undoClock.current?.timer) clearTimeout(undoClock.current.timer);
    const id = nextId++;
    const t: Undo = { id, message, undoFn, busy: false, done: false, isError: false };
    undoRef.current = t;
    setUndo(t);
    undoClock.current = { id, remaining: timeoutMs, startedAt: Date.now(), timer: null };
    // Already under the pointer / holding focus (a quick second action): stay paused.
    const el = undoEl.current;
    if (!(el && (el.matches(":hover") || el.contains(document.activeElement)))) resumeUndo();
  }, [resumeUndo]);

  const runUndo = useCallback(async () => {
    const t = undoRef.current;
    if (!t || t.busy || t.done) return;
    pauseUndo();
    const busy = { ...t, busy: true };
    undoRef.current = busy;
    setUndo(busy);
    let result: UndoOutcome;
    try {
      result = await t.undoFn();
    } catch (err) {
      result = { message: "Undo failed: " + (err as Error).message, isError: true };
    }
    if (undoRef.current?.id !== t.id) return;   // replaced by a newer action meanwhile
    const r = typeof result === "string" ? { message: result } : result;
    const done = { ...t, busy: false, done: true, message: r.message, isError: !!r.isError };
    undoRef.current = done;
    setUndo(done);
    // The outcome stays long enough to read, then goes; hovering still holds it.
    if (undoClock.current) undoClock.current.remaining = r.isError ? 7000 : 3500;
    if (!undoEl.current?.matches(":hover")) resumeUndo();
  }, [pauseUndo, resumeUndo]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = undoRef.current;
      if (!t || t.done) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      if (isTypingTarget(e.target) || document.querySelector(".modal [role=dialog]")) return;
      e.preventDefault();
      void runUndo();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [runUndo]);

  useEffect(() => () => {
    if (plainTimer.current) clearTimeout(plainTimer.current);
    if (undoClock.current?.timer) clearTimeout(undoClock.current.timer);
  }, []);

  const node: ReactNode = (
    <>
      <div id="toast" hidden={!plain} className={plain ? (plain.isError ? "err" : "ok") : undefined}
        role={plain?.isError ? "alert" : "status"} aria-live={plain?.isError ? "assertive" : "polite"}
        onMouseEnter={() => { if (plainTimer.current) clearTimeout(plainTimer.current); }}
        onMouseLeave={() => { if (plain) armPlain(1500); }}>
        {plain && <span className="toast-msg">{plain.message}</span>}
        {plain?.isError && <button type="button" className="toast-close" aria-label="Dismiss" title="Dismiss" onClick={hidePlain}>✕</button>}
      </div>
      <div ref={undoEl} id="undo-toast" hidden={!undo} role="status" aria-live="polite"
        className={`undo-toast${undo?.done ? " ut-result" : ""}${undo?.isError ? " err" : ""}`}
        onMouseEnter={pauseUndo}
        onMouseLeave={() => { if (!undoEl.current?.contains(document.activeElement)) resumeUndo(); }}
        onFocus={pauseUndo}
        onBlur={(e) => { if (!undoEl.current?.contains(e.relatedTarget as Node | null) && !undoEl.current?.matches(":hover")) resumeUndo(); }}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); hideUndo(); } }}>
        {undo && <span className="ut-msg">{undo.message}</span>}
        {undo && !undo.done && (
          <button type="button" className="ut-undo" title="Undo (Ctrl+Z)" disabled={undo.busy} onClick={() => void runUndo()}>
            {undo.busy ? "Undoing…" : "Undo"}
          </button>
        )}
        {undo && <button type="button" className="ut-close" aria-label="Dismiss" title="Dismiss — keep the change" onClick={hideUndo}>✕</button>}
      </div>
    </>
  );

  return { toast, undoToast, node };
}
