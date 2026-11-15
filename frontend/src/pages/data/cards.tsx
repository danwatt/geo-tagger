import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { acceptStarted, api, type Schemas } from "../../api/client";
import { ApiError } from "../../api/errors";
import { fmtBytes } from "../../lib/format";
import { useJob } from "../../lib/useJob";
import { DataCard, FileStatusList, JobControls } from "./parts";

/* The simple download cards: status rows + one start-and-poll job each. */

export const DATA_STATUS_KEY = ["data-status"] as const;

function useRefreshStatus() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: DATA_STATUS_KEY });
}

export function GeonamesCard({ status }: { status: Schemas["GeonamesStatus"] | undefined }) {
  const job = useJob("/api/data/geonames/download/status", { onFinished: useRefreshStatus() });
  return (
    <DataCard id="card-geonames" title="GeoNames (nearest-city lookup)" help={
      "Cities, admin regions (state/county), and country names used as the fallback " +
      "reverse-geocode when a photo falls outside every OSM place polygon below."
    }>
      {status && (
        <FileStatusList rows={status.files.map((f) => ({
          label: f.name, ok: f.present, value: f.present ? fmtBytes(f.size) : "missing",
        }))} />
      )}
      <JobControls
        id="geonames" job={job}
        startLabel={status?.available ? "Re-download GeoNames data" : "Download GeoNames data"}
        start={async (force) => acceptStarted(await api.POST("/api/data/geonames/download", { body: { force } }))}
      />
    </DataCard>
  );
}

export function CensusCard({ status: c }: { status: Schemas["CensusStatus"] | undefined }) {
  const job = useJob("/api/data/census/download/status", { onFinished: useRefreshStatus() });
  return (
    <DataCard id="card-census" title="US Census places & ZIP areas" help={<>
      The Census Bureau's national 1:500,000 boundaries. <strong>Places</strong> include census
      designated places — the unincorporated suburbia that has no city boundary at all, so a photo
      there gets a real place name instead of whichever GeoNames town happens to be nearest.{" "}
      <strong>ZCTAs</strong> add each photo's ZIP code, and (via a small GeoNames crosswalk) the
      ZIP's mailing city as a last resort before that nearest-city estimate. ~90 MB total; rebuilds
      in seconds.
    </>}>
      {c && (
        <FileStatusList rows={[
          {
            label: <>Places DB{c.source && <span className="data-file-note"> ({c.source})</span>}</>,
            ok: c.available, value: c.available ? `${c.places.toLocaleString()} total` : "not built yet",
          },
          ...Object.entries(c.by_kind).map(([kind, n]) => ({ label: kind, value: n.toLocaleString(), sub: true })),
          { label: "ZIP areas (ZCTA)", ok: c.zctas > 0, value: c.zctas ? `${c.zctas.toLocaleString()} total` : "not loaded" },
          ...(c.zctas ? [{ label: "with a city name", value: c.zip_names.toLocaleString(), sub: true }] : []),
        ]} />
      )}
      <JobControls
        id="census" job={job}
        startLabel={c?.available ? "Re-download Census data" : "Download Census data"}
        start={async (force) => acceptStarted(await api.POST("/api/data/census/download", { body: { force } }))}
      />
    </DataCard>
  );
}

export function FaceModelCard({ status: m }: { status: Schemas["ModelStatus"] | undefined }) {
  const job = useJob("/api/data/face-model/download/status", { onFinished: useRefreshStatus() });
  return (
    <DataCard id="card-face-model" title="Face matcher model" help={<>
      InsightFace's <code>buffalo_l</code> detection + recognition pack (~275 MB). Normally
      downloaded automatically the first time you scan for faces — pre-fetch it here instead if
      you'd rather not wait mid-scan.
    </>}>
      {m && <FileStatusList rows={[{ label: m.name, ok: m.available, value: m.available ? "installed" : "not downloaded" }]} />}
      <JobControls
        id="face-model" job={job}
        startLabel={m?.available ? "Re-download face model" : "Download face model"}
        start={async (force) => acceptStarted(await api.POST("/api/data/face-model/download", { body: { force } }))}
      />
    </DataCard>
  );
}

/** Save a Blob under `filename`. The anchor must be in the document for Firefox. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BackupCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setError(null);
    setBusy(true);
    try {
      // A file download, not JSON data: plain fetch, read the server's filename.
      const res = await fetch("/api/data/backup");
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      const match = (res.headers.get("Content-Disposition") ?? "").match(/filename="([^"]+)"/);
      saveBlob(await res.blob(), match?.[1] ?? "geotagger-backup.json");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DataCard id="card-backup" title="Backup" help={
      "Downloads a compact JSON snapshot of the data nothing else can regenerate — places, " +
      "people & families, face-to-person labels, per-photo lat/lng, and settings. Leaves out " +
      "anything derivable by rescanning (photo metadata, reverse-geocode results, face " +
      "embeddings, download history), so it's small even on a large library."
    }>
      <button type="button" id="backup-download-btn" disabled={busy} onClick={() => void download()}>
        {busy ? "Preparing…" : "Download backup"}
      </button>
      {error && <div className="data-error" role="alert">{error}</div>}
    </DataCard>
  );
}
