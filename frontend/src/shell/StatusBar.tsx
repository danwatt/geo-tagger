/* Bottom status line (theme.css #status-bar). aria-live so screen readers hear
 * updates (audit Y4). */

export type Status = { message: string; isError?: boolean };

export function StatusBar({ status }: { status: Status }) {
  return (
    <div id="status-bar" aria-live="polite" style={{ color: status.isError ? "var(--danger-text)" : "var(--text-muted)" }}>
      {status.message}
    </div>
  );
}
