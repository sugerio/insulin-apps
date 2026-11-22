import type { Context } from 'hono'
import { EngineClient } from '../engine/client.ts'
import type { AppEnv } from '../env.ts'
import { nowOf } from '../env.ts'
import { ApiError, badRequest } from '../http.ts'
import type { Caller } from '../identity.ts'

export type Ctx = Context<AppEnv>

export const callerOf = (c: Ctx): Caller => c.get('caller')
export const now = (c: Ctx): number => nowOf(c.env)

/** The engine for the caller's organization, or 503 engine_unavailable. */
export function engineFor(c: Ctx, org = callerOf(c).organizationId): EngineClient {
  if (!c.env.ENGINE) throw new ApiError('engine_unavailable', "Knowledge's engine isn't available here, so collections can't be read or changed right now.")
  return new EngineClient(c.env.ENGINE, org)
}

export const json = (c: Ctx, body: unknown, status: 200 | 201 | 202 = 200) => c.json(body as object, status)

/** A route parameter, present by construction. */
export const param = (c: Ctx, name: string): string => c.req.param(name) ?? ''

export const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

/** The header a caller names whom it acts for with (K3). */
export const ON_BEHALF_OF = 'x-on-behalf-of'
/** Its longest value, in characters. */
const ON_BEHALF_OF_MAX = 200

/**
 * `x-on-behalf-of` on a change to a collection's content: whom the caller says it acts for, such as the person who
 * approved what an AI agent wrote ("Ana Lee"). A label and nothing more: it is kept with the import, returned with it
 * and shown in History, and never used to decide access. Trimmed; empty is the same as absent; at most 200 characters
 * and no control characters, or 400 naming the header. A value sent as UTF-8 bytes is read as UTF-8; it isn't
 * percent-decoded.
 */
export function onBehalfOf(c: Ctx): string | null {
  const raw = c.req.header(ON_BEHALF_OF)
  if (raw === undefined) return null
  const value = utf8Header(raw).trim()
  if (!value) return null
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw badRequest(`Check the ${ON_BEHALF_OF} header: it names whom you act for, in one line with no control characters.`, { header: ON_BEHALF_OF })
  }
  if ([...value].length > ON_BEHALF_OF_MAX) {
    throw badRequest(`Check the ${ON_BEHALF_OF} header: it names whom you act for in at most ${ON_BEHALF_OF_MAX} characters.`, { header: ON_BEHALF_OF })
  }
  return value
}

/** A header's value as the bytes it was sent in (each one character, as HTTP gives them), read as UTF-8 when it is. */
function utf8Header(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value, (char) => char.charCodeAt(0)))
  } catch {
    return value
  }
}
