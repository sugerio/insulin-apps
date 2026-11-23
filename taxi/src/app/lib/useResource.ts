import { useCallback, useEffect, useRef, useState } from "react";

export type Resource<T> =
  | { status: "loading"; reload: () => void }
  | { status: "ready"; data: T; reload: () => void; replace: (data: T) => void }
  | { status: "error"; error: unknown; reload: () => void };

/**
 * Loads `load` when the component mounts and whenever `key` changes; `reload` loads it again, and `replace` swaps in
 * data a write returned, without another request. An answer for an older key is dropped.
 */
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ key: string; status: "loading" } | { key: string; status: "ready"; data: T } | { key: string; status: "error"; error: unknown }>({
    key,
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, status: "loading" });
    loader.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, status: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, status: "error", error });
      },
    );
    return () => controller.abort();
  }, [key, attempt]);
  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  const replace = useCallback((data: T) => setState({ key, status: "ready", data }), [key]);
  if (state.key !== key || state.status === "loading") return { status: "loading", reload };
  if (state.status === "error") return { status: "error", error: state.error, reload };
  return { status: "ready", data: state.data, reload, replace };
}
