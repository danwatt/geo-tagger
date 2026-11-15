import { useId, useState } from "react";
import { api, unwrap } from "../../api/client";
import { nav } from "../../lib/handoff";
import { FaceActionsMenu, type FaceMenuItem } from "../../photos/FaceActionsMenu";
import { GroupSection } from "../../photos/GroupHeader";
import { PersonPickerDialog, type PickedPerson } from "../../photos/PersonPickerDialog";
import { groupTitle, photoCount } from "../../photos/PhotoGrid";
import type { Candidate, Person } from "./query";
import { groupCandidates, markFaceAssigned, proposedByPerson, proposedFor, removeFaces } from "./untagged";

/* Untagged-face results: one row per candidate photo — its thumbnail (opens
 * the preview pane) then its tagged and proposed faces — grouped by year/month
 * like the plain grid. Port of search.js renderUntaggedGrid and the face
 * actions around it.
 *
 * Every action patches the loaded candidates locally (no refetch), so the
 * visible groups don't reshuffle mid-tagging; the user re-runs the search to
 * pick up new candidates. confirm() prompts became inline confirmations. */

type Face = {
  id: number;
  photoId: number;
  personName: string | null;
  suggestion: { person_id: number; person_name: string | null; score: number } | null;
};

type Pending =
  | { kind: "group-confirm" | "group-ignore"; groupKey: string; count: number; run: () => Promise<void> }
  | { kind: "reject-all"; count: number; personName: string; run: () => Promise<void> };

/** Above this many faces, a group action asks first (as the legacy page did). */
const CONFIRM_OVER = 3;

function locationText(c: Candidate): string | null {
  const loc = c.photo.location;
  if (!loc) return null;
  return [loc.city, loc.sublocation, loc.state, loc.country].filter(Boolean).join(", ") || null;
}

export function UntaggedResults({ candidates, persons, focusedId, onFocusPhoto, patch, status, onPersonsChanged }: {
  candidates: Candidate[];
  persons: Person[];
  focusedId: number | null;
  onFocusPhoto: (photoId: number) => void;
  patch: (fn: (cs: Candidate[]) => Candidate[]) => void;
  status: (message: string, isError?: boolean) => void;
  /** A face was assigned (possibly to a new person): refresh the people list. */
  onPersonsChanged: () => void;
}) {
  const uid = useId();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; face: Face } | null>(null);
  const [picker, setPicker] = useState<Face | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const nameOf = (pid: number) => persons.find((p) => p.id === pid)?.name ?? null;

  async function assign(faceId: number, personId: number | null) {
    try {
      unwrap(await api.POST("/api/faces/{face_id}/assign", {
        params: { path: { face_id: faceId } },
        body: personId == null ? { clear: true } : { person_id: personId, clear: false },
      }));
      onPersonsChanged();
      patch((cs) => markFaceAssigned(cs, faceId, personId, personId == null ? null : nameOf(personId)));
    } catch (e) {
      status(`Assign failed: ${(e as Error).message}`, true);
    }
  }

  async function assignNew(faceId: number, name: string) {
    try {
      const r = unwrap(await api.POST("/api/faces/{face_id}/assign", { params: { path: { face_id: faceId } }, body: { name, clear: false } }));
      onPersonsChanged();
      if (r.person_id != null) patch((cs) => markFaceAssigned(cs, faceId, r.person_id!, name));
    } catch (e) {
      status(`Assign failed: ${(e as Error).message}`, true);
    }
  }

  async function setFlag(path: "/api/faces/ignore" | "/api/faces/come-back", faceIds: number[], label: string) {
    try {
      if (path === "/api/faces/ignore") unwrap(await api.POST(path, { body: { face_ids: faceIds, ignored: true } }));
      else unwrap(await api.POST(path, { body: { face_ids: faceIds, come_back: true } }));
      patch((cs) => removeFaces(cs, faceIds));
    } catch (e) {
      status(`${label} failed: ${(e as Error).message}`, true);
    }
  }

  // "Definitely not this person": drops the person from the face's ranking so
  // the next-best guess surfaces instead of bouncing back to the same rejection.
  async function reject(faceIds: number[], personId: number, personName: string) {
    try {
      unwrap(await api.POST("/api/faces/negatives", { body: { face_ids: faceIds, person_id: personId, negative: true } }));
      status(faceIds.length === 1 ? `Marked as not ${personName}.` : `Marked ${faceIds.length} face(s) as not ${personName}.`);
      patch((cs) => removeFaces(cs, faceIds));
    } catch (e) {
      status(`Reject failed: ${(e as Error).message}`, true);
    }
  }

  // Sweep the whole loaded batch: every proposed face suggested as this person
  // gets the same negative, in one call.
  function rejectAll(personId: number, personName: string) {
    const faceIds = proposedFor(candidates, personId);
    if (!faceIds.length) { status(`No faces suggested as ${personName}.`, true); return; }
    setPending({ kind: "reject-all", count: faceIds.length, personName, run: () => reject(faceIds, personId, personName) });
  }

  // Group header buttons: act on every *proposed* face across the group's photos.
  async function confirmGroup(cands: Candidate[]) {
    try {
      for (const [pid, faceIds] of proposedByPerson(cands)) {
        unwrap(await api.POST("/api/faces/assign", { body: { face_ids: faceIds, person_id: pid, clear: false } }));
        const name = nameOf(pid);
        patch((cs) => faceIds.reduce((acc, fid) => markFaceAssigned(acc, fid, pid, name), cs));
      }
      onPersonsChanged();
    } catch (e) {
      status(`Confirm all failed: ${(e as Error).message}`, true);
    }
  }

  function askOrRun(p: Pending) {
    if (p.count > CONFIRM_OVER) setPending(p);
    else void p.run();
  }

  function menuItems(face: Face): FaceMenuItem[] {
    const s = face.suggestion;
    const items: FaceMenuItem[] = [];
    if (s && !face.personName) items.push({ label: `✓ ${s.person_name}`, primary: true, onSelect: () => void assign(face.id, s.person_id) });
    if (face.personName) items.push({ label: "× Unassign", danger: true, onSelect: () => void assign(face.id, null) });
    if (s) {
      items.push({ label: `⛔ Not ${s.person_name}`, danger: true, onSelect: () => void reject([face.id], s.person_id, s.person_name ?? "") });
      items.push({
        label: `⛔ Not ${s.person_name} — Any`, danger: true,
        title: `Mark every face currently suggested as ${s.person_name} as definitely not them`,
        onSelect: () => rejectAll(s.person_id, s.person_name ?? ""),
      });
    }
    items.push({ label: "Assign to…", onSelect: () => setPicker(face) });
    items.push({ label: "🚫 Ignore", danger: true, onSelect: () => void setFlag("/api/faces/ignore", [face.id], "Ignore") });
    items.push({ label: "🕒 Come back later", onSelect: () => void setFlag("/api/faces/come-back", [face.id], "Come back") });
    items.push({ label: "Open photo ↗", onSelect: () => nav.open(`/api/preview/${face.photoId}`) });
    return items;
  }

  function faceCell(face: Face) {
    const s = face.suggestion;
    const name = face.personName ?? s?.person_name ?? "face";
    const openMenu = (el: HTMLElement) => setMenu((m) => (m?.face.id === face.id ? null : { anchor: el, face }));
    return (
      <div key={face.id} className="untagged-face-wrap">
        <div className="thumb-cell search-face-cell"
          onContextMenu={(e) => { e.preventDefault(); openMenu(e.currentTarget.querySelector<HTMLElement>(".face-menu-btn") ?? e.currentTarget); }}>
          <img src={`/api/faces/${face.id}/crop`} loading="lazy" alt={face.personName ? `Face of ${face.personName}` : `Face suggested as ${name}`} />
          {face.personName && <div className="face-label">{face.personName}</div>}
          {!face.personName && s && (
            <div className="face-suggest">
              <button type="button" className="sug-confirm" title={`Click to confirm: ${s.person_name} (${s.score.toFixed(2)})`}
                onClick={() => void assign(face.id, s.person_id)}>
                <span className="sug-check" aria-hidden="true">✓</span>
                <span className="sug-name">{s.person_name}?</span>
              </button>
              <button type="button" className="sug-reject" title={`Not ${s.person_name}`} aria-label={`Not ${s.person_name}`}
                onClick={() => void reject([face.id], s.person_id, s.person_name ?? "")}>✕</button>
            </div>
          )}
          <button type="button" className="face-menu-btn" aria-label={`Actions for ${name}`} aria-haspopup="menu"
            aria-expanded={menu?.face.id === face.id} onClick={(e) => openMenu(e.currentTarget)}>⋯</button>
        </div>
      </div>
    );
  }

  if (candidates.length === 0) {
    return <div id="grid" className="photo-grid"><div className="grid-empty">No untagged-face candidates found.</div></div>;
  }

  const confirmBox = (p: Pending) => (
    <div className="inline-confirm" role="alertdialog" aria-labelledby={`${uid}-confirm`}>
      <p id={`${uid}-confirm`}>
        {p.kind === "group-confirm" && `Confirm ${p.count} suggested face(s) in this group?`}
        {p.kind === "group-ignore" && `Ignore ${p.count} suggested face(s) in this group?`}
        {p.kind === "reject-all" && `Mark ${p.count} face(s) as definitely NOT ${p.personName}? They will stop being suggested as ${p.personName} and fall through to their next-best match.`}
      </p>
      <button type="button" className={p.kind === "group-confirm" ? "primary" : "danger"} autoFocus
        onClick={() => { setPending(null); void p.run(); }}>
        {p.kind === "group-confirm" ? "Confirm all" : p.kind === "group-ignore" ? "Ignore all" : "Mark not them"}
      </button>
      <button type="button" onClick={() => setPending(null)}>Cancel</button>
    </div>
  );

  return (
    <div id="grid" className="photo-grid">
      {pending?.kind === "reject-all" && <div className="untagged-confirm">{confirmBox(pending)}</div>}
      {groupCandidates(candidates).map((g, gi) => {
        const cands = g.items.map((x) => x.item);
        const proposedCount = cands.reduce((n, c) => n + c.proposed.length, 0);
        const groupFaceIds = cands.flatMap((c) => c.proposed.map((p) => p.face_id));
        return (
          <GroupSection key={g.key} index={gi} labelId={`${uid}-g${gi}`} title={groupTitle(g)} meta={`· ${photoCount(cands.length)}`}
            buttons={proposedCount ? (
              <>
                <button type="button" className="primary icon-btn" title="Confirm every suggested face in this group"
                  aria-label={`Confirm all (${proposedCount})`}
                  onClick={() => askOrRun({ kind: "group-confirm", groupKey: g.key, count: proposedCount, run: () => confirmGroup(cands) })}>✓</button>
                <button type="button" className="danger icon-btn" title="Ignore every suggested (untagged) face in this group"
                  aria-label={`Ignore all (${proposedCount})`}
                  onClick={() => askOrRun({ kind: "group-ignore", groupKey: g.key, count: groupFaceIds.length, run: () => setFlag("/api/faces/ignore", groupFaceIds, "Ignore all") })}>🚫</button>
              </>
            ) : undefined}>
            {pending && pending.kind !== "reject-all" && pending.groupKey === g.key && <div className="untagged-confirm">{confirmBox(pending)}</div>}
            <div className="untagged-rows">
              {cands.map((c) => {
                const loc = locationText(c);
                const p = c.photo;
                return (
                  <div key={p.id} className="photo-row">
                    <div className="photo-row-thumb-wrap">
                      <button type="button"
                        className={"thumb-cell photo-row-thumb" + (p.lat != null ? " tagged" : "") + (p.geocode_ignored ? " geo-ignored" : "") + (p.id === focusedId ? " selected" : "")}
                        title={p.filename} aria-label={`Preview ${p.filename}`} aria-pressed={p.id === focusedId}
                        onClick={() => onFocusPhoto(p.id)}>
                        <img src={`/api/thumbnail/${p.id}`} loading="lazy" alt="" />
                      </button>
                      {loc && <div className="photo-row-loc">{loc}</div>}
                    </div>
                    <div className="photo-row-faces">
                      {c.tagged.map((t) => faceCell({ id: t.face_id, photoId: p.id, personName: t.person_name ?? null, suggestion: null }))}
                      {c.proposed.map((pr) => faceCell({
                        id: pr.face_id, photoId: p.id, personName: null,
                        suggestion: { person_id: pr.person_id, person_name: pr.person_name ?? null, score: pr.score },
                      }))}
                    </div>
                  </div>
                );
              })}
            </div>
          </GroupSection>
        );
      })}
      {menu && (
        <FaceActionsMenu anchor={menu.anchor} label="Face actions" items={menuItems(menu.face)} onClose={() => setMenu(null)} />
      )}
      {picker && (
        <PersonPickerDialog persons={persons} onClose={() => setPicker(null)}
          onPick={(who: PickedPerson) => {
            const face = picker;
            setPicker(null);
            if ("person_id" in who) void assign(face.id, who.person_id);
            else void assignNew(face.id, who.name);
          }} />
      )}
    </div>
  );
}
