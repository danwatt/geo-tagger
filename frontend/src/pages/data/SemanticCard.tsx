import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { acceptStarted, api, unwrap, type Schemas } from "../../api/client";
import { ApiError } from "../../api/errors";
import { fmtBytes } from "../../lib/format";
import { useBatchLoop } from "../../lib/useBatchLoop";
import { useJob } from "../../lib/useJob";
import { DATA_STATUS_KEY } from "./cards";
import { DataCard, FileStatusList, JobControls, JobLines } from "./parts";

/* Text search model: download (start-and-poll job), then index photos with the
 * client batch loop. A batch the server aborts after too many unreadable files
 * in a row (503 too_many_failures) asks whether to mark them and carry on. */

const SEMANTIC_STATUS_KEY = ["semantic-status"] as const;
const BATCH = 32;

type ScanResult = Schemas["SemanticScanResponse"];
type Aborted = { message: string; errors: string[] };

/** The 503 detail of a batch that stopped on consecutive unreadable files. */
function tooManyFailures(e: unknown): Aborted | null {
  if (!(e instanceof ApiError) || e.status !== 503) return null;
  const d = (e.body as { detail?: { code?: string; message?: string; errors?: string[] } } | null)?.detail;
  return d?.code === "too_many_failures" ? { message: d.message ?? e.message, errors: d.errors ?? [] } : null;
}

export function SemanticCard({ status: m }: { status: Schemas["ModelStatus"] | undefined }) {
  const queryClient = useQueryClient();
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: DATA_STATUS_KEY });
    void queryClient.invalidateQueries({ queryKey: SEMANTIC_STATUS_KEY });
  };
  const idx = useQuery({
    queryKey: SEMANTIC_STATUS_KEY,
    queryFn: async () => unwrap(await api.GET("/api/semantic/status")),
  }).data;
  const job = useJob("/api/data/semantic-model/download/status", { intervalMs: 1000, onFinished: refreshAll });
  const loop = useBatchLoop<ScanResult>("Indexing");
  const [progress, setProgress] = useState("");
  const [aborted, setAborted] = useState<Aborted | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const failedThisRun = useRef(0);

  async function runIndex(allowFailuresFirst = false) {
    setAborted(null);
    setRetryError(null);
    setProgress("");
    failedThisRun.current = 0;
    let allowFailures = allowFailuresFirst;
    let t0 = 0;
    await loop.run(
      async () => {
        t0 = performance.now();
        const r = await api.POST("/api/semantic/scan", { body: { limit: BATCH, allow_failures: allowFailures } });
        allowFailures = false; // the override covers one batch only
        try {
          return unwrap(r);
        } catch (e) {
          const a = tooManyFailures(e);
          if (a) setAborted(a);
          throw e;
        }
      },
      (r) => {
        failedThisRun.current += r.errors.length;
        const rate = r.processed / ((performance.now() - t0) / 1000);
        setProgress(r.remaining > 0
          ? `~${rate.toFixed(1)} photos/s · about ${Math.ceil(r.remaining / Math.max(rate, 0.1) / 60).toLocaleString()} min left`
          : `Done.${failedThisRun.current ? ` ${failedThisRun.current} photo(s) couldn't be read.` : ""}`);
      },
    );
    refreshAll();
  }

  async function retryFailed() {
    setRetryError(null);
    try {
      unwrap(await api.POST("/api/semantic/retry-failed"));
      await runIndex();
    } catch (e) {
      setRetryError((e as Error).message);
    }
  }

  const remaining = loop.running && loop.last ? loop.last.remaining : idx?.remaining;
  const indexLabel = loop.running
    ? `Indexing… ${remaining?.toLocaleString() ?? ""} left`
    : idx && idx.remaining > 0 ? `Index ${idx.remaining.toLocaleString()} photos` : "Index photos";
  const progressText = loop.stopped ? "Stopped — Index photos resumes where it left off." : progress;

  return (
    <DataCard id="card-semantic" title="Text search model" help={<>
      SigLIP 2 image/text model (~1.4 GB) behind the Search page's <em>Describe</em> box and{" "}
      <em>More like this</em>. Download it once, then index your photos — roughly 2–10 photos/second
      on CPU, ~30/second on an NVIDIA GPU (both faster once previews are cached, e.g. after face
      detection), and only new photos need indexing afterwards. Runs fully offline; nothing is
      written to your files.
    </>}>
      {m && (
        <FileStatusList rows={[
          { label: m.name, ok: m.available, value: m.available ? fmtBytes(m.size_bytes) : "not downloaded" },
          ...(idx ? [{
            label: "Photos indexed", ok: idx.remaining === 0,
            value: `${idx.embedded.toLocaleString()} of ${idx.total.toLocaleString()}` +
              (idx.failed ? ` · ${idx.failed.toLocaleString()} unreadable` : ""),
          }] : []),
        ]} />
      )}
      <JobControls
        id="semantic" job={job}
        startLabel={m?.available ? "Re-download text search model" : "Download text search model"}
        start={async (force) => acceptStarted(await api.POST("/api/data/semantic-model/download", { body: { force } }))}
        extraButtons={<>
          <button type="button" disabled={loop.running || !m?.available || !idx || idx.remaining === 0} onClick={() => void runIndex()}>
            {indexLabel}
          </button>
          {loop.running && <button type="button" onClick={loop.stop}>Stop</button>}
          {!loop.running && m?.available && Boolean(idx?.failed) && (
            <button type="button" onClick={() => void retryFailed()}>Retry failed</button>
          )}
        </>}
      />
      {aborted && !loop.running && (
        <div className="data-confirm" role="alertdialog" aria-labelledby="semantic-abort-text">
          <p id="semantic-abort-text">{aborted.message}</p>
          {aborted.errors.length > 0 && (
            <ul className="data-confirm-list">{aborted.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
          <p>If these files really are unreadable, mark them as failed and keep indexing?</p>
          <button type="button" onClick={() => void runIndex(true)} autoFocus>Mark unreadable and continue</button>
          <button type="button" onClick={() => setAborted(null)}>Cancel</button>
        </div>
      )}
      <JobLines message={progressText} error={aborted ? null : (loop.error ?? retryError)} />
    </DataCard>
  );
}
