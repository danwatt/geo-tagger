import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";

/* Background-scan banner under the toolbar. Port of the legacy nav.js banner:
 * one status check on load, polling every 2s only while a scan runs. Files the
 * scan couldn't index persist server-side; the banner offers their list until
 * dismissed for that count (remembered per browser). */

const POLL_MS = 2000;
const ISSUES_KEY = "geotagger.scanIssuesDismissed"; // same key as nav.js, so dismissals carry over
// Phases after the per-file pass, where processed/total no longer move.
const PHASES: Partial<Record<string, string>> = { geocoding: "reverse geocoding", pruning: "checking for moved files" };

type ScanStatus = Schemas["ScanStatusResponse"];

function readDismissed(): number {
  try { return Number(localStorage.getItem(ISSUES_KEY)) || 0; } catch { return 0; }
}
function writeDismissed(n: number) {
  try { localStorage.setItem(ISSUES_KEY, String(n)); } catch { /* storage blocked */ }
}

type BannerView =
  | { kind: "hidden" }
  | { kind: "running" | "finished" | "error" | "issues"; text: string; closable: boolean };

export function bannerView(s: ScanStatus, opts: { sawRunning: boolean; dismissedError: string | null; dismissedCount: number }): BannerView {
  if (s.running) {
    const phase = s.phase ? PHASES[s.phase] : undefined;
    const text = phase
      ? `Scanning library… ${phase}`
      : s.total > 0
        ? `Scanning library… ${s.processed.toLocaleString()} / ${s.total.toLocaleString()} files`
        : "Scanning library… counting files";
    return { kind: "running", text, closable: false };
  }
  if (s.error && s.error !== opts.dismissedError) {
    return { kind: "error", text: `Library scan failed: ${s.error}`, closable: true };
  }
  if (opts.sawRunning) {
    // The page was loaded mid-scan, so what it shows predates the new photos.
    const text = s.warnings > 0
      ? `Library scan finished with ${s.warnings.toLocaleString()} warning(s). Reload to see new photos.`
      : "Library scan finished — reload to see new photos.";
    return { kind: "finished", text, closable: true };
  }
  if (s.errors > 0 && s.errors !== opts.dismissedCount) {
    return { kind: "issues", text: "Library scan:", closable: true };
  }
  return { kind: "hidden" };
}

const BANNER_CLASS = { running: "scan-running", finished: "scan-running", error: "scan-error", issues: "scan-issues" } as const;

export function ScanBanner() {
  const [sawRunning, setSawRunning] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [dismissedCount, setDismissedCount] = useState(readDismissed);
  const [showIssues, setShowIssues] = useState(false);

  const status = useQuery({
    queryKey: ["scan-status"],
    queryFn: async () => unwrap(await api.GET("/api/scan/status")),
    // Keep polling through a failed request while a scan was last seen running.
    refetchInterval: (q) => (q.state.data?.running ? POLL_MS : false),
    retry: false,
  });
  const s = status.data;
  if (s?.running && !sawRunning) setSawRunning(true);

  if (!s) return null;
  const view = bannerView(s, { sawRunning, dismissedError, dismissedCount });
  if (view.kind === "hidden") return null;

  const close = () => {
    setDismissedError(s.error ?? null);
    setSawRunning(false);
    if (s.errors) {
      writeDismissed(s.errors);
      setDismissedCount(s.errors);
    }
    setShowIssues(false);
  };

  return (
    <>
      <div id="scan-banner" className={BANNER_CLASS[view.kind]} role="status">
        <span>{view.text}</span>
        {s.errors > 0 && (
          <button type="button" className="scan-banner-issues" aria-expanded={showIssues} onClick={() => setShowIssues((v) => !v)}>
            {s.errors.toLocaleString()} file(s) couldn’t be indexed
          </button>
        )}
        {view.closable && (
          <button type="button" className="scan-banner-close" title="Dismiss" aria-label="Dismiss" onClick={close}>
            ✕
          </button>
        )}
      </div>
      {showIssues && <ScanIssues onRetried={() => setShowIssues(false)} />}
    </>
  );
}

function ScanIssues({ onRetried }: { onRetried: () => void }) {
  const queryClient = useQueryClient();
  const issues = useQuery({
    queryKey: ["scan-errors"],
    queryFn: async () => unwrap(await api.GET("/api/scan/errors")),
  });
  const retry = useMutation({
    mutationFn: async () => unwrap(await api.DELETE("/api/scan/errors")),
    onSuccess: () => {
      onRetried();
      void queryClient.invalidateQueries({ queryKey: ["scan-status"] });
    },
  });

  if (issues.isPending) return <div id="scan-issues"><div className="scan-issues-note">Loading…</div></div>;
  if (issues.isError) {
    return <div id="scan-issues"><div className="scan-issues-note">Couldn’t load the list ({issues.error.message}).</div></div>;
  }
  const d = issues.data;
  return (
    <div id="scan-issues">
      <div className="scan-issues-note">
        Unchanged files that failed to read aren’t retried on later scans.
        <button type="button" className="scan-issues-retry" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isError ? `Retry failed (${retry.error.message})` : "Retry all on next scan"}
        </button>
      </div>
      <ul>
        {d.errors.map((e) => (
          <li key={e.path}>
            <span className="scan-issues-path">{e.path}</span> — {e.error}
            {e.attempts > 1 && <span className="scan-issues-note"> ({e.attempts} attempts)</span>}
          </li>
        ))}
        {d.count > d.errors.length && (
          <li className="scan-issues-note">…and {(d.count - d.errors.length).toLocaleString()} more</li>
        )}
      </ul>
      {d.warnings.length > 0 && (
        <details>
          <summary>All {d.warnings.length.toLocaleString()} warning(s) from the last scan</summary>
          <ul>{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
