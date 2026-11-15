import { useEffect, useRef } from "react";
import { api, getJson, unwrap } from "../../api/client";
import { parseScopeUrl, type ScopeDef } from "./scope";
import type { Photo } from "./staging";
import type { BatchFlow } from "./useBatchFlow";
import type { MapHandle } from "./useMapHandle";
import type { Staging } from "./useStaging";

/* The page's start-up sequence, in the legacy order: the ExifTool check, the
 * map fitted to the whole library, then the staged work kept from before a
 * reload or crash (U7) — before any scope loads, because restored photos sit
 * in the staging area whatever scope is picked, and a batch or ?ids= scope
 * then leaves them out of its selection — and last the URL's scope. */

/** GET /api/photos?ids=… in URL-sized chunks (a restored staging area can hold
 *  thousands of ids). Ids that no longer exist are simply absent. */
export async function fetchPhotosByIds(ids: number[], chunk = 400): Promise<Photo[]> {
  const out: Photo[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    out.push(...await getJson<Photo[]>(`/api/photos?ids=${ids.slice(i, i + chunk).join(",")}`));
  }
  return out;
}

export type Restored = { ids: number[]; detail: string };

export function useStartup({ map, staging, batch, load, say, onRestored }: {
  map: MapHandle;
  staging: Staging;
  batch: BatchFlow;
  load: (def: ScopeDef, opts?: { fitMap?: boolean }) => Promise<unknown>;
  say: (msg: string, isError?: boolean) => void;
  onRestored: (r: Restored) => void;
}) {
  const started = useRef(false);
  const deps = useRef({ map, staging, batch, load, say, onRestored });
  deps.current = { map, staging, batch, load, say, onRestored };

  useEffect(() => {
    // Once per page: StrictMode's second mount must not restore or load twice.
    if (started.current) return;
    started.current = true;
    const d = deps.current;
    void (async () => {
      try {
        const st = unwrap(await api.GET("/api/status"));
        if (!st.exiftool.available) {
          d.say("⚠ ExifTool not found — run: uv run python scripts/get_exiftool.py  |  " + (st.exiftool.reason ?? ""), true);
        }
      } catch { /* server not yet ready, or an error that isn't "ExifTool missing" */ }

      try {
        const b = unwrap(await api.GET("/api/stats/bounds"));
        if (b.has_data && b.min_lat != null && b.min_lng != null && b.max_lat != null && b.max_lng != null) {
          d.map.run((m) => m.fitBounds([[b.min_lat!, b.min_lng!], [b.max_lat!, b.max_lng!]], { padding: [40, 40], maxZoom: 14 }));
        }
      } catch { /* keep the world view */ }

      const r = await d.staging.restore(fetchPhotosByIds);
      if (r?.failed !== undefined) {
        d.say(`Couldn't check the ${r.total} staged change(s) kept from your last visit (${r.failed}). They're kept for the next reload.`, true);
      } else if (r) {
        const dropped: string[] = [];
        if (r.gone) dropped.push(`${r.gone} photo(s) no longer exist`);
        if (r.applied) dropped.push(`${r.applied} already saved`);
        const droppedNote = dropped.length ? `Dropped: ${dropped.join(", ")}.` : "";
        if (!r.entries.length) {
          d.say(`Nothing left to restore from your last visit. ${droppedNote}`);
        } else {
          const notes: string[] = [];
          if (r.changed) notes.push(`${r.changed} changed elsewhere since; committing overwrites that.`);
          if (droppedNote) notes.push(droppedNote);
          d.onRestored({ ids: r.entries.map((e) => e.id), detail: notes.join(" ") });
          d.say(`Restored ${r.entries.length} staged change(s) from your last visit — review them in the staging area. Nothing is saved until you Commit.`);
        }
      }

      const url = parseScopeUrl(window.location.search);
      switch (url.kind) {
        case "batch": await d.batch.enter(url.id); break;
        case "handoff-missing":
          d.say("That Search selection is no longer available in this tab — open it from Search again.", true);
          break;
        case "ids": await d.load({ kind: "ids", ids: url.ids, label: `${url.ids.length.toLocaleString()} photo(s) from Search` }); break;
        case "month": await d.load({ kind: "month", year: url.year, month: url.month }, { fitMap: true }); break;
        case "undated": await d.load({ kind: "undated" }, { fitMap: true }); break;
        case "none":
          // Don't paint over a restore or ExifTool message.
          if (!d.staging.ref.current.size) d.say("Click 'Select Month' to begin");
          break;
      }
    })();
  }, []);
}
