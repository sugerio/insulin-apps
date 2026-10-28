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
      await reader.cancel()
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

/** A form field as a string, or '' when absent; repeated fields keep the first value. */
export function field(form: URLSearchParams, name: string): string {
  return form.get(name) ?? ''
}
