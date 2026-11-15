import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../api/client";
import { AppShell } from "../../shell/AppShell";
import { MonthBars, UndatedLink, type MonthBarMode, type Segment } from "../../ui/MonthBars";
import { Card, ProgressBar, SegmentedToggle } from "../../ui/ui";
import { FacesCard } from "./FacesCard";
import { ReverseGeocodeCard } from "./ReverseGeocodeCard";
import { WorkQueue } from "./WorkQueue";
import "./home.css";

const KEYS = {
  summary: ["stats", "summary"],
  coverage: ["stats", "face-coverage"],
  months: ["stats", "months"],
  facesMonths: ["stats", "faces-months"],
} as const;

const GEO_SEGMENTS: Segment<"not_geotagged" | "geotagged">[] = [
  { key: "not_geotagged", cls: "bar-untagged", label: "untagged" },
  { key: "geotagged", cls: "bar-tagged", label: "tagged" },
];
const FACE_SEGMENTS: Segment<"no_faces" | "none" | "partial" | "full">[] = [
  { key: "no_faces", cls: "cov-noface", label: "no faces" },
  { key: "none", cls: "cov-none", label: "none labeled" },
  { key: "partial", cls: "cov-partial", label: "partial" },
  { key: "full", cls: "cov-full", label: "full" },
];
const MODE_OPTIONS: { value: MonthBarMode; label: string }[] = [
  { value: "pct", label: "%" },
  { value: "abs", label: "Count" },
];

function GeotagCard({ s, error }: { s: Schemas["SummaryResponse"] | undefined; error: string | null }) {
  const total = s?.photos.total ?? 0;
  const done = s ? s.geotag.tagged + s.geotag.ignored : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Card id="card-geotag" title="Geotagging" full error={error}>
      <ProgressBar pct={pct} label={`${pct}%`} />
      {s && (
        <div className="stat-line">
          {s.geotag.tagged.toLocaleString()} tagged · {s.geotag.ignored.toLocaleString()} ignored ·{" "}
          <strong>{s.geotag.untagged.toLocaleString()} remaining</strong>
        </div>
      )}
      {s && s.guessable.count > 0 && (
        <div className="stat-line highlight">
          {s.guessable.count.toLocaleString()} photos have a nearby-in-time guess available
        </div>
      )}
      <WorkQueue />
      <div className="card-actions">
        <a className="button" href="/geocode.html">📍 Open Geocode view</a>
      </div>
    </Card>
  );
}

function FaceCoverageCard({ cov, error }: { cov: Schemas["FaceBuckets"] | undefined; error: string | null }) {
  const segs = [
    { label: "Full", cls: "cov-full", n: cov?.full ?? 0 },
    { label: "Partial", cls: "cov-partial", n: cov?.partial ?? 0 },
    { label: "No coverage", cls: "cov-none", n: cov?.none ?? 0 },
    { label: "No faces", cls: "cov-noface", n: cov?.no_faces ?? 0 },
  ];
  const total = segs.reduce((sum, s) => sum + s.n, 0);
  return (
    <Card id="card-face-coverage" title="Face coverage" error={error}>
      <div className="coverage-bar" role="img" aria-label={segs.map((s) => `${s.label} ${s.n}`).join(", ")}>
        {/* Empty segments are skipped so tiny slivers don't show. */}
        {segs.filter((s) => s.n > 0).map((s) => (
          <div key={s.cls} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} title={`${s.label}: ${s.n.toLocaleString()}`} />
        ))}
      </div>
      <div className="progress-label">
        {total > 0 ? `${total.toLocaleString()} photos scanned for faces` : "No photos scanned for faces yet"}
      </div>
      <div className="coverage-legend">
        {segs.map((s) => (
          <span key={s.cls} className="lg"><span className={`sw ${s.cls}`} />{s.label} {s.n.toLocaleString()}</span>
        ))}
      </div>
    </Card>
  );
}

export function HomePage() {
  const queryClient = useQueryClient();
  const summary = useQuery({ queryKey: KEYS.summary, queryFn: async () => unwrap(await api.GET("/api/stats/summary")) });
  const coverage = useQuery({ queryKey: KEYS.coverage, queryFn: async () => unwrap(await api.GET("/api/stats/face-coverage")) });
  const months = useQuery({ queryKey: KEYS.months, queryFn: async () => unwrap(await api.GET("/api/stats/months")) });
  const facesMonths = useQuery({ queryKey: KEYS.facesMonths, queryFn: async () => unwrap(await api.GET("/api/stats/faces-months")) });
  const [geoMode, setGeoMode] = useState<MonthBarMode>("pct");
  const [faceMode, setFaceMode] = useState<MonthBarMode>("pct");

  // After a loop ends, everything it could have moved: counts, coverage, charts.
  const refreshStats = () => void queryClient.invalidateQueries({ queryKey: ["stats"] });

  const s = summary.data;
  const summaryError = summary.isError ? summary.error.message : null;
  const fu = facesMonths.data?.undated;

  return (
    <AppShell active="home">
      <main id="dashboard">
        <GeotagCard s={s} error={summaryError} />

        <Card id="card-library" title="Library" error={summaryError}>
          <div className="big-number">{s ? s.photos.total.toLocaleString() : "—"}</div>
          {s && <div className="sub-line">{s.photos.images.toLocaleString()} images · {s.photos.videos.toLocaleString()} videos</div>}
        </Card>

        <ReverseGeocodeCard geocode={s?.geocode} error={summaryError} onDone={refreshStats} />
        <FacesCard faces={s?.faces} error={summaryError} onDone={refreshStats} />
        <FaceCoverageCard cov={coverage.data} error={coverage.isError ? coverage.error.message : null} />

        <Card id="card-people" title="People" error={summaryError}>
          {s && <div className="stat-line">{s.people.persons.toLocaleString()} people · {s.people.families.toLocaleString()} families</div>}
          <div className="card-actions">
            <a className="button" href="/people-manage.html">⚙ Manage</a>
          </div>
        </Card>

        <Card id="card-months" title="Coverage by month" full error={months.isError ? months.error.message : null}
          headerExtra={<SegmentedToggle label="Coverage by month scale" options={MODE_OPTIONS} value={geoMode} onChange={setGeoMode} />}>
          {months.data && (
            <>
              <MonthBars months={[...months.data.months].reverse()} segments={GEO_SEGMENTS} mode={geoMode} linkPage="geocode.html" />
              <UndatedLink total={months.data.undated.total} linkPage="geocode.html" />
            </>
          )}
        </Card>

        <Card id="card-faces-months" title="Face coverage by month" full error={facesMonths.isError ? facesMonths.error.message : null}
          headerExtra={<SegmentedToggle label="Face coverage by month scale" options={MODE_OPTIONS} value={faceMode} onChange={setFaceMode} />}>
          {facesMonths.data && (
            <>
              <MonthBars months={[...facesMonths.data.months].reverse()} segments={FACE_SEGMENTS} mode={faceMode} linkPage="people.html" />
              <UndatedLink total={fu ? fu.full + fu.partial + fu.none + fu.no_faces : 0} linkPage="people.html" />
            </>
          )}
        </Card>
      </main>
    </AppShell>
  );
}
