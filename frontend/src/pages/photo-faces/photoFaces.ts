import type { Schemas } from "../../api/client";

/* Photo Faces' pure parts: the URL contract, the playlist walk and the face
 * sections. Port of web/photo-faces.js. Two modes share the page:
 *   "crowd"  — walk the /api/crowds photo list with Prev/Next (from People ▸ Crowds);
 *   "single" — one photo's faces, no playlist (from any photo preview).
 * Crowd mode is opt-in: a bare ?photo_id= link is single-photo mode. */

export type PhotoFace = Schemas["PhotoFace"];
export type PlaylistPhoto = { id: number; filename: string; unlabeled_faces: number };

export const SKIP_DONE_LS_KEY = "geotagger.photoFaces.skipCompleted.v1";

/** An integer query param, or null when absent / not a number. */
function intParam(params: URLSearchParams, key: string): number | null {
  const v = parseInt(params.get(key) ?? "", 10);
  return Number.isFinite(v) ? v : null;
}

/** Reduce an untrusted URL (the ?back= param) to a same-origin path+query+hash,
 *  or `fallback`: guards navigating to it against javascript:/data: URLs and
 *  off-site redirects. Port of common.js safeSameOriginPath. */
export function safeSameOriginPath(raw: string | null, fallback: string, origin = window.location.origin): string {
  if (!raw) return fallback;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return fallback;
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

export type PageParams = {
  mode: "crowd" | "single";
  photoId: number;
  minFaces: number;
  groupGap: number;
  startTs: number | null;
  endTs: number | null;
  back: string;
};

export function parseParams(search: string, origin?: string): PageParams {
  const p = new URLSearchParams(search);
  const mode = p.get("mode") === "crowd" ? "crowd" : "single";
  return {
    mode,
    photoId: parseInt(p.get("photo_id") || "0", 10) || 0,
    minFaces: parseInt(p.get("min_faces") || "50", 10) || 50,
    groupGap: parseInt(p.get("group_gap") || "86400", 10) || 86400,
    startTs: intParam(p, "start_ts"),
    endTs: intParam(p, "end_ts"),
    back: safeSameOriginPath(p.get("back"), mode === "crowd" ? "/people.html" : "", origin),
  };
}

/** The crowd playlist's query: thresholds plus any People Focus window. */
export function crowdQuery(pp: Pick<PageParams, "minFaces" | "groupGap" | "startTs" | "endTs">): string {
  let q = `min_faces=${pp.minFaces}&group_gap=${pp.groupGap}`;
  if (pp.startTs != null) q += `&start_ts=${pp.startTs}`;
  if (pp.endTs != null) q += `&end_ts=${pp.endTs}`;
  return q;
}

/** The previous / next playlist index (skipping completed photos when asked), or -1. */
export function stepIndex(list: readonly PlaylistPhoto[], from: number, dir: 1 | -1, skipDone: boolean): number {
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) {
    if (!skipDone || list[i]!.unlabeled_faces > 0) return i;
  }
  return -1;
}

export function counterText(list: readonly PlaylistPhoto[], idx: number, skipDone: boolean): string {
  const total = list.length;
  if (!skipDone) return `${idx + 1} / ${total}`;
  return `${idx + 1} / ${total} · ${list.filter((p) => p.unlabeled_faces > 0).length} remaining`;
}

export type Sections = {
  tagged: PhotoFace[];
  /** Suggested faces by person, biggest group first. */
  suggested: { personId: number; name: string; faces: PhotoFace[] }[];
  unknown: PhotoFace[];
  comeBack: PhotoFace[];
  ignored: PhotoFace[];
  /** Faces neither tagged, ignored nor deferred. */
  unlabeled: number;
};

export function faceSections(faces: readonly PhotoFace[]): Sections {
  const tagged = faces.filter((f) => f.person_id != null);
  const ignored = faces.filter((f) => f.ignored);
  const comeBack = faces.filter((f) => f.come_back);
  const active = faces.filter((f) => f.person_id == null && !f.ignored && !f.come_back);
  const byPerson = new Map<number, { personId: number; name: string; faces: PhotoFace[] }>();
  const unknown: PhotoFace[] = [];
  for (const f of active) {
    if (f.suggestion) {
      const pid = f.suggestion.person_id;
      let g = byPerson.get(pid);
      if (!g) { g = { personId: pid, name: f.suggestion.person_name ?? "", faces: [] }; byPerson.set(pid, g); }
      g.faces.push(f);
    } else unknown.push(f);
  }
  const suggested = [...byPerson.values()].sort((a, b) => b.faces.length - a.faces.length);
  return { tagged, suggested, unknown, comeBack, ignored, unlabeled: active.length };
}

export function sectionsStatus(s: Sections): string {
  return s.unlabeled === 0
    ? `✓ Done — ${s.tagged.length} tagged, ${s.ignored.length} ignored.`
    : `${s.tagged.length} tagged · ${s.unlabeled} unlabeled · ${s.comeBack.length} come back · ${s.ignored.length} ignored`;
}

/** The bbox state class: tagged / ignored / come-back / suggested / unknown. */
export function boxKind(f: PhotoFace): "tagged" | "ignored" | "come-back" | "suggested" | "unknown" {
  if (f.person_id != null) return "tagged";
  if (f.ignored) return "ignored";
  if (f.come_back) return "come-back";
  return f.suggestion ? "suggested" : "unknown";
}

/** A drag from (sx, sy) to (cx, cy) in overlay fractions, as a normalized box;
 *  null for a click rather than a drag (never a 1px face). */
export function dragBox(sx: number, sy: number, cx: number, cy: number): [number, number, number, number] | null {
  const box: [number, number, number, number] = [Math.min(sx, cx), Math.min(sy, cy), Math.max(sx, cx), Math.max(sy, cy)];
  return box[2] - box[0] < 0.01 || box[3] - box[1] < 0.01 ? null : box;
}
