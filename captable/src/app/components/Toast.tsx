import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "./Icon.tsx";

// The success toast every write ends with ("a success toast links to the result"). The provider
// sits in the org workspace, so a toast outlives the navigation to the record it links to.

export interface ToastMessage {
  message: string;
  /** The record the write produced or changed. */
  to?: string;
  linkLabel?: string;
  /** "warn": recorded, but not quite as asked, or nothing was done. */
  tone?: "ok" | "warn";
}

interface ToastEntry extends ToastMessage {
  id: number;
}

const ToastContext = createContext<((toast: ToastMessage) => void) | null>(null);

const VISIBLE_MS = 6_500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);
  const show = useCallback((toast: ToastMessage) => {
    const id = next.current++;
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    // A warning stays longer: it says something the admin may need to act on.
    timers.current.set(id, window.setTimeout(() => dismiss(id), toast.tone === "warn" ? VISIBLE_MS * 3 : VISIBLE_MS));
  }, [dismiss]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext value={value}>
      {children}
      {/* A live region present before any toast arrives, so each one is announced; no role="status", which pages use
          for their loading lines. */}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div className={toast.tone === "warn" ? "toast-item warn" : "toast-item"} key={toast.id}>
            <Icon name={toast.tone === "warn" ? "alert" : "check"} />
            <span>{toast.message}</span>
            {toast.to ? <Link to={toast.to} onClick={() => dismiss(toast.id)}>{toast.linkLabel ?? "Open"}</Link> : null}
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}><Icon name="x" /></button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

/** Shows a success toast; outside a provider (a stand-alone test) it does nothing. */
export function useToast(): (toast: ToastMessage) => void {
  return useContext(ToastContext) ?? noop;
}

function noop() {}
