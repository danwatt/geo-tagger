import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { fullSizeUrl, isRawName } from "../lib/fullsize";
import { nav } from "../lib/handoff";
import "./PhotoPreviewPane.css";

/* The preview pane: the focused photo's preview image, its metadata table, and
 * per-photo actions. Port of search.js showDetail.
 *
 * Arrowing through a grid focuses one photo per keypress, and only the photo
 * focused last may fill the pane. The query is keyed by photo id, so a reply
 * for a photo that's no longer focused lands in its own cache entry and is never
 * drawn here — the latest-only guarantee showDetail got from latestOnly(). On an
 * error the previous photo's details don't stay up under this one's selection. */

export type PhotoDetail = Schemas["PhotoDetail"];

export function photoQueryKey(id: number) {
  return ["photo", id] as const;
}

export function detailRows(d: PhotoDetail): [string, string][] {
  const loc = d.location;
  const place = loc ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ") : "";
  return [
    ["File", d.filename],
    ["Type", d.media_type ?? "—"],
    ["Camera", d.camera || "—"],
    ["Date", d.datetime || "—"],
    ["Dimensions", d.dimensions || "—"],
    ["Latitude", d.lat != null ? d.lat.toFixed(6) : "—"],
    ["Longitude", d.lng != null ? d.lng.toFixed(6) : "—"],
    ["Location", place || "—"],
  ];
}

export function PhotoPreviewPane({ photoId, actions, hidden, id = "detail-pane" }: {
  photoId: number | null;
  /** Page-specific actions under the image (Search: "More like this"). */
  actions?: (detail: PhotoDetail) => ReactNode;
  hidden?: boolean;
  id?: string;
}) {
  const q = useQuery({
    queryKey: photoQueryKey(photoId ?? 0),
    queryFn: async () => unwrap(await api.GET("/api/photos/{photo_id}", { params: { path: { photo_id: photoId! } } })),
    enabled: photoId != null,
  });

  let body: ReactNode;
  if (photoId == null) {
    body = <div className="detail-placeholder">Select a photo to view details</div>;
  } else if (q.isError) {
    body = <div className="detail-placeholder" role="alert">Could not load photo details: {q.error.message}</div>;
  } else if (!q.data) {
    body = <div className="detail-placeholder">Loading…</div>;
  } else {
    const d = q.data;
    body = (
      <div className="detail-content">
        <img className="detail-img" src={`/api/preview/${d.id}`} alt={`Preview of ${d.filename}`} />
        {isRawName(d.filename) && (
          <div className="detail-actions">
            <button type="button" title="Decode the RAW at full resolution and open it (with face boxes) in a new tab"
              onClick={() => nav.open(fullSizeUrl(d.id))}>🔍 View full size (RAW)</button>
          </div>
        )}
        {actions?.(d)}
        <table className="detail-meta">
          <tbody>
            {detailRows(d).map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}
          </tbody>
        </table>
      </div>
    );
  }

  return <aside id={id} className="detail-pane" hidden={hidden} aria-label="Photo preview" aria-live="polite">{body}</aside>;
}
