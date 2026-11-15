import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { MONTH_NAMES } from "../../lib/format";
import { Dialog } from "../../ui/Dialog";
import "./MonthPickerDialog.css";

/* Select Month. Two levels: a year grid first (one card per year, with a
 * 12-cell strip that shows each month's volume + geotag coverage at a glance),
 * then drill into a year for its month grid. A flat year-headed list meant
 * scrolling past ~12 rows per year to reach anything older. Port of app.js's
 * month picker; every card and cell is a real button. */

type Month = Schemas["MonthGeo"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (n: number | null | undefined) => (n || 0).toLocaleString();

/** Geotagged share of a bucket, as a slim two-tone bar. */
function CoverageBar({ geotagged, total }: { geotagged: number; total: number }) {
  const pct = total ? Math.round((geotagged / total) * 100) : 0;
  return <div className="yp-bar" title={`${pct}% geotagged`} aria-hidden="true"><div className="yp-bar-fill" style={{ width: `${pct}%` }} /></div>;
}

function Counts({ total, geotagged, notGeotagged, short }: { total?: number; geotagged: number; notGeotagged: number; short?: boolean }) {
  return (
    <div className="month-counts">
      {total !== undefined && <span className="count-badge count-total">{fmt(total)} total</span>}
      <span className="count-badge count-geotagged">{fmt(geotagged)}{short ? "" : " geotagged"}</span>
      <span className="count-badge count-not-geotagged">{fmt(notGeotagged)}{short ? "" : " not geotagged"}</span>
    </div>
  );
}

export function MonthPickerDialog({ onMonth, onYear, onUndated, onClose, onError }: {
  onMonth: (year: number, month: number) => void;
  onYear: (year: number) => void;
  onUndated: () => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const stats = useQuery({
    queryKey: ["stats", "months"],
    queryFn: async () => unwrap(await api.GET("/api/stats/months")),
  });
  const [year, setYear] = useState<number | null>(null);
  const errRef = useRef(onError);
  errRef.current = onError;
  const errMsg = stats.isError ? stats.error.message : null;
  useEffect(() => {
    if (errMsg) errRef.current("Error loading months: " + errMsg);
  }, [errMsg]);
  const months = stats.data?.months ?? [];
  const byYear = new Map<number, Map<number, Month>>();
  months.forEach((m) => {
    if (!byYear.has(m.year)) byYear.set(m.year, new Map());
    byYear.get(m.year)!.set(m.month, m);
  });

  if (year !== null) {
    const ms = byYear.get(year) ?? new Map<number, Month>();
    return (
      <Dialog title={`Select Month — ${year}`} onClose={onClose} id="month-picker-modal">
        <div className="yp-crumb">
          <button type="button" className="yp-back" onClick={() => setYear(null)}>← All years</button>
          <button type="button" className="yp-all-btn" onClick={() => onYear(year)}>Browse all {year}</button>
        </div>
        <div className="yp-month-grid">
          {MONTH_ABBR.map((abbr, i) => {
            const m = ms.get(i + 1);
            if (!m) {
              return (
                <div key={abbr} className="yp-month-card empty" aria-label={`${MONTH_NAMES[i]} ${year}: no photos`}>
                  <div className="yp-month-name">{abbr}</div>
                  <div className="yp-month-none">—</div>
                </div>
              );
            }
            return (
              <button key={abbr} type="button" className="yp-month-card" onClick={() => onMonth(year, i + 1)}
                aria-label={`${MONTH_NAMES[i]} ${year}: ${fmt(m.total)} photos, ${fmt(m.geotagged)} geotagged`}>
                <div className="yp-month-name">{MONTH_NAMES[i]}</div>
                <div className="yp-month-total">{fmt(m.total)}</div>
                <CoverageBar geotagged={m.geotagged} total={m.total} />
                <Counts geotagged={m.geotagged} notGeotagged={m.not_geotagged} short />
              </button>
            );
          })}
        </div>
      </Dialog>
    );
  }

  const undated = stats.data?.undated;
  const years = [...byYear.keys()].sort((a, b) => b - a);
  // Month cells are scaled against the busiest month in the whole library, so
  // the strips are comparable across years rather than each year self-scaling.
  const peak = Math.max(1, ...months.map((m) => m.total));
  return (
    <Dialog title="Select Year" onClose={onClose} id="month-picker-modal">
      <div id="month-picker-list">
        {!stats.data && !stats.isError && <p>Loading months…</p>}
        {undated && undated.total > 0 && (
          <button type="button" className="yp-undated" onClick={onUndated}>
            <span className="yp-undated-name">📁 Undated</span>
            <Counts total={undated.total} geotagged={undated.geotagged} notGeotagged={undated.not_geotagged} />
          </button>
        )}
        {stats.data && !months.length && !(undated && undated.total > 0) && <p>No photos found with timestamps.</p>}
        {years.length > 0 && (
          <div className="yp-year-grid">
            {years.map((y) => {
              const ms = byYear.get(y)!;
              let tot = 0, geo = 0, nogeo = 0;
              ms.forEach((m) => { tot += m.total; geo += m.geotagged; nogeo += m.not_geotagged; });
              return (
                <div key={y} className="yp-year-card">
                  <div className="yp-year-top">
                    <button type="button" className="yp-year-num" onClick={() => setYear(y)} title={`Show the months of ${y}`}>{y}</button>
                    <button type="button" className="yp-all-btn" title={`Load every photo from ${y}`} onClick={() => onYear(y)}>All year</button>
                  </div>
                  <CoverageBar geotagged={geo} total={tot} />
                  <Counts total={tot} geotagged={geo} notGeotagged={nogeo} short />
                  <div className="yp-spark">
                    {MONTH_ABBR.map((abbr, i) => {
                      const m = ms.get(i + 1);
                      if (!m) return <div key={abbr} className="yp-spark-cell empty" aria-hidden="true" />;
                      // Height encodes volume (sqrt so a single huge month doesn't
                      // flatten the rest), fill colour encodes geotag coverage.
                      const h = Math.max(0.12, Math.sqrt(m.total / peak));
                      const pct = m.total ? Math.round((m.geotagged / m.total) * 100) : 0;
                      const label = `${MONTH_NAMES[i]} ${y} — ${fmt(m.total)} photos, ${pct}% geotagged`;
                      return (
                        <button key={abbr} type="button" className="yp-spark-cell" title={label} aria-label={label} onClick={() => onMonth(y, i + 1)}>
                          <span className="yp-spark-bar" style={{ height: `${(h * 100).toFixed(0)}%` }}>
                            <span className="yp-spark-geo" style={{ height: `${pct}%` }} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
