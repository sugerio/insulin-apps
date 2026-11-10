// The platform's tick (DESIGN.md §8.5). Apps get no cron trigger, so every five minutes the gateway POSTs to the path
// each app declares in `insulin.scheduled`, over its service binding, with the app's id and `x-suger-access-via:
// schedule` and nothing else: no person, organization, role or permissions, and an empty body. The apps run at once,
// each on its own, so a slow or failing app never holds up another.
import type { Config, HostedApp } from './config.ts'
import { scheduleHeaders } from './http/forward.ts'
import { log } from './log.ts'

/** The tick, every five minutes. */
export const TICK_CRON = '*/5 * * * *'
/** The daily retention cleanup (housekeeping.ts), for quiet days. Never at the same minute as a tick. */
export const HOUSEKEEPING_CRON = '17 3 * * *'
/** How long one app's scheduled request may take before the gateway stops waiting for it. */
export const TICK_TIMEOUT_MS = 25_000

/**
 * One app's tick: POST to its scheduled path. Never throws; the log carries the app's name and the status (the HTTP
 * status, `timeout` or `unreachable`) only.
 */
export async function tickApp(config: Pick<Config, 'testMode'>, app: HostedApp, timeoutMs = TICK_TIMEOUT_MS): Promise<void> {
  if (!app.scheduled || !app.service) return
  // The app's own address, as its other requests arrive (an app builds links from it, e.g. to a signed copy).
  const url = `${config.testMode ? 'http:' : 'https:'}//${app.host}${app.scheduled}`
  // The timer aborts the request (so the app's invocation is cancelled where the runtime passes that on) and stops the
  // wait in any case, even if the binding ignored the signal.
  const controller = new AbortController()
  let expire: (reason: unknown) => void = () => {}
  const timeout = new Promise<never>((_, reject) => { expire = reject })
  timeout.catch(() => {})
  const timer = setTimeout(() => {
    const reason = new DOMException('The scheduled request took too long', 'TimeoutError')
    controller.abort(reason)
    expire(reason)
  }, timeoutMs)
  let status: number | string
  try {
    const request = new Request(url, { method: 'POST', headers: scheduleHeaders(app), redirect: 'manual', signal: controller.signal })
    const response = await Promise.race([app.service.fetch(request), timeout])
    status = response.status
    await response.body?.cancel().catch(() => {})
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name
    status = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable'
  } finally {
    clearTimeout(timer)
  }
  log('app_scheduled', { app: app.name, status })
}

/** Ticks every app that declares a scheduled path and has a service binding, each through `waitUntil`. */
export function tickApps(config: Pick<Config, 'testMode' | 'apps'>, waitUntil: (work: Promise<unknown>) => void): void {
  for (const app of config.apps) {
    if (app.scheduled && app.service) waitUntil(tickApp(config, app).catch(() => {}))
  }
}
