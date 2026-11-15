import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client";
import type { Face } from "../../faces/faceGrid";
import { BboxBox } from "../../faces/FaceTile";
import { isRawName } from "../../lib/fullsize";
import { formatWallClock } from "../../lib/wallClock";
import type { PeopleController } from "./usePeople";

/* The detail (preview) pane: the focused face's photo with its box, the people
 * already tagged in that photo, the suggestion / "not this person" controls,
 * per-face actions and metadata. Port of people-detail.js updateDetail. The
 * actions here act on the previewed face only, never the grid selection. */

/** Committed person tags in a photo. Keyed per photo, so arrowing through
 *  several faces of one photo costs one request; every grid load drops the
 *  cache (tags may have changed). */
function useTaggedPeople(photoId: number | null) {
  return useQuery({
    queryKey: ["photo-tagged-people", photoId],
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/photos/{photo_id}/tagged-people", { params: { path: { photo_id: photoId! } }, signal })),
    enabled: photoId != null,
  });
}

function PhotoPeople({ face, onHover }: { face: Face; onHover: (bbox: number[] | null) => void }) {
  const q = useTaggedPeople(face.photo_id);
  const people = q.data ?? [];
  if (!people.length) return null;
  return (
    <div id="photo-people">
      <div className="pp-label">Already tagged in this photo ({people.length}):</div>
      {people.map((p) => {
        const self = p.id === face.id;
        return (
          <div key={p.id} className={`pp-chip${self ? " pp-self" : ""}`}
            title={self ? `${p.person_name} — this face` : `${p.person_name} — hover to locate in the photo`}
            onMouseEnter={self ? undefined : () => onHover(p.bbox)} onMouseLeave={self ? undefined : () => onHover(null)}>
            <img src={`/api/faces/${p.id}/crop`} alt="" />
            <span>{p.person_name}</span>
          </div>
        );
      })}
    </div>
  );
}

export function DetailPane({ ctl }: { ctl: PeopleController }) {
  const { state, actions: a } = ctl;
  const face = ctl.findFace(state.focusedId);
  // Which other tagged face is being hovered, for this face only.
  const [hover, setHover] = useState<{ faceId: number; bbox: number[] } | null>(null);

  if (!face) {
    return (
      <aside id="detail-pane" aria-label="Face details">
        <div id="detail-placeholder">Select a face to view details</div>
      </aside>
    );
  }
  const staged = state.pending.get(face.id);
  const loc = face.location;
  const place = loc ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ") : null;
  const sug = !face.person_name ? face.suggestion : null;
  const alts = face.alternatives ?? [];
  const negatives = face.negatives ?? [];
  const nameOf = (pid: number) => state.persons.find((p) => p.id === pid)?.name || "Unknown";
  const icon = (glyph: string, label: string, onClick: () => void, cls = "") => (
    <button type="button" className={`icon-btn${cls ? ` ${cls}` : ""}`} title={label} aria-label={label} onClick={onClick}>{glyph}</button>
  );

  return (
    <aside id="detail-pane" aria-label="Face details">
      <div id="detail-content">
        <div id="face-photo-wrap">
          <img id="detail-img" src={`/api/preview/${face.photo_id}`} alt={`Source photo ${face.filename ?? ""}`.trim()} />
          <BboxBox id="face-box" bbox={face.bbox} />
          {hover?.faceId === face.id && <BboxBox id="photo-people-box" bbox={hover.bbox} />}
        </div>
        <PhotoPeople key={face.id} face={face} onHover={(bbox) => setHover(bbox ? { faceId: face.id, bbox } : null)} />
        <div id="face-assign-bar">
          {sug && (
            <div id="face-suggestion">
              <div className="sug-primary">
                <span className="sug-text">Looks like <b>{sug.person_name}</b> ({sug.score})</span>
                <button type="button" className="primary" onClick={() => void a.confirmFace(face.id, sug.person_id)}>Confirm</button>
                <button type="button" className="danger" title={`Mark this face as definitely not ${sug.person_name}`}
                  onClick={() => void a.rejectSuggestion(face.id, sug.person_id, sug.person_name ?? "")}>Not {sug.person_name}</button>
              </div>
              {alts.length > 0 && (
                <div className="sug-alts">
                  <span className="sug-alts-label">…or maybe:</span>
                  {alts.map((alt) => (
                    <span key={alt.person_id} className="sug-alt-group">
                      <button type="button" className="alt-btn" title={`Tag this face as ${alt.person_name} instead`}
                        onClick={() => void a.confirmFace(face.id, alt.person_id)}>{alt.person_name} ({alt.score})</button>
                      <button type="button" className="alt-btn alt-not-btn" title={`Not ${alt.person_name}`} aria-label={`Not ${alt.person_name}`}
                        onClick={() => void a.rejectSuggestion(face.id, alt.person_id, alt.person_name ?? "")}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {negatives.length > 0 && (
            <div id="face-negatives">
              <div className="neg-title">Marked as NOT this face:</div>
              {negatives.map((pid) => (
                <div key={pid} className="neg-row">
                  <span>{nameOf(pid)}</span>
                  <button type="button" className="neg-undo-btn" title={`Allow ${nameOf(pid)} to be suggested for this face again`}
                    onClick={() => void a.rejectSuggestion(face.id, pid, nameOf(pid), false)}>↩ Undo</button>
                </div>
              ))}
            </div>
          )}
          <div className="face-assign-row">
            <button type="button" className="primary" title="Assign this face to a person" onClick={a.openDetailPicker}>Assign…</button>
            {icon("×", "Unassign", () => a.assignFocused(null), "danger")}
            {icon(face.ignored ? "↩" : "🚫", face.ignored ? "Restore" : "Ignore", () => void a.ignoreIds([face.id], !face.ignored))}
            {icon(face.come_back ? "↩" : "🕒", face.come_back ? "Restore" : "Come back later", () => void a.comeBackIds([face.id], !face.come_back))}
            {icon("🖼", "Open photo", () => a.openPhoto(face.photo_id))}
            {icon("👥", "All faces in this photo", () => a.openPhotoFaces(face.photo_id))}
            {isRawName(face.filename) && icon("🔍", "View full size (RAW)", a.openFocusedFullsize)}
          </div>
        </div>
        <table id="detail-meta">
          <tbody>
            <tr><th scope="row">Photo</th><td>{face.filename}</td></tr>
            <tr><th scope="row">Taken</th><td>{face.photo_datetime ? formatWallClock(face.photo_datetime) : "Unknown"}</td></tr>
            {place && <tr><th scope="row">Location</th><td>{place}</td></tr>}
            <tr>
              <th scope="row">Person</th>
              <td>{face.ignored ? <i className="meta-ignored">Ignored</i>
                : face.come_back ? <i className="meta-come-back">Come back later</i>
                  : face.person_name ? face.person_name : <i className="meta-unassigned">Unassigned</i>}</td>
            </tr>
            {staged && <tr><th scope="row">Staged</th><td><b className="meta-staged">→ {a.cellLabel(staged)}</b> (not saved)</td></tr>}
            {face.det_score != null && <tr><th scope="row">Detection</th><td>{face.det_score.toFixed(3)}</td></tr>}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
