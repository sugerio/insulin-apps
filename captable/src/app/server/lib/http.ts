import type { ApiErrorBody, ApiErrorCode } from "#shared";
import type { Context } from "hono";
import type { ZodType } from "zod";

const STATUS: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  self_dealing: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  digest_mismatch: 422,
  invariant_violation: 422,
  warnings_unacknowledged: 422,
  unavailable: 503,
  internal: 500,
};

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly issues?: { path: string; message: string }[],
    readonly details?: {
      reason?: string;
      violations?: { code: string; message: string }[];
      warnings?: { code: string; message: string; details?: Record<string, unknown> }[];
    },
  ) {
    super(message);
    this.status = STATUS[code];
  }

  toResponse(headers?: HeadersInit): Response {
    const body: ApiErrorBody = { error: { code: this.code, message: this.message } };
    if (this.code === "validation_failed") {
      body.error.issues = this.issues?.length ? this.issues : [{ path: "", message: this.message }];
    } else if (this.issues) body.error.issues = this.issues;
    if (this.details?.reason) body.error.reason = this.details.reason;
    if (this.details?.violations) body.error.violations = this.details.violations;
    if (this.details?.warnings) body.error.warnings = this.details.warnings;
    const responseHeaders = new Headers(headers);
    return Response.json(body, { status: this.status, headers: responseHeaders });
  }
}

export const notFound = (message = "Not found") => new ApiError("not_found", message);
export const forbidden = (message = "You do not have permission to do that") => new ApiError("forbidden", message);

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

/** Reads UTF-8 and enforces the limit even without Content-Length. */
export async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

export async function readJson<T>(
  c: Context,
  schema: ZodType<T>,
  maxBytes = 256 * 1024,
  validationError?: (input: unknown, issues: { path: string; message: string }[]) => ApiError | undefined,
): Promise<T> {
  if (!/^application\/json(\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
    throw new ApiError("validation_failed", "Expected an application/json body");
  }
  let text: string;
  try {
    text = await readBodyText(c.req.raw, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new ApiError("payload_too_large", "Request body is too large");
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid JSON");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = issuesOf(result.error);
    throw validationError?.(json, issues) ?? new ApiError("validation_failed", "Some fields are invalid", issues);
  }
  return result.data;
}

export function clientIp(c: Context): string | null {
  return c.req.header("CF-Connecting-IP") ?? null;
}

export function userAgent(c: Context): string | null {
  return c.req.header("User-Agent")?.slice(0, 500) ?? null;
}

/** Structured log line; never pass secrets, codes, or assertion contents. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Internal failures go to stderr with their stack; callers must keep fields free of request bodies and personal data. */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({ event, ...fields, name: failure.name, stack: failure.stack ?? failure.message }));
}
