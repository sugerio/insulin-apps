import { logError } from './http.ts'

/**
 * The hourly usage report to the platform. The platform can't read this database, so its operator console sees Cap
 * Table's usage only through these reports: counts of records and bytes of documents per organization, never a name,
 * an e-mail address, an amount or a document.
 *
 * The platform's tick (`POST /api/scheduled`, every five minutes) calls `reportUsage`. The first tick of each UTC hour
 * claims the hour in `metrics_reports` with one conditional statement, so two overlapping ticks never both send, then
 * sends `POST <SUGER_METRICS_URL>` with the app's token: at most 500 organizations per request, `app` in the first.
 * Every value is a gauge (the total now), and each request replaces the values it carries for that hour, so a report
 * sent twice is harmless. The hour counts as sent once every request was answered 202; otherwise the claim is released
 * and the next tick tries again. Without the URL or the token (the local preview, tests) nothing is reported.
 */
export type MetricsEnv = {
  SUGER_METRICS_URL?: string
  SUGER_APP_TOKEN?: string
  /** The fetch the report is sent with: the gateway's service binding when the deploy gave the app one (gateway-fetch.ts). */
  METRICS_FETCH?: typeof fetch
}

/** What a tick did: nothing to report to, the hour already claimed (or sent), the report sent, or a failure. */
export type UsageReportOutcome = 'not_configured' | 'already_claimed' | 'sent' | 'failed'

const HOUR_MS = 3_600_000
/** An unsent claim this old belongs to a tick that died (the platform gives a tick 25 seconds): the next tick retakes it. */
const STALE_CLAIM_MS = 10 * 60_000
/** Hours older than this are deleted. */
const KEEP_MS = 3 * 24 * HOUR_MS
/**
 * How long the report's requests may take together: well inside the platform's 25 seconds for the tick, so a gateway
 * that doesn't answer still leaves this tick time to release the claim, and the next tick tries again.
 */
const REQUESTS_BUDGET_MS = 15_000
/** The platform takes at most this many organizations in one request. */
export const ORGANIZATIONS_PER_REQUEST = 500

/** Each organization's metrics, in the order they are sent. */
export const ORGANIZATION_METRICS = [
  'companies', 'stakeholders', 'share_classes', 'equity_plans', 'securities', 'transactions', 'documents',
  'storage_bytes', 'valuations', 'exercise_requests',
] as const
export type OrganizationMetric = (typeof ORGANIZATION_METRICS)[number]

/** Rows of a company table, by the console organization that owns the company. */
const countOf = (metric: OrganizationMetric, table: string) =>
  `SELECT o.console_organization_id AS organization_id, count(*) AS ${metric}
   FROM ${table} r JOIN orgs o ON o.id = r.org_id
   WHERE o.console_organization_id IS NOT NULL GROUP BY o.console_organization_id`

/**
 * One GROUP BY over a whole table per query, so the work doesn't grow with the number of organizations; each column
 * other than `organization_id` is a metric. The organization is the console organization that owns the company
 * (`orgs.console_organization_id`). `companies` counts the active company; the other counts take every company of the
 * organization, archived or importing too, because its records are stored all the same. Companies from before
 * organizations belong to nobody and count only in database_bytes. `storage_bytes` adds up the documents' sizes, every
 * version (nothing is deleted), from their recorded byte size rather than by reading the bytes.
 */
const QUERIES = [
  `SELECT console_organization_id AS organization_id, sum(status = 'active') AS companies
   FROM orgs WHERE console_organization_id IS NOT NULL GROUP BY console_organization_id`,
  countOf('stakeholders', 'stakeholders'),
  countOf('share_classes', 'stock_classes'),
  countOf('equity_plans', 'stock_plans'),
  countOf('securities', 'securities'),
  countOf('transactions', 'transactions'),
  `SELECT o.console_organization_id AS organization_id, count(*) AS documents, sum(r.byte_size) AS storage_bytes
   FROM documents r JOIN orgs o ON o.id = r.org_id
   WHERE o.console_organization_id IS NOT NULL GROUP BY o.console_organization_id`,
  countOf('valuations', 'valuations'),
  countOf('exercise_requests', 'exercise_requests'),
]

export interface UsageReport {
  /** The start of the UTC hour the values were measured in, epoch milliseconds. */
  hour: number
  /** The database's size from D1, when it gave one. */
  databaseBytes: number | null
  /** Every organization with a company, by id, with every metric (0 when it has none of those records). */
  organizations: { id: string; metrics: Record<OrganizationMetric, number> }[]
}

/** The platform's address and the app's token, when both are set and the address is https (http only on loopback). */
export function metricsConfig(env: MetricsEnv): { url: string; token: string } | null {
  const url = env.SUGER_METRICS_URL?.trim() ?? '', token = env.SUGER_APP_TOKEN?.trim() ?? ''
  if (!url || !token) return null
  try {
    const parsed = new URL(url)
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname.endsWith('.localhost')
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null
  } catch {
    return null
  }
  return { url, token }
}

/** The start of the UTC hour `now` falls in. */
export const hourOf = (now: number) => Math.floor(now / HOUR_MS) * HOUR_MS

/** Measures every organization's metrics, in one batch of read-only queries. */
export async function measureUsage(db: D1Database, hour: number, databaseBytes: number | null): Promise<UsageReport> {
  const results = await db.batch<Record<string, unknown>>(QUERIES.map((query) => db.prepare(query)))
  const byId = new Map<string, Record<OrganizationMetric, number>>()
  // The first query lists every organization with a company; the others only add to them.
  for (const [index, result] of results.entries()) {
    for (const row of result.results) {
      const id = String(row.organization_id)
      let metrics = byId.get(id)
      if (!metrics) {
        if (index > 0) continue
        metrics = Object.fromEntries(ORGANIZATION_METRICS.map((metric) => [metric, 0])) as Record<OrganizationMetric, number>
        byId.set(id, metrics)
      }
      for (const metric of ORGANIZATION_METRICS) {
        const value = Number(row[metric])
        if (metric in row && Number.isFinite(value) && value >= 0) metrics[metric] = value
      }
    }
  }
  const organizations = [...byId].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, metrics]) => ({ id, metrics }))
  return { hour, databaseBytes, organizations }
}

/** The report as the platform takes it: one body per 500 organizations (one, when there are none), `app` in the first. */
export function reportBodies(report: UsageReport): Record<string, unknown>[] {
  const hour = new Date(report.hour).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const app = {
    ...(report.databaseBytes === null ? {} : { database_bytes: report.databaseBytes }),
    organizations: report.organizations.length,
  }
  const bodies: Record<string, unknown>[] = []
  for (let start = 0; start === 0 || start < report.organizations.length; start += ORGANIZATIONS_PER_REQUEST) {
    bodies.push({
      hour,
      ...(start === 0 ? { app } : {}),
      organizations: report.organizations.slice(start, start + ORGANIZATIONS_PER_REQUEST),
    })
  }
  return bodies
}

export class MetricsReportError extends Error {
  readonly status: number
  constructor(status: number) { super(`The platform answered the usage report with ${status}`); this.status = status }
}

/**
 * The tick's work: report this hour's usage unless this hour's report was sent or another tick is sending it. Never
 * throws for a failed report: the claim is released, the failure logged, and the next tick tries again.
 */
export async function reportUsage(db: D1Database, env: MetricsEnv, now: number): Promise<UsageReportOutcome> {
  const target = metricsConfig(env)
  if (!target) return 'not_configured'
  const hour = hourOf(now)
  // The claim: a new hour, or an unsent claim old enough that its tick must have died. `started_at` = now marks it as
  // this tick's, so only this tick marks it sent or releases it.
  const claim = await db.prepare(
    `INSERT INTO metrics_reports (hour, started_at) VALUES (?, ?)
     ON CONFLICT(hour) DO UPDATE SET started_at = excluded.started_at
     WHERE metrics_reports.sent_at IS NULL AND metrics_reports.started_at < ?
     RETURNING hour`,
  ).bind(hour, now, now - STALE_CLAIM_MS).all()
  if (claim.results.length === 0) return 'already_claimed'
  const size = claim.meta?.size_after
  try {
    const report = await measureUsage(db, hour, typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null)
    const send = env.METRICS_FETCH ?? fetch
    const signal = AbortSignal.timeout(REQUESTS_BUDGET_MS)
    for (const body of reportBodies(report)) {
      const response = await send(target.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
      })
      if (response.status !== 202) throw new MetricsReportError(response.status)
    }
    await db.batch([
      db.prepare('UPDATE metrics_reports SET sent_at = ? WHERE hour = ? AND started_at = ?').bind(now, hour, now),
      db.prepare('DELETE FROM metrics_reports WHERE hour < ?').bind(hour - KEEP_MS),
    ])
    return 'sent'
  } catch (error) {
    logError('usage_report_failed', error, {
      hour: new Date(hour).toISOString(),
      ...(error instanceof MetricsReportError ? { status: error.status } : {}),
    })
    try {
      await db.prepare('DELETE FROM metrics_reports WHERE hour = ? AND started_at = ? AND sent_at IS NULL').bind(hour, now).run()
    } catch (release) {
      // The claim then goes stale and a later tick retakes it.
      logError('usage_report_release_failed', release)
    }
    return 'failed'
  }
}
