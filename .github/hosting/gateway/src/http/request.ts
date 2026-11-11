import type { Context } from '../context.ts'
import { ownOrigin } from '../context.ts'

export const FORM_LIMIT_BYTES = 16 * 1024

export function isFormBody(request: Request): boolean {
  return /^application\/x-www-form-urlencoded(\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')
}

export function isJsonBody(request: Request): boolean {
  return /^application\/json(\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')
}

export function wantsJson(request: Request): boolean {
  return /\bapplication\/json\b/i.test(request.headers.get('Accept') ?? '')
}

/**
 * A state-changing request must come from this host's own origin: the Origin header equals the request's origin and,
 * when the browser sends Sec-Fetch-Site, it says same-origin. Missing or `null` origins are refused.
 */
export function isSameOrigin(ctx: Context): boolean {
  const origin = ctx.request.headers.get('Origin')
  const site = ctx.request.headers.get('Sec-Fetch-Site')
  return origin === ownOrigin(ctx) && (site === null || site === 'same-origin')
}

export class BodyTooLarge extends Error {
  override name = 'BodyTooLarge'
}

/** Reads a small request body as text, enforcing the limit even without Content-Length. */
export async function readText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('Content-Length') ?? 0) > maxBytes) throw new BodyTooLarge()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      // The rest is left for drainUnread, so the connection survives the 413.
      reader.releaseLock()
      throw new BodyTooLarge()
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

/** How much of an unread request body drainUnread reads and discards; past it, the connection may close. */
export const DRAIN_LIMIT_BYTES = 256 * 1024

/**
 * Reads and discards what a handler left unread of the request body (a refused POST, an oversized form) before the
 * response goes out. workerd closes a connection whose request body was left unread, and the next request on it
 * fails ("other side closed" in Miniflare). A body handed on to an app Worker is locked and left alone.
 */
export async function drainUnread(request: Request): Promise<void> {
  const body = request.body
  if (!body || body.locked) return
  const reader = body.getReader()
  try {
    for (let read = 0; read <= DRAIN_LIMIT_BYTES;) {
      const { done, value } = await reader.read()
      if (done) return
      read += value.byteLength
    }
    await reader.cancel()
  } catch {
    // The client went away mid-body: there is no connection left to keep.
  }
}

/** A form field as a string, or '' when absent; repeated fields keep the first value. */
export function field(form: URLSearchParams, name: string): string {
  return form.get(name) ?? ''
}
