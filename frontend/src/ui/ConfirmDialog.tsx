import { useRef } from "react";
import { Dialog } from "./Dialog";

/* A yes/no question in the shared Dialog — the replacement for confirm(). The
 * confirming button takes focus, so Enter answers yes and Escape no, as the
 * browser's own prompt did. Render it only while the question is open. */

export function ConfirmDialog({ title, message, confirmLabel, cancelLabel = "Cancel", danger, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const yes = useRef<HTMLButtonElement>(null);
  return (
    <Dialog title={title} onClose={onCancel} initialFocus={yes}>
      <p className="confirm-message">{message}</p>
      <div className="confirm-actions">
        <button ref={yes} type="button" className={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" onClick={onCancel}>{cancelLabel}</button>
      </div>
    </Dialog>
  );
}
