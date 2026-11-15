import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, unwrap, type Schemas } from "../../api/client";
import { faceWord, formatDateRange, locationLabel, minMaxOf, type Face } from "../../faces/faceGrid";
import { FaceQuickActions, type QuickTarget } from "../../faces/FaceQuickActions";
import { BboxBox, FaceTile } from "../../faces/FaceTile";
import { faceUndoable, undoFaceToken, type FaceUndoToken } from "../../photos/faceUndo";
import { PersonPickerDialog, type PickedPerson } from "../../photos/PersonPickerDialog";
import { fullSizeUrl, isRawName } from "../../lib/fullsize";
import { nav } from "../../lib/handoff";
import { latestOnly } from "../../lib/latestOnly";
import { useToasts } from "../../ui/Toast";
import {
  WINDOW_OPTIONS, dropGroup, loadPrevPerson, loadSettings, removeFace, restoreToQueue, savePrevPerson, saveSettings, splitGroups,
  type PrevPerson, type Queue, type Settings, type TagGroup,
} from "./quickTag";
import "./tag.css";

/* Quick Tag — phone/tablet face triage. Port of web/tag.js. Walks the
 * clustering endpoint one correlated group at a time: Accept (as the suggested
 * person, or one picked / typed), Ignore, or Skip; tap a face for the full photo
 * with its box, long-press / right-click it for per-face actions. Every write
 * acts at once and offers Undo, which puts the faces back in the queue.
 *
 * Deliberately not inside AppShell: it's a full-height mobile screen with its
 * own slim header (back to People, progress, settings) and a thumb-reach action
 * footer; the desktop nav bar would eat a phone's screen. */

type Person = Schemas["PersonListItem"];

function dateRange(g: TagGroup): string {
  const ts = g.faces.map((f) => f.photo_datetime).filter((t): t is number => !!t);
  return ts.length ? formatDateRange(...minMaxOf(ts)) : "Undated";
}

/** Full-photo preview with the face boxed; a tap anywhere (or Esc) closes it. */
function Preview({ face, onClose }: { face: Face; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return (
    <div id="overlay" ref={ref} role="dialog" aria-modal="true" aria-label={`Photo ${face.filename ?? ""}`.trim()} tabIndex={-1}
      onClick={onClose} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div id="overlay-inner">
        <img id="overlay-img" src={`/api/preview/${face.photo_id}`} alt={face.filename ?? "Photo"} />
        <BboxBox id="overlay-box" bbox={face.bbox} />
      </div>
      {isRawName(face.filename) && (
        <button type="button" id="overlay-fullsize-btn" onClick={(e) => { e.stopPropagation(); nav.open(fullSizeUrl(face.photo_id)); }}>
          🔍 View full size (RAW)
        </button>
      )}
      <button type="button" id="overlay-hint" onClick={onClose}>tap to close</button>
    </div>
  );
}

export function TagPage() {
  const uid = useId();
  const { toast, undoToast, node: toasts } = useToasts();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queue, setQueueState] = useState<Queue>({ groups: [], pos: 0 });
  const queueRef = useRef(queue);
  const setQueue = useCallback((f: (q: Queue) => Queue) => {
    queueRef.current = f(queueRef.current);
    setQueueState(queueRef.current);
  }, []);
  const [loading, setLoading] = useState<string | null>("Finding groups…");
  const [persons, setPersons] = useState<Person[]>([]);
  const [prev, setPrev] = useState<PrevPerson | null>(loadPrevPerson);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const busyRef = useRef(new Set<number>());
  const [picker, setPicker] = useState<TagGroup | null>(null);
  const [preview, setPreview] = useState<Face | null>(null);
  const [menu, setMenu] = useState<(QuickTarget<Face> & { group: TagGroup }) | null>(null);
  const nextId = useRef(1);

  const loadPersons = useCallback(async () => {
    try { setPersons(unwrap(await api.GET("/api/persons"))); } catch { /* the picker just offers create-new */ }
  }, []);

  // Latest-only: the strictness slider and window select can fire a reload
  // while the previous one is still clustering.
  const loadGroups = useMemo(() => latestOnly(async (signal: AbortSignal, s: Settings) => {
    setLoading("Finding groups…");
    try {
      // full=true: every face per group, so the grid can show them all.
      const data = unwrap(await api.GET("/api/faces/clusters", { params: { query: { full: true, threshold: s.threshold } }, signal }));
      if (signal.aborted) return;
      const groups = data.clusters.flatMap((c) => splitGroups(c, s.windowDays * 86400, () => nextId.current++));
      setQueue(() => ({ groups, pos: 0 }));
      setLoading(null);
    } catch (err) {
      if (signal.aborted) return;
      setLoading("Could not load groups: " + (err as Error).message);
    }
  }), [setQueue]);

  useEffect(() => {
    void loadPersons();
    void loadGroups(loadSettings());
  }, [loadPersons, loadGroups]);

  // The slider reloads once it settles.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeSettings = (next: Settings, debounce: boolean) => {
    setSettings(next);
    saveSettings(next);
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    if (debounce) reloadTimer.current = setTimeout(() => void loadGroups(next), 600);
    else void loadGroups(next);
  };

  const g = queue.groups[queue.pos];
  const groupBusy = !!g && busy.has(g.id);

  /* ── In-flight guard ── One request per group at a time: while a group's
   * POST is out its card and the footer are disabled, or a second tap would post
   * again and splice a second group out on return. */
  const withGroupBusy = async (group: TagGroup, send: () => Promise<void>) => {
    if (busyRef.current.has(group.id)) return;
    busyRef.current.add(group.id);
    setBusy(new Set(busyRef.current));
    try {
      await send();
    } finally {
      busyRef.current.delete(group.id);
      setBusy(new Set(busyRef.current));
    }
  };

  /** Undo puts the faces back exactly and returns them to the queue as the
   *  group on screen; faces changed elsewhere since stay out. */
  const offerUndo = (msg: string, token: FaceUndoToken | null | undefined, group: TagGroup, faces: Face[]) => {
    if (!faceUndoable(token)) { toast(msg); return; }
    undoToast(msg, async () => {
      const r = await undoFaceToken(token);
      const back = new Set(r.out.restored);
      setQueue((q) => restoreToQueue(q, group, faces.filter((f) => back.has(f.id))));
      if ((token as { created_person_id?: number | null }).created_person_id != null) void loadPersons();
      return r;
    });
  };

  type Write = { undo?: FaceUndoToken | null };
  /** A whole-group action; the group acted on is the one that leaves (by id). */
  const act = (group: TagGroup, send: () => Promise<Write>, msg: string, assigns: boolean) => withGroupBusy(group, async () => {
    try {
      const data = await send();
      const faces = group.faces.slice();
      setQueue((q) => dropGroup(q, group.id));   // the next group shifts into place
      offerUndo(msg, data.undo, group, faces);
      if (assigns) void loadPersons();   // pick up a newly created person
    } catch (err) {
      toast("Failed: " + (err as Error).message, true);
    }
  });

  /** A per-face action: the face splits out of its group, so a misclustered face
   *  can be fixed without abandoning the rest. */
  const faceAction = (group: TagGroup, f: Face, send: () => Promise<Write>, msg: string, assigns: boolean) => withGroupBusy(group, async () => {
    try {
      const data = await send();
      setQueue((q) => removeFace(q, group.id, f.id));
      if (assigns) void loadPersons();
      offerUndo(msg, data.undo, group, [f]);
    } catch (err) {
      toast("Failed: " + (err as Error).message, true);
    }
  });

  const ids = (group: TagGroup) => group.faces.map((f) => f.id);
  const assignGroup = (group: TagGroup, who: PickedPerson, label: string) => {
    if ("person_id" in who) { const p = { id: who.person_id, name: label }; savePrevPerson(p); setPrev(p); }
    void act(group, async () => unwrap(await api.POST("/api/faces/assign", { body: { face_ids: ids(group), ...who, clear: false } })),
      `Tagged ${group.faces.length} as ${label}`, true);
  };

  const onAccept = () => {
    if (!g || groupBusy) return;
    if (g.suggestion) assignGroup(g, { person_id: g.suggestion.person_id }, g.suggestion.person_name ?? "");
    else setPicker(g);   // no guess: choose an existing person or create one
  };
  const onUsePrevious = () => {
    if (!g || groupBusy || !prev) return;
    void act(g, async () => unwrap(await api.POST("/api/faces/assign", { body: { face_ids: ids(g), person_id: prev.id, clear: false } })),
      `Tagged ${g.faces.length} as ${prev.name}`, true);
  };
  const onIgnore = () => {
    if (!g || groupBusy) return;
    const n = g.faces.length;
    void act(g, async () => unwrap(await api.POST("/api/faces/ignore", { body: { face_ids: ids(g), ignored: true } })),
      `Ignored ${n} face${n > 1 ? "s" : ""}`, false);
  };
  const onSkip = () => {
    if (groupBusy) return;
    setQueue((q) => (q.pos < q.groups.length ? { ...q, pos: q.pos + 1 } : q));
  };
  const openPicker = () => { if (g && !groupBusy) setPicker(g); };

  const personName = (pid: number) => persons.find((p) => p.id === pid)?.name ?? "that person";
  const done = !loading && queue.pos >= queue.groups.length;

  return (
    <div id="app">
      <header id="bar">
        <a id="back" href="/people.html" title="Full People view" aria-label="Back to People">‹</a>
        <h1 id="title">Quick Tag</h1>
        <span id="progress" aria-live="polite">{!loading && !done ? `${queue.pos + 1} / ${queue.groups.length}` : ""}</span>
        <button type="button" id="settings-btn" aria-label="Settings" aria-expanded={settingsOpen} aria-controls={`${uid}-settings`}
          onClick={() => setSettingsOpen((o) => !o)}>⚙</button>
      </header>
      <div id={`${uid}-settings`} className="settings-panel" hidden={!settingsOpen}>
        <label className="ctl">
          <span className="ctl-label">Strictness</span>
          <input type="range" id="threshold-slider" min={0.3} max={0.95} step={0.05} value={settings.threshold}
            onChange={(e) => changeSettings({ ...settings, threshold: parseFloat(e.target.value) }, true)} />
          <span className="ctl-val" aria-hidden="true">{settings.threshold}</span>
        </label>
        <label className="ctl">
          <span className="ctl-label">Date window</span>
          <select id="window-select" value={settings.windowDays}
            onChange={(e) => changeSettings({ ...settings, windowDays: parseInt(e.target.value, 10) }, false)}>
            {WINDOW_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      <main id="stage">
        {loading && <div className="msg" role="status">{loading}</div>}
        {done && (
          <div id="done" className="msg" role="status">
            {queue.groups.length === 0 ? <p>🎉 All caught up!</p> : (
              <>
                <p>Done for now — {queue.groups.length} group(s) skipped.</p>
                <button type="button" className="act" onClick={() => setQueue((q) => ({ ...q, pos: 0 }))}>Review skipped</button>
              </>
            )}
            <button type="button" className="act primary" onClick={() => void loadGroups(settings)}>Reload</button>
          </div>
        )}
        {!loading && g && (
          <section id="card" className={groupBusy ? "busy" : undefined} aria-busy={groupBusy} aria-labelledby={`${uid}-hint`}>
            <div id="card-head">
              <button type="button" id={`${uid}-hint`} className={`hint ${g.suggestion ? "known" : "new"}`} title="Tap to choose or rename"
                onClick={openPicker}>
                {g.suggestion ? `Looks like ${g.suggestion.person_name}` : "New person?"}
              </button>
              <div id="meta">{dateRange(g)} · {g.faces.length} face{g.faces.length > 1 ? "s" : ""}</div>
              {locationLabel(g.faces) && <div id="place">📍 {locationLabel(g.faces)}</div>}
              <div id="card-actions">
                <button type="button" className="link-btn" disabled={groupBusy} onClick={openPicker}>👤 Choose person…</button>
                {prev && (
                  <button type="button" className="link-btn" disabled={groupBusy} onClick={onUsePrevious}>
                    ↩ Use previous<span id="prev-name">{prev.name}</span>
                  </button>
                )}
              </div>
            </div>
            <div id="faces">
              {g.faces.map((f) => (
                <FaceTile key={f.id} face={f} className="tag-face" label={`Face in ${f.filename ?? "photo"} — tap for the photo`}
                  onActivate={() => setPreview(f)}
                  onMenu={(el) => { if (!groupBusy) setMenu((m) => (m && m.face.id === f.id ? null : { face: f, anchor: el, group: g })); }} />
              ))}
            </div>
          </section>
        )}
      </main>

      {!loading && g && (
        <footer id="actions">
          <button type="button" id="ignore-btn" className="act danger" disabled={groupBusy} onClick={onIgnore}>🚫 Ignore</button>
          <button type="button" id="skip-btn" className="act" disabled={groupBusy} onClick={onSkip}>Skip ›</button>
          <button type="button" id="accept-btn" className="act primary" disabled={groupBusy} onClick={onAccept}>
            {g.suggestion ? `✓ Accept as ${g.suggestion.person_name}` : "✓ Name & accept"}
          </button>
        </footer>
      )}

      {toasts}
      {preview && <Preview face={preview} onClose={() => setPreview(null)} />}
      {picker && (
        <PersonPickerDialog id="picker-sheet" persons={persons} title={`Assign ${faceWord(picker.faces.length)} to…`} fuzzy
          onClose={() => setPicker(null)}
          onPick={(who) => {
            const group = picker;
            setPicker(null);
            if (busyRef.current.has(group.id)) return;
            assignGroup(group, who, "person_id" in who ? personName(who.person_id) : who.name);
          }} />
      )}
      {menu && (
        <FaceQuickActions target={menu} persons={persons} onDone={() => setMenu(null)}
          handlers={{
            onAssign: (pid) => void faceAction(menu.group, menu.face, async () => unwrap(await api.POST("/api/faces/assign", {
              body: pid === null ? { face_ids: [menu.face.id], clear: true } : { face_ids: [menu.face.id], person_id: pid, clear: false },
            })), pid === null ? "Unassigned the face." : `Tagged the face as ${personName(pid)}.`, true),
            onIgnore: (ignored) => void faceAction(menu.group, menu.face, async () => unwrap(await api.POST("/api/faces/ignore", {
              body: { face_ids: [menu.face.id], ignored },
            })), ignored ? "Ignored the face." : "Restored the face.", false),
            onComeBack: (cb) => void faceAction(menu.group, menu.face, async () => unwrap(await api.POST("/api/faces/come-back", {
              body: { face_ids: [menu.face.id], come_back: cb },
            })), cb ? "Moved the face to Come back." : "Restored the face.", false),
            onOpenPhoto: () => setPreview(menu.face),
          }}
          onAssignNew={(name) => void faceAction(menu.group, menu.face, async () => unwrap(await api.POST("/api/faces/assign", {
            body: { face_ids: [menu.face.id], name, clear: false },
          })), `Tagged the face as ${name}.`, true)} />
      )}
    </div>
  );
}
