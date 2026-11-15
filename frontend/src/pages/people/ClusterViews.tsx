import { useId } from "react";
import { locationLabel, minOf, primaryDirKey, primaryLocationKey, sortGroups, type Face } from "../../faces/faceGrid";
import { FaceTile } from "../../faces/FaceTile";
import { GroupHeader } from "../../photos/GroupHeader";
import type { Cluster, CrowdGroup, CrowdPhoto, PeopleController } from "./usePeople";

/* Discover's cluster cards and Crowds' photo groups. Port of
 * people-discover.js / people-crowds.js renderers. Both act straight on the
 * server (their face lists aren't the full face objects staging needs). */

export function DiscoverView({ ctl, onMenu }: { ctl: PeopleController; onMenu: (face: Face, anchor: HTMLElement) => void }) {
  const { state } = ctl;
  // Photo count comes off the sample unless the group is bigger than it.
  const clusters = sortGroups(state.clusters, state.gridSort, (cl) => ({
    date: minOf(cl.sample.map((f) => f.photo_datetime || Infinity)),
    count: Math.max(cl.size, new Set(cl.sample.map((f) => f.photo_id)).size),
    place: primaryLocationKey(cl.sample),
    dir: primaryDirKey(cl.sample),
  }));
  return <>{clusters.map((cl) => <ClusterCard key={cl.face_ids[0]} cl={cl} ctl={ctl} onMenu={onMenu} />)}</>;
}

function ClusterCard({ cl, ctl, onMenu }: { cl: Cluster; ctl: PeopleController; onMenu: (face: Face, anchor: HTMLElement) => void }) {
  const id = useId();
  const a = ctl.actions;
  const sug = cl.suggestion;
  const place = locationLabel(cl.sample);
  const title = sug ? `Looks like ${sug.person_name}` : "New group";
  return (
    <section className="cluster-card" aria-labelledby={id}>
      <GroupHeader id={id} title={title}
        meta={`· ${cl.size} face(s)` + (sug ? ` · ${Math.round(sug.score * 100)}% of group` : "") + (place ? ` · 📍 ${place}` : "")}>
        {sug && (
          <button type="button" className="primary icon-btn" title={`Assign to ${sug.person_name}`} aria-label={`Assign to ${sug.person_name}`}
            onClick={() => void a.clusterAssign(cl, { person_id: sug.person_id }, sug.person_name ?? "")}>✓</button>
        )}
        {/* The shared picker, not prompt(): typing shows existing people (and
            near-spellings) first, so naming a group can't mint a duplicate. */}
        <button type="button" className={`icon-btn${sug ? "" : " primary"}`} title={sug ? "Name instead…" : "Name…"}
          aria-label={sug ? "Name instead…" : "Name…"} onClick={() => a.nameCluster(cl)}>✏️</button>
        <button type="button" className="danger icon-btn" title="Ignore all" aria-label="Ignore all" onClick={() => void a.clusterIgnore(cl)}>🚫</button>
      </GroupHeader>
      <div className="cluster-faces">
        {cl.sample.map((f) => (
          <FaceTile key={f.id} face={f} label={`Face in ${f.filename ?? "photo"}`} title={f.filename ?? undefined}
            className={`cluster-face${f.id === ctl.state.focusedId ? " focused" : ""}`} current={f.id === ctl.state.focusedId}
            onActivate={() => a.focusFace(f.id)}
            onMenu={(el) => { a.focusFace(f.id); onMenu(f, el); }} />
        ))}
        {cl.size > cl.sample.length && <span className="cluster-more">+{cl.size - cl.sample.length} more</span>}
      </div>
    </section>
  );
}

/** The groups and photos Crowds shows: "Hide completed" drops photos with no
 *  unlabeled faces left (and groups left empty), except those just acted on. */
export function visibleCrowds(groups: readonly CrowdGroup[], hideDone: boolean, keep: ReadonlySet<number>): { g: CrowdGroup; photos: CrowdPhoto[] }[] {
  const out = groups.map((g) => ({ g, photos: hideDone ? g.photos.filter((p) => p.unlabeled_faces > 0 || keep.has(p.id)) : g.photos }));
  return hideDone ? out.filter((v) => v.photos.length > 0) : out;
}

export function CrowdsView({ ctl }: { ctl: PeopleController }) {
  const { state } = ctl;
  const visible = visibleCrowds(state.crowds, state.hideDoneCrowds, state.crowdsKeep);
  if (!visible.length && state.crowds.length) {
    return <div className="crowds-done">All crowd photos are complete. Uncheck "Hide completed" to review them.</div>;
  }
  const sorted = sortGroups(visible, state.gridSort, (v) => ({
    date: minOf(v.photos.map((p) => p.photo_datetime || Infinity)),
    count: v.photos.length,
    place: primaryLocationKey(v.photos),
    dir: primaryDirKey(v.photos),
  }));
  return <>{sorted.map((v, i) => <CrowdCard key={`${v.g.label}-${v.g.photos[0]?.id ?? i}`} g={v.g} photos={v.photos} ctl={ctl} />)}</>;
}

function CrowdCard({ g, photos, ctl }: { g: CrowdGroup; photos: CrowdPhoto[]; ctl: PeopleController }) {
  const id = useId();
  let meta = `· ${photos.length} photo(s) · ${g.total_faces} face(s)`;
  if (g.unlabeled_faces > 0) meta += ` · ${g.unlabeled_faces} unlabeled`;
  // Place goes last so the "Location, then date" sort reads here too.
  const place = locationLabel(photos);
  if (place) meta += ` · 📍 ${place}`;
  const label = `Ignore ${g.unlabeled_faces} unlabeled`;
  return (
    <section className="cluster-card crowd-group-card" aria-labelledby={id}>
      <GroupHeader id={id} title={g.label} meta={meta} variant="amber">
        <button type="button" className="danger icon-btn" title={label} aria-label={label} disabled={g.unlabeled_faces === 0}
          onClick={() => void ctl.actions.crowdIgnoreGroup(g)}>🚫</button>
      </GroupHeader>
      <div className="crowd-photos">
        {photos.map((ph) => <CrowdPhotoCell key={ph.id} ph={ph} ctl={ctl} />)}
      </div>
    </section>
  );
}

function CrowdPhotoCell({ ph, ctl }: { ph: CrowdPhoto; ctl: PeopleController }) {
  const parts = [`${ph.total_faces} faces`];
  if (ph.labeled_faces) parts.push(`${ph.labeled_faces} labeled`);
  if (ph.unlabeled_faces) parts.push(`${ph.unlabeled_faces} unlabeled`);
  return (
    <div className="crowd-photo-cell">
      <button type="button" className="crowd-photo-open" title={`${ph.filename} — click to open`} aria-label={`Open ${ph.filename}`}
        onClick={() => ctl.actions.openPhoto(ph.id)}>
        <img src={`/api/thumbnail/${ph.id}`} loading="lazy" alt="" />
      </button>
      <div className="crowd-badge">{parts.join(" · ")}</div>
      <div className="crowd-photo-actions">
        <button type="button" className="danger" disabled={ph.unlabeled_faces === 0} onClick={() => void ctl.actions.crowdIgnorePhoto(ph)}>Ignore unlabeled</button>
        <a className="button" href={ctl.actions.crowdReviewUrl(ph.id)}>Review</a>
        <button type="button" onClick={() => ctl.actions.openPhoto(ph.id)}>Photo ↗</button>
      </div>
    </div>
  );
}
