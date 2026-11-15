import { locationLabel, type Face, type GroupSort } from "../../faces/faceGrid";
import { MONTH_NAMES } from "../../lib/format";
import { wallClockParts } from "../../lib/wallClock";
import {
  computeBatches, computeMonthLocationGroups, computeTimeGroups, computeUnlabeledDirGroups, computeUnlabeledPersonGroups,
  computeUnlabeledPhotoGroups, facesDateRange, formatGroupRange, formatRelativeTime, personRuns, photoCountLabel,
  shortDirPath, sortFaceGroups, type RunRank,
} from "./grouping";

/* What the main People grid draws for a scope, as data: dividers, group
 * sections (with what their header says and offers) and loose cells — plus
 * `order`, every face in the order its cell appears, which shift-click ranges
 * and j/k navigation walk. Port of people-grid.js renderGridInner and the
 * people-cells.js renderers, minus the DOM. */

export type Scope = "unlabeled" | "discover" | "crowds" | "recent" | "all" | "ignored" | "come_back" | "person" | "suggested";
export type Hierarchy = "date" | "person" | "photo" | "directory";
export const HIERARCHIES: readonly Hierarchy[] = ["date", "person", "photo", "directory"];

export const FLAT_GRID_SCOPES: ReadonlySet<Scope> = new Set(["unlabeled", "all", "person", "suggested", "ignored", "come_back", "recent"]);
export const isFlatGridScope = (s: Scope) => FLAT_GRID_SCOPES.has(s);

export type HeaderSpec =
  /** A section of faces: Accept all / Select all / Select only / Deselect all /
   *  Ignore. `ignoreAll`: Ignore takes the whole group (Unlabeled) rather than
   *  just its selected faces (guesses). `openPhotoId` adds "Open photo". */
  | { kind: "group"; title: string; meta: string; label: string; ignoreAll: boolean; openPhotoId?: number }
  | { kind: "ignore-batch"; title: string; meta: string }
  | { kind: "come-back-batch"; title: string; meta: string }
  | { kind: "tag-batch"; title: string; meta: string; who: string };

export type GridItem =
  | { type: "divider"; level: "year" | "month"; text: string; key: string }
  | { type: "person-header"; count: number; key: string }
  | { type: "group"; key: string; index: number; header: HeaderSpec; faces: Face[]; runs: Face[][] | null }
  | { type: "cells"; key: string; faces: Face[] };

export type GridModel = { items: GridItem[]; order: Face[] };

export type GridInput = {
  scope: Scope;
  /** The faces the grid shows (staged ones already left out). */
  list: readonly Face[];
  hierarchy: Hierarchy;
  sort: GroupSort;
  gapSeconds: number;
  rank?: RunRank;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function buildGridModel({ scope, list, hierarchy, sort, gapSeconds, rank }: GridInput): GridModel {
  const items: GridItem[] = [];
  const order: Face[] = [];
  let gi = 0;
  const group = (header: HeaderSpec, faces: Face[], runs = false) => {
    order.push(...faces);
    items.push({ type: "group", key: `g${gi}`, index: gi, header, faces, runs: runs ? personRuns(faces) : null });
    gi++;
  };
  // Year/month dividers read correctly only while groups are chronological, so
  // only the Date sort draws them (each header still carries its own range).
  const dividers = () => {
    let curYear: number | null | undefined, curMonth: number | null | undefined;
    return (year: number | null, month: number | null) => {
      if (sort !== "date") return;
      if (year !== curYear) {
        curYear = year; curMonth = undefined;
        items.push({ type: "divider", level: "year", text: year === null ? "Undated" : String(year), key: `y${items.length}` });
      }
      if (month !== curMonth) {
        curMonth = month;
        if (month !== null) items.push({ type: "divider", level: "month", text: MONTH_NAMES[month]!, key: `m${items.length}` });
      }
    };
  };

  if (scope === "suggested") {
    for (const g of sortFaceGroups(computeTimeGroups(list, gapSeconds), sort)) {
      const place = locationLabel(g.faces);
      const title = formatGroupRange(g);
      group({ kind: "group", title, label: title, ignoreAll: false,
        meta: `· ${photoCountLabel(g.faces)}` + (place ? ` · 📍 ${place}` : "") }, g.faces);
    }
  } else if (scope === "ignored" || scope === "come_back") {
    const ignored = scope === "ignored";
    for (const b of computeBatches(list, (f) => (ignored ? f.ignored_at : f.come_back_at))) {
      const when = b.ts ? formatRelativeTime(b.ts) : ignored ? "before tracking" : "unknown time";
      group({ kind: ignored ? "ignore-batch" : "come-back-batch", title: `${ignored ? "Ignored" : "Come back"} ${when}`,
        meta: `· ${b.faces.length} face(s)` }, b.faces);
    }
  } else if (scope === "recent") {
    for (const b of computeBatches(list, (f) => f.assigned_at)) {
      const names = [...new Set(b.faces.map((f) => f.person_name).filter((n): n is string => !!n))];
      const who = names.length === 1 ? names[0]! : names.length === 2 ? names.join(" & ") : `${names.length} people`;
      group({ kind: "tag-batch", title: who, who, meta: `· ${formatRelativeTime(b.ts)} · ${b.faces.length} face(s)` }, b.faces);
    }
  } else if (scope === "unlabeled" && hierarchy === "person") {
    for (const person of computeUnlabeledPersonGroups(list)) {
      items.push({ type: "divider", level: "year", text: person.name || `No suggestion (${person.faces.length})`, key: `p${items.length}` });
      for (const chunk of person.chunks) {
        const place = locationLabel(chunk.faces);
        const range = formatGroupRange(chunk);
        group({ kind: "group", title: range, meta: place ? `· 📍 ${place}` : "",
          label: `${person.name || "unlabeled faces"} · ${range}`, ignoreAll: true }, chunk.faces);
      }
    }
  } else if (scope === "unlabeled" && hierarchy === "photo") {
    const div = dividers();
    for (const g of sortFaceGroups(computeUnlabeledPhotoGroups(list, rank), sort)) {
      div(g.year, g.month);
      const place = locationLabel(g.faces);
      group({ kind: "group", title: `🖼 ${g.filename}`, label: g.filename, ignoreAll: true, openPhotoId: g.photoId,
        meta: `· ${facesDateRange(g.faces)} · ${plural(g.faces.length, "face")}` + (place ? ` · 📍 ${place}` : "") }, g.faces);
    }
  } else if (scope === "unlabeled" && hierarchy === "directory") {
    // No dividers: a scanned folder routinely spans decades.
    for (const g of sortFaceGroups(computeUnlabeledDirGroups(list, rank), sort)) {
      const place = locationLabel(g.faces);
      group({ kind: "group", title: `📁 ${shortDirPath(g.dir)}`, label: g.name, ignoreAll: true,
        meta: `· ${facesDateRange(g.faces)} · ${photoCountLabel(g.faces)} · ${plural(g.faces.length, "face")}` +
          (place ? ` · 📍 ${place}` : "") }, g.faces, true);
    }
  } else if (scope === "unlabeled") {
    const div = dividers();
    for (const g of sortFaceGroups(computeMonthLocationGroups(list, rank), sort)) {
      div(g.year, g.month);
      group({ kind: "group", title: g.place ? `📍 ${g.place}` : g.dir ? `📁 ${g.dir}` : "No location",
        label: g.place || g.dir || "No location", ignoreAll: true,
        meta: `· ${facesDateRange(g.faces)} · ${photoCountLabel(g.faces)}` }, g.faces, true);
    }
  } else if (scope === "person") {
    // An action bar to hunt for more of this person, then year/month dividers
    // between loose cells (no per-month actions).
    items.push({ type: "person-header", count: list.length, key: "ph" });
    let curYear: number | null = null, curMonth: number | null = null;
    let run: Face[] = [];
    const flush = () => { if (run.length) items.push({ type: "cells", key: `c${items.length}`, faces: run }); run = []; };
    for (const f of list) {
      const p = wallClockParts(f.photo_datetime);
      if (p) {
        if (p.year !== curYear) {
          flush();
          curYear = p.year; curMonth = p.month;
          items.push({ type: "divider", level: "year", text: String(p.year), key: `y${items.length}` });
        } else if (p.month !== curMonth) {
          flush();
          curMonth = p.month;
          items.push({ type: "divider", level: "month", text: MONTH_NAMES[p.month]!, key: `m${items.length}` });
        }
      }
      run.push(f);
      order.push(f);
    }
    flush();
  } else {
    order.push(...list);
    if (list.length) items.push({ type: "cells", key: "all", faces: list.slice() });
  }
  return { items, order };
}
