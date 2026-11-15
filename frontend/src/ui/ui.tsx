import type { ReactNode } from "react";
import "./ui.css";

/* Small shared presentational pieces. Styling comes from theme.css (.card shell)
 * plus ui.css. */

export function Card({ id, title, full, headerExtra, error, children }: {
  id: string;
  title: string;
  /** Span the whole dashboard row. */
  full?: boolean;
  /** Right-aligned control in the header row (e.g. a SegmentedToggle). */
  headerExtra?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <section className={`card ui-card${full ? " card-full" : ""}`} id={id} aria-labelledby={`${id}-title`}>
      <div className="card-header-row">
        <h2 id={`${id}-title`}>{title}</h2>
        {headerExtra}
      </div>
      {children}
      {error && <div className="error-line" role="alert">Error: {error}</div>}
    </section>
  );
}

export function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <>
      <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-label">{label}</div>
    </>
  );
}

/** Two-to-four option switch (e.g. % / Count). Buttons with aria-pressed. */
export function SegmentedToggle<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="mode-toggle" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? "active" : undefined}
          aria-pressed={o.value === value}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
