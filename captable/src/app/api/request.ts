import type { ApiErrorCode } from "#shared";
import { api } from "#shared";
import { ApiError, handleUnauthorized } from "./client.ts";

// The typed client the API contract declares (`api.ApiRequest`): a route from `api.routes` plus its params, query and
// body, checked against the route's own schemas on the way out and on the way back. Paths come from the route table,
// mutating calls carry an Idempotency-Key per user intent, non-2xx answers become `ApiRequestError` with the parsed
// error envelope, and a 401 swaps the app for the "open it from the console" page.

/** A refused call: the HTTP status, the error code and the parsed envelope (null when the body wasn't one). */
export class ApiRequestError extends ApiError implements api.ApiFailure {
  override name = "ApiRequestError";
  constructor(
    status: number,
    code: ApiError["code"],
    message: string,
    readonly body: api.ApiErrorBody | null,
  ) {
    super(status, code, message, body?.error.reason ?? null);
  }
}

/** The answer didn't match the contract: a server bug, never something the person can fix. */
export const CONTRACT_MISMATCH = "The server's answer didn't match the API contract.";

const STATUS_CODES: Partial<Record<number, ApiErrorCode>> = {
  400: "validation_failed",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "invariant_violation",
  503: "unavailable",
};

/** One key per user intent (a UUIDv4): reuse it to retry the same intent. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface LooseRequest {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  dryRun?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function localError(status: 400 | 404, code: "validation_failed" | "not_found", message: string, issues?: { path: string; message: string }[]) {
  return new ApiRequestError(status, code, message, { error: { code, message, ...(issues ? { issues } : {}) } });
}

/** `route.path` with its `:params` filled in. A param that fails its schema is a 404, as the server answers. */
export function routePath(route: api.AnyRoute, params: Record<string, unknown> = {}): string {
  if (route.params) {
    const check = route.params.safeParse(params);
    if (!check.success) throw localError(404, "not_found", "Not found");
  }
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name: string) => encodeURIComponent(String(params[name])));
}

function queryString(route: api.AnyRoute, request: LooseRequest): string {
  if (request.dryRun) return "?dryRun=true";
  if (!route.query || !request.query) return "";
  const check = route.query.safeParse(request.query);
  if (!check.success) throw localError(400, "validation_failed", "The request's query is invalid.", issuesOf(check.error));
  // The input is sent, not the parsed output, so defaults (limit=50, tab=ownership) stay the server's.
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function bodyOf(route: api.AnyRoute, request: LooseRequest, headers: Record<string, string>): BodyInit | undefined {
  const body = route.body;
  if (body.kind === "json") {
    const schema = request.dryRun && body.dryRunSchema ? body.dryRunSchema : body.schema;
    const check = schema.safeParse(request.body ?? {});
    if (!check.success) throw localError(400, "validation_failed", "Check the highlighted fields.", issuesOf(check.error));
    headers["Content-Type"] = "application/json";
    return JSON.stringify(request.body ?? {});
  }
  if (body.kind === "raw") {
    for (const [name, value] of Object.entries(request.headers ?? {})) if (value !== undefined) headers[name] = value;
    return request.body as BodyInit;
  }
  if (body.kind === "form") {
    const check = body.schema.safeParse(request.body ?? {});
    if (!check.success) throw localError(400, "validation_failed", "Check the files you chose.", issuesOf(check.error));
    // No Content-Type of ours: the browser writes multipart/form-data with the boundary it chose.
    return formData((request.body ?? {}) as Record<string, unknown>);
  }
  return undefined;
}

/** A form body as multipart fields: a list repeats its field (one `files` part per file), files keep their names. */
export function formData(fields: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      if (item instanceof Blob) form.append(name, item, item instanceof File ? item.name : name);
      else form.append(name, String(item));
    }
  }
  return form;
}

async function failure(response: Response): Promise<ApiRequestError> {
  const raw: unknown = await response.json().catch(() => null);
  const parsed = api.apiErrorBodySchema.safeParse(raw);
  const body = parsed.success ? parsed.data : null;
  return new ApiRequestError(
    response.status,
    body?.error.code ?? STATUS_CODES[response.status] ?? "internal",
    body?.error.message ?? "Something went wrong.",
    body,
  );
}

function contractError(status: number, detail: unknown): ApiRequestError {
  // The issues help whoever reads the browser console; the person sees a fixed sentence.
  console.error(CONTRACT_MISMATCH, detail);
  return new ApiRequestError(status, "internal", CONTRACT_MISMATCH, null);
}

async function call<R extends api.AnyRoute>(route: R, request: api.RouteRequest<R>): Promise<api.RouteResult<R>> {
  const req = request as LooseRequest;
  const headers: Record<string, string> = { Accept: "application/json" };
  const url = `${routePath(route, req.params)}${queryString(route, req)}`;
  const body = bodyOf(route, req, headers);
  if (route.idempotency === "required" || (route.idempotency === "required_unless_dry_run" && !req.dryRun)) {
    headers["Idempotency-Key"] = req.idempotencyKey ?? newIdempotencyKey();
  }
  let response: Response;
  try {
    response = await fetch(url, { method: route.method, credentials: "same-origin", cache: "no-store", headers, body, signal: req.signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError(0, "network_error", "Could not reach Cap Table.", null);
  }
  if (!response.ok) {
    const error = await failure(response);
    if (response.status === 401) handleUnauthorized();
    throw error;
  }
  const spec: api.ResponseSpec = route.response;
  type Result = api.RouteResult<R>;
  switch (spec.kind) {
    case "json": {
      const json: unknown = await response.json().catch(() => undefined);
      const parsed = spec.schema.safeParse(json);
      if (!parsed.success) throw contractError(response.status, parsed.error.issues);
      return parsed.data as Result;
    }
    case "empty":
      return undefined as Result;
    case "file": {
      const fileHeaders = Object.fromEntries(response.headers.entries());
      const parsed = spec.headers.safeParse(fileHeaders);
      if (!parsed.success) throw contractError(response.status, parsed.error.issues);
      return response as Result;
    }
  }
}

/** Calls one route of the contract. Rejects with `ApiRequestError` on a refusal and on an answer that breaks the contract. */
export const apiRequest: api.ApiRequest = call;

/** The name a download asks to be saved as (`filename*=UTF-8''…`, RFC 5987). */
export function attachmentName(disposition: string | null): string | null {
  const match = disposition ? /filename\*=UTF-8''([^;\s]+)/i.exec(disposition) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/**
 * Runs a file route (an export or a document download) and saves the bytes. The file is never rendered: it goes from
 * a Blob straight to the browser's download, under the name the server gives it.
 */
export async function saveFile<R extends api.AnyRoute>(route: R, request: api.RouteRequest<R>, fallbackName: string): Promise<string> {
  const response = (await apiRequest(route, request)) as unknown as Response;
  const name = attachmentName(response.headers.get("content-disposition")) ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return name;
}
