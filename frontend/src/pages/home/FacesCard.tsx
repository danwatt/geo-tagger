import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { ScanAbortPrompt, tooManyFailures, type ScanAborted } from "../../lib/scanAbort";
import { useBatchLoop } from "../../lib/useBatchLoop";
import { Card, ProgressBar } from "../../ui/ui";

/* Face detection (client batch loop, with the unreadable-files prompt), retry of
 * photos that couldn't be read, and the one-shot representative-face recompute. */

type Faces = Schemas["SummaryFaces"];

export function FacesCard({ faces, error, onDone }: { faces: Faces | undefined; error: string | null; onDone: () => void }) {
  const scan = useBatchLoop<Schemas["FacesScanResponse"]>("Face detection");
  const [aborted, setAborted] = useState<ScanAborted | null>(null);

  async function runScan(allowFailuresFirst = false) {
    setAborted(null);
    let allowFailures = allowFailuresFirst;
    await scan.run(async () => {
      const r = await api.POST("/api/faces/scan", { body: { limit: 50, allow_failures: allowFailures } });
      allowFailures = false; // the override covers one batch, never the rest of the walk
      try {
        return unwrap(r);
      } catch (e) {
        const a = tooManyFailures(e);
        if (a) setAborted(a);
        throw e;
      }
    });
    onDone();
  }

  const retry = useMutation({
    mutationFn: async () => unwrap(await api.POST("/api/faces/scan/retry-failed")),
    onSuccess: () => runScan(),
  });

  const dedup = useMutation({
    mutationFn: async () => unwrap(await api.POST("/api/faces/dedup/recompute")),
  });
  let dedupText = "";
  if (dedup.data) {
    const persons = dedup.data.persons;
    const totalFaces = persons.reduce((sum, p) => sum + p.total, 0);
    const totalReps = persons.reduce((sum, p) => sum + p.representative, 0);
    dedupText = persons.length
      ? `${persons.length} people processed: ${totalFaces.toLocaleString()} labeled faces -> ${totalReps.toLocaleString()} representatives`
      : "No one has enough labeled faces yet (see Settings for the threshold).";
  }

  const denom = faces ? faces.total - faces.ignored : 0;
  const pct = faces && denom > 0 ? Math.round((faces.labeled / denom) * 100) : 0;
  const failed = faces?.failed_photos ?? 0;
  const shownError = (aborted ? null : scan.error) ?? retry.error?.message ?? dedup.error?.message ?? error;

  return (
    <Card id="card-faces" title="Faces" error={shownError}>
      <ProgressBar pct={pct} label={faces ? `${faces.labeled.toLocaleString()} of ${denom.toLocaleString()} faces labeled` : ""} />
      {faces && <div className="stat-line">{faces.unscanned_photos.toLocaleString()} photos not yet scanned for faces</div>}
      {/* Photos whose file couldn't be read sit out of the queue until "Retry failed". */}
      {failed > 0 && <div className="hint">{failed.toLocaleString()} photos couldn't be read for face detection</div>}
      <div className="card-actions">
        <button type="button" id="detect-faces-btn" disabled={scan.running} onClick={() => void runScan()}>
          {scan.running && scan.last?.remaining ? `Scanning… ${scan.last.remaining.toLocaleString()} left` : "Detect faces"}
        </button>
        {scan.running && <button type="button" className="danger" onClick={scan.stop}>Stop</button>}
        {failed > 0 && !scan.running && (
          <button type="button" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry failed</button>
        )}
      </div>
      {aborted && !scan.running && (
        <ScanAbortPrompt id="faces" aborted={aborted} verb="scanning"
          onContinue={() => void runScan(true)} onCancel={() => setAborted(null)} />
      )}
      <div className="card-actions">
        <a className="button" href="/people.html">🙂 People</a>
        <a className="button" href="/tag.html">📱 Quick Tag</a>
      </div>
      {dedupText && <div className="stat-line">{dedupText}</div>}
      <div className="card-actions">
        <button type="button" disabled={dedup.isPending} onClick={() => dedup.mutate()}>
          {dedup.isPending ? "Recomputing…" : "Recompute representative faces"}
        </button>
      </div>
    </Card>
  );
}
