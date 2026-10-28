import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { isAbortError } from "../api/request.ts";
import { isApiError } from "./errors.ts";

// Loads a screen's data: `load` runs again when `deps` change (the old data is cleared, so an as-of
// change never shows the previous date's numbers) or on `reload()` (the old data stays until the new arrives, and is
// dropped if the reload fails). Superseded requests are aborted.

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

interface ResourceState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

function sameDeps(a: DependencyList | null, b: DependencyList): boolean {
  return a !== null && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList, enabled = true): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ data: undefined, error: undefined, loading: enabled });
  const [generation, setGeneration] = useState(0);
  const lastDeps = useRef<DependencyList | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState({ data: undefined, error: undefined, loading: false });
      return;
    }
    const controller = new AbortController();
    const depsChanged = !sameDeps(lastDeps.current, deps);
    lastDeps.current = deps;
    setState((previous) => ({ data: depsChanged ? undefined : previous.data, error: undefined, loading: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        // A failed reload drops what was shown: the page says the request failed rather than keep showing figures
        // the server no longer stands behind.
        setState({ data: undefined, error, loading: false });
      },
    );
    return () => controller.abort();
    // `load` is deliberately not a dependency: callers pass an inline function and list what it uses in `deps`.
  }, [...deps, generation, enabled]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

type DataOf<R> = R extends Resource<infer T> ? T : never;

/**
 * Several resources a view needs together: data only once every one has succeeded, so nothing is ever derived from a
 * request that is still loading or that failed (a missing lookup must never read as zero or as an empty list). The
 * first failure is the error; `reload` retries the ones that failed, or all of them when none did.
 */
export function allOf<const R extends readonly Resource<unknown>[]>(...resources: R): Resource<{ -readonly [K in keyof R]: DataOf<R[K]> }> {
  type Data = { -readonly [K in keyof R]: DataOf<R[K]> };
  const ready = resources.every((resource) => resource.data !== undefined);
  const failed = resources.filter((resource) => resource.data === undefined && resource.error !== undefined);
  return {
    data: ready ? (resources.map((resource) => resource.data) as unknown as Data) : undefined,
    error: ready ? undefined : failed[0]?.error,
    loading: resources.some((resource) => resource.loading),
    reload: () => (failed.length ? failed : resources).forEach((resource) => resource.reload()),
  };
}

/**
 * A lookup where 404 means "there is no such record" (a deleted grant behind a migrated request, say): its data is null
 * instead of an error, so the view can say "not found" for that one field. Every other failure stays an error.
 */
export function notFoundAsNull<T>(resource: Resource<T>): Resource<T | null> {
  if (resource.data === undefined && isApiError(resource.error, "not_found")) return { data: null, error: undefined, loading: false, reload: resource.reload };
  return resource;
}
