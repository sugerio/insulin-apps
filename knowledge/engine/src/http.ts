// Small HTTP helpers shared by the Worker and its Durable Objects. Errors are the contract's EngineError.

import type { EngineError, EngineErrorCode } from './contract.ts'

const STATUS: Record<EngineErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  deleting: 409,
  not_restorable: 409,
  busy_learning: 409,
  capacity: 429,
  too_large: 413,
  unsupported_type: 415,
  model_unavailable: 503,
  stale_settings: 409,
  internal: 500,
}

export class EngineFailure extends Error {
  code: EngineErrorCode
  status: number
  retryAfterSeconds: number | undefined

  constructor(code: EngineErrorCode, message: string, retryAfterSeconds?: number) {
    super(message)
    this.code = code
    this.status = STATUS[code]
    this.retryAfterSeconds = retryAfterSeconds
  }

  toBody(): EngineError {
    return this.retryAfterSeconds === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, retryAfterSeconds: this.retryAfterSeconds }
  }
}

export const fail = (code: EngineErrorCode, message: string, retryAfterSeconds?: number): never => {
  throw new EngineFailure(code, message, retryAfterSeconds)
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof EngineFailure) {
    const headers: Record<string, string> = error.retryAfterSeconds === undefined ? {} : { 'retry-after': String(error.retryAfterSeconds) }
    return json(error.toBody(), error.status, headers)
  }
  console.error('engine request failed:', error)
  return json({ error: 'internal', message: 'Something went wrong in the engine. Try again in a moment.' } satisfies EngineError, 500)
}

export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    return fail('bad_request', 'The request body is not valid JSON.')
  }
}

/** Ids we put in R2 keys, Durable Object names and container paths. */
export const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/
/** Organization ids: UUIDs or similar opaque ids. */
export const SAFE_ORG = /^[A-Za-z0-9._-]{1,128}$/

export function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
    return fail('bad_request', `${what} must be 1 to 128 letters, digits, dots, dashes or underscores.`)
  }
  return value
}
