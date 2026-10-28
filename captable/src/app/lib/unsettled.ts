import { createContext, useCallback, useContext, useEffect, useRef } from "react";

// Writes whose outcome isn't known yet: being sent, being checked, or answered ambiguously (a lost answer). Each holds
// its body and Idempotency-Key in its own component, so while one is open nothing may close it: its dialog isn't
// dismissible and the app doesn't navigate away (UnsettledGuard). The count changes synchronously when the outcome
// becomes known, so a write that succeeded can navigate to its result at once. A write nested inside a dialog (a
// document upload in a command's form) also holds that dialog through UnsettledScope, which the Modal provides.

let open = 0;

/** The nearest dialog a write holds open while it is unsettled: it is told +1 when the write is sent, -1 once settled. */
export const UnsettledScope = createContext<((delta: number) => void) | null>(null);

/** How many writes have an outcome that isn't known yet. */
export function unsettledWrites(): number {
  return open;
}

/** Holds the app on this write while its outcome is unknown: `hold(true)` when it is sent, `hold(false)` once settled. */
export function useWriteHold(): (on: boolean) => void {
  const scope = useContext(UnsettledScope);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const held = useRef(false);
  useEffect(() => () => {
    if (held.current) {
      held.current = false;
      open -= 1;
      scopeRef.current?.(-1);
    }
  }, []);
  return useCallback((on: boolean) => {
    if (held.current === on) return;
    held.current = on;
    open += on ? 1 : -1;
    scopeRef.current?.(on ? 1 : -1);
  }, []);
}
