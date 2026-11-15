import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client";
import { Dialog } from "../../ui/Dialog";
import { MIN_RADIUS_M, insideShape, parseShape, shapeBbox } from "../../map/shapes";
import { deleteMessage, nameClash, type Place } from "./places";

/* ── Name / rename dialog ──
 * window.prompt could only ask one question and couldn't answer back, so a
 * place had to be named blind and resized afterwards, and a clashing name went
 * unnoticed until the list showed two rows with the same label. This takes the
 * name and the radius together and checks the name against the existing places
 * while it's being typed. `radius` null hides that field — renaming has the
 * map's drag handles for geometry, so only creation asks for a size. */

export type PlaceAnswer = { name: string; radius: number | null };

export function PlaceDialog({ title, initialName = "", radius = null, submitLabel, places, excludeId = null, onCancel, onSubmit }: {
  title: string;
  initialName?: string;
  radius?: number | null;
  submitLabel: string;
  places: readonly Place[];
  /** The place being renamed: its own name is not a clash. */
  excludeId?: number | null;
  onCancel: () => void;
  onSubmit: (answer: PlaceAnswer) => void;
}) {
  const uid = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [radiusText, setRadiusText] = useState(radius === null ? "" : String(Math.round(radius)));
  const clash = nameClash(places, name, excludeId);

  // The suggested name (a hotspot's geocoded label names the neighbourhood, not
  // the place — "Elm St, Springfield" for what you'd call "Mom's house") starts
  // selected, so typing replaces it.
  useEffect(() => { nameRef.current?.select(); }, []);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;                    // Save is disabled anyway
    let r: number | null = null;
    if (radius !== null) {
      r = Number(radiusText);
      if (!Number.isFinite(r) || r < MIN_RADIUS_M) r = MIN_RADIUS_M;
    }
    onSubmit({ name: trimmed, radius: r });
  }

  return (
    <Dialog title={title} onClose={onCancel} initialFocus={nameRef} id="place-dialog-content">
      {/* A form, so Enter in either field saves — and on a focused button Enter
          is that button's own click (Cancel cancels), as in any form. */}
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="dialog-field">
          <span>Name</span>
          <input
            ref={nameRef} type="text" autoComplete="off" maxLength={200}
            value={name} onChange={(e) => setName(e.target.value)}
            aria-describedby={clash ? `${uid}-dupe` : undefined}
          />
        </label>
        {clash && (
          <div id={`${uid}-dupe`} className="dialog-note place-dialog-dupe" role="status">
            Another place is already called “{name.trim()}”.
          </div>
        )}
        {radius !== null && (
          <>
            <label className="dialog-field">
              <span>Radius (metres)</span>
              <input type="number" min={MIN_RADIUS_M} step={1} value={radiusText} onChange={(e) => setRadiusText(e.target.value)} />
            </label>
            <div className="dialog-note">Photos inside this radius count as taken here.</div>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

/* ── Delete confirmation ──
 * Same shell as the name dialog so an irreversible action doesn't look like a
 * different app than the one that created the place. */

export function DeletePlaceDialog({ place, onCancel, onConfirm }: { place: Place; onCancel: () => void; onConfirm: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog title={`Delete “${place.name}”?`} onClose={onCancel} initialFocus={okRef} id="confirm-dialog-content">
      <p className="dialog-note">{deleteMessage(place)}</p>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" ref={okRef} className="danger" onClick={onConfirm}>Delete place</button>
      </div>
    </Dialog>
  );
}

/* ── Representative photo picker ──
 * A place's representative photo is picked from the photos taken inside it —
 * that's the whole candidate set, so the picker is just those photos in a grid.
 * Newest first: the most recent visit is usually the one you remember.
 *
 * Bounds are the box the R*Tree query understands; a circle then gets an exact
 * distance pass client-side, since its bounding box overshoots the ring, which
 * at a 5 km place is a lot of photos from down the road. Keyed by place, so a
 * slower answer for the previous place can never fill this one's grid. */

export const REP_PICKER_LIMIT = 200;

export function RepPicker({ place, onPick, onClear, onClose }: {
  place: Place;
  onPick: (photoId: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const shape = parseShape(place.type, place.bounds);
  const photos = useQuery({
    queryKey: ["rep-picker", place.id, place.bounds],
    enabled: !!shape,
    queryFn: async ({ signal }) => {
      // geotagged=yes + window=0: only photos actually located here, not the
      // untagged time-neighbours by-bounds folds in for the Geocode page.
      const found = unwrap(await api.GET("/api/photos/by-bounds", {
        params: { query: { ...shapeBbox(shape!), geotagged: "yes", window: 0 } },
        signal,
      }));
      const inside = found.filter((p) => p.lat != null && p.lng != null && insideShape(shape!, { lat: p.lat, lng: p.lng }));
      return inside.reverse();               // the endpoint sorts oldest-first
    },
  });
  const all = photos.data ?? [];
  const shown = all.slice(0, REP_PICKER_LIMIT);

  return (
    <Dialog title={`Representative photo — ${place.name}`} onClose={onClose} wide id="rep-picker-content">
      <div id="rep-picker-grid" aria-busy={photos.isFetching}>
        {photos.isPending && shape ? (
          <div className="rep-picker-empty">Loading photos taken here…</div>
        ) : photos.isError ? (
          <div className="rep-picker-empty" role="alert">Couldn't load photos: {photos.error.message}</div>
        ) : !shown.length ? (
          <div className="rep-picker-empty">
            No geotagged photos inside this place yet. Tag some on the Geocode page, or widen the circle.
          </div>
        ) : (
          <>
            {shown.map((photo) => (
              <button
                key={photo.id} type="button"
                className={`rep-picker-cell${photo.id === place.representative_photo_id ? " selected" : ""}`}
                title={photo.filename} aria-label={photo.filename}
                aria-pressed={photo.id === place.representative_photo_id}
                onClick={() => onPick(photo.id)}
              >
                <img src={`/api/thumbnail/${photo.id}`} loading="lazy" alt="" />
              </button>
            ))}
            {all.length > shown.length && (
              <div className="rep-picker-note">Showing the {shown.length} most recent of {all.length} photos here.</div>
            )}
          </>
        )}
      </div>
      <div id="rep-picker-actions">
        {place.representative_photo_id != null && (
          <button type="button" className="danger" title="Leave this place without a representative photo" onClick={onClear}>Clear photo</button>
        )}
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
