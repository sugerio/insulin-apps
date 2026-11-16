import { gatewayEndpoint } from './gateway-fetch.ts';
import { periodOf, SECONDS_PER_HOUR } from './limits.ts';

/**
 * Usage reports (DESIGN.md §8.6, §12.2): every hour Knowledge tells the platform how much each organization uses it,
 * under exactly the keys of its limits (package.json `insulin.limits`) that measure use, plus `database_bytes` for the
 * app. Counts and sizes only: never a name, an address, a question or a collection's contents. Every value is a gauge,
 * the total as measured now; the month counters (`*_month`) are month-to-date and drop to 0 on the 1st (UTC).
 *
 * The platform's five-minute tick (POST /api/scheduled) sends the current hour's report after its due work:
 * `POST <SUGER_METRICS_URL>` with the app's token (`SUGER_APP_TOKEN`), over the gateway's service binding when the
 * deploy gave one (gateway-fetch.ts). The platform answers 202 once it has stored a request; anything else is a
 * failure. Each request replaces the values it carries for that hour, so sending a report again is safe.
 *
 * Once an hour: the tick claims the hour in `metrics_reports` with one conditional statement, so two overlapping
 * ticks can't both send it, and marks it sent once every request was accepted. On any failure it releases the claim
 * and the next tick sends the report again; a claim left unsent (a tick cut short) is taken again after ten minutes.
 * Esign's usage-metrics.ts is the pattern.
 *
 * Without the address or the token (the local preview, tests) nothing is reported.
 */
export type MetricsEnv = {
  DB: D1Database;
  SUGER_METRICS_URL?: string;
  SUGER_APP_TOKEN?: string;
  /** The fetch the platform is called with (the gateway binding's; tests replace it). */
  METRICS_FETCH?: typeof fetch;
};

/** A report's gauges: the app's own, and each organization's (by the platform's organization id). */
export type UsageReport = {
  app: Record<string, number>;
  organizations: { id: string; metrics: Record<string, number> }[];
};

export type ReportOutcome = 'skipped' | 'not_due' | 'sent' | 'failed';

const HOUR_MS = 60 * 60 * 1000;
/** An unsent claim older than this was left by a tick that was cut short, and is taken again. */
const CLAIM_EXPIRES_MS = 10 * 60 * 1000;
/** How long the hours' rows are kept. */
const KEEP_MS = 3 * 24 * HOUR_MS;
/** The platform's limit of organizations per request; a larger report is several requests for the same hour. */
export const ORGANIZATIONS_PER_REQUEST = 500;
/** The time the report's requests may take, well within the tick's 25 seconds; past it, the next tick sends it. */
const REQUESTS_BUDGET_MS = 15_000;

/** Each organization's gauges: the limit keys that measure use, in order; an organization with data has every one. */
export const ORGANIZATION_METRICS = [
  'collections', 'documents', 'storage_bytes', 'learned_month', 'questions_month', 'answers_month', 'awake_hours_month', 'ready_collections',
] as const;
type OrganizationMetric = (typeof ORGANIZATION_METRICS)[number];

/**
 * Measures the report in one batch: per organization, its active collections, their documents and stored text, the
 * ones kept ready, and this month's counters (awake hours as hours, to two decimals). The organizations are those
 * with a collection or with use this month, in order of id. `database_bytes` is the database's size as D1 reports
 * it with a result, left out where it doesn't.
 */
export async function measureUsage(db: D1Database, now = Date.now()): Promise<UsageReport> {
  type Row = { org_id: string; key?: string; value: number; documents?: number; bytes?: number; ready?: number };
  const [collections, counters] = await db.batch<Row>([
    db.prepare(`SELECT org_id, COUNT(*) AS value, COALESCE(SUM(documents), 0) AS documents, COALESCE(SUM(bytes), 0) AS bytes,
      SUM(CASE WHEN keep_ready IS NOT NULL THEN 1 ELSE 0 END) AS ready FROM collections WHERE state = 'active' GROUP BY org_id`),
    db.prepare(`SELECT org_id, key, SUM(used) AS value FROM usage_counters WHERE period = ? GROUP BY org_id, key`).bind(periodOf(now)),
  ]);
  const organizations = new Map<string, Record<OrganizationMetric, number>>();
  const metricsOf = (org: string) => {
    let metrics = organizations.get(org);
    if (!metrics) organizations.set(org, metrics = Object.fromEntries(ORGANIZATION_METRICS.map((name) => [name, 0])) as Record<OrganizationMetric, number>);
    return metrics;
  };
  for (const row of collections!.results) {
    const metrics = metricsOf(row.org_id);
    metrics.collections = Number(row.value) || 0;
    metrics.documents = Number(row.documents) || 0;
    metrics.storage_bytes = Number(row.bytes) || 0;
    metrics.ready_collections = Number(row.ready) || 0;
  }
  for (const row of counters!.results) {
    const key = row.key as OrganizationMetric;
    if (!(ORGANIZATION_METRICS as readonly string[]).includes(key)) continue;
    const value = Number(row.value) || 0;
    metricsOf(row.org_id)[key] = key === 'awake_hours_month' ? Math.round((value / SECONDS_PER_HOUR) * 100) / 100 : value;
  }
  const size = collections!.meta.size_after as unknown;
  return {
    app: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { database_bytes: size } : {},
    organizations: [...organizations.keys()].sort().map((id) => ({ id, metrics: organizations.get(id)! })),
  };
}

/** The top of the UTC hour `at` falls in (epoch ms), and how the platform names it: ISO 8601, `Z`, no milliseconds. */
export const hourOf = (at: number) => Math.floor(at / HOUR_MS) * HOUR_MS;
const hourName = (hour: number) => `${new Date(hour).toISOString().slice(0, 19)}Z`;

/** The requests of one hour's report: at most 500 organizations each, the app's gauges in the first only. */
export function reportBodies(hour: number, report: UsageReport): { hour: string; app?: Record<string, number>; organizations: UsageReport['organizations'] }[] {
  const bodies = [];
  for (let start = 0; start === 0 || start < report.organizations.length; start += ORGANIZATIONS_PER_REQUEST)
    bodies.push({ hour: hourName(hour), ...(start === 0 ? { app: report.app } : {}), organizations: report.organizations.slice(start, start + ORGANIZATIONS_PER_REQUEST) });
  return bodies;
}

export class MetricsReportError extends Error {
  readonly status: number;
  constructor(status: number) { super(`The platform answered ${status}`); this.status = status; }
}

/**
 * Sends the report of the hour `now` falls in, unless a tick already sent it or is sending it. Never throws: a report
 * that fails is retried by the next tick, and never fails the tick's other work.
 */
export async function reportUsage(env: MetricsEnv, now = Date.now()): Promise<ReportOutcome> {
  const hour = hourOf(now);
  let claimed = false;
  try {
    const endpoint = gatewayEndpoint(env.SUGER_METRICS_URL, env.SUGER_APP_TOKEN);
    if (!endpoint) return 'skipped';
    // The claim: a new hour, or one whose claim was left unsent for ten minutes; never an hour already sent.
    const claim = await env.DB.prepare(`INSERT INTO metrics_reports (hour, started_at) VALUES (?1, ?2)
        ON CONFLICT (hour) DO UPDATE SET started_at = excluded.started_at WHERE metrics_reports.sent_at IS NULL AND metrics_reports.started_at < ?3`)
      .bind(hour, now, now - CLAIM_EXPIRES_MS).run();
    if (claim.meta.changes !== 1) return 'not_due';
    claimed = true;
    const report = await measureUsage(env.DB, now);
    const send = env.METRICS_FETCH ?? fetch;
    const signal = AbortSignal.timeout(REQUESTS_BUDGET_MS);
    for (const body of reportBodies(hour, report)) {
      const response = await send(endpoint.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
      });
      if (response.status !== 202) throw new MetricsReportError(response.status);
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE metrics_reports SET sent_at = ?1 WHERE hour = ?2 AND sent_at IS NULL').bind(Date.now(), hour),
      env.DB.prepare('DELETE FROM metrics_reports WHERE hour < ?').bind(hour - KEEP_MS),
    ]);
    return 'sent';
  } catch (error) {
    // Only this tick's own claim is released: one that took it over after ten minutes keeps it.
    if (claimed) await env.DB.prepare('DELETE FROM metrics_reports WHERE hour = ? AND started_at = ? AND sent_at IS NULL').bind(hour, now).run().catch(() => {});
    const reason = error instanceof MetricsReportError ? error.message : error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : 'an error';
    console.error(`Knowledge: the usage report for ${hourName(hour)} was not sent (${reason}); the next tick sends it again`);
    return 'failed';
  }
}
