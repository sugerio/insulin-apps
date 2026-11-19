import { openAppD1, readAppEnv } from '#platform'
import { createApp } from './app.ts'
import { engineOf } from './engine/index.ts'
import type { Bindings } from './env.ts'
import { gatewayFetchOf } from './gateway-fetch.ts'
import { waitUntilOf } from './wait-until.ts'

const app = createApp()

/**
 * What Knowledge runs with, from the platform: the D1 binding; the engine (the SUGER_ENGINE service binding, or the
 * in-memory engine in a development build, engine/index.ts); the gateway's service binding for mail, usage reports,
 * limits, members and the organization's integrations (its own answer model); and the deploy's vars.
 */
async function bindings(request: Request): Promise<Bindings> {
  const value = (name: string) => readAppEnv(name)?.trim() || undefined
  const dev = import.meta.env.DEV && readAppEnv('SUGER_ACCESS_MODE') !== 'console'
  return {
    DB: (await openAppD1()) as unknown as D1Database,
    ENGINE: await engineOf(request),
    GATEWAY_FETCH: gatewayFetchOf(request),
    WAIT_UNTIL: waitUntilOf(request),
    PREVIEW: dev,
    TRUST_ORG_ROLE: Boolean(value('SUGER_TRUST_ORG_ROLE')),
    SUPPORT_EMAIL: value('SUGER_SUPPORT_EMAIL'),
    SUGER_APP_TOKEN: value('SUGER_APP_TOKEN'),
    SUGER_MAIL_URL: value('SUGER_MAIL_URL'),
    SUGER_INTEGRATIONS_URL: value('SUGER_INTEGRATIONS_URL'),
    SUGER_METRICS_URL: value('SUGER_METRICS_URL'),
    SUGER_LIMITS_URL: value('SUGER_LIMITS_URL'),
    SUGER_MEMBERS_URL: value('SUGER_MEMBERS_URL'),
    SUGER_MEMBER_STATUS_URL: value('SUGER_MEMBER_STATUS_URL'),
    SUGER_MEMBER_EVENTS_URL: value('SUGER_MEMBER_EVENTS_URL'),
  }
}

/** Every `/api/**` request of the app (src/api.ts): Knowledge's Hono app, with the platform's bindings. */
export async function handleAppRequest(request: Request): Promise<Response> {
  return app.fetch(request, await bindings(request))
}
