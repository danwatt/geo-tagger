import { useState } from "react";
import { api, unwrap, type Schemas } from "../../api/client";
import { plural } from "../../lib/format";
import { useBatchLoop } from "../../lib/useBatchLoop";
import { Card } from "../../ui/ui";

/* Two client loops on one card: reverse-geocode backfill, and the DB-to-sidecar
 * export. The export also carries a cursor: each batch returns the last photo id
 * it looked at and the next starts after it, so photos that fail to write are
 * stepped past (and counted) instead of picked forever. */

const NO_GEOCODE_DATA_HINT =
  "No place data installed — add GeoNames, US Census places or OSM places on the Data page";

type Geocode = Schemas["SummaryGeocode"];

export function ReverseGeocodeCard({ geocode, error, onDone }: {
  geocode: Geocode | undefined;
  error: string | null;
  /** Re-read the dashboard after a loop ends. */
  onDone: () => void;
}) {
  const backfill = useBatchLoop<Schemas["BackfillResponse"]>("Backfill");
  const exporter = useBatchLoop<Schemas["ExportSidecarsResponse"]>("Sidecar export");
  const [noData, setNoData] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  async function runBackfill() {
    setNoData(false);
    await backfill.run(async () => {
      const r = await api.POST("/api/geocode/backfill", { body: { limit: 1000 } });
      // 503: every dataset is gone (deleted since the page loaded). A hint, not an error.
      if (r.response.status === 503) {
        setNoData(true);
        return { processed: 0, matched: 0, available: false, remaining: 0 };
      }
      return unwrap(r);
    });
    onDone();
  }

  async function runExport() {
    setExportResult(null);
    let cursor = 0;
    let written = 0;
    let failed = 0;
    const samples: string[] = [];
    await exporter.run(async () => {
      const d = unwrap(await api.POST("/api/geocode/export-sidecars", { body: { limit: 200, after_id: cursor } }));
      written += d.written;
      failed += d.failed;
      for (const s of d.errors_sample) if (samples.length < 5) samples.push(s);
      cursor = d.cursor;
      // A batch that looked at nothing means the cursor ran off the end.
      return { ...d, remaining: d.processed > 0 ? d.remaining : 0 };
    });
    if (written || failed) {
      setExportResult(`Wrote ${plural(written, "sidecar")}` + (failed ? ` · ${failed.toLocaleString()} failed (${samples.join("; ")})` : ""));
    }
    onDone();
  }

  // any_available, not available: the latter is GeoNames alone, and an OSM- or
  // Census-only install geocodes too.
  const missingData = noData || (geocode !== undefined && !geocode.any_available);
  const exportPending = geocode?.export_pending ?? 0;
  const loopError = backfill.error ?? exporter.error;

  return (
    <Card id="card-reverse-geocode" title="Reverse geocoding (place names)" error={loopError ?? error}>
      {geocode && (
        <div className="stat-line">
          {geocode.geocoded.toLocaleString()} geocoded · {geocode.pending.toLocaleString()} pending
        </div>
      )}
      {missingData && <div className="hint">{NO_GEOCODE_DATA_HINT}</div>}
      <div className="card-actions">
        <button type="button" id="backfill-btn" disabled={backfill.running || missingData || !geocode} onClick={() => void runBackfill()}>
          {backfill.running && backfill.last?.remaining ? `Backfilling… ${backfill.last.remaining.toLocaleString()} left` : "Run backfill"}
        </button>
      </div>
      {geocode && (
        <div className="stat-line">
          {exportPending
            ? `${exportPending.toLocaleString()} geotagged photos not yet written to XMP sidecars`
            : "Every geotagged photo's sidecar is up to date"}
        </div>
      )}
      {exportResult && <div className="hint">{exportResult}</div>}
      <div className="card-actions">
        <button
          type="button" id="export-sidecars-btn" disabled={exporter.running || !exportPending}
          title="Write each geotagged photo's GPS and place names into its XMP sidecar (originals are never modified)"
          onClick={() => void runExport()}
        >
          {exporter.running && exporter.last?.remaining ? `Exporting… ${exporter.last.remaining.toLocaleString()} left` : "Export to sidecars"}
        </button>
      </div>
    </Card>
  );
}

export { NO_GEOCODE_DATA_HINT };
