import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import "./Dialog.css";

/* Modal dialog (audit Y3): role="dialog" + aria-modal, a labelled title, focus
 * moved in on open and trapped while open (Tab / Shift+Tab cycle inside), Escape
 * and a real <button> close it, and focus goes back to whatever opened it. The
 * backdrop keeps the legacy .modal look and, like the legacy modals, a click on
 * it does nothing: a stray click must not throw away a dialog's staged work
 * (Guess dates' reviewed checkboxes). Render it only while open. */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, wide, initialFocus, id }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The wider variant (a table inside). */
  wide?: boolean;
  /** Element to focus on open; default the first focusable one after the close button. */
  initialFocus?: RefObject<HTMLElement | null>;
  id?: string;
}) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    if (box) {
      const target = initialFocus?.current
        ?? [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => !el.classList.contains("modal-close"))
        ?? box;
      target.focus();
    }
    return () => {
      // Back to the opener, if it's still on the page (a re-render may have
      // replaced it; then focus just falls to the body).
      if (opener && opener.isConnected) opener.focus();
    };
    // Mount/unmount only: the dialog is rendered only while open.
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab" || !boxRef.current) return;
    const items = [...boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !boxRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !boxRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal">
      <div
        ref={boxRef}
        id={id}
        className={`modal-content${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
