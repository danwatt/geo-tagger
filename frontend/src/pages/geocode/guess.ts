import type { Schemas } from "../../api/client";

/* "Guess location" (time-neighbour guess): the display side — the source pins'
 * colours and the summary line. Port of app.js doGuess / makeSourcePinIcon. */

export type Guess = Schemas["GuessResponse"];
export type GuessSource = Schemas["GuessSource"];

export function formatDelta(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}min`;
}

/** Source pins: before = blue family, after = green; vivid and larger when close
 *  in time, muted at the edge of the window. */
export function sourcePinStyle(deltaSec: number, isBefore: boolean, windowSec = 900): { fill: string; stroke: string; r: number; size: number } {
  // proximity 1 = very close in time, 0 = at the edge of the window
  const ratio = deltaSec / windowSec;
  const proximity = Number.isFinite(ratio) ? Math.max(0, 1 - ratio) : 0.5;
  const hue = isBefore ? 210 : 145;
  const sat = Math.round(40 + proximity * 55);   // 40% → 95%
  const lit = Math.round(28 + proximity * 38);   // 28% → 66%
  const r = Math.round(7 + proximity * 4);       // 7–11px radius
  return {
    fill: `hsl(${hue},${sat}%,${lit}%)`,
    stroke: `hsl(${hue},${Math.max(20, sat - 20)}%,${Math.min(90, lit + 25)}%)`,
    r,
    size: (r + 3) * 2,
  };
}

export function guessSummary(g: Guess): string {
  const list = g.sources.slice(0, 3)
    .map((s) => `${s.filename} (${formatDelta(s.delta_sec)} ${s.is_before ? "before" : "after"})`)
    .join(", ");
  const more = g.source_count > 3 ? ` +${g.source_count - 3} more` : "";
  return `Based on ${g.source_count} nearby photo${g.source_count > 1 ? "s" : ""}: ${list}${more}`;
}

/** "±0.25 miles (~0.4 km)" / "±12.0 m" / "—". */
export function formatAccuracy(meters: number | null | undefined): string {
  if (meters == null || meters <= 0) return "—";
  if (meters >= 160.934) {
    const trim = (n: number) => {
      const s = n.toFixed(2);
      return s.endsWith(".00") ? n.toFixed(0) : s.endsWith("0") ? n.toFixed(1) : s;
    };
    return `±${trim(meters / 1609.344)} miles (~${trim(meters / 1000)} km)`;
  }
  return `±${meters.toFixed(1)} m`;
}
