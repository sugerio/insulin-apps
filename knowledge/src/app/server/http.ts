import type { Context } from 'hono'
import type { ZodType } from 'zod'

/**
 * Errors as JSON in plain words: `{ error, message }`, with the status the code implies. `error` is a stable code for
 * programs (AI assistants and API clients act on it); `message` says, for a person, what happened and what to do.
 * Raw error text from below (the engine, the platform, the database) never reaches a response: it goes to the log.
 */
export type ErrorCode =
  | 'bad_request'
  | 'collection_required'
  | 'too_many_collections'
  | 'idempotency_key_required'
  | 'unauthorized'
  | 'forbidden'
  | 'browser_only'
  | 'assistants_off'
  | 'not_found'
  | 'conflict'
  | 'idempotency_key_reused'
  | 'deleting'
  | 'not_restorable'
  | 'busy_learning'
  | 'version_changed'
  | 'payload_too_large'
  | 'unsupported_type'
  | 'quota_exceeded'
  | 'capacity'
  | 'engine_unavailable'
  | 'not_configured'
  | 'unreachable'
  | 'internal'

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  collection_required: 400,
  too_many_collections: 400,
  idempotency_key_required: 400,
  unauthorized: 401,
  forbidden: 403,
  browser_only: 403,
  assistants_off: 403,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  deleting: 409,
  not_restorable: 409,
  busy_learning: 409,
  version_changed: 409,
  payload_too_large: 413,
  unsupported_type: 415,
  quota_exceeded: 429,
  capacity: 429,
  engine_unavailable: 503,
  not_configured: 503,
  unreachable: 502,
  internal: 500,
}

export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number

  constructor(readonly code: ErrorCode, message: string, readonly extra: Record<string, unknown> = {}, status?: number) {
    super(message)
    this.status = status ?? STATUS[code]
  }

  toResponse(): Response {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store' }
    const retry = this.extra.retryAfterSeconds
    if (typeof retry === 'number' && retry > 0) headers['retry-after'] = String(Math.ceil(retry))
    return new Response(JSON.stringify({ error: this.code, message: this.message, ...this.extra }), { status: this.status, headers })
  }
}

export const badRequest = (message: string, extra?: Record<string, unknown>) => new ApiError('bad_request', message, extra)
export const forbidden = (message = "You don't have permission to do that.") => new ApiError('forbidden', message)
export const notFound = (message = "There's nothing here. It may have been deleted, or the link is wrong.") => new ApiError('not_found', message)
export const browserOnly = () =>
  new ApiError('browser_only', 'This can only be done by a person on the Knowledge site, not by an AI assistant or an API client.')

export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError'
}

/** Reads a body as UTF-8 within a limit, even without Content-Length. */
export async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw new BodyTooLargeError()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** The JSON body, checked against a schema; an empty body counts as `{}`. Refusals name the field in plain words. */
export async function readJson<T>(c: Context, schema: ZodType<T>, maxBytes = 256 * 1024): Promise<T> {
  let text: string
  try {
    text = await readBodyText(c.req.raw, maxBytes)
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new ApiError('payload_too_large', 'That request is too large.')
    throw error
  }
  if (text.trim() && !/^application\/json(\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw badRequest('Send the request as JSON (Content-Type: application/json).')
  }
  let value: unknown = {}
  if (text.trim()) {
    try {
      value = JSON.parse(text)
    } catch {
      throw badRequest("The request isn't valid JSON.")
    }
  }
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue?.path.map(String).join('.') || 'the request'
    throw badRequest(`Check ${field}: ${issue?.message ?? 'it is not valid'}.`, {
      issues: result.error.issues.map((item) => ({ path: item.path.map(String).join('.'), message: item.message })),
    })
  }
  return result.data
}

/** A structured log line; never pass request bodies, names, addresses or text from a collection. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const failure = error instanceof Error ? error : new Error(String(error))
  console.error(JSON.stringify({ event, ...fields, name: failure.name, stack: failure.stack ?? failure.message }))
}
