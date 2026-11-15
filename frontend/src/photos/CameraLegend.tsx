import type { CameraColors } from "./cameraColors";
import "./CameraLegend.css";

/* The camera legend above the Geocode and Time Sync grids. Port of
 * camera-colors.js renderLegend: only cameras in the loaded photos show, in
 * the order they were first given a colour. */

/** One chip per camera in the loaded scope; a click hides / shows its photos. */
export function CameraLegend({ photos, colors, hidden, onToggle }: {
  photos: readonly { camera?: string | null }[];
  colors: CameraColors;
  hidden: ReadonlySet<string>;
  onToggle: (camera: string) => void;
}) {
  const cams = colors.legend(photos);
  return (
    <div id="cam-legend" role="group" aria-label="Cameras">
      {cams.map(({ camera, color }) => (
        <button key={camera} type="button" className={`cam-legend-item${hidden.has(camera) ? " dimmed" : ""}`}
          aria-pressed={!hidden.has(camera)} title={`Click to hide/show ${camera}`} onClick={() => onToggle(camera)}>
          <span className="cam-legend-dot" style={{ background: color }} aria-hidden="true" />
          <span>{camera}</span>
        </button>
      ))}
    </div>
  );
}

