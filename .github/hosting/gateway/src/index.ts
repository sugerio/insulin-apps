// insulin-apps-gateway: sign-in, organizations and the app proxy for Insulin Apps.
// Hosts: the apex SITE_DOMAIN (landing, privacy, terms), auth.SITE_DOMAIN (accounts and organizations), and
// <app>.SITE_DOMAIN (proxied to the app Worker over its APP_<APP> service binding). See README.md.
import { loadConfig } from './config.ts'
import type { Env } from './env.ts'
import { housekeeping } from './housekeeping.ts'
import { secure } from './http/secure.ts'
import { logError } from './log.ts'
import { handleRequest } from './router.ts'

export default {
  /** Every response, uncaught failures included, leaves through `secure` (HSTS and the common security headers). */
  async fetch(request, env, ctx): Promise<Response> {
    let response: Response
    try {
      response = await handleRequest(request, env, ctx)
    } catch (error) {
      logError('unhandled_error', error)
      response = new Response('Something went wrong. Please try again.\n', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    return secure(request, response)
  },

  /** Optional: with a cron trigger, the retention cleanup also runs on a schedule, in larger batches. */
  async scheduled(_controller, env, ctx): Promise<void> {
    const loaded = loadConfig(env)
    if (loaded.ok) ctx.waitUntil(housekeeping(loaded.config.db, Date.now(), 2000).catch((error) => logError('housekeeping_failed', error)))
  },
} satisfies ExportedHandler<Env>
