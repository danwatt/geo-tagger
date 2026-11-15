import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client";
import { AppShell } from "../../shell/AppShell";
import { BackupCard, CensusCard, DATA_STATUS_KEY, FaceModelCard, GeonamesCard } from "./cards";
import { OsmCard } from "./OsmCard";
import { SemanticCard } from "./SemanticCard";
import { StreetsCard } from "./StreetsCard";
import "./data.css";

export function DataPage() {
  const status = useQuery({
    queryKey: DATA_STATUS_KEY,
    queryFn: async () => unwrap(await api.GET("/api/data/status")),
  });
  const d = status.data;

  return (
    <AppShell active="data">
      <main id="data-page">
        <p className="data-intro">
          Offline reference datasets used for reverse geocoding. Downloads pull from the public
          GeoNames / GeoFabrik / US Census servers and can take a while — the page keeps polling
          while a download runs, so it's safe to leave this tab and come back.
        </p>
        {status.isError && (
          <div className="data-error" role="alert">Couldn't load dataset status: {status.error.message}</div>
        )}
        <BackupCard />
        <GeonamesCard status={d?.geonames} />
        <CensusCard status={d?.census} />
        <FaceModelCard status={d?.face_model} />
        <SemanticCard status={d?.semantic_model} />
        <OsmCard status={d?.osm} />
        <StreetsCard />
      </main>
    </AppShell>
  );
}
