import { gatewayEndpoint } from '../gateway-fetch.ts';

/**
 * Usage reports: every hour Esign tells the platform how much each organization uses it, for the platform's
 * operators, who can't read the app's database. Counts and byte sizes only: never a name, an email address, a
 * document's title or its contents. Every value is a gauge, the total as measured now (not what happened in the hour),
 * so the platform derives activity from the difference between hours.
 *
 * The platform's five-minute tick (POST /api/scheduled) sends the current hour's report after its due work:
 * `POST <SUGER_METRICS_URL>` with the app's token (`SUGER_APP_TOKEN`), over the gateway's service binding when the
 * deploy gave one (gateway-fetch.ts). The platform answers 202 once it has stored a request; anything else is a
 * failure. Each request replaces the values it carries for that hour, so sending a report again is safe.
 *
 * Once an hour: the tick claims the hour in `metrics_reports` with one conditional statement, so two overlapping
 * ticks can't both send it, and marks it sent once every request was accepted. On any failure it releases the claim
 * and the next tick sends the report again; a claim left unsent (a tick cut short) is taken again after ten minutes.
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

/** A report's gauges: the app's own, and each organization's (by the platform's organization id, Esign's tenant). */
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
/**
 * The platform's limit of organizations per request; a larger report is several requests for the same hour, the app's
 * gauges in the first. 500 organizations (ids of at most 128 characters, ten gauges each) stay well under its 512 KB.
 */
export const ORGANIZATIONS_PER_REQUEST = 500;
/** The time the report's requests may take, well within the tick's 25 seconds; past it, the next tick sends it. */
const REQUESTS_BUDGET_MS = 15_000;

/** Each organization's gauges, in the order they are sent; an organization with data has every one, zeros included. */
const ORGANIZATION_METRICS = [
  'envelopes', 'envelopes_in_progress', 'envelopes_finalizing', 'envelopes_completed', 'envelopes_declined', 'envelopes_expired', 'envelopes_voided',
  'templates', 'signatures', 'storage_bytes',
] as const;
type OrganizationMetric = (typeof ORGANIZATION_METRICS)[number];

/** The gauge of each envelope status; `envelopes` counts them all. */
const STATUS_METRICS: Record<string, OrganizationMetric> = {
  IN_PROGRESS: 'envelopes_in_progress',
  FINALIZING: 'envelopes_finalizing',
  COMPLETED: 'envelopes_completed',
  DECLINED: 'envelopes_declined',
  EXPIRED: 'envelopes_expired',
  VOIDED: 'envelopes_voided',
};

/**
 * The bytes each organization's objects take in the object store (blob-store.ts, bucket `artifacts`), by whose key
 * names them: a template's source PDF (`templates.object_key`), everything under `envelopes/<id>/` (the initial document,
 * each signer's output PDF and drawn images, the seal, the delivery PDF) and an editing session's staged PDF
 * (`editor-sources/<id>/`). Only the recorded sizes are read, never the chunks.
 */
const STORAGE_BYTES = `WITH owned (tenant_id, size) AS (
    SELECT t.tenant_id, b.size FROM blobs b JOIN templates t ON t.object_key = b.key WHERE b.bucket = 'artifacts'
    UNION ALL
    SELECT e.tenant_id, b.size FROM blobs b JOIN envelopes e ON e.id = substr(b.key, 11, instr(substr(b.key, 11), '/') - 1)
      WHERE b.bucket = 'artifacts' AND substr(b.key, 1, 10) = 'envelopes/'
    UNION ALL
    SELECT x.tenant_id, b.size FROM blobs b JOIN editor_sessions x ON x.id = substr(b.key, 16, instr(substr(b.key, 16), '/') - 1)
      WHERE b.bucket = 'artifacts' AND substr(b.key, 1, 15) = 'editor-sources/'
  )
  SELECT tenant_id, SUM(size) AS value FROM owned GROUP BY tenant_id`;

/**
 * Measures the report: one query per gauge over its whole table, grouped by organization, in one batch. The
 * organizations are those with data (templates, envelopes or stored objects), in order of id. `database_bytes` is the
 * database's size as D1 reports it with a result, left out where it doesn't.
 */
export async function measureUsage(db: D1Database): Promise<UsageReport> {
  type Row = { tenant_id: string; status?: string; value: number };
  const [statuses, templates, signatures, storage] = await db.batch<Row>([
    db.prepare('SELECT tenant_id, status, COUNT(*) AS value FROM envelopes GROUP BY tenant_id, status'),
    db.prepare('SELECT tenant_id, COUNT(*) AS value FROM templates GROUP BY tenant_id'),
    db.prepare('SELECT e.tenant_id, COUNT(*) AS value FROM signatures s JOIN envelopes e ON e.id = s.envelope_id GROUP BY e.tenant_id'),
    db.prepare(STORAGE_BYTES),
  ]);
  const organizations = new Map<string, Record<OrganizationMetric, number>>();
  const add = (row: Row, metric: OrganizationMetric) => {
    let metrics = organizations.get(row.tenant_id);
    if (!metrics) organizations.set(row.tenant_id, metrics = Object.fromEntries(ORGANIZATION_METRICS.map((name) => [name, 0])) as Record<OrganizationMetric, number>);
    metrics[metric] += Number(row.value) || 0;
  };
  for (const row of statuses!.results) {
    add(row, 'envelopes');
    const metric = STATUS_METRICS[row.status ?? ''];
    if (metric) add(row, metric);
  }
  for (const row of templates!.results) add(row, 'templates');
  for (const row of signatures!.results) add(row, 'signatures');
  for (const row of storage!.results) add(row, 'storage_bytes');
  const size = statuses!.meta.size_after as unknown;
  return {
    app: { ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { database_bytes: size } : {}), organizations: organizations.size },
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
    const report = await measureUsage(env.DB);
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
    console.error(`Esign: the usage report for ${hourName(hour)} was not sent (${reason}); the next tick sends it again`);
    return 'failed';
  }
}
