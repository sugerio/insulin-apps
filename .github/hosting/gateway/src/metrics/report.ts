// Usage reports from apps (DESIGN.md §8.6): POST https://<apex>/__insulin/metrics. The operator console never reads an
// app's database, so each app pushes a few numbers every hour instead: gauges for the app as a whole (its database's
// size, say) and per organization (records, bytes stored), never content. The app sends them with its SUGER_APP_TOKEN,
// over the SUGER_GATEWAY binding, from its five-minute tick.
import type { Context } from '../context.ts'
import { isId } from '../crypto.ts'
import { HOUR_MS, storeReport, type Metrics } from '../db/metrics.ts'
import { BodyTooLarge, isJsonBody, readText } from '../http/request.ts'
import { jsonResponse } from '../http/response.ts'
import { appForToken } from '../integrations/proxy.ts'
import { log } from '../log.ts'
import { bearerToken } from '../oauth/tokens.ts'
import { allowApp } from '../ratelimit.ts'

export const BODY_LIMIT_BYTES = 512 * 1024
/** Organizations per request: a larger report is sent as several requests for the same hour. */
export const ORGANIZATIONS_PER_REPORT = 500
export const METRICS_PER_OBJECT = 20
export const METRIC_NAME = /^[a-z][a-z0-9_]{0,39}$/
const VALUE_MAX = 1e15
/** How old a report's hour may be (an app catching up after an outage), and how far ahead a clock may run. */
const MAX_AGE_MS = 7 * 24 * HOUR_MS
const CLOCK_SKEW_MS = 5 * 60 * 1000
const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/

function problem(error: string, status: number, detail?: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(detail ? { error, detail } : { error }, status, headers)
}

/** A metrics object: at most 20 entries, each a lower-case name and a finite number from 0 to 10^15. Null otherwise. */
export function readMetrics(value: unknown): Metrics | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > METRICS_PER_OBJECT) return null
  const metrics: Metrics = {}
  for (const [name, number] of entries) {
    if (!METRIC_NAME.test(name) || typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > VALUE_MAX) return null
    metrics[name] = number
  }
  return metrics
}

type Parsed = { hour: number; appMetrics: Metrics | null; organizations: { id: string; metrics: Metrics }[] }

/** The report, or the reason it is refused (for the app's logs: it names the field, never echoes a value). */
export function readReport(value: unknown, now: number): Parsed | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'the body must be a JSON object'
  const body = value as Record<string, unknown>
  const unknown = Object.keys(body).filter((key) => key !== 'hour' && key !== 'app' && key !== 'organizations')
  if (unknown.length) return 'unknown field'
  if (typeof body.hour !== 'string' || !HOUR_PATTERN.test(body.hour)) return 'hour must be the top of a UTC hour, like 2026-01-01T10:00:00Z'
  const hour = Date.parse(body.hour)
  if (Number.isNaN(hour) || hour % HOUR_MS !== 0) return 'hour is not a valid time'
  if (hour > now + CLOCK_SKEW_MS) return 'hour is in the future'
  if (hour < now - MAX_AGE_MS) return 'hour is more than seven days old'
  let appMetrics: Metrics | null = null
  if (body.app !== undefined) {
    appMetrics = readMetrics(body.app)
    if (!appMetrics) return 'app must be an object of at most 20 metrics, each a lower-case name and a number from 0 to 10^15'
  }
  const organizations: Parsed['organizations'] = []
  if (body.organizations !== undefined) {
    if (!Array.isArray(body.organizations) || body.organizations.length > ORGANIZATIONS_PER_REPORT) {
      return `organizations must be an array of at most ${ORGANIZATIONS_PER_REPORT}`
    }
    const seen = new Set<string>()
    for (const entry of body.organizations) {
      const item = (typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>
      if (!isId(item.id) || seen.has(item.id) || Object.keys(item).some((key) => key !== 'id' && key !== 'metrics')) {
        return 'each organization needs a unique organization id and its metrics'
      }
      const metrics = readMetrics(item.metrics)
      if (!metrics) return 'an organization\'s metrics must be an object of at most 20 metrics, each a lower-case name and a number from 0 to 10^15'
      seen.add(item.id)
      organizations.push({ id: item.id, metrics })
    }
  }
  if (!appMetrics && !organizations.length) return 'the report holds no metrics'
  return { hour, appMetrics, organizations }
}

export async function appMetricsReport(ctx: Context): Promise<Response> {
  if (ctx.site !== 'apex') return problem('not_found', 404)
  if (ctx.request.method !== 'POST') return problem('method_not_allowed', 405, undefined, { Allow: 'POST' })
  const master = ctx.config.secretKey
  if (!master) return problem('not_configured', 503)
  const app = await appForToken(ctx, master, bearerToken(ctx.request))
  if (!app) return problem('unauthorized', 401)
  if (!(await allowApp(ctx, `metrics:${app.name}`))) return problem('rate_limited', 429, undefined, { 'Retry-After': '60' })
  if (!isJsonBody(ctx.request)) return problem('invalid_request', 400, 'send JSON')
  let parsed: Parsed | string
  try {
    parsed = readReport(JSON.parse(await readText(ctx.request, BODY_LIMIT_BYTES)), ctx.now)
  } catch (error) {
    if (error instanceof BodyTooLarge) return problem('too_large', 413)
    if (error instanceof SyntaxError) return problem('invalid_request', 400, 'the body is not JSON')
    throw error
  }
  if (typeof parsed === 'string') {
    log('app_metrics_refused', { app: app.name })
    return problem('invalid_request', 400, parsed)
  }
  const stored = await storeReport(ctx.config.db, { app: app.name, ...parsed, now: ctx.now })
  log('app_metrics', { app: app.name, hour: parsed.hour, organizations: stored })
  return jsonResponse({ status: 'accepted', organizations: stored, skipped: parsed.organizations.length - stored }, 202)
}
