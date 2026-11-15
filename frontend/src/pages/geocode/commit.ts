import type { Schemas } from "../../api/client";
import type { DropEntry, Photo, Snapshot, StagedGroup } from "./staging";
import { pointKey } from "./staging";

/* Commit and undo, minus the network: what calls a commit makes, how their
 * replies fold back into the loaded photos, and the status lines. Port of
 * app.js commitGroups / geotag / removeGeotag / setGeocodeIgnored /
 * undoLastCommit. The page supplies the transport (CommitApi). */

export type BatchReply = Schemas["GeotagBatchResponse"];
export type GeotagResult = Schemas["GeotagResult"];
export type IgnoreReply = Schemas["IgnoreResponse"];

export type CommitCall =
  | { kind: "ignore"; label: string; ids: number[] }
  | { kind: "remove"; label: string; ids: number[] }
  | { kind: "geotag"; label: string; ids: number[]; lat: number; lng: number; accuracy: number | null };

/** The requests a commit of `groups` makes, in order. The no-location group
 *  writes a flag, not a coordinate — one call for all of it; removals one call
 *  per group; photos in one place group can come from several drops, so one
 *  /api/geotag call per distinct point. */
export function commitPlan(groups: readonly StagedGroup[]): CommitCall[] {
  const calls: CommitCall[] = [];
  for (const g of groups) {
    const ids = g.entries.map((e) => e.id);
    if (g.kind === "ignore") { calls.push({ kind: "ignore", label: g.label, ids }); continue; }
    if (g.kind === "remove") { calls.push({ kind: "remove", label: g.label, ids }); continue; }
    const byPoint = new Map<string, Extract<CommitCall, { kind: "geotag" }>>();
    (g.entries as DropEntry[]).forEach((e) => {
      const k = pointKey(e);
      let p = byPoint.get(k);
      if (!p) {
        p = { kind: "geotag", label: g.label, ids: [], lat: e.lat, lng: e.lng, accuracy: e.accuracy };
        byPoint.set(k, p);
      }
      p.ids.push(e.id);
    });
    calls.push(...byPoint.values());
  }
  return calls;
}

/** "2 failed: <first reason>" for the status line, or "" when everything landed. */
export function batchProblems(out: BatchReply): string {
  const bad = out.failed.length + out.not_found.length;
  if (!bad) return "";
  const first = out.failed.length ? out.failed[0]!.error : "photo not found";
  return `${bad} failed: ${first}`;
}

export type CommitApi = {
  /** Each resolves to the {results, written, failed, not_found} breakdown (the
   *  server sends it under 502/404 too when nothing at all was written) and
   *  throws when the request itself failed. */
  geotag: (ids: number[], lat: number, lng: number, accuracy: number | null) => Promise<BatchReply>;
  remove: (ids: number[]) => Promise<BatchReply>;
  ignore: (ids: number[], ignored: boolean) => Promise<IgnoreReply>;
};

export type PhotoPatch = Partial<Pick<Photo, "lat" | "lng" | "geotag_source" | "gps_accuracy" | "geocode_ignored" | "location">>;

export type CommitOutcome = {
  saved: number;
  total: number;
  /** "<group> (<what>) — <why>" for every call that didn't fully land. */
  failures: string[];
  /** Every landed write's undo snapshot, so the whole commit — all its groups
   *  and points — can be taken back in one go. */
  snapshots: Snapshot[];
  /** Ids that landed; only these leave the staging area. */
  landed: number[];
  patches: Map<number, PhotoPatch>;
  /** Committed points — the location picker's Recent list from here on. */
  recents: { lat: number; lng: number; accuracy: number | null; label: string }[];
};

export async function runCommit(groups: readonly StagedGroup[], api: CommitApi,
  onProgress: (msg: string) => void = () => {}): Promise<CommitOutcome> {
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  const out: CommitOutcome = { saved: 0, total, failures: [], snapshots: [], landed: [], patches: new Map(), recents: [] };
  const keep = (results: readonly { previous?: Snapshot | null }[] | undefined) =>
    (results ?? []).forEach((r) => { if (r.previous) out.snapshots.push(r.previous); });
  const land = (ids: readonly number[], patch: PhotoPatch | ((id: number) => PhotoPatch)) => {
    ids.forEach((id) => {
      out.landed.push(id);
      out.patches.set(id, { ...out.patches.get(id), ...(typeof patch === "function" ? patch(id) : patch) });
    });
    out.saved += ids.length;
  };

  for (const call of commitPlan(groups)) {
    if (call.kind === "ignore") {
      // No Recent entry: "needs no location" isn't a place anyone will reuse.
      try {
        const reply = await api.ignore(call.ids, true);
        land(call.ids, { geocode_ignored: true });
        keep(reply.results);
      } catch (e) {
        out.failures.push(`${call.label} (${call.ids.length} photo(s)) — ${(e as Error).message}`);
      }
      continue;
    }
    if (call.kind === "remove") {
      onProgress(`Removing the location from ${call.ids.length} photo(s)…`);
      let reply: BatchReply;
      try {
        reply = await api.remove(call.ids);
      } catch (e) {
        out.failures.push(`${call.label} (${call.ids.length} photo(s)) — ${(e as Error).message}`);
        continue;
      }
      // Only photos the server actually cleared lose their pin; failed ones keep it
      // and stay staged.
      land(reply.written, { lat: null, lng: null, geotag_source: "none", gps_accuracy: null, location: null });
      keep(reply.results);
      if (reply.written.length < call.ids.length) {
        const why = batchProblems(reply);
        out.failures.push(`${call.label} (${call.ids.length - reply.written.length} photo(s))` + (why ? ` — ${why}` : ""));
      }
      continue;
    }
    onProgress(`Geotagging ${call.ids.length} photo(s)…`);
    let reply: BatchReply;
    try {
      reply = await api.geotag(call.ids, call.lat, call.lng, call.accuracy);
    } catch (e) {
      out.failures.push(`${call.label} (${call.lat.toFixed(4)}, ${call.lng.toFixed(4)}) — ${(e as Error).message}`);
      continue;
    }
    const byId = new Map(reply.results.map((r) => [r.id, r]));
    land(reply.written, (id) => {
      const r = byId.get(id);
      return { lat: r?.lat ?? call.lat, lng: r?.lng ?? call.lng, geotag_source: r?.geotag_source ?? null, gps_accuracy: r?.gps_accuracy ?? null };
    });
    keep(reply.results);
    // A committed point is a location the user demonstrably uses.
    if (reply.written.length) out.recents.push({ lat: call.lat, lng: call.lng, accuracy: call.accuracy, label: call.label });
    if (reply.written.length < call.ids.length) {
      const why = batchProblems(reply);
      out.failures.push(`${call.label} (${call.lat.toFixed(4)}, ${call.lng.toFixed(4)})` + (why ? ` — ${why}` : ""));
    }
  }
  return out;
}

export function commitSummary(o: CommitOutcome): { message: string; isError: boolean } {
  if (o.failures.length) {
    return { message: `Committed ${o.saved} of ${o.total} change(s). Still staged after failing: ${o.failures.join(", ")}.`, isError: true };
  }
  return { message: `Committed ${o.saved} change(s).`, isError: false };
}

/** A new photos array with `patches` applied; untouched photos keep their
 *  identity so memoised cells don't re-render. */
export function patchPhotos(photos: readonly Photo[], patches: ReadonlyMap<number, PhotoPatch>): Photo[] {
  if (!patches.size) return photos as Photo[];
  return photos.map((p) => {
    const patch = patches.get(p.id);
    return patch ? { ...p, ...patch } : p;
  });
}

/** Undo results → patches. `location` only when the undo restored a geotag (the
 *  server leaves it out of an ignore-only undo). */
export function undoPatches(results: readonly GeotagResult[]): Map<number, PhotoPatch> {
  const out = new Map<number, PhotoPatch>();
  results.forEach((r) => {
    const patch: PhotoPatch = {
      lat: r.lat ?? null, lng: r.lng ?? null, geotag_source: r.geotag_source ?? null,
      gps_accuracy: r.gps_accuracy ?? null, geocode_ignored: !!r.geocode_ignored,
    };
    if ("location" in r) {
      const loc = r.location;
      patch.location = loc ? { city: loc.city ?? null, sublocation: loc.sublocation ?? null, state: loc.state ?? null, country: loc.country ?? null } : null;
    }
    out.set(r.id, patch);
  });
  return out;
}

/** What's left to retry after an undo, and the status line. A photo changed
 *  since the commit (conflict) or deleted (not_found) would just fail the same
 *  way again, so only the other failures are kept. */
export function undoOutcome(snaps: readonly Snapshot[], out: BatchReply, nameOf: (id: number) => string | undefined): {
  retry: Snapshot[]; message: string; isError: boolean;
} {
  const retryIds = new Set(out.failed.filter((f) => !f.conflict).map((f) => f.id));
  const retry = snaps.filter((s) => retryIds.has(s.id));
  const bad = out.failed.length + out.not_found.length;
  if (!bad) return { retry, message: `Undid the last commit: ${out.written.length} photo(s) restored.`, isError: false };
  const name = (id: number) => nameOf(id) || `photo #${id}`;
  const lines = out.failed.map((f) => `${name(f.id)} (${f.error})`)
    .concat(out.not_found.map((id) => `${name(id)} (no longer in the library)`));
  const shown = lines.slice(0, 5).join(", ") + (lines.length > 5 ? `, +${lines.length - 5} more` : "");
  return {
    retry,
    message: `Undid ${out.written.length} of ${snaps.length} photo(s); not restored: ${shown}.` +
      (retryIds.size ? " Undo again to retry the failed ones." : ""),
    isError: true,
  };
}
