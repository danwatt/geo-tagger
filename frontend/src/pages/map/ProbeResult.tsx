import { probeErrorMessage, probeView, type Probe } from "./geoData";

/* The click-to-probe popup's contents: what a photo taken at the clicked point
 * would be saved with, and which source said so. */

export function ProbeResult({ data, loading, error }: { data?: Probe; loading?: boolean; error?: unknown }) {
  if (loading) return <div className="map-popup" role="status"><div className="map-popup-meta">Geocoding…</div></div>;
  if (error || !data) return <div className="map-popup" role="alert"><div className="map-popup-meta">{probeErrorMessage(error)}</div></div>;
  const v = probeView(data);
  return (
    <div className="map-popup map-popup-probe" role="status">
      <div className="map-popup-name">{v.name}</div>
      <div className="map-popup-probe-label">Would be saved for a photo here:</div>
      {v.fields.length ? (
        <dl className="map-popup-fields">
          {v.fields.map(([k, val]) => (
            <div className="map-popup-field" key={k}><dt className="map-popup-field-key">{k}</dt><dd>{val}</dd></div>
          ))}
        </dl>
      ) : (
        <div className="map-popup-meta">(nothing — no location)</div>
      )}
      {v.candidates.length > 0 && (
        <>
          <div className="map-popup-probe-label">City candidates, best first:</div>
          <dl className="map-popup-fields">
            {v.candidates.map((c) => (
              <div className={`map-popup-field${c.won ? " map-popup-source-win" : ""}`} key={c.label}>
                <dt className="map-popup-field-key">{c.label}</dt><dd>{c.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="map-popup-meta">{v.coords}</div>
    </div>
  );
}

/** A GeoNames marker's popup, built as DOM (with text nodes — names are data)
 *  because thousands of markers are made imperatively in one batch. */
export function placePopupElement(place: { city?: string | null; county?: string | null; state?: string | null; country?: string | null; country_code?: string | null; population: number; lat: number; lng: number }): HTMLElement {
  const root = document.createElement("div");
  root.className = "map-popup";
  const line = (cls: string, text: string) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    root.appendChild(d);
  };
  line("map-popup-name", place.city || "(unnamed)");
  const region = [place.county, place.state].filter(Boolean).join(", ");
  if (region) line("map-popup-region", region);
  line("map-popup-country", place.country || place.country_code || "");
  line("map-popup-meta", `Population: ${place.population.toLocaleString()}`);
  line("map-popup-meta", `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`);
  return root;
}
