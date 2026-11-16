// insulin-apps-gateway: sign-in, organizations and the app proxy for Insulin Apps.
// Hosts: the apex SITE_DOMAIN (landing, privacy, terms), auth.SITE_DOMAIN (accounts and organizations), and
// <app>.SITE_DOMAIN (proxied to the app Worker over its APP_<APP> service binding). See README.md.
import { loadConfig } from './config.ts'
import type { Env } from './env.ts'
import { reconcileOwnerDomains } from './db/orgs.ts'
import { housekeeping } from './housekeeping.ts'
import { drainUnread } from './http/request.ts'
import { secure } from './http/secure.ts'
import { log, logError } from './log.ts'
import { handleRequest } from './router.ts'
import { HOUSEKEEPING_CRON, tickApps } from './scheduled.ts'
import { runHourlyJobs } from './super/jobs.ts'

export default {
  /**
   * Every response, uncaught failures included, leaves through `secure` (HSTS and the common security headers), after
   * any request body the handler left unread is drained (http/request.ts).
   */
  async fetch(request, env, ctx): Promise<Response> {
    let response: Response
    try {
      response = await handleRequest(request, env, ctx)
    } catch (error) {
      logError('unhandled_error', error)
      response = new Response('Something went wrong. Please try again.\n', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    await drainUnread(request)
    return secure(request, response)
  },

  /**
   * The daily cron (HOUSEKEEPING_CRON) runs the retention cleanup in larger batches and reconciles owner domains
   * (db/orgs.ts); every other trigger, the
   * five-minute one (TICK_CRON), ticks the apps that declare a scheduled path (scheduled.ts, DESIGN.md §8.5) and runs
   * the operator console's hourly work when the hour's run is still unclaimed (super/jobs.ts, DESIGN.md §11.5).
   */
  async scheduled(controller, env, ctx): Promise<void> {
    const loaded = loadConfig(env)
    if (!loaded.ok) return
    if (controller.cron === HOUSEKEEPING_CRON) {
      ctx.waitUntil(housekeeping(loaded.config.db, Date.now(), 2000).catch((error) => logError('housekeeping_failed', error)))
      // Owner domains in the form the organization limit counts by (migrations can only approximate it in SQL).
      ctx.waitUntil(reconcileOwnerDomains(loaded.config.db)
        .then((changed) => log('owner_domains_reconciled', changed))
        .catch((error) => logError('owner_domains_reconcile_failed', error)))
      return
    }
    tickApps(loaded.config, (work) => ctx.waitUntil(work))
    ctx.waitUntil(runHourlyJobs(loaded.config, Date.now()).catch((error) => logError('hourly_jobs_failed', error)))
  },
} satisfies ExportedHandler<Env>
