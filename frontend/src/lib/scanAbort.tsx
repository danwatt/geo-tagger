import { ApiError } from "../api/errors";

/* Batch scans (face detection, text-search indexing) stop with a 503 whose detail
 * is {code, message, errors} when the server aborted the batch without marking
 * anything. For code "too_many_failures" (a long run of unreadable files) the
 * user may say the files really are bad, and the next batch is sent with
 * allow_failures. This is the shared check and prompt; it replaces confirm(). */

export type ScanAborted = { message: string; errors: string[] };

/** The abort detail when `e` is a too_many_failures 503, else null. */
export function tooManyFailures(e: unknown): ScanAborted | null {
  if (!(e instanceof ApiError) || e.status !== 503) return null;
  const d = (e.body as { detail?: { code?: string; message?: string; errors?: string[] } } | null)?.detail;
  return d?.code === "too_many_failures" ? { message: d.message ?? e.message, errors: d.errors ?? [] } : null;
}

export function ScanAbortPrompt({ id, aborted, verb, onContinue, onCancel }: {
  id: string;
  aborted: ScanAborted;
  /** "scanning" / "indexing", for the question. */
  verb: string;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="inline-confirm" role="alertdialog" aria-labelledby={`${id}-abort-text`}>
      <p id={`${id}-abort-text`}>{aborted.message}</p>
      {aborted.errors.length > 0 && (
        <ul className="inline-confirm-list">{aborted.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}
      <p>If these files really are unreadable, mark them as failed and keep {verb}?</p>
      <button type="button" onClick={onContinue} autoFocus>Mark unreadable and continue</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
