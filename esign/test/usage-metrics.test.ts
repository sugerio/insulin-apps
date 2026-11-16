// The hourly usage report (src/app/server/esign/usage-metrics.ts): what it measures and sends, the platform's limits
// (500 organizations a request, the app's gauges in the first), one report an hour whatever the ticks do, retries after
// a refusal, nothing without the platform's address and token, and a tick whose due work never depends on it.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { applyMigrations, blobStore } from './helpers/platform.ts';
import app from '../src/app/server/esign/app.ts';
import { prodProblems } from '../src/app/server/esign/environment.ts';
import { gatewayFetchOf } from '../src/app/server/gateway-fetch.ts';
import { hourOf, ORGANIZATIONS_PER_REQUEST, reportBodies, reportUsage } from '../src/app/server/esign/usage-metrics.ts';

const METRICS_URL = 'https://apps.example.com/__insulin/metrics';
const TOKEN = 'synthetic-app-token';
const HOUR = 60 * 60 * 1000;
/** 10:17:05 UTC: the report is of the hour from 10:00. */
const NOW = Date.UTC(2026, 10, 13, 10, 17, 5);
/** What the gateway's five-minute tick sends: the app's id and `x-suger-access-via: schedule`, nothing else. */
const TICK = { 'x-suger-app-id': 'insulin-apps-esign', 'x-suger-access-via': 'schedule' };

type Body = { hour: string; app?: Record<string, number>; organizations: { id: string; metrics: Record<string, number> }[] };
type Sent = { url: string; init: RequestInit; headers: Headers; raw: string; body: Body };

/** Plays the platform's metrics endpoint: every request it was sent, answered `status()` (202: accepted). */
function platform(status: () => number = () => 202) {
  const sent: Sent[] = [];
  const env = {
    SUGER_METRICS_URL: METRICS_URL,
    SUGER_APP_TOKEN: TOKEN,
    METRICS_FETCH: (async (url: string, init: RequestInit) => {
      const raw = String(init.body);
      sent.push({ url, init, headers: new Headers(init.headers), raw, body: JSON.parse(raw) });
      const code = status();
      return new Response(code === 204 ? null : JSON.stringify(code === 202 ? { status: 'accepted' } : { error: 'refused' }), { status: code });
    }) as typeof fetch,
  };
  return { sent, env };
}

async function harness(extra: Record<string, unknown> = {}) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  await applyMigrations(db, { gateway: false });
  const artifacts = await blobStore(mf, 'artifacts'), testMail = await blobStore(mf, 'test-mail');
  const env = { DB: db, ARTIFACTS: artifacts, OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_MAIL: testMail, TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes', ...extra };
  const tick = (more: Record<string, unknown> = {}) => app.fetch(new Request('http://localhost/api/scheduled', { method: 'POST', headers: TICK }), { ...env, ...more } as never);
  return { mf, db, env, artifacts, testMail, tick };
}

/** Every gauge of an organization, zeros included, as the report sends them. */
const gauges = (values: Record<string, number>) => ({
  envelopes: 0, envelopes_in_progress: 0, envelopes_finalizing: 0, envelopes_completed: 0, envelopes_declined: 0, envelopes_expired: 0, envelopes_voided: 0,
  templates: 0, signatures: 0, storage_bytes: 0, ...values,
});

/** The platform's limits on one request's body (see the contract in usage-metrics.ts). */
function assertWithinContract(body: Body, raw: string) {
  assert.match(body.hour, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/, 'the top of a UTC hour, without milliseconds');
  assert.ok(new TextEncoder().encode(raw).length <= 512 * 1024, 'at most 512 KB');
  assert.ok(body.organizations.length <= ORGANIZATIONS_PER_REQUEST);
  assert.equal(new Set(body.organizations.map((o) => o.id)).size, body.organizations.length, 'organization ids are unique');
  for (const metrics of [...(body.app ? [body.app] : []), ...body.organizations.map((o) => o.metrics)]) {
    assert.ok(Object.keys(metrics).length <= 20);
    for (const [name, value] of Object.entries(metrics)) {
      assert.match(name, /^[a-z][a-z0-9_]{0,39}$/);
      assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${name} is a number >= 0`);
    }
  }
}

/** Two organizations' templates, envelopes, signatures and stored objects, and a third with only a staged PDF. */
async function seed(db: D1Database, artifacts: Awaited<ReturnType<typeof blobStore>>, testMail: Awaited<ReturnType<typeof blobStore>>) {
  const bytes = (n: number) => new Uint8Array(n).fill(7);
  for (const [id, org, size] of [['tpl-a1', 'org-a', 1000], ['tpl-a2', 'org-a', 2000], ['tpl-b1', 'org-b', 500]] as const) {
    await db.prepare("INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at, name) VALUES (?1, ?2, ?3, '[\"signer\"]', 1, 'Synthetic Supplier Agreement')").bind(id, org, `templates/${id}/source.pdf`).run();
    await artifacts.put(`templates/${id}/source.pdf`, bytes(size));
  }
  const envelopes = [['env-a1', 'org-a', 'tpl-a1', 'IN_PROGRESS'], ['env-a2', 'org-a', 'tpl-a1', 'COMPLETED'], ['env-a3', 'org-a', 'tpl-a2', 'VOIDED'], ['env-a4', 'org-a', 'tpl-a2', 'FINALIZING'], ['env-b1', 'org-b', 'tpl-b1', 'DECLINED'], ['env-b2', 'org-b', 'tpl-b1', 'EXPIRED']] as const;
  for (const [id, org, template, status] of envelopes)
    await db.prepare("INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256, details_json) VALUES (?1, ?2, ?3, ?4, 1, 'x', '{\"documentName\":\"Synthetic Supplier Agreement\"}')").bind(id, org, template, status).run();
  for (const [envelope, task, status] of [['env-a1', 'task-a1', 'ACTIVE'], ['env-a2', 'task-a2', 'SIGNED']] as const) {
    await db.prepare("INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status) VALUES (?1, ?2, 'signer', 'Ana Example', 'ana@example.com', 1, ?3)").bind(task, envelope, status).run();
    await db.prepare("INSERT INTO signatures (id, envelope_id, task_id, sequence, status, input_artifact_id, input_sha256, previous_hash, event_hash, facts_json, render_json) VALUES (?1, ?2, ?3, 1, 'PENDING', 'd0', ?4, NULL, ?4, '{}', '{}')").bind(`sig-${task}`, envelope, task, 'a'.repeat(64)).run();
  }
  // Everything under envelopes/<id>/ is the envelope's organization's: its initial document, a signer's output PDF and
  // drawn image, its seal.
  for (const [key, size] of [['envelopes/env-a1/d0.pdf', 1000], ['envelopes/env-a2/d0.pdf', 1000], ['envelopes/env-a2/out-1.pdf', 1500], ['envelopes/env-a2/signature-images/sig-task-a2/field-1.png', 300], ['envelopes/env-a2/managed-evidence.json', 200], ['envelopes/env-b1/d0.pdf', 500]] as const)
    await artifacts.put(key, bytes(size));
  // An editing session's staged PDF is its organization's, the only data org-c has; a session without one is nothing.
  await db.prepare("INSERT INTO editor_sessions (id, tenant_id, parent_origin) VALUES ('ses-a', 'org-a', 'https://host.example.com'), ('ses-c', 'org-c', 'https://host.example.com'), ('ses-d', 'org-d', 'https://host.example.com')").run();
  await artifacts.put('editor-sources/ses-a/staged-1.pdf', bytes(700));
  await artifacts.put('editor-sources/ses-c/staged-1.pdf', bytes(400));
  // Nobody's: objects no record names, and the local preview's test mailbox.
  await artifacts.put('templates/tpl-gone/source.pdf', bytes(900));
  await artifacts.put('envelopes/env-gone/d0.pdf', bytes(900));
  await testMail.put('codes/task-a1.json', bytes(900));
}

test('the report counts each organization\'s envelopes, templates, signatures and stored bytes, and the app\'s database', async () => {
  const { sent, env: metrics } = platform();
  const { mf, db, env, artifacts, testMail } = await harness(metrics);
  try {
    await seed(db, artifacts, testMail);
    assert.equal(await reportUsage(env, NOW), 'sent');
    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.equal(request!.url, METRICS_URL);
    assert.equal(request!.init.method, 'POST');
    assert.equal(request!.init.redirect, 'manual');
    assert.equal(request!.headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(request!.headers.get('content-type'), 'application/json');
    assert.equal(request!.headers.get('x-suger-organization-id'), null, 'one report for every organization');
    const { database_bytes: databaseBytes, ...appGauges } = request!.body.app ?? {};
    assert.ok(typeof databaseBytes === 'number' && databaseBytes > 0, 'the database size D1 reports');
    assert.deepEqual({ ...request!.body, app: appGauges }, {
      hour: '2026-11-13T10:00:00Z',
      app: { organizations: 3 },
      organizations: [
        { id: 'org-a', metrics: gauges({ envelopes: 4, envelopes_in_progress: 1, envelopes_finalizing: 1, envelopes_completed: 1, envelopes_voided: 1, templates: 2, signatures: 2, storage_bytes: 1000 + 2000 + 1000 + 1000 + 1500 + 300 + 200 + 700 }) },
        { id: 'org-b', metrics: gauges({ envelopes: 2, envelopes_declined: 1, envelopes_expired: 1, templates: 1, storage_bytes: 500 + 500 }) },
        { id: 'org-c', metrics: gauges({ storage_bytes: 400 }) },
      ],
    });
    assertWithinContract(request!.body, request!.raw);
    // Counts and sizes only: no name, email address, document name or id of anything but the organization.
    for (const word of ['Ana Example', 'ana@example.com', 'Synthetic Supplier Agreement', 'tpl-a1', 'env-a1', 'ses-a', 'host.example.com'])
      assert.equal(request!.raw.includes(word), false, word);
    const row = await db.prepare('SELECT hour, started_at, sent_at FROM metrics_reports').first<{ hour: number; started_at: number; sent_at: number | null }>();
    assert.equal(row?.hour, Date.UTC(2026, 10, 13, 10));
    assert.equal(row?.started_at, NOW);
    assert.ok(row?.sent_at, 'marked sent');
  } finally { await mf.dispose(); }
});

test('an organization with nothing yet is not listed, and an empty database still reports the app\'s gauges', async () => {
  const { sent, env: metrics } = platform();
  const { mf, env } = await harness(metrics);
  try {
    assert.equal(await reportUsage(env, NOW), 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.body.app?.organizations, 0);
    assert.equal(typeof sent[0]!.body.app?.database_bytes, 'number');
    assert.deepEqual(sent[0]!.body.organizations, []);
    // database_bytes only when D1 gives the size.
    assert.deepEqual(reportBodies(hourOf(NOW), { app: { organizations: 0 }, organizations: [] }), [{ hour: '2026-11-13T10:00:00Z', app: { organizations: 0 }, organizations: [] }]);
  } finally { await mf.dispose(); }
});

test('more than 500 organizations go as several requests for the same hour, the app\'s gauges in the first only', async () => {
  const { sent, env: metrics } = platform();
  const { mf, db, env } = await harness(metrics);
  try {
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1201)
      INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) SELECT 'tpl-' || i, printf('org-%04d', i), 'templates/tpl-' || i || '/source.pdf', '["signer"]', 1 FROM n`).run();
    assert.equal(await reportUsage(env, NOW), 'sent');
    assert.deepEqual(sent.map((request) => request.body.organizations.length), [500, 500, 201]);
    assert.deepEqual(sent.map((request) => request.body.hour), Array(3).fill('2026-11-13T10:00:00Z'));
    assert.deepEqual(sent.map((request) => request.body.app?.organizations), [1201, undefined, undefined]);
    const ids = sent.flatMap((request) => request.body.organizations.map((o) => o.id));
    assert.deepEqual(ids, Array.from({ length: 1201 }, (_, i) => `org-${String(i + 1).padStart(4, '0')}`), 'each organization once, in order');
    for (const request of sent) assertWithinContract(request.body, request.raw);
    assert.deepEqual(sent[1]!.body.organizations[0], { id: 'org-0501', metrics: gauges({ templates: 1 }) });
    // The largest request the platform allows: 500 organizations with the longest ids Esign stores (128 characters).
    const widest = { app: { database_bytes: Number.MAX_SAFE_INTEGER, organizations: 500 }, organizations: Array.from({ length: 500 }, (_, i) => ({ id: `${'o'.repeat(124)}${String(i).padStart(4, '0')}`, metrics: gauges(Object.fromEntries(Object.keys(gauges({})).map((name) => [name, Number.MAX_SAFE_INTEGER]))) })) };
    const [body] = reportBodies(hourOf(NOW), widest);
    assertWithinContract(body as Body, JSON.stringify(body));
  } finally { await mf.dispose(); }
});

test('an hour is reported once: a second tick in that hour sends nothing, the next hour sends again, old hours are pruned', async () => {
  const { sent, env: metrics } = platform();
  const { mf, db, env, tick } = await harness(metrics);
  try {
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    await db.prepare('INSERT INTO metrics_reports (hour, started_at, sent_at) VALUES (?1, ?1, ?1), (?2, ?2, ?2)').bind(hour - 4 * 24 * HOUR, hour - 2 * 24 * HOUR).run();
    const refused = await app.fetch(new Request('http://localhost/api/scheduled', { method: 'POST', headers: { ...TICK, 'x-suger-organization-id': 'org-a' } }), env as never);
    assert.equal(refused.status, 403);
    assert.equal(sent.length, 0, 'only the tick reports');
    const first = await tick();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { expired: 0, completed: 0, waiting: 0, failed: 0 }, 'the tick answers as before');
    assert.equal(sent.length, 1);
    assert.ok([hour, hour + HOUR].map((at) => new Date(at).toISOString().replace('.000Z', 'Z')).includes(sent[0]!.body.hour), 'the hour of the tick');
    assert.equal((await tick()).status, 200);
    assert.equal(sent.length, 1, 'the second tick of the hour sends nothing');
    assert.equal(await reportUsage(env, Date.now()), 'not_due');
    const kept = (await db.prepare('SELECT hour FROM metrics_reports ORDER BY hour').all<{ hour: number }>()).results.map((row) => row.hour);
    assert.equal(kept.includes(hour - 4 * 24 * HOUR), false, 'hours older than three days are pruned');
    assert.ok(kept.includes(hour - 2 * 24 * HOUR));
    assert.equal(await reportUsage(env, Date.now() + HOUR), 'sent', 'the next hour');
    assert.equal(sent.length, 2);
  } finally { await mf.dispose(); }
});

test('overlapping ticks claim the hour once, and a claim left unsent is taken again after ten minutes', async () => {
  const { sent, env: metrics } = platform();
  const { mf, db, env } = await harness(metrics);
  try {
    const outcomes = await Promise.all([reportUsage(env, NOW), reportUsage(env, NOW), reportUsage(env, NOW + 1000)]);
    assert.deepEqual(outcomes.sort(), ['not_due', 'not_due', 'sent']);
    assert.equal(sent.length, 1);
    // A tick cut short left its claim of the next hour unsent.
    const next = Date.UTC(2026, 10, 13, 11);
    await db.prepare('INSERT INTO metrics_reports (hour, started_at) VALUES (?, ?)').bind(next, next + 60_000).run();
    assert.equal(await reportUsage(env, next + 9 * 60_000), 'not_due', 'eight minutes old: still being sent');
    assert.equal(await reportUsage(env, next + 11 * 60_000 + 1), 'sent', 'over ten minutes old: taken again');
    assert.equal(sent.length, 2);
    assert.ok((await db.prepare('SELECT sent_at FROM metrics_reports WHERE hour = ?').bind(next).first<{ sent_at: number | null }>())?.sent_at);
  } finally { await mf.dispose(); }
});

test('anything but 202 releases the claim, and the next tick sends the whole report again', async (t: TestContext) => {
  const errors = t.mock.method(console, 'error', () => {});
  for (const status of [400, 401, 413, 429, 503, 500, 200, 204, 302]) {
    const answers = [status];
    const { sent, env: metrics } = platform(() => answers.shift() ?? 202);
    const { mf, db, env } = await harness(metrics);
    try {
      assert.equal(await reportUsage(env, NOW), 'failed', `${status}`);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM metrics_reports').first<{ n: number }>())?.n, 0, `${status} released the claim`);
      assert.equal(await reportUsage(env, NOW + 5 * 60_000), 'sent', `after ${status}, the next tick`);
      assert.equal(sent.length, 2);
    } finally { await mf.dispose(); }
  }
  // A report of two requests whose second is refused: the next tick sends both again (each replaces its values).
  const answers = [202, 429];
  const { sent, env: metrics } = platform(() => answers.shift() ?? 202);
  const { mf, db, env } = await harness(metrics);
  try {
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
      INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) SELECT 'tpl-' || i, printf('org-%04d', i), 'templates/tpl-' || i || '/source.pdf', '["signer"]', 1 FROM n`).run();
    assert.equal(await reportUsage(env, NOW), 'failed');
    assert.equal(await reportUsage(env, NOW + 5 * 60_000), 'sent');
    assert.deepEqual(sent.map((request) => [request.body.app !== undefined, request.body.organizations.length]), [[true, 500], [false, 1], [true, 500], [false, 1]]);
  } finally { await mf.dispose(); }
  // The request itself failing (the gateway unreachable, the time budget spent) is the same.
  const { mf: mf2, db: db2, env: env2 } = await harness({ ...platform().env, METRICS_FETCH: (async () => { throw new TypeError('Network connection lost'); }) as typeof fetch });
  try {
    assert.equal(await reportUsage(env2, NOW), 'failed');
    assert.equal((await db2.prepare('SELECT COUNT(*) AS n FROM metrics_reports').first<{ n: number }>())?.n, 0);
  } finally { await mf2.dispose(); }
  assert.ok(errors.mock.calls.length >= 11, 'each failure is logged');
  for (const call of errors.mock.calls) {
    assert.match(String(call.arguments[0]), /^Esign: the usage report for 2026-11-13T10:00:00Z was not sent \(.+\); the next tick sends it again$/);
    assert.equal(String(call.arguments[0]).includes(TOKEN), false, 'never the token');
  }
});

test('the report gets fifteen seconds in all: a gateway that never answers is given up on, and the claim released', async (t: TestContext) => {
  t.mock.method(console, 'error', () => {});
  // Only the report's own deadline ends the wait, well inside the tick's 25 seconds.
  const timeout = t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('The report took too long', 'TimeoutError')));
  const signals: (AbortSignal | null | undefined)[] = [];
  const stalled = (async (_url: string, init: RequestInit) => {
    signals.push(init.signal);
    return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  }) as typeof fetch;
  const { mf, db, env } = await harness({ ...platform().env, METRICS_FETCH: stalled });
  try {
    await db.prepare(`INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) VALUES ('tpl-1', 'org-a', 'templates/tpl-1/source.pdf', '["signer"]', 1)`).run();
    assert.equal(await reportUsage(env, NOW), 'failed');
    assert.deepEqual(timeout.mock.calls.map((call) => call.arguments), [[15_000]]);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM metrics_reports').first<{ n: number }>())?.n, 0);
  } finally { await mf.dispose(); }
});

test('without the platform\'s address or token nothing is reported or written, and signing doesn\'t need them', async () => {
  for (const config of [{}, { SUGER_METRICS_URL: METRICS_URL }, { SUGER_APP_TOKEN: TOKEN }, { SUGER_METRICS_URL: ' ', SUGER_APP_TOKEN: TOKEN }, { SUGER_METRICS_URL: 'http://apps.example.com/__insulin/metrics', SUGER_APP_TOKEN: TOKEN }, { SUGER_METRICS_URL: 'not a url', SUGER_APP_TOKEN: TOKEN }]) {
    const { sent, env: metrics } = platform();
    const { mf, db, env, tick } = await harness({ METRICS_FETCH: metrics.METRICS_FETCH, ...config });
    try {
      assert.equal(await reportUsage(env, NOW), 'skipped', JSON.stringify(config));
      assert.equal((await tick()).status, 200);
      assert.equal(sent.length, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM metrics_reports').first<{ n: number }>())?.n, 0);
    } finally { await mf.dispose(); }
  }
  // http only on a loopback host (a local stack).
  const { sent, env: metrics } = platform();
  const { mf, env } = await harness({ ...metrics, SUGER_METRICS_URL: 'http://apps.insulinapps.localhost:8787/__insulin/metrics' });
  try {
    assert.equal(await reportUsage(env, NOW), 'sent');
    assert.equal(sent[0]!.url, 'http://apps.insulinapps.localhost:8787/__insulin/metrics');
  } finally { await mf.dispose(); }
  assert.deepEqual(prodProblems({ ESIGN_ENV: 'prod' }).filter((problem) => /METRICS|usage/i.test(problem)), [], 'not a setting signing waits for');
});

test('a failed report never fails the tick\'s due work, and a tick that can\'t sign still reports', async (t: TestContext) => {
  t.mock.method(console, 'error', () => {});
  const late = async (db: D1Database) => {
    await db.prepare("INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) VALUES ('tpl-a', 'org-a', 'templates/tpl-a/source.pdf', '[\"signer\"]', 1)").run();
    await db.prepare("INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256) VALUES ('late-a', 'org-a', 'tpl-a', 'IN_PROGRESS', 1, 'x')").run();
    await db.prepare("INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status, expires_at) VALUES ('late-task', 'late-a', 'signer', 'Ana Example', 'ana@example.com', 1, 'ACTIVE', 1)").run();
  };
  {
    const { mf, db, tick } = await harness({ ...platform().env, METRICS_FETCH: (async () => { throw new TypeError('Network connection lost'); }) as typeof fetch });
    try {
      await late(db);
      const ran = await tick();
      assert.equal(ran.status, 200);
      assert.deepEqual(await ran.json(), { expired: 1, completed: 0, waiting: 0, failed: 0 }, 'the request failing changes nothing');
      assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id = 'late-a'").first<{ status: string }>())?.status, 'EXPIRED');
    } finally { await mf.dispose(); }
  }
  {
    const { sent, env: metrics } = platform();
    const { mf, db, tick } = await harness(metrics);
    try {
      await late(db);
      await db.prepare('DROP TABLE metrics_reports').run();
      const ran = await tick();
      assert.equal(ran.status, 200);
      assert.deepEqual(await ran.json(), { expired: 1, completed: 0, waiting: 0, failed: 0 }, 'nor does the database refusing the claim');
      assert.equal(sent.length, 0);
    } finally { await mf.dispose(); }
  }
  {
    const { sent, env: metrics } = platform();
    const { mf, tick } = await harness(metrics);
    try {
      const ran = await tick({ OTP_KEY: undefined });
      assert.equal(ran.status, 404);
      assert.deepEqual(await ran.json(), { error: 'signing_disabled' });
      assert.equal(sent.length, 1, 'usage is reported whether or not signing is set up');
    } finally { await mf.dispose(); }
  }
});

test('with the request\'s waitUntil the report runs after the tick has answered', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { sent, env: metrics } = platform();
  const pending: Promise<unknown>[] = [];
  const { mf, tick } = await harness({ ...metrics, METRICS_FETCH: (async (url: string, init: RequestInit) => { await held; return metrics.METRICS_FETCH(url, init); }) as typeof fetch, WAIT_UNTIL: (work: Promise<unknown>) => { pending.push(work); } });
  try {
    const ran = await tick();
    assert.equal(ran.status, 200, 'answered while the report is still being sent');
    assert.equal(pending.length, 1);
    assert.equal(sent.length, 0);
    release();
    assert.equal(await pending[0], 'sent');
    assert.equal(sent.length, 1);
  } finally { await mf.dispose(); }
});

test('the report goes over the SUGER_GATEWAY service binding when the deploy gave one', async () => {
  const seen: { self: unknown; request: Request; body: string }[] = [];
  const binding = { async fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) { const request = new Request(input, init); seen.push({ self: this, request, body: await request.text() }); return new Response('{"status":"accepted"}', { status: 202 }); } };
  const request = Object.assign(new Request('https://esign.example.com/api/scheduled', { method: 'POST' }), { runtime: { name: 'cloudflare', cloudflare: { env: { SUGER_GATEWAY: binding, DB: {} } } } });
  const viaGateway = gatewayFetchOf(request);
  assert.equal(typeof viaGateway, 'function');
  const { mf, env } = await harness({ SUGER_METRICS_URL: METRICS_URL, SUGER_APP_TOKEN: TOKEN, METRICS_FETCH: viaGateway });
  try {
    assert.equal(await reportUsage(env, NOW), 'sent');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.self, binding, 'called as the binding\'s method');
    // The address stays the platform's (the gateway routes by it); only the transport is the binding.
    assert.equal(seen[0]!.request.url, METRICS_URL);
    assert.equal(seen[0]!.request.method, 'POST');
    assert.equal(seen[0]!.request.redirect, 'manual');
    assert.equal(seen[0]!.request.headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(JSON.parse(seen[0]!.body).hour, '2026-11-13T10:00:00Z');
  } finally { await mf.dispose(); }
});
