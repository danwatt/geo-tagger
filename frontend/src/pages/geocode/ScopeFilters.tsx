import { DateRangePicker, type DateRange } from "../../ui/DateRangePicker";
import { LocationPicker, type LocationItem } from "../../ui/LocationPicker";
import type { DayRow } from "../../ui/dateRange";
import { shortDir, type ScopeDef } from "./scope";

/* The scope controls above the panes: Location (saved places and recorded photo
 * locations, with a buffer for a place), Select Month, the Folder facet, the
 * date range (over the loaded scope, live), Select Area and the "include
 * untagged within N" window that the location scopes pull candidates with. */

export const BUFFER_OPTIONS = [
  { value: 0, label: "Within bounds" }, { value: 0.1, label: "+0.1 miles" }, { value: 0.25, label: "+0.25 miles" },
  { value: 0.5, label: "+0.5 miles" }, { value: 1, label: "+1 mile" }, { value: 2, label: "+2 miles" },
  { value: 5, label: "+5 miles" }, { value: 10, label: "+10 miles" },
];

export const WINDOW_OPTIONS = [
  { value: "900", label: "15 min" }, { value: "1800", label: "30 min" }, { value: "3600", label: "1 hr" },
  { value: "7200", label: "2 hr" }, { value: "43200", label: "12 hr" }, { value: "86400", label: "24 hr" },
  { value: "604800", label: "1 week" },
];

const LOCATION_HELP = {
  none: "Choose a location to load photos and nearby untagged candidates.",
  edit: "Choose a suggestion to change the loaded location.",
  place: "Matches saved bounds; includes untagged candidates within the time window.",
  location: "Matches recorded photo locations; includes untagged candidates within the time window.",
};

export type Dir = { dir: string; total: number; untagged: number };

export function ScopeFilters(p: {
  scope: ScopeDef | null;
  locationText: string;
  editing: boolean;
  onLocationText: (t: string) => void;
  onLocationPick: (item: LocationItem) => void;
  onLocationEdit: () => void;
  onBuffer: (miles: number) => void;
  onSelectMonth: () => void;
  dirs: readonly Dir[];
  onDir: (dir: string) => void;
  dateRange: DateRange;
  dates: DayRow[];
  timeline: boolean;
  generation: number;
  onDateRange: (r: DateRange) => void;
  drawing: boolean;
  onSelectArea: () => void;
  onUseMapView: () => void;
  windowSecs: string;
  onWindow: (w: string) => void;
}) {
  const kind = p.scope?.kind;
  const help = p.editing ? LOCATION_HELP.edit : kind === "place" ? LOCATION_HELP.place : kind === "location" ? LOCATION_HELP.location : LOCATION_HELP.none;
  // A folder batch arriving from the queue shows up in the picker too.
  const scopeDir = p.scope?.kind === "dir" ? p.scope.dir : null;
  const dirValue = scopeDir !== null && p.dirs.some((d) => d.dir === scopeDir) ? scopeDir : "";
  return (
    <div id="workspace-filters">
      <div className="toolbar-group geocode-location-group">
        <label htmlFor="geocode-location-input">Location:</label>
        <div className="geocode-location-picker">
          <LocationPicker id="geocode-location-input" value={p.locationText} placeholder="Saved places, cities, counties…"
            describedBy="geocode-location-help"
            emptyMessage="No saved or recorded locations match. Try a city, county, or saved place name."
            errorMessage="Could not load locations. Type to retry."
            onTextChange={p.onLocationText} onSelect={p.onLocationPick} onEdit={p.onLocationEdit} />
        </div>
        {p.scope?.kind === "place" && (
          <select id="place-buffer-select" aria-label="Search area" title="Grow the place's bounds outward before filtering photos"
            value={p.scope.buffer} onChange={(e) => p.onBuffer(Number(e.target.value))}>
            {BUFFER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <a className="button" href="/custom-places.html" title="Add or edit custom places">✏️ Edit places</a>
        <span id="geocode-location-help" className="visually-hidden" aria-live="polite">{help}</span>
      </div>
      <div className="scope-date-controls">
        <div className="toolbar-group">
          <button type="button" id="select-month-btn" onClick={p.onSelectMonth}>Select Month</button>
          {/* Folder facet: scans and imports arrive by directory, and an undated
              one can't be reached by month at all. Loads through /api/photos?dir=. */}
          <select id="dir-select" aria-label="Folder" title="Load every photo in one directory" value={dirValue}
            onChange={(e) => { if (e.target.value) p.onDir(e.target.value); }}>
            <option value="">Folder: any</option>
            {p.dirs.map((d) => (
              // Untagged first in the label as well as the order — that's what
              // says whether a folder is worth opening.
              <option key={d.dir} value={d.dir} title={d.dir}>
                {d.untagged
                  ? `${shortDir(d.dir)} — ${d.untagged.toLocaleString()} untagged of ${d.total.toLocaleString()}`
                  : `${shortDir(d.dir)} — all ${d.total.toLocaleString()} done`}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar-group" id="timeline-toolbar-group">
          <span id="date-range-label">Dates:</span>
          {/* Fed the loaded scope's own day counts, and live: it filters photos
              already in memory, so waiting for an Apply would feel broken. */}
          <DateRangePicker key={p.generation} id="date-range" labelledBy="date-range-label" compact live
            value={p.dateRange} dates={p.dates} onChange={p.onDateRange} disabled={!p.timeline}
            disabledTitle="Load dated photos to narrow the date range" />
        </div>
        <div className="toolbar-group">
          <button type="button" id="select-area-btn" aria-pressed={p.drawing} onClick={p.onSelectArea}
            title={p.drawing ? "Cancel the area selection (Esc)" : "Draw a circle on the map to load the photos in it"}>
            {p.drawing ? "Cancel area" : "Select Area"}
          </button>
          {p.drawing && (
            <button type="button" id="use-map-view-btn" onClick={p.onUseMapView}
              title="Use the circle that fits the visible map instead of drawing one">Use map view</button>
          )}
          <label htmlFor="window-select">Include untagged within</label>
          <select id="window-select" value={p.windowSecs} onChange={(e) => p.onWindow(e.target.value)}>
            {WINDOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
