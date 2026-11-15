import { useState, type ReactNode } from "react";
import type { useJob } from "../../lib/useJob";

/* Building blocks shared by the Data page's cards. */

export function DataCard({ id, title, help, children }: { id: string; title: string; help: ReactNode; children: ReactNode }) {
  return (
    <section className="data-group" id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p className="data-help">{help}</p>
      {children}
    </section>
  );
}

export type FileRow = {
  label: ReactNode;
  value: ReactNode;
  /** true = present (green), false = missing (orange), undefined = plain. */
  ok?: boolean;
  sub?: boolean;
};

export function FileStatusList({ rows }: { rows: FileRow[] }) {
  return (
    <div className="data-files">
      {rows.map((r, i) => (
        <div key={i} className={`data-file-row${r.sub ? " data-file-subrow" : ""}`}>
          <span>{r.label}</span>
          <span className={r.ok === undefined ? undefined : r.ok ? "present" : "missing"}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Progress line, then the error (a start failure wins over the job's own). */
export function JobLines({ message, error }: { message?: string; error?: string | null }) {
  return (
    <>
      <div className="data-progress" aria-live="polite">{message}</div>
      {error && <div className="data-error" role="alert">{error}</div>}
    </>
  );
}

type Job = ReturnType<typeof useJob>;

type JobControlsProps = {
  id: string;
  job: Job;
  startLabel: string;
  /** Start the job; resolve when the server accepted it (or said it's already running). */
  start: (force: boolean) => Promise<void>;
  /** A problem that blocks starting (shown instead of starting), e.g. nothing selected. */
  validate?: () => string | null;
  /** When "force" is ticked, ask first with this text (replaces the old confirm()). */
  forceWarning?: () => string;
  extraButtons?: ReactNode;
};

/** Force checkbox + start button + progress/error lines for one download job. */
export function JobControls({ id, job, startLabel, start, validate, forceWarning, extraButtons }: JobControlsProps) {
  const [force, setForce] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function doStart() {
    setConfirming(null);
    setStarting(true);
    try {
      await start(force);
      job.watch();
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  function onClick() {
    setStartError(null);
    const problem = validate?.();
    if (problem) {
      setStartError(problem);
      return;
    }
    if (force && forceWarning) setConfirming(forceWarning());
    else void doStart();
  }

  const busy = starting || job.running;
  return (
    <>
      <label className="force-label">
        <input type="checkbox" id={`${id}-force`} checked={force} onChange={(e) => setForce(e.target.checked)} />
        Force re-download (ignore local cache)
      </label>
      {confirming ? (
        <div className="data-confirm" role="alertdialog" aria-labelledby={`${id}-confirm-text`}>
          <p id={`${id}-confirm-text`}>{confirming}</p>
          <button type="button" onClick={() => void doStart()} autoFocus>Re-download</button>
          <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      ) : (
        <div className="data-actions">
          <button type="button" id={`${id}-download-btn`} disabled={busy} onClick={onClick}>
            {startLabel}
          </button>
          {extraButtons}
        </div>
      )}
      <JobLines message={job.message} error={startError ?? job.error ?? job.retrying} />
    </>
  );
}
