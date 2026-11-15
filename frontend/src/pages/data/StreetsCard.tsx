import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Polyline, Tooltip } from "react-leaflet";
import { latLngBounds, type Map as LeafletMap } from "leaflet";
import { acceptStarted, api, getJson, unwrap, type Schemas } from "../../api/client";
import { fmtBytes, plural } from "../../lib/format";
import { useJob } from "../../lib/useJob";
import { MapView, cssVar } from "../../map/MapView";
import { DataCard, FileStatusList, JobLines } from "./parts";
import { groupStreets, unionBounds, type StreetGroup } from "./streets";

/* Street search: streets live in no database (see osm_streets.py); a search
 * streams the cached .osm.pbf extracts for roads crossing the visible map, which
 * takes seconds to a minute, so it's a start-and-poll job like the downloads. */

export const STREETS_STATUS_KEY = ["streets-status"] as const;

type PhotoBounds = { has_data: boolean; min_lat?: number; max_lat?: number; min_lng?: number; max_lng?: number };

export function StreetsCard() {
  const status = useQuery({
    queryKey: STREETS_STATUS_KEY,
    queryFn: async () => unwrap(await api.GET("/api/data/streets/status")),
  });
  const s = status.data;
  // State, not a ref: the effects below must re-run once Leaflet has created the map.
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [query, setQuery] = useState("");
  const [includePaths, setIncludePaths] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [groups, setGroups] = useState<StreetGroup[]>([]);
  const [active, setActive] = useState<number | null>(null);

  const job = useJob<Schemas["StreetSearchJob"]>("/api/data/streets/search/status", {
    intervalMs: 800,
    onFinished: (j) => {
      if (!j.done) return;
      setGroups(groupStreets(j.result?.streets ?? []));
      setActive(null);
    },
  });

  // Open on something searchable: the cached extracts' extents, the only areas a
  // search can return anything for; failing that, the library's photo bounds.
  const fitted = useRef(false);
  useEffect(() => {
    if (!s || !map || fitted.current) return;
    fitted.current = true;
    const extracts = unionBounds(s.files.flatMap((f) => (f.bbox ? [f.bbox] : [])));
    if (extracts) {
      map.fitBounds(extracts, { padding: [20, 20] });
      return;
    }
    getJson<PhotoBounds>("/api/stats/bounds")
      .then((b) => {
        if (b.has_data) map.fitBounds([[b.min_lat!, b.min_lng!], [b.max_lat!, b.max_lng!]], { padding: [20, 20] });
      })
      .catch(() => { /* keep the default view */ });
  }, [s, map]);

  // Fit to the results when they arrive, or to the focused street.
  useEffect(() => {
    const ways = active === null ? groups.flatMap((g) => g.ways) : (groups[active]?.ways ?? []);
    if (!map || !ways.length) return;
    map.fitBounds(latLngBounds(ways.flatMap((w) => w.coords)).pad(active === null ? 0.15 : 0.25));
  }, [groups, active, map]);

  async function search() {
    setStartError(null);
    const q = query.trim();
    if (q.length < 2) {
      setStartError("Type at least 2 characters to search.");
      return;
    }
    if (!map) return;
    const b = map.getBounds();
    try {
      acceptStarted(await api.POST("/api/data/streets/search", {
        body: { bbox: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`, query: q, include_paths: includePaths },
      }));
      job.watch();
    } catch (e) {
      setStartError((e as Error).message);
    }
  }

  const colors = useMemo(() => ({ line: cssVar("--gold", "#e0a040"), focus: cssVar("--accent-text", "#7ab8f5") }), []);

  return (
    <DataCard id="card-streets" title="Street search (roads & lines)" help={<>
      Streets are <em>not</em> stored in any database — there are far too many of them to be worth
      it for reverse geocoding. Instead this searches the raw <code>.osm.pbf</code> downloads still
      sitting in the cache, live, and draws what it finds on the map below. Pan/zoom to the area you
      care about, type part of a street name or route number, and search: only roads passing through
      the visible map area are returned. If the raw downloads have been deleted, this stops working
      until a region is re-downloaded.
    </>}>
      {s && (
        <FileStatusList rows={s.available
          ? [
            { label: "Raw OSM extracts", ok: true, value: `${s.files.length} cached, ${fmtBytes(s.total_size)}` },
            ...s.files.map((f) => ({ label: f.label, value: fmtBytes(f.size), sub: true })),
          ]
          : [
            { label: "Raw OSM extracts", ok: false, value: "none cached — street search unavailable" },
            { label: `Expected in ${s.cache_dir}`, value: "", sub: true },
          ]} />
      )}
      <form className="streets-controls" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input
          type="text" id="streets-query" aria-label="Street name or route number"
          placeholder="Street name or route number…" autoComplete="off" spellCheck={false}
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={!s?.available || job.running}>Search this map area</button>
      </form>
      <label className="force-label">
        <input type="checkbox" id="streets-paths" checked={includePaths} onChange={(e) => setIncludePaths(e.target.checked)} />
        Include trails, paths &amp; sidewalks
      </label>
      <MapView id="streets-map" mapRef={setMap}>
        {groups.map((g, gi) => g.ways.map((w, wi) => (
          <Polyline
            key={`${gi}-${wi}-${active === gi}`}
            positions={w.coords}
            pathOptions={active === null || active === gi
              ? { color: active === gi ? colors.focus : colors.line, weight: active === gi ? 6 : 4, opacity: active === gi ? 1 : 0.85 }
              : { color: colors.line, weight: 4, opacity: 0.35 }}
          >
            <Tooltip sticky>{w.name}{w.highway ? ` · ${w.highway}` : ""}</Tooltip>
          </Polyline>
        )))}
      </MapView>
      {groups.length > 0 && (
        <ul className="streets-results" aria-label="Matching streets">
          {groups.map((g, i) => (
            <li key={g.key}>
              <button type="button" className={`street-row${active === i ? " active" : ""}`} aria-pressed={active === i} onClick={() => setActive(i)}>
                <span>{g.key}</span>
                <span className="street-meta">{plural(g.ways.length, "segment")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <JobLines message={job.message} error={startError ?? job.error ?? job.retrying ?? (status.isError ? status.error.message : null)} />
    </DataCard>
  );
}
