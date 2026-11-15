import type { FaceMenuItem } from "../photos/FaceActionsMenu";

/* The per-face quick-action list. Port of face-grid.js openQuickActions' button
 * set; FaceQuickActions renders it as a menu (or a bottom sheet on a phone).
 * Each page supplies the callbacks it supports; a missing one drops its item. */

export type QuickFace = {
  id: number;
  person_name?: string | null;
  suggestion?: { person_id: number; person_name?: string | null } | null;
  ignored?: boolean;
  come_back?: boolean;
  source?: string | null;
};

export type QuickActionHandlers = {
  /** Required: person id, or null to unassign. */
  onAssign: (personId: number | null) => void;
  /** "Assign to…": opens the person picker (FaceQuickActions does that). */
  onPickPerson: () => void;
  /** Reject face.suggestion ("not this person"). */
  onNotPerson?: (personId: number, personName: string) => void;
  /** The same rejection for every face the caller's batch suggests for them. */
  onNotPersonAll?: (personId: number, personName: string) => void;
  onIgnore?: (ignored: boolean) => void;
  onComeBack?: (comeBack: boolean) => void;
  /** Only offered for hand-drawn boxes (source "manual"): a detected face would
   *  come back on the next scan, so those get Ignore instead. */
  onDelete?: () => void;
  onOpenPhoto?: () => void;
  /** Override; default = a suggestion on a face nobody is assigned to. */
  showConfirm?: boolean;
};

export function quickActionItems(face: QuickFace, h: QuickActionHandlers): FaceMenuItem[] {
  const items: FaceMenuItem[] = [];
  const sug = face.suggestion;
  const sugName = sug?.person_name ?? "suggested person";
  const showConfirm = h.showConfirm ?? (!!sug && !face.person_name);
  if (showConfirm && sug) {
    items.push({ label: `✓ ${sugName}`, primary: true, onSelect: () => h.onAssign(sug.person_id) });
  }
  if (face.person_name) items.push({ label: "× Unassign", danger: true, onSelect: () => h.onAssign(null) });
  if (h.onNotPerson && sug) {
    const fn = h.onNotPerson;
    items.push({ label: `⛔ Not ${sugName}`, danger: true, onSelect: () => fn(sug.person_id, sugName) });
  }
  if (h.onNotPersonAll && sug) {
    const fn = h.onNotPersonAll;
    items.push({
      label: `⛔ Not ${sugName} — Any`, danger: true,
      title: `Mark every face currently suggested as ${sugName} as definitely not them`,
      onSelect: () => fn(sug.person_id, sugName),
    });
  }
  items.push({ label: "Assign to…", onSelect: h.onPickPerson });
  if (h.onIgnore) {
    const fn = h.onIgnore;
    items.push(face.ignored
      ? { label: "↩ Restore", onSelect: () => fn(false) }
      : { label: "🚫 Ignore", danger: true, onSelect: () => fn(true) });
  }
  if (h.onComeBack) {
    const fn = h.onComeBack;
    items.push(face.come_back
      // A face is ignored or come-back, never both, so the two Restores can't clash.
      ? { label: "↩ Restore", onSelect: () => fn(false) }
      : { label: "🕒 Come back later", onSelect: () => fn(true) });
  }
  if (h.onDelete && face.source === "manual") items.push({ label: "🗑 Delete box", danger: true, onSelect: h.onDelete });
  if (h.onOpenPhoto) items.push({ label: "Open photo ↗", onSelect: h.onOpenPhoto });
  return items;
}
