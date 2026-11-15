import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson, type Schemas } from "../api/client";
import { ApiError } from "../api/errors";

/* Polling a server background job (dataset downloads, street search): the
 * status route returns {running, done, error, message, …}. One fetch on mount
 * picks up a job already running (e.g. a reload mid-download); polling runs
 * only while `running`. Port of data.js pollJob:
 *  - network errors and 5xx are transient (server restarting, laptop waking):
 *    retried with a growing delay, shown as "Lost contact…", up to MAX_FAILURES;
 *  - 404 means the job or route is gone, and other 4xx won't change on retry,
 *    so those stop at once. */

export type JobStatus = Schemas["JobStatus"];

const MAX_FAILURES = 5;

function isTransient(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status >= 500;
}

type Options<T extends JobStatus> = {
  intervalMs?: number;
  /** Runs once when a job this page saw running stops (done, failed or cancelled). */
  onFinished?: (job: T) => void;
};

export function useJob<T extends JobStatus = JobStatus>(path: string, { intervalMs = 1500, onFinished }: Options<T> = {}) {
  const query = useQuery({
    queryKey: ["job", path],
    queryFn: () => getJson<T>(path),
    refetchInterval: (q) => (q.state.data?.running ? intervalMs : false),
    retry: (failures, e) => isTransient(e) && failures < MAX_FAILURES - 1,
    retryDelay: (attempt) => Math.max(intervalMs, 1000) * Math.min(attempt + 2, 4),
  });

  // Fire onFinished on the running → stopped edge, not on every render.
  const wasRunning = useRef(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  // The server keeps a finished job's state until the next run. Only report
  // jobs this page watched run, so a reload doesn't replay yesterday's
  // "Download complete" (or its error).
  const [watched, setWatched] = useState(false);
  const job = query.data;
  useEffect(() => {
    if (!job) return;
    if (job.running) setWatched(true);
    if (wasRunning.current && !job.running) finished.current?.(job);
    wasRunning.current = job.running;
  }, [job]);

  let error: string | null = watched ? (job?.error ?? null) : null;
  let retrying: string | null = null;
  if (query.isError && watched) {
    const e = query.error;
    error = e instanceof ApiError && e.status === 404
      ? "The job is no longer on the server."
      : isTransient(e) ? `Lost contact with server: ${e.message}` : e.message;
  } else if (query.failureCount > 0 && query.isFetching) {
    retrying = `Lost contact with server — retrying… (${(query.failureReason as Error | null)?.message ?? ""})`;
  }

  return {
    job,
    watched,
    running: Boolean(job?.running),
    message: watched ? (job?.message ?? "") : "",
    error,
    retrying,
    /** Call right after starting the job: reports it even if it finishes before
     *  a poll sees it running, and fetches its status now. */
    watch: () => {
      setWatched(true);
      wasRunning.current = true;
      void query.refetch();
    },
  };
}
