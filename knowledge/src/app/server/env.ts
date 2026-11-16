import type { Caller } from './identity.ts'

/** Anything that answers a Request: the SUGER_ENGINE service binding, or the in-memory engine. */
export interface EngineFetcher {
  fetch(request: Request): Promise<Response>
}

/**
 * What Knowledge runs with. src/app/server/router.ts builds it from the platform for every request (the D1 binding,
 * the engine, the gateway's service binding, the deploy's vars); tests build it directly.
 */
export interface Bindings {
  DB: D1Database
  /** The engine; without one, routes that need it answer 503 engine_unavailable. */
  ENGINE?: EngineFetcher
  /** The gateway's service binding's fetch (mail, usage reports, limits, members); the global fetch without it. */
  GATEWAY_FETCH?: typeof fetch
  /** How the organization's own model is called (tests replace it); without it, the platform's proxy over the gateway. */
  INTEGRATION_FETCH?: (key: string) => typeof fetch
  /** SUGER_INTEGRATIONS_URL: the platform's integration proxy (DESIGN.md §6), reached over the gateway binding. */
  SUGER_INTEGRATIONS_URL?: string
  /** How web pages are fetched (tests replace it). */
  WEB_FETCH?: typeof fetch
  /** The request's waitUntil, when the runtime gives one. */
  WAIT_UNTIL?: (work: Promise<unknown>) => void
  /** The local preview: no platform identity means its stand-in organization owner (identity.ts). */
  PREVIEW?: boolean
  /** SUGER_TRUST_ORG_ROLE: honour x-suger-org-role (organization owners' powers). */
  TRUST_ORG_ROLE?: boolean
  /** SUGER_SUPPORT_EMAIL: Insulin Apps support, named in every limit message; absent, the message names no address. */
  SUPPORT_EMAIL?: string
  SUGER_APP_TOKEN?: string
  SUGER_MAIL_URL?: string
  SUGER_METRICS_URL?: string
  SUGER_LIMITS_URL?: string
  SUGER_MEMBERS_URL?: string
  SUGER_MEMBER_STATUS_URL?: string
  SUGER_MEMBER_EVENTS_URL?: string
  /** The clock (tests move it). */
  NOW?: () => number
  /**
   * The tick's deadline (Date.now() time), set on the tick's own copy of the bindings: engine and platform calls made
   * with it are given up at that time, their bodies included.
   */
  DEADLINE?: number
}

export type AppEnv = { Bindings: Bindings; Variables: { caller: Caller } }

export const nowOf = (env: Bindings) => (env.NOW ?? Date.now)()
