import { useCallback, useEffect, useRef, useState } from "react";
import { formatWallClockDate } from "../lib/wallClock";
import { cssVar } from "../lib/cssVar";
import "./TimelineHistogram.css";

/* A result set's timeline: a canvas histogram of photo dates with two range
 * sliders that narrow which of the photos are shown. Port of search.js's
 * timeline (a simplified version of the geocode page's): single-colour bars,
 * since search results aren't camera-grouped.
 *
 * The caller supplies the buckets (Search gets them from the server, for every
 * match rather than just the loaded page) and owns what the range filters. The
 * sliders are this component's state: give it a fresh `key` with each new
 * histogram and they start at the full span again. */

export type Histogram = { min: number; max: number; bucket_secs: number; counts: number[] };
export type TimeRange = { lo: number; hi: number };

const STEPS = 1000;
const DAY = 86400;

/** A slider position (0..STEPS) as a wall-clock timestamp across [min, max]. */
export function sliderToTs(v: number, h: Pick<Histogram, "min" | "max">): number {
  return Math.round(h.min + (v / STEPS) * (h.max - h.min));
}

/** True while `range` excludes part of the histogram's span. */
export function timelineNarrowed(h: Histogram | null, range: TimeRange | null): boolean {
  return !!h && !!range && h.counts.length > 0 && (range.lo > h.min || range.hi < h.max);
}

/** The photos inside the range; undated photos always pass (they have no place
 *  on the timeline, and hiding them would lose them). */
export function inTimelineRange<T extends { photo_datetime?: number | null }>(photos: T[], h: Histogram | null, range: TimeRange | null): T[] {
  if (!timelineNarrowed(h, range)) return photos;
  return photos.filter((p) => !p.photo_datetime || (p.photo_datetime >= range!.lo && p.photo_datetime <= range!.hi));
}

/** Hover text for a bucket: a day, a week span or a month, plus its count. */
export function bucketLabel(ts: number, bucketSecs: number, count: number): string {
  let label: string;
  if (bucketSecs <= DAY) {
    label = formatWallClockDate(ts, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  } else if (bucketSecs <= DAY * 7) {
    label = formatWallClockDate(ts, { month: "short", day: "numeric" }) + " – " +
      formatWallClockDate(ts + bucketSecs - DAY, { month: "short", day: "numeric", year: "numeric" });
  } else {
    label = formatWallClockDate(ts, { month: "long", year: "numeric" });
  }
  return count ? `${label} · ${count}` : label;
}

const fmtDate = (ts: number) => (ts ? formatWallClockDate(ts, { year: "numeric", month: "short", day: "numeric" }) : "");

export function TimelineHistogram({ histogram: h, onRangeChange, id = "timeline" }: {
  histogram: Histogram;
  onRangeChange: (range: TimeRange) => void;
  id?: string;
}) {
  const [lo, setLo] = useState(0);
  const [hi, setHi] = useState(STEPS);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const range = { lo: sliderToTs(lo, h), hi: sliderToTs(hi, h) };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const n = h.counts.length;
    if (!n || h.min === h.max) return;
    // Plain loop, not Math.max(...counts): a long span can carry many buckets.
    let maxCount = 1;
    for (const c of h.counts) if (c > maxCount) maxCount = c;
    const barW = cssW / n;
    const span = h.max - h.min;
    const inColor = cssVar("--accent", "#4a90d9");
    const outColor = cssVar("--border-strong", "#444");
    h.counts.forEach((count, i) => {
      const ts = h.min + i * h.bucket_secs;
      const barH = (count / maxCount) * cssH * 0.92;
      ctx.fillStyle = ts >= range.lo && ts <= range.hi ? inColor : outColor;
      ctx.fillRect(i * barW + 0.5, cssH - barH, barW - 1, barH);
    });
    const loX = ((range.lo - h.min) / span) * cssW;
    const hiX = ((range.hi - h.min) / span) * cssW;
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(loX, 0); ctx.lineTo(loX, cssH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hiX, 0); ctx.lineTo(hiX, cssH); ctx.stroke();
  }, [h, range.lo, range.hi]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  function onSlide(which: "lo" | "hi", v: number) {
    // The thumbs can't cross: the one being dragged stops at the other.
    let nextLo = lo, nextHi = hi;
    if (which === "lo") nextLo = Math.min(v, hi); else nextHi = Math.max(v, lo);
    setLo(nextLo);
    setHi(nextHi);
    onRangeChange({ lo: sliderToTs(nextLo, h), hi: sliderToTs(nextHi, h) });
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!h.counts.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.min(Math.floor(((e.clientX - rect.left) / (rect.width || 1)) * h.counts.length), h.counts.length - 1);
    const count = h.counts[i];
    if (count === undefined || i < 0) return;
    const tipW = tipRef.current?.offsetWidth ?? 0;
    setTip({
      text: bucketLabel(h.min + i * h.bucket_secs, h.bucket_secs, count),
      x: Math.min(e.clientX + 12, window.innerWidth - tipW - 8),
      y: e.clientY - 32,
    });
  }

  return (
    <div id={id} className="timeline-hist">
      <canvas ref={canvasRef} className="hist-canvas" aria-hidden="true" onMouseMove={onMouseMove} onMouseLeave={() => setTip(null)} />
      <input className="hist-range" type="range" min={0} max={STEPS} value={lo} aria-label="Timeline start"
        aria-valuetext={fmtDate(range.lo)} onChange={(e) => onSlide("lo", Number(e.target.value))} />
      <input className="hist-range" type="range" min={0} max={STEPS} value={hi} aria-label="Timeline end"
        aria-valuetext={fmtDate(range.hi)} onChange={(e) => onSlide("hi", Number(e.target.value))} />
      <div className="hist-labels" aria-hidden="true">
        <span>{fmtDate(range.lo)}</span>
        <span>{fmtDate(range.hi)}</span>
      </div>
      <div ref={tipRef} className="hist-tooltip" hidden={!tip} style={tip ? { left: tip.x, top: tip.y } : undefined}>{tip?.text}</div>
    </div>
  );
}
