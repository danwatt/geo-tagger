import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, getJson, unwrap, type Schemas } from "../../api/client";
import { faceWord } from "../../faces/faceGrid";
import { FaceQuickActions, type QuickTarget } from "../../faces/FaceQuickActions";
import { BboxBox, FaceTile } from "../../faces/FaceTile";
import { faceUndoable, undoFaceToken, type FaceUndoToken } from "../../photos/faceUndo";
import { GroupHeader } from "../../photos/GroupHeader";
import { PersonPickerDialog } from "../../photos/PersonPickerDialog";
import { photoQueryKey } from "../../photos/PhotoPreviewPane";
import { fullSizeUrl, isRawName } from "../../lib/fullsize";
import { nav } from "../../lib/handoff";
import { latestOnly } from "../../lib/latestOnly";
import { AppShell } from "../../shell/AppShell";
import { StatusBar, type Status } from "../../shell/StatusBar";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useToasts } from "../../ui/Toast";
import { isTypingTarget } from "../geocode/keyboard";
import { isBool, loadViewPref, saveViewPref } from "../people/focus";
import {
  SKIP_DONE_LS_KEY, boxKind, counterText, crowdQuery, dragBox, faceSections, parseParams, sectionsStatus, stepIndex,
  type PhotoFace, type PlaylistPhoto,
} from "./photoFaces";
import "./photo-faces.css";

/* Photo Faces: every face of one photo, sorted into Tagged / Suggested /
 * Unrecognized / Come Back / Ignored, beside the photo with each face boxed.
 * Port of web/photo-faces.js. In crowd mode Prev/Next (and ←/→) walk the
 * /api/crowds playlist. Every write acts at once and offers Undo (U3). */

type Person = Schemas["PersonListItem"];
type Ask = { title: string; message: string; confirmLabel: string; danger?: boolean; resolve: (yes: boolean) => void };

export function PhotoFacesPage() {
  const uid = useId();
  const params = useMemo(() => parseParams(window.location.search), []);
  const crowd = params.mode === "crowd";
  const { undoToast, node: toasts } = useToasts();
  const [status, setStatus] = useState<Status>({ message: "Loading…" });
  const say = useCallback((message: string, isError = false) => setStatus({ message, isError }), []);
  const [playlist, setPlaylist] = useState<PlaylistPhoto[]>([]);
  const [idx, setIdx] = useState(-1);
  const [persons, setPersons] = useState<Person[]>([]);
  const [faces, setFaces] = useState<PhotoFace[] | null>(null);
  const [skipDone, setSkipDone] = useState(() => loadViewPref(SKIP_DONE_LS_KEY, true, isBool));
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null);
  const [whoPicker, setWhoPicker] = useState<[number, number, number, number] | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [menu, setMenu] = useState<QuickTarget<PhotoFace> | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [bust, setBust] = useState<Record<number, number>>({});
  const doneNextBusy = useRef(false);
  const confirm = useCallback((q: Omit<Ask, "resolve">) => new Promise<boolean>((resolve) => setAsk({ ...q, resolve })), []);

  const photo = idx >= 0 ? playlist[idx] : undefined;
  const photoId = photo?.id;
  const current = useRef<number | undefined>(undefined);
  current.current = photoId;
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;

  const meta = useQuery({
    queryKey: photoQueryKey(photoId ?? 0),
    queryFn: async () => unwrap(await api.GET("/api/photos/{photo_id}", { params: { path: { photo_id: photoId! } } })),
    enabled: photoId != null,
  });

  const loadPersons = useCallback(async () => {
    const list = unwrap(await api.GET("/api/persons"));
    setPersons(list);
  }, []);

  /* Latest-only with an on-screen check on top: fast Prev/Next must never paint
   * one photo's faces beside another photo. Landing recomputes the photo's
   * unlabeled count (Prev/Next and "Skip completed" read it) and the status. */
  const loadFaces = useMemo(() => latestOnly(async (signal: AbortSignal, pid: number) => {
    try {
      const list = unwrap(await api.GET("/api/photos/{photo_id}/faces", { params: { path: { photo_id: pid } }, signal }));
      if (signal.aborted || pid !== current.current) return;
      setMenu(null);
      setFaces(list);
      const s = faceSections(list);
      setPlaylist((pl) => pl.map((p) => (p.id === pid ? { ...p, unlabeled_faces: s.unlabeled } : p)));
      say(sectionsStatus(s));
    } catch (err) {
      if (signal.aborted || pid !== current.current) return;
      say("Failed to load faces: " + (err as Error).message, true);
    }
  }), [say]);

  /** Refresh after an action on `pid` — only if it's still the photo on screen;
   *  otherwise the new photo's own load owns the panel. */
  const reloadFacesFor = useCallback(async (pid: number | undefined) => {
    if (pid != null && pid === current.current) await loadFaces(pid);
  }, [loadFaces]);

  const navigateTo = useCallback((i: number) => {
    const p = playlistRef.current[i];
    if (!p) return;
    setDrawMode(false);   // a half-drawn box doesn't survive the photo
    setDraft(null);
    setHighlight(null);
    setFaces(null);       // the panel's photo-wide actions stay off until this one's faces land
    setIdx(i);
    current.current = p.id;
    if (crowd) window.history.replaceState(null, "", `?photo_id=${p.id}&mode=crowd&${crowdQuery(params)}`);
    say("Loading faces…");
    void loadFaces(p.id);
  }, [crowd, params, say, loadFaces]);

  /* ── Start-up ── */
  useEffect(() => {
    if (!crowd && !params.photoId) { say("No photo_id given.", true); return; }
    void (async () => {
      let list: PlaylistPhoto[];
      try {
        const [pl] = await Promise.all([
          crowd
            ? getJson<Schemas["CrowdsResponse"]>(`/api/crowds?${crowdQuery(params)}`).then((d) => d.groups.flatMap((g) => g.photos))
            // Single mode: a one-entry playlist; the count is recomputed from the faces.
            : api.GET("/api/photos/{photo_id}", { params: { path: { photo_id: params.photoId } } }).then(unwrap)
              .then((d) => [{ id: params.photoId, filename: d.filename, unlabeled_faces: 0 }]),
          loadPersons(),
        ]);
        list = pl.map((p) => ({ id: p.id, filename: p.filename, unlabeled_faces: p.unlabeled_faces }));
      } catch (err) {
        say("Failed to load: " + (err as Error).message, true);
        return;
      }
      if (!list.length) {
        say(`No crowd photos with ≥ ${params.minFaces} faces found` +
          (params.startTs != null || params.endTs != null ? " in the People Focus window." : "."));
        return;
      }
      playlistRef.current = list;
      setPlaylist(list);
      const start = params.photoId ? list.findIndex((p) => p.id === params.photoId) : -1;
      navigateTo(start >= 0 ? start : 0);
    })();
  }, []);   // once

  const prevIdx = photo ? stepIndex(playlist, idx, -1, skipDone) : -1;
  const nextIdx = photo ? stepIndex(playlist, idx, 1, skipDone) : -1;

  /* ── Actions ── */
  const faceWrite = useCallback(async <T extends { undo?: FaceUndoToken | null },>(
    send: () => Promise<T>, { message, failLabel, reloadPersons = false, onUndone }: {
      message: string; failLabel: string; reloadPersons?: boolean; onUndone?: (out: Schemas["UndoFacesResponse"]) => void;
    }): Promise<T> => {
    const pid = current.current;   // the photo this click was for
    try {
      const data = await send();
      await Promise.all([reloadPersons ? loadPersons() : null, reloadFacesFor(pid)]);
      const token = data.undo;
      if (faceUndoable(token)) {
        undoToast(message, async () => {
          const r = await undoFaceToken(token);
          onUndone?.(r.out);
          // A name-created person may have been removed again by the undo.
          await Promise.all([(token as { created_person_id?: number | null }).created_person_id != null ? loadPersons() : null, reloadFacesFor(pid)]);
          return r;
        });
      }
      return data;
    } catch (err) {
      say(`${failLabel} failed: ` + (err as Error).message, true);
      throw err;
    }
  }, [loadPersons, reloadFacesFor, undoToast, say]);

  const personName = (pid: number) => persons.find((p) => p.id === pid)?.name;
  const quiet = (p: Promise<unknown>) => { p.catch(() => {}); };

  const doAssign = (f: PhotoFace, personId: number | null) => quiet(faceWrite(
    async () => unwrap(await api.POST("/api/faces/{face_id}/assign", {
      params: { path: { face_id: f.id } }, body: personId == null ? { clear: true } : { person_id: personId, clear: false },
    })),
    { message: personId == null ? `Unassigned ${f.person_name ? `“${f.person_name}”` : "the face"}.` : `Tagged the face as ${personName(personId) ?? "that person"}.`, failLabel: "Assign" }));
  const doAssignByName = (f: PhotoFace, name: string) => quiet(faceWrite(
    async () => unwrap(await api.POST("/api/faces/{face_id}/assign", { params: { path: { face_id: f.id } }, body: { name, clear: false } })),
    { message: `Tagged the face as ${name}.`, failLabel: "Assign", reloadPersons: true }));
  const doAcceptAll = (personId: number, list: PhotoFace[]) => quiet(faceWrite(
    async () => unwrap(await api.POST("/api/faces/assign", { body: { face_ids: list.map((f) => f.id), person_id: personId, clear: false } })),
    { message: `Tagged ${faceWord(list.length)} as ${personName(personId) ?? "that person"}.`, failLabel: "Accept" }));
  const ignoreFaces = (ids: number[]) => {
    if (ids.length) quiet(faceWrite(async () => unwrap(await api.POST("/api/faces/ignore", { body: { face_ids: ids, ignored: true } })),
      { message: `Ignored ${faceWord(ids.length)}.`, failLabel: "Ignore" }));
  };
  const restoreFace = (id: number) => quiet(faceWrite(async () => unwrap(await api.POST("/api/faces/ignore", { body: { face_ids: [id], ignored: false } })),
    { message: "Restored the face to the unlabeled queue.", failLabel: "Restore" }));
  const comeBackFace = (id: number, comeBack: boolean) => quiet(faceWrite(
    async () => unwrap(await api.POST("/api/faces/come-back", { body: { face_ids: [id], come_back: comeBack } })),
    { message: comeBack ? "Moved the face to Come back." : "Restored the face to the unlabeled queue.", failLabel: "Come back" }));

  const deleteManualFace = async (faceId: number) => {
    const pid = current.current;
    if (!(await confirm({ title: "Delete face box", message: "Delete this hand-drawn face box?", confirmLabel: "Delete", danger: true }))) return;
    try {
      unwrap(await api.DELETE("/api/faces/{face_id}", { params: { path: { face_id: faceId } } }));
      await reloadFacesFor(pid);
      say("Face box deleted.");
    } catch (err) {
      say("Delete failed: " + (err as Error).message, true);
    }
  };

  const ignoreAllUnlabeled = async (silent: boolean) => {
    const p = photo;
    if (!p || !faces) return;
    const before = p.unlabeled_faces;
    const n = faces.filter((f) => f.person_id == null && !f.ignored && !f.come_back).length;
    const data = await faceWrite(async () => unwrap(await api.POST("/api/crowds/ignore-unlabeled", { body: { photo_ids: [p.id] } })), {
      message: `Ignored ${faceWord(n)} unlabeled on ${p.filename}.`, failLabel: "Ignore",
      // Done & next has moved on by the time Undo is clicked: put the count back
      // so Prev/Next and "Skip completed" see the photo as unfinished again.
      onUndone: (out) => {
        if (out.restored.length) setPlaylist((pl) => pl.map((x) => (x.id === p.id ? { ...x, unlabeled_faces: before } : x)));
      },
    });
    // After the reload, whose "✓ Done — …" would replace this at once.
    if (!silent && p.id === current.current) say(`Ignored ${data.ignored} unlabeled face(s) — this photo is done.`);
  };

  const doneAndNext = async () => {
    doneNextBusy.current = true;
    try {
      await ignoreAllUnlabeled(true);
    } catch { /* reported */ } finally {
      doneNextBusy.current = false;
    }
    const i = stepIndex(playlistRef.current, idx, 1, skipDone);
    if (i >= 0) navigateTo(i);
  };

  /* Nuclear rescan: wipe every face plus the cached renditions, re-detect, and
   * show the fresh result. */
  const rescan = async () => {
    const p = photo;
    if (!p) return;
    const yes = await confirm({
      title: "Rescan faces", danger: true, confirmLabel: "Rescan",
      message: `Rescan faces for ${p.filename}: permanently delete ALL existing faces (tagged, unlabeled, and ignored) and their ` +
        `cached crops, then re-run face detection from scratch. This cannot be undone. Continue?`,
    });
    if (!yes) return;
    setRescanning(true);
    say("Rescanning faces…");
    try {
      const data = unwrap(await api.POST("/api/faces/rescan", { body: { photo_ids: [p.id] } }));
      if (p.id !== current.current) return;   // moved on: the new photo owns the status line
      // The preview was regenerated: bust the browser cache so the boxes line up.
      setBust((b) => ({ ...b, [p.id]: Date.now() }));
      await loadFaces(p.id);
      if (p.id !== current.current) return;
      const errs = data.errors.length ? ` (${data.errors.length} error(s))` : "";
      const rot = data.orientations_updated ? " · orientation corrected" : "";
      say(`Rescanned: ${data.faces_deleted} face(s) removed, ${data.faces_found} re-detected${rot}${errs}.`, data.errors.length > 0);
    } catch (err) {
      say("Rescan failed: " + (err as Error).message, true);
    } finally {
      setRescanning(false);
    }
  };

  /* ── Add face: draw a box ── For faces detection missed. Coordinates are
   * fractions of the displayed image (display space, as stored boxes are drawn);
   * the server maps them back to sensor space. */
  const toggleDraw = (on: boolean) => {
    setDrawMode(on);
    if (!on) setDraft(null);
    say(on ? "Drag a box around the face, then pick who it is (Esc to cancel)." : "");
  };
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; rect: DOMRect } | null>(null);
  const frac = (e: React.PointerEvent, rect: DOMRect): [number, number] => [
    Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
  ];
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawMode || e.button !== 0 || whoPicker) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const [x, y] = frac(e, rect);
    dragStart.current = { x, y, rect };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
    setDraft([x, y, x, y]);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragStart.current;
    if (!d) return;
    const [cx, cy] = frac(e, d.rect);
    setDraft([Math.min(d.x, cx), Math.min(d.y, cy), Math.max(d.x, cx), Math.max(d.y, cy)]);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = dragStart.current;
    if (!d) return;
    dragStart.current = null;
    const [cx, cy] = frac(e, d.rect);
    const box = dragBox(d.x, d.y, cx, cy);
    if (!box) { setDraft(null); return; }   // a click, not a drag
    setDraft(box);
    setWhoPicker(box);
  };
  const submitManualFace = async (bbox: [number, number, number, number], who: { person_id: number } | { name: string }) => {
    const pid = current.current;
    if (pid == null) return;
    say("Adding face…");
    try {
      const data = unwrap(await api.POST("/api/photos/{photo_id}/faces", {
        params: { path: { photo_id: pid } },
        body: { bbox, person_id: "person_id" in who ? who.person_id : null, name: "name" in who ? who.name : null },
      }));
      toggleDraw(false);
      await Promise.all([loadPersons(), reloadFacesFor(pid)]);
      if (pid !== current.current) return;
      // Without an embedding the box is still a tag, but it can't take part in recognition.
      say(data.embedded ? "Face added." : "Face added, but no face was recognizable inside the box — it won't be used for matching.");
    } catch (err) {
      toggleDraw(false);
      say("Add face failed: " + (err as Error).message, true);
    }
  };

  /* ── Keys ── ←/→ step the playlist (honouring the buttons' disabled state);
   * off while typing, in a dialog or menu, while drawing, and while Done & next
   * is still ignoring (it navigates itself). Esc leaves draw mode. */
  const live = useRef({ prevIdx, nextIdx, drawMode, menu, ask, whoPicker, navigateTo, toggleDraw });
  live.current = { prevIdx, nextIdx, drawMode, menu, ask, whoPicker, navigateTo, toggleDraw };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const l = live.current;
      if (e.key === "Escape" && l.drawMode && !l.whoPicker && !document.querySelector(".modal [role=dialog]")) { l.toggleDraw(false); return; }
      if (!crowd || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isTypingTarget(e.target) || l.menu || l.ask || l.whoPicker || l.drawMode || doneNextBusy.current) return;
      if (document.querySelector('.modal [role="dialog"], [role="menu"]')) return;
      const i = e.key === "ArrowLeft" ? l.prevIdx : l.nextIdx;
      if (i < 0) return;
      e.preventDefault();
      l.navigateTo(i);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [crowd]);

  /* ── Rendering ── */
  const sections = faces ? faceSections(faces) : null;
  const highlightCard = (id: number) => {
    setHighlight(id);
    requestAnimationFrame(() => document.querySelector(`.face-card[data-face-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const openMenu = (f: PhotoFace, el: HTMLElement) => setMenu((m) => (m && m.face.id === f.id ? null : { face: f, anchor: el }));

  const card = (f: PhotoFace, kind: "labeled" | "suggested" | "plain" | "ignored" | "come-back") => {
    const label = f.person_name ? `Face: ${f.person_name}` : kind === "ignored" ? "Ignored face" : kind === "come-back" ? "Come-back face"
      : f.suggestion ? `Face, looks like ${f.suggestion.person_name}` : "Unrecognized face";
    return (
      <div key={f.id} data-face-id={f.id}
        className={`face-card${kind === "labeled" ? " labeled-card" : kind === "ignored" ? " ignored-card" : kind === "come-back" ? " come-back-card" : ""}${highlight === f.id ? " card-highlighted" : ""}`}>
        {/* Left: highlight its box on the photo; right-click / Shift+F10: actions. */}
        <FaceTile face={{ id: f.id }} label={label} className="face-card-btn" pressed={highlight === f.id}
          title="Click to find on the photo; right-click for actions"
          onActivate={() => setHighlight(f.id)} onMenu={(el) => openMenu(f, el)} />
        {kind === "labeled" && (
          <div className="face-name-chip">
            <span>{f.person_name}</span>
            <button type="button" className="chip-unassign" title="Unassign" aria-label={`Unassign ${f.person_name}`} onClick={() => doAssign(f, null)}>×</button>
          </div>
        )}
        {kind === "suggested" && f.suggestion && <div className="face-score-chip" aria-hidden="true">{Math.round(f.suggestion.score * 100)}%</div>}
        {kind === "ignored" && <div className="face-ignored-chip" aria-hidden="true">ignored</div>}
        {kind === "come-back" && <div className="face-come-back-chip" aria-hidden="true">come back</div>}
      </div>
    );
  };
  const section = (key: string, title: string, meta: string, variant: "green" | "blue" | "grey" | "amber" | undefined,
    body: React.ReactNode, buttons?: React.ReactNode) => (
    <section className="cr-section" aria-labelledby={`${uid}-${key}`}>
      <GroupHeader id={`${uid}-${key}`} title={title} meta={meta} variant={variant}>{buttons}</GroupHeader>
      {body}
    </section>
  );

  const backLabel = crowd || params.back ? "← Back" : "✕ Close";
  const goBack = () => {
    if (params.back) nav.go(params.back);
    else if (window.history.length > 1) window.history.back();
    else nav.go("/");
  };
  const unlabeled = sections?.unlabeled ?? 0;
  const previewSrc = photo ? `/api/preview/${photo.id}${bust[photo.id] ? `?t=${bust[photo.id]}` : ""}` : "";
  const d = meta.data && meta.data.id === photoId ? meta.data : null;

  return (
    <AppShell active="people" toolbar={
      <>
        <div className="toolbar-group">
          <button type="button" onClick={goBack}>{backLabel}</button>
        </div>
        {crowd && (
          <div className="toolbar-group" id="nav-group">
            <button type="button" disabled={prevIdx < 0} onClick={() => navigateTo(prevIdx)}>← Prev</button>
            <span id="photo-counter" className="toolbar-label" aria-live="polite">{photo ? counterText(playlist, idx, skipDone) : "—"}</span>
            <button type="button" disabled={nextIdx < 0} onClick={() => navigateTo(nextIdx)}>Next →</button>
          </div>
        )}
        <div className="toolbar-group">
          <span id="photo-filename" className="toolbar-label filename-label">{photo?.filename}</span>
          {photo && isRawName(photo.filename) && (
            <button type="button" title="Decode the RAW at full resolution and open it (with face boxes) in a new tab"
              onClick={() => nav.open(fullSizeUrl(photo.id))}>🔍 View full size (RAW)</button>
          )}
        </div>
        <div className="toolbar-group">
          <button type="button" className={drawMode ? "primary" : undefined} aria-pressed={drawMode} disabled={!photo}
            title="Draw a box around a face detection missed, then pick who it is" onClick={() => toggleDraw(!drawMode)}>
            {drawMode ? "✕ Cancel add" : "➕ Add face"}
          </button>
          <button type="button" className="danger" disabled={!photo || rescanning}
            title="Wipe every face for this photo (including tagged ones) and re-run detection from scratch" onClick={() => void rescan()}>
            {rescanning ? "Rescanning…" : "🔄 Rescan faces"}
          </button>
          <button type="button" className="danger" disabled={!faces || unlabeled === 0} onClick={() => quiet(ignoreAllUnlabeled(false))}>
            Ignore unlabeled ({faces ? unlabeled : "—"})
          </button>
          {crowd && <button type="button" className="primary" disabled={!faces} onClick={() => void doneAndNext()}>Done &amp; next →</button>}
        </div>
        {crowd && (
          <div className="toolbar-group">
            <label title="Prev/Next skip photos where all faces are labeled or ignored">
              <input type="checkbox" checked={skipDone} onChange={(e) => { setSkipDone(e.target.checked); saveViewPref(SKIP_DONE_LS_KEY, e.target.checked); }} /> Skip completed
            </label>
          </div>
        )}
      </>
    }>
      <div id="cr-main">
        <main id="cr-faces" aria-label="Faces in this photo">
          {sections && sections.tagged.length > 0 && section("tagged", "Tagged people", `— ${sections.tagged.length} faces tagged`, "green",
            <div className="face-strip">{sections.tagged.map((f) => card(f, "labeled"))}</div>)}
          {sections && sections.suggested.length > 0 && section("suggested", "Suggested matches",
            `— ${sections.suggested.reduce((n, g) => n + g.faces.length, 0)} face(s) across ${sections.suggested.length} person(s)`, "blue",
            sections.suggested.map((g) => (
              <div key={g.personId} className="suggested-group">
                <GroupHeader title={g.name} meta={`— ${g.faces.length} face(s)`} variant="blue">
                  <button type="button" className="primary icon-btn" title={`Accept all ${g.faces.length} suggestion(s)`} aria-label={`Accept all as ${g.name}`}
                    onClick={() => doAcceptAll(g.personId, g.faces)}>✓</button>
                  <button type="button" className="danger icon-btn" title="Ignore every face in this group" aria-label={`Ignore the ${g.name} group`}
                    onClick={() => ignoreFaces(g.faces.map((f) => f.id))}>🚫</button>
                </GroupHeader>
                <div className="face-strip">{g.faces.map((f) => card(f, "suggested"))}</div>
              </div>
            )))}
          {sections && sections.unknown.length > 0 && section("unknown", "Unrecognized", `— ${sections.unknown.length} face(s) — no match found`, undefined,
            <div className="face-strip">{sections.unknown.map((f) => card(f, "plain"))}</div>,
            sections.unknown.length > 1 && (
              <button type="button" className="danger icon-btn" title={`Ignore all ${sections.unknown.length} unrecognized face(s)`}
                aria-label={`Ignore all ${sections.unknown.length}`} onClick={() => ignoreFaces(sections.unknown.map((f) => f.id))}>🚫</button>
            ))}
          {sections && sections.comeBack.length > 0 && section("comeback", "Come Back", `— ${sections.comeBack.length} face(s) — known/suspected, deferred — click to restore`, "amber",
            <div className="face-strip">{sections.comeBack.map((f) => card(f, "come-back"))}</div>)}
          {sections && sections.ignored.length > 0 && section("ignored", "Ignored", `— ${sections.ignored.length} face(s) — click to restore`, "grey",
            <div className="face-strip">{sections.ignored.map((f) => card(f, "ignored"))}</div>)}
          {faces && faces.length === 0 && <div id="cr-empty">No faces found for this photo.</div>}
        </main>

        <aside id="cr-photo-pane" aria-label="Photo">
          {photo && (
            <div id="photo-container" className={drawMode ? "draw-mode" : undefined}>
              <img id="photo-full" src={previewSrc} alt={photo.filename} />
              <div id="bbox-overlay" ref={overlayRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                {faces?.map((f) => (
                  <BboxBox key={f.id} bbox={f.bbox} aria-hidden="true"
                    className={`face-bbox box-${boxKind(f)}${highlight === f.id ? " bbox-highlighted" : ""}`}
                    onClick={(e) => { e.stopPropagation(); if (!drawMode) highlightCard(f.id); }}>
                    {f.person_id != null && <div className="bbox-label">{f.person_name}</div>}
                  </BboxBox>
                ))}
                {draft && <BboxBox bbox={draft} className="face-bbox draft-bbox" aria-hidden="true" />}
              </div>
            </div>
          )}
          {d && (
            <table id="photo-meta">
              <tbody>
                {([["File", d.filename], ["Date", d.datetime || "—"], ["Camera", d.camera || "—"], ["Dimensions", d.dimensions || "—"]] as const)
                  .map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}
              </tbody>
            </table>
          )}
        </aside>
      </div>
      <StatusBar status={status} />
      {toasts}

      {menu && (
        <FaceQuickActions target={menu} persons={persons} onDone={() => setMenu(null)}
          handlers={{
            onAssign: (pid) => doAssign(menu.face, pid),
            onIgnore: (ignored) => (ignored ? ignoreFaces([menu.face.id]) : restoreFace(menu.face.id)),
            onComeBack: (cb) => comeBackFace(menu.face.id, cb),
            onDelete: () => void deleteManualFace(menu.face.id),
            onOpenPhoto: () => { if (photo) nav.open(`/api/preview/${photo.id}`); },
          }}
          onAssignNew={(name) => doAssignByName(menu.face, name)} />
      )}
      {whoPicker && (
        <PersonPickerDialog persons={persons} title="Who is this?" fuzzy
          onPick={(who) => { const box = whoPicker; setWhoPicker(null); void submitManualFace(box, who); }}
          onClose={() => { setWhoPicker(null); toggleDraw(false); }} />
      )}
      {ask && (
        <ConfirmDialog title={ask.title} message={ask.message} confirmLabel={ask.confirmLabel} danger={ask.danger}
          onConfirm={() => { ask.resolve(true); setAsk(null); }} onCancel={() => { ask.resolve(false); setAsk(null); }} />
      )}
    </AppShell>
  );
}
