import { useEffect, useRef, useState } from "react";
import { isAbortError } from "../api/request.ts";
import { useResource } from "./useResource.ts";

// A list the API returns page by page with an opaque cursor: the first page
// loads on mount and `loadMore` appends the next. A failed page leaves the cursor where it was, so pressing the button
// again retries it. To start over (another org, other filters), remount the component with a new `key`.

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorPages<T> {
  loaded: boolean;
  error: unknown;
  reload: () => void;
  items: T[];
  nextCursor: string | null;
  loadMore: () => Promise<void>;
  loadingMore: boolean;
  moreError: unknown;
}

export function useCursorPages<T>(
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>,
  keyOf: (item: T) => string,
): CursorPages<T> {
  // `load` is fixed for the component's life: callers remount to change it.
  const first = useResource((signal) => load(undefined, signal), []);
  const [more, setMore] = useState<CursorPage<T> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  // A row can shift onto the next page while paging; show it once.
  const seen = new Set<string>();
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])].filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const nextCursor = more ? more.nextCursor : (first.data?.nextCursor ?? null);

  async function loadMore() {
    if (nextCursor === null || loadingMore) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await load(nextCursor, current.signal);
      if (current.signal.aborted) return;
      setMore((previous) => ({ items: [...(previous?.items ?? []), ...page.items], nextCursor: page.nextCursor }));
    } catch (error) {
      if (!current.signal.aborted && !isAbortError(error)) setMoreError(error);
    } finally {
      if (!current.signal.aborted) setLoadingMore(false);
    }
  }

  return { loaded: first.data !== undefined, error: first.error, reload: first.reload, items, nextCursor, loadMore, loadingMore, moreError };
}
