// HTTP for the endpoints that machines call (OAuth metadata, registration, token and revocation; MCP): JSON in and out,
// CORS open to every origin because no cookie is ever read or set on them, and RFC 6749 error bodies.
import type { Context } from '../context.ts'
import { BodyTooLarge, isFormBody, isJsonBody, readText } from '../http/request.ts'
import { jsonResponse } from '../http/response.ts'

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
}

export function corsJson(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return jsonResponse(data, status, { ...CORS, Pragma: 'no-cache', ...extra })
}

/** An RFC 6749 §5.2 error. */
export function oauthError(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return corsJson({ error, error_description: description }, status, extra)
}

/** The answer to a CORS preflight on these endpoints. */
export function preflight(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
      'Access-Control-Max-Age': '600',
    },
  })
}

/** A small form or JSON body as string fields (JSON values that aren't strings are left out), or the error to send. */
export async function readParams(ctx: Context, limit = 16 * 1024): Promise<Record<string, string> | Response> {
  const json = isJsonBody(ctx.request)
  if (!json && !isFormBody(ctx.request)) return oauthError('invalid_request', 'Send the parameters as a form or as JSON.', 415)
  let text: string
  try {
    text = await readText(ctx.request, limit)
  } catch (error) {
    if (error instanceof BodyTooLarge) return oauthError('invalid_request', 'The request is too large.', 413)
    throw error
  }
  if (!json) {
    const params: Record<string, string> = {}
    for (const [name, value] of new URLSearchParams(text)) params[name] ??= value
    return params
  }
  const value = parseJson(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return oauthError('invalid_request', 'The body must be a JSON object.')
  const params: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) if (typeof entry === 'string') params[name] = entry
  return params
}

/** A JSON body of at most `limit` bytes, parsed; undefined when it isn't JSON; the error to send when it's too large. */
export async function readJson(ctx: Context, limit: number): Promise<unknown | Response> {
  if (!isJsonBody(ctx.request)) return undefined
  try {
    return parseJson(await readText(ctx.request, limit))
  } catch (error) {
    if (error instanceof BodyTooLarge) return oauthError('invalid_request', 'The request is too large.', 413)
    throw error
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `url` with these query parameters added (null values left out). */
export function withParams(url: string, params: Record<string, string | null | undefined>): string {
  const target = new URL(url)
  for (const [name, value] of Object.entries(params)) if (value != null) target.searchParams.set(name, value)
  return target.href
}
