import { API_ERROR_STATUS, type ApiErrorBody, type ApiErrorCode } from "#shared";
import type { ZodType } from "zod";

/** A refusal the API answers with its error envelope; anything else is a 500 with no detail. */
export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.status = API_ERROR_STATUS[code];
  }

  toResponse(): Response {
    const body: ApiErrorBody = { error: { code: this.code, message: this.message, ...(this.issues ? { issues: this.issues } : {}) } };
    return Response.json(body, { status: this.status });
  }
}

export const notFound = (message = "Not found") => new ApiError("not_found", message);
export const forbidden = (message = "You do not have permission to do that") => new ApiError("forbidden", message);
export const conflict = (message: string) => new ApiError("conflict", message);

const MAX_BODY_BYTES = 64 * 1024;

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

/** Parses a value against a schema, refusing it as `validation_failed` with each issue's path. */
export function parseOr400<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("validation_failed", `The ${what} is invalid`, issuesOf(result.error));
  return result.data;
}

/** Reads a JSON body of at most 64 KiB, enforced on the bytes read rather than a Content-Length. */
export async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    throw new ApiError("validation_failed", "Expected an application/json body");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader?.read();
    if (!next || next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader?.cancel();
      throw new ApiError("payload_too_large", "Request body is too large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid JSON");
  }
}

/** Internal failures go to stderr with their stack; never pass request bodies or personal data in `fields`. */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({ event, ...fields, name: failure.name, stack: failure.stack ?? failure.message }));
}

/** Whether a D1 error is the named constraint failing (a CHECK, or a UNIQUE index by its columns). */
export function isConstraintError(error: unknown, name: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (/constraint/i.test(current.message) && current.message.includes(name)) return true;
  }
  return false;
}
