import { useRef, useState } from "react";
import { stallGuard } from "./stallGuard";

/* The client batch loop for long server work (CLAUDE.md): POST a batch with a
 * `limit`, read `remaining`, repeat until 0. Holds the running/stop state and the
 * stall guard; the caller supplies one step and renders progress from the
 * result. Stop is cooperative: the batch in flight finishes first. */

export type BatchResult = { remaining: number };

type Step<T extends BatchResult> = () => Promise<T>;

export function useBatchLoop<T extends BatchResult>(label: string) {
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const stopRequested = useRef(false);
  const active = useRef(false);

  /** Run `step` until nothing remains, it throws, or stop() is called.
   *  `onBatch` sees each result (e.g. for a rate estimate). */
  async function run(step: Step<T>, onBatch?: (result: T) => void): Promise<void> {
    if (active.current) return;
    active.current = true;
    stopRequested.current = false;
    setRunning(true);
    setStopped(false);
    setError(null);
    const check = stallGuard(label);
    try {
      let remaining = Infinity;
      while (remaining > 0 && !stopRequested.current) {
        const result = await step();
        remaining = result.remaining;
        check(remaining);
        setLast(result);
        onBatch?.(result);
      }
      if (stopRequested.current) setStopped(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      active.current = false;
      setRunning(false);
    }
  }

  return {
    run,
    stop: () => { stopRequested.current = true; },
    running,
    stopped,
    last,
    error,
  };
}
