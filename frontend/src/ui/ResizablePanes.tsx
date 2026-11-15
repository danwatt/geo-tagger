import { useEffect, useRef, useState } from "react";

/* Resizable workspace panes with keyboard-accessible dividers. Port of
 * workspace-layout.js: the container is a CSS grid whose columns are the pane
 * weights (fr units) with a 6px divider column between each pair; the last pane
 * (the preview) can be hidden.
 *
 * Pane widths and the preview toggle are a per-viewer convenience, so they live
 * in this browser's localStorage, one key per page — the same keys as the legacy
 * script, so a saved layout carries over. Versioned: a change to the pane set
 * bumps the key rather than misreading an old layout. */

export const MIN_WEIGHT = 15;

export type Layout = { weights: number[]; previewVisible: boolean };

/** A saved layout, or the defaults when it doesn't validate: wrong pane count, a
 *  pane under the floor the dividers enforce, a total nowhere near 100. */
export function parseSavedLayout(raw: string | null, defaults: number[]): Layout {
  const out: Layout = { weights: defaults.slice(), previewVisible: true };
  try {
    const saved: unknown = JSON.parse(raw || "null");
    if (!saved || typeof saved !== "object") return out;
    const { weights, previewVisible } = saved as { weights?: unknown; previewVisible?: unknown };
    const max = 100 - MIN_WEIGHT * (defaults.length - 1);
    if (Array.isArray(weights) && weights.length === defaults.length &&
        weights.every((w) => typeof w === "number" && Number.isFinite(w) && w >= MIN_WEIGHT && w <= max)) {
      const sum = (weights as number[]).reduce((a, b) => a + b, 0);
      if (sum > 90 && sum < 110) out.weights = (weights as number[]).map((w) => (w * 100) / sum);
    }
    if (typeof previewVisible === "boolean") out.previewVisible = previewVisible;
  } catch { /* junk — keep the defaults */ }
  return out;
}

/** Move the divider between pane i and i+1 by `delta` weight, keeping both
 *  panes at or above the floor and their sum unchanged. */
export function adjustWeights(weights: number[], i: number, delta: number): number[] {
  const next = weights.slice();
  const sum = next[i]! + next[i + 1]!;
  next[i] = Math.max(MIN_WEIGHT, Math.min(sum - MIN_WEIGHT, next[i]! + delta));
  next[i + 1] = sum - next[i]!;
  return next;
}

export function gridColumns(weights: number[], visible: number): string {
  const cols: string[] = [];
  for (let i = 0; i < visible; i++) {
    if (i) cols.push("6px");
    cols.push(`minmax(0, ${weights[i]}fr)`);
  }
  return cols.join(" ");
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function usePaneLayout(storageKey: string, defaults: number[]) {
  const [layout, setLayout] = useState<Layout>(() => parseSavedLayout(readStorage(storageKey), defaults));
  const first = useRef(true);
  useEffect(() => {
    // The initial paint of a restored layout needn't re-save it.
    if (first.current) { first.current = false; return; }
    // Debounced: a divider drag changes the layout per pointer move.
    const t = setTimeout(() => {
      try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* won't stick */ }
    }, 250);
    return () => clearTimeout(t);
  }, [layout, storageKey]);
  // Legacy pages listened for resize after a layout change; the canvas timeline
  // here does too, so it redraws at its new width.
  useEffect(() => { window.dispatchEvent(new Event("resize")); }, [layout]);

  const visible = layout.previewVisible ? defaults.length : defaults.length - 1;
  return {
    ...layout,
    columns: gridColumns(layout.weights, visible),
    visible,
    togglePreview: () => setLayout((l) => ({ ...l, previewVisible: !l.previewVisible })),
    adjust: (i: number, delta: number) => setLayout((l) => ({ ...l, weights: adjustWeights(l.weights, i, delta) })),
  };
}

/** The drag handle between pane `index` and the next. A focusable separator:
 *  Left/Right arrows nudge it 2%, a pointer drag moves it. */
export function PaneDivider({ index, label, weight, onAdjust, containerRef, totalWeight }: {
  index: number;
  label: string;
  weight: number;
  onAdjust: (index: number, delta: number) => void;
  containerRef: React.RefObject<HTMLElement | null>;
  /** Sum of the visible panes' weights: a pixel drag converts through it. */
  totalWeight: number;
}) {
  const prevX = useRef<number | null>(null);
  return (
    <div
      className="pane-divider"
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={MIN_WEIGHT}
      aria-valuemax={100 - MIN_WEIGHT}
      aria-valuenow={Math.round(weight)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onAdjust(index, e.key === "ArrowLeft" ? -2 : 2);
        }
      }}
      onPointerDown={(e) => {
        prevX.current = e.clientX;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
      }}
      onPointerMove={(e) => {
        if (prevX.current === null) return;
        const width = containerRef.current?.clientWidth || 1;
        onAdjust(index, ((e.clientX - prevX.current) / width) * totalWeight);
        prevX.current = e.clientX;
      }}
      onPointerUp={() => { prevX.current = null; }}
      onLostPointerCapture={() => { prevX.current = null; }}
    />
  );
}
