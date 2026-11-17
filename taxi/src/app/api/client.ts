import { z } from "zod";
import { apiErrorBodySchema, type AnyRoute, type ApiErrorBody, type ApiErrorCode } from "#shared";

// The browser's API client: a route from the shared route table, its params and body, and the answer parsed with the
// route's own schema. A 401 means the app was opened outside Insulin Apps: the app swaps every page for the message
// that says so (auth/AuthProvider.tsx listens here).

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network_error" | "contract_mismatch",
    message: string,
    readonly body: ApiErrorBody | null = null,
  ) {
    super(message);
  }
}

const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

type ParamsOf<R extends AnyRoute> = R["params"] extends z.ZodType ? { params: z.input<R["params"]> } : { params?: undefined };
type BodyOf<R extends AnyRoute> = R["body"] extends z.ZodType ? { body: z.input<R["body"]> } : { body?: undefined };
type ResultOf<R extends AnyRoute> = R["response"] extends z.ZodType ? z.infer<R["response"]> : void;
/** A route that takes a file rather than JSON (uploadDocument) gets its bytes, type and extra headers here. */
export interface RawBody {
  body: Blob;
  contentType: string;
  headers?: Record<string, string>;
}
export type RequestOf<R extends AnyRoute> = ParamsOf<R> & BodyOf<R> & { signal?: AbortSignal; raw?: RawBody };

export function routePath(route: AnyRoute, params: Record<string, unknown> = {}): string {
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name: string) => encodeURIComponent(String(params[name])));
}

export async function apiRequest<R extends AnyRoute>(route: R, request: RequestOf<R>): Promise<ResultOf<R>> {
  const { params, body, signal, raw } = request as { params?: Record<string, unknown>; body?: unknown; signal?: AbortSignal; raw?: RawBody };
  let response: Response;
  try {
    response = await fetch(routePath(route, params), {
      method: route.method,
      credentials: "same-origin",
      headers: raw
        ? { Accept: "application/json", "Content-Type": raw.contentType, ...raw.headers }
        : { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Couldn't reach the server. Check your connection and try again.");
  }
  if (response.status === 401) for (const listener of [...unauthorizedListeners]) listener();
  if (!response.ok) {
    const parsed = apiErrorBodySchema.safeParse(await response.json().catch(() => null));
    if (parsed.success) throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data);
    throw new ApiError(response.status, "internal", "Something went wrong. Try again in a moment.");
  }
  if (route.response === null) return undefined as ResultOf<R>;
  const result = (route.response as z.ZodType).safeParse(await response.json().catch(() => null));
  if (!result.success) throw new ApiError(response.status, "contract_mismatch", "The server's answer didn't match the API contract.");
  return result.data as ResultOf<R>;
}

/** The message to show for a failed call, with each field's issue when the server named them. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Try again in a moment.";
}
