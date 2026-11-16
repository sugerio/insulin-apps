import type { Context } from 'hono'
import { EngineClient } from '../engine/client.ts'
import type { AppEnv } from '../env.ts'
import { nowOf } from '../env.ts'
import { ApiError } from '../http.ts'
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
