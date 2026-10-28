import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { UnsettledScope } from "../lib/unsettled.ts";
import { Icon } from "./Icon.tsx";

// A modal dialog and a side drawer: focus moves in on open, Tab stays inside,
// Escape or the backdrop closes, and focus returns to what opened it. A modal that can't be dismissed (a write whose
// outcome isn't known yet) ignores Escape and the backdrop and disables its close button.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useDialogFocus(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => opener?.focus?.();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return { panel, onKeyDown };
}

interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const NOT_DISMISSIBLE = "Settle the write first: Try again, or Check what was recorded.";

/** Whether a write inside the open modal (an upload in its form) is unsettled: its own close buttons wait too. */
const NestedHeld = createContext(false);

/** A footer's Cancel or Close: disabled while a write inside the dialog is unsettled, like the dialog's own ✕. */
export function DismissButton({ onClick, children, className = "btn btn-ghost", disabled }: { onClick: () => void; children: ReactNode; className?: string; disabled?: boolean }) {
  const held = useContext(NestedHeld);
  return (
    <button type="button" className={className} onClick={onClick} disabled={held || disabled} title={held ? NOT_DISMISSIBLE : undefined}>
      {children}
    </button>
  );
}

export function Drawer({ title, onClose, children, footer }: DialogProps) {
  const titleId = useId();
  const { panel, onKeyDown } = useDialogFocus(onClose);
  return (
    <>
      <div className="drawer-back" onClick={onClose} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="drawer-h">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-x" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="drawer-b">{children}</div>
        {footer ? <div className="drawer-f">{footer}</div> : null}
      </div>
    </>
  );
}

export function Modal({ title, onClose, children, footer, dismissible = true }: DialogProps & { dismissible?: boolean }) {
  const titleId = useId();
  // Writes inside the dialog (an upload in a command's form) whose outcome isn't known yet hold it open too.
  const [nested, setNested] = useState(0);
  const change = useCallback((delta: number) => setNested((count) => Math.max(0, count + delta)), []);
  const open = dismissible && nested === 0;
  const close = () => {
    if (open) onClose();
  };
  const { panel, onKeyDown } = useDialogFocus(close);
  return (
    <UnsettledScope value={change}>
      <NestedHeld value={nested > 0}>
      <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel} tabIndex={-1} onKeyDown={onKeyDown}>
          <div className="modal-h">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="modal-x" aria-label="Close" onClick={close} disabled={!open} title={open ? undefined : NOT_DISMISSIBLE}><Icon name="x" /></button>
          </div>
          <div className="modal-b">{children}</div>
          {footer ? <div className="modal-f">{footer}</div> : null}
        </div>
      </div>
      </NestedHeld>
    </UnsettledScope>
  );
}
