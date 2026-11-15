import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { acceptStarted, api, type Schemas } from "../../api/client";
import { useJob } from "../../lib/useJob";
import { DATA_STATUS_KEY } from "./cards";
import { DataCard, FileStatusList, JobControls } from "./parts";
import { STREETS_STATUS_KEY } from "./StreetsCard";

/* OSM place polygons: pick GeoFabrik regions (grouped: US states, countries…),
 * download + merge. Selection survives switching the region group. */

export function OsmCard({ status: o }: { status: Schemas["OsmStatus"] | undefined }) {
  const queryClient = useQueryClient();
  const [activeGroup, setActiveGroup] = useState("us");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const job = useJob("/api/data/osm/download/status", {
    intervalMs: 2000,
    onFinished: () => {
      void queryClient.invalidateQueries({ queryKey: DATA_STATUS_KEY });
      // The merge just cached a fresh .osm.pbf, a newly searchable region.
      void queryClient.invalidateQueries({ queryKey: STREETS_STATUS_KEY });
    },
  });

  const groups = o?.groups ?? [];
  const group = groups.find((g) => g.group === activeGroup) ?? groups[0];
  const ingested = new Set(o?.ingested_keys ?? []);

  function regionName(key: string): string {
    for (const g of groups) {
      const item = g.items.find((i) => i.key === key);
      if (item) return item.name;
    }
    return key;
  }

  function toggle(key: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <DataCard id="card-osm" title="OSM places (city / park / venue polygons)" help={
      "Named place polygons from OpenStreetMap (via GeoFabrik state extracts), merged into one " +
      "local database. Adding a state downloads its extract and appends its places to whatever's " +
      "already there — safe to add states incrementally as your library grows."
    }>
      {o && (
        <FileStatusList rows={[
          { label: "Places DB", ok: o.available, value: o.available ? `${o.places.toLocaleString()} total` : "not built yet" },
          ...Object.entries(o.by_category).map(([category, n]) => ({ label: category, value: n.toLocaleString(), sub: true })),
        ]} />
      )}
      <label className="osm-group-label" htmlFor="osm-group-select">Region:</label>
      <select id="osm-group-select" value={group?.group ?? ""} onChange={(e) => setActiveGroup(e.target.value)}>
        {groups.map((g) => <option key={g.group} value={g.group}>{g.label}</option>)}
      </select>
      {group && (
        <fieldset id="osm-state-picker" aria-label={`${group.label} regions`}>
          {group.items.map(({ key, name }) => {
            const loaded = ingested.has(key);
            return (
              <label key={key} className={loaded ? "state-loaded" : undefined} title={loaded ? "Already merged" : undefined}>
                <input type="checkbox" checked={selected.has(key)} onChange={(e) => toggle(key, e.target.checked)} />
                {name}{loaded ? " ✓" : ""}
              </label>
            );
          })}
        </fieldset>
      )}
      <JobControls
        id="osm" job={job}
        startLabel="Download & merge selected"
        validate={() => (selected.size ? null : "Select at least one region.")}
        forceWarning={() =>
          `This discards the locally cached download for ${[...selected].map(regionName).join(", ")} ` +
          "and re-fetches it from GeoFabrik."}
        start={async (force) =>
          acceptStarted(await api.POST("/api/data/osm/download", { body: { regions: [...selected], force } }))}
      />
    </DataCard>
  );
}
