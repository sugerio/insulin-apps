import type { ApiErrorCode } from "#shared";

export type ClientErrorCode = ApiErrorCode | "network_error";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

// Signing in is the Insulin console's job: the app never sends the browser anywhere (it runs in a sandboxed frame
// that can't navigate the top window). A 401 means the console no longer vouches for the caller, so the app swaps
// every page for the "open this app from the console" message (auth/AuthProvider.tsx listens here).
const unauthorizedListeners = new Set<() => void>();

/** Reports a 401 (also used by the typed client in request.ts). */
export function handleUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) listener();
}

/** Runs `listener` on every 401; returns the unsubscribe. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}
