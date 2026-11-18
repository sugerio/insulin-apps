// Send later (scheduled-send.ts, app.ts): `sendAt` on a creation or a draft checks the request as a send would and
// saves a draft that keeps when to send it and who scheduled it; the platform's tick (and process-due) sends the drafts
// due, as that person, and records on the draft why one couldn't be. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, identity, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { DUE_DRAFTS_SQL, DUE_ORGANIZATIONS_SQL, parseSendAt } from '../src/app/server/esign/scheduled-send.ts';

const ORIGIN = 'https://esign.example.test';
const TICK = { 'x-suger-app-id': 'insulin-apps-esign', 'x-suger-access-via': 'schedule' };
const HOUR = 60 * 60 * 1000;

async function setup(platform: { status?: (body: { org: string; ids: string[] }) => Response | Promise<Response>; report?: (body: unknown) => Response; timing?: { budgetMs: number; statusTimeoutMs: number } } = {}, accepts: (url: URL, body: unknown) => boolean = () => true) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  const env = {
    DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), TEST_MAIL: await blobStore(mf, 'test-mail'), OTP_KEY: 'scheduled-pepper-at-least-32-bytes-long', TEST_SEAL_KEY: 'scheduled-seal-key-at-least-32-bytes-long',
    // Who can use Esign now, as the platform's member status answers (directory.ts); without it, as they scheduled.
    ...(platform.status ? {
      SUGER_MEMBER_STATUS_URL: 'https://apps.example.test/__insulin/members/status', SUGER_APP_TOKEN: 'app-token-for-esign',
      // As a fetch is: abandoned when its signal aborts (the question's wait), whatever the platform does.
      MEMBERS_FETCH: (async (input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (!accepts(new URL(input), body)) return Response.json({ error: 'invalid_request' }, { status: 400 });
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          Promise.resolve(platform.status!(body)).then(resolve, reject);
        });
      }) as unknown as typeof fetch,
    } : {}),
    ...(platform.timing ? { SCHEDULED_TIMING: platform.timing } : {}),
    // The hourly usage report (usage-metrics.ts), as the platform takes it.
    ...(platform.report ? {
      SUGER_METRICS_URL: 'https://apps.example.test/__insulin/metrics',
      METRICS_FETCH: (async (_input: string, init: RequestInit) => platform.report!(JSON.parse(String(init.body)))) as unknown as typeof fetch,
    } : {}),
  };
  const person = (name: string, role: 'EDITOR' | 'VIEWER' = 'EDITOR') => identity('tenant', { userId: `user-${name}`, email: `${name}@example.test`, role });
  const ana = person('ana'), bo = person('bo');
  const req = (path: string, headers: Record<string, string>, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } }), env);
  const post = (path: string, headers: Record<string, string>, body: unknown, extra: Record<string, string> = {}) => req(path, headers, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(['partner', 'seller']));
  const created = await req('/api/templates', ana, { method: 'POST', body: form });
  assert.equal(created.status, 201, await created.clone().text());
  const templateId = (await created.json() as { id: string }).id;
  const row = (id: string) => db.prepare('SELECT status, draft_json, owner_user_id FROM envelopes WHERE id = ?').bind(id).first<{ status: string; draft_json: string | null; owner_user_id: string }>();
  // Makes a scheduled draft due now (a request can only schedule a minute ahead or more).
  const due = (id: string) => db.prepare("UPDATE envelopes SET draft_json = json_set(draft_json, '$.schedule.at', ?) WHERE id = ?").bind(Date.now() - 1000, id).run();
  const tick = async () => { const r = await req('/api/scheduled', TICK, { method: 'POST' }); assert.equal(r.status, 200, await r.clone().text()); return r.json() as Promise<{ scheduledSent: number; scheduledFailed: number }>; };
  const tasks = async (id: string) => (await db.prepare('SELECT role, recipient_name, status FROM tasks WHERE envelope_id = ? ORDER BY routing_order').bind(id).all<{ role: string; recipient_name: string; status: string }>()).results;
  // Lets a waiting draft (schedule.retryAt) be tried at the next tick, as ten minutes on.
  const retry = (id: string) => db.prepare("UPDATE envelopes SET draft_json = json_set(draft_json, '$.schedule.retryAt', ?) WHERE id = ?").bind(Date.now() - 1000, id).run();
  return { mf, db, req, post, ana, bo, templateId, row, due, retry, tick, tasks, pdf, form };
}

const whole = (templateId: string, extra: Record<string, unknown> = {}) => ({ templateId, recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }, { role: 'seller', name: 'Sam Seller', email: 'sam@seller.example' }], documentName: 'Reseller agreement', ...extra });
const later = (ms = HOUR) => new Date(Date.now() + ms).toISOString();

test('the time: an ISO 8601 time at least a minute and at most 400 days ahead', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  assert.equal(parseSendAt('2026-11-16T01:00:00Z', now), now + HOUR);
  assert.equal(parseSendAt('2026-11-16T09:00:00+08:00', now), now + HOUR);
  for (const bad of ['2026-11-16T00:00:30Z', '2025-01-01T00:00:00Z', '2028-01-01T00:00:00Z', 'tomorrow', 42, null, '']) assert.equal(parseSendAt(bad, now), 'invalid', String(bad));
});

test('scheduled: checked as a send, saved as a draft that keeps when, nothing sent; its readers see when, never who in full', async () => {
  const h = await setup();
  try {
    const sendAt = later();
    const key = { 'idempotency-key': 'later-1' };
    const saved = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt }, key);
    assert.equal(saved.status, 201, await saved.clone().text());
    const { id, status, sendAt: when } = await saved.json() as { id: string; status: string; sendAt: string };
    assert.deepEqual([status, when], ['DRAFT', sendAt]);
    assert.equal((await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt }, key)).status, 201, 'a retry is the same draft');
    assert.deepEqual(await h.tasks(id), [], 'nothing sent');
    const shown = await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { status: string; sendAt: string; draft: Record<string, unknown> };
    assert.deepEqual([shown.status, shown.sendAt, shown.draft], ['DRAFT', sendAt, whole(h.templateId)], 'its request, without the schedule');
    const [listed] = (await (await h.req('/api/envelopes?status=DRAFT', h.ana)).json() as { envelopes: { id: string; sendAt?: string }[] }).envelopes;
    assert.deepEqual([listed!.id, listed!.sendAt], [id, sendAt]);
    // Refused as a send would be, and nothing saved: an unfinished request, a deadline before it is sent, a bad time.
    const fresh = () => ({ 'idempotency-key': crypto.randomUUID() });
    const before = (await h.db.prepare('SELECT count(*) AS n FROM envelopes').first<{ n: number }>())!.n;
    const unfinished = { templateId: h.templateId, recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@' }, { role: 'seller', name: '', email: '' }] };
    assert.deepEqual([(await h.post('/api/envelopes', h.ana, { ...unfinished, sendAt }, fresh())).status], [422]);
    const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const early = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId, { recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example', expiresAt: deadline }, { role: 'seller', name: 'Sam Seller', email: 'sam@seller.example' }] }), sendAt }, fresh());
    assert.deepEqual([early.status, await early.json()], [422, { error: 'deadline_before_send_at' }]);
    for (const bad of [new Date(Date.now() - HOUR).toISOString(), later(401 * 24 * HOUR), 'soon'])
      assert.deepEqual(await (await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: bad }, fresh())).json(), { error: 'invalid_send_at' }, bad);
    assert.equal((await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt, draft: true }, fresh())).status, 422, 'a draft or later, not both');
    assert.equal((await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), schedule: { at: 1 } }, fresh())).status, 422, 'the schedule is never a request\'s own');
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM envelopes').first<{ n: number }>())!.n, before);
  } finally { await h.mf.dispose(); }
});

test('when due, the tick sends it as whoever scheduled it, once; process-due too, for its organization', async () => {
  const h = await setup();
  try {
    const { id } = await (await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': 'later-2' })).json() as { id: string };
    const early = await h.tick();
    assert.deepEqual([early.scheduledSent, early.scheduledFailed], [0, 0], 'not yet');
    await h.due(id);
    const ran = await h.tick();
    assert.deepEqual([ran.scheduledSent, ran.scheduledFailed], [1, 0]);
    const sent = await h.row(id);
    assert.deepEqual([sent!.status, sent!.draft_json, sent!.owner_user_id], ['IN_PROGRESS', null, 'user-ana']);
    assert.deepEqual((await h.tasks(id)).map((t) => [t.role, t.recipient_name, t.status]), [['partner', 'Pat Partner', 'ACTIVE'], ['seller', 'Sam Seller', 'PENDING']]);
    assert.equal((await h.tick()).scheduledSent, 0, 'sent once');
    // process-due: the caller's organization's due drafts.
    const { id: second } = await (await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': 'later-3' })).json() as { id: string };
    await h.due(second);
    const due = await (await h.req('/api/process-due', h.ana, { method: 'POST' })).json() as { scheduledSent: number };
    assert.equal(due.scheduledSent, 1);
    assert.equal((await h.row(second))!.status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});

test('one that can\'t be sent stays a draft, unscheduled, with why; Save draft unschedules; Send now and a new time work', async () => {
  const h = await setup();
  try {
    // Scheduled by bo, an editor it is shared with, who then loses the share: not sent, as bo can't send it now.
    const { id } = await (await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), draft: true }, { 'idempotency-key': 'later-4' })).json() as { id: string };
    await h.post(`/api/envelopes/${id}/shares`, h.ana, { email: 'bo@example.test', role: 'editor' });
    await h.post(`/api/templates/${h.templateId}/shares`, h.ana, { email: 'bo@example.test', role: 'viewer' });
    const byBo = await h.post(`/api/envelopes/${id}`, h.bo, { ...whole(h.templateId), sendAt: later() });
    assert.equal(byBo.status, 200, await byBo.clone().text());
    await h.post(`/api/envelopes/${id}/shares/delete`, h.ana, { email: 'bo@example.test' });
    await h.due(id);
    assert.deepEqual([(await h.tick()).scheduledFailed], [1]);
    const failed = await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { status: string; sendAt?: string; sendError?: string };
    assert.deepEqual([failed.status, failed.sendAt, failed.sendError], ['DRAFT', undefined, 'not_allowed']);
    const again = await h.tick();
    assert.deepEqual([again.scheduledSent, again.scheduledFailed], [0, 0], 'and is not tried again');
    // Its template made a draft meanwhile: the send's own refusal is kept.
    const rescheduled = await h.post(`/api/envelopes/${id}`, h.ana, { ...whole(h.templateId), sendAt: later() });
    const answer = await rescheduled.json() as { status: string; sendAt?: string };
    assert.equal(answer.status, 'DRAFT');
    assert.equal((await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { sendAt?: string; sendError?: string }).sendAt, answer.sendAt, 'scheduled again: the error goes');
    await h.db.prepare("UPDATE templates SET status = 'draft' WHERE id = ?").bind(h.templateId).run();
    await h.due(id);
    await h.tick();
    assert.equal((await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { sendError?: string }).sendError, 'template_draft');
    await h.db.prepare("UPDATE templates SET status = 'active' WHERE id = ?").bind(h.templateId).run();
    // Save draft: no longer scheduled.
    await h.post(`/api/envelopes/${id}`, h.ana, { ...whole(h.templateId), sendAt: later() });
    await h.post(`/api/envelopes/${id}`, h.ana, { ...whole(h.templateId), draft: true });
    const unscheduled = await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { sendAt?: string; sendError?: string };
    assert.deepEqual([unscheduled.sendAt, unscheduled.sendError], [undefined, undefined]);
    // Send now, while scheduled: sent, and the tick has nothing left to do.
    await h.post(`/api/envelopes/${id}`, h.ana, { ...whole(h.templateId), sendAt: later() });
    assert.equal((await h.post(`/api/envelopes/${id}`, h.ana, whole(h.templateId))).status, 200);
    await h.due(id);
    assert.equal((await h.tick()).scheduledSent, 0);
    assert.equal((await h.row(id))!.status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});

/** The platform's member status for one id (DESIGN.md §8.9), as the gateway answers it. */
const status = (entry: Record<string, unknown>, standing = 'active') => () => Response.json({ org: 'tenant', standing, owners: [], members: [{ id: 'user-ana', ...entry }] });
const editor = { type: 'person', status: 'member', orgRole: 'EDITOR', appRole: 'EDITOR', permissions: ['esign.manage', 'esign.view'], standing: 'active' };

test('when due, it is sent only while whoever scheduled it can still send: the platform says who can use Esign now', async () => {
  let now: () => Response = status(editor);
  const h = await setup({ status: () => now() }, (url, body) => url.pathname === '/__insulin/members/status' && JSON.stringify(body) === JSON.stringify({ org: 'tenant', ids: ['user-ana'] }));
  try {
    const schedule = async (key: string) => {
      const r = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': key });
      assert.equal(r.status, 201, await r.clone().text());
      const { id } = await r.json() as { id: string };
      await h.due(id);
      return id;
    };
    const error = async (id: string) => JSON.parse((await h.row(id))!.draft_json!).schedule.error;
    // Gone from the organization, or from Esign; the organization deleted.
    for (const [key, answer] of [['removed', status({ type: 'person', status: 'left' })], ['deleted', () => Response.json({ error: 'org_deleted' }, { status: 404 })]] as const) {
      now = answer;
      const removed = await schedule(key);
      const ran = await h.tick();
      assert.deepEqual([ran.scheduledSent, ran.scheduledFailed], [0, 1], key);
      assert.deepEqual([(await h.row(removed))?.status, await error(removed)], ['DRAFT', 'not_allowed'], key);
    }
    // Made a Viewer, or given a custom role that only views; an account Insulin Apps suspended or disabled.
    for (const [key, entry] of [['viewer', { ...editor, appRole: 'VIEWER', permissions: ['esign.view'] }], ['custom', { ...editor, permissions: ['esign.view'] }], ['suspended', { ...editor, standing: 'suspended' }], ['disabled', { ...editor, standing: 'disabled' }]] as const) {
      now = status(entry);
      const demoted = await schedule(`demoted-${key}`);
      await h.tick();
      assert.equal(await error(demoted), 'not_allowed', key);
    }
    // The platform can't be asked, or the organization is suspended: it waits for the next tick, unchanged, and is sent
    // once it can.
    for (const [key, answer] of [['unavailable', () => new Response('unavailable', { status: 503 })], ['unknown', () => Response.json({ error: 'unknown_organization' }, { status: 404 })], ['held', status(editor, 'suspended')]] as const) {
      now = answer;
      const waiting = await schedule(`waiting-${key}`);
      await h.tick();
      assert.deepEqual([(await h.row(waiting))?.status, await error(waiting)], ['DRAFT', undefined], key);
      now = status(editor);
      await h.retry(waiting);
      await h.tick();
      assert.equal((await h.row(waiting))?.status, 'IN_PROGRESS', `${key}: still an editor, sent`);
    }
    // A member status without standing (a gateway from before it said so): sent as the role allows.
    const { standing: _standing, ...older } = editor;
    now = () => Response.json({ org: 'tenant', owners: [], members: [{ id: 'user-ana', ...older }] });
    const sent = await schedule('older-platform');
    await h.tick();
    assert.equal((await h.row(sent))?.status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});

test('due in an organization the platform has no record of Esign in: it waits, still scheduled, says why, and goes once the platform confirms it', async () => {
  // As the gateway answers after its upgrade (DESIGN.md §8.9) for an organization whose only use of Esign came just
  // before: unknown to it until someone opens Esign there. A usage report doesn't change that.
  let confirmed = false, asked = 0;
  const h = await setup({
    status: () => { asked += 1; return confirmed ? status(editor)() : Response.json({ error: 'unknown_organization' }, { status: 404 }); },
    report: () => Response.json({ status: 'accepted' }, { status: 202 }),
  });
  try {
    const r = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': 'unconfirmed' });
    assert.equal(r.status, 201, await r.clone().text());
    const { id, sendAt } = await r.json() as { id: string; sendAt: string };
    await h.due(id);
    for (const n of [1, 2]) {
      assert.deepEqual(await h.tick(), { expired: 0, completed: 0, waiting: 0, failed: 0, scheduledSent: 0, scheduledFailed: 0 }, `tick ${n}`);
      assert.equal((await h.row(id))?.status, 'DRAFT');
    }
    assert.equal(asked, 1, 'tried again only ten minutes on, not at the very next tick');
    // Its sender sees why: still scheduled for its time, waiting for the platform; never an error.
    const shown = await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { sendAt?: string; sendError?: string; sendWaiting?: string };
    assert.deepEqual([typeof shown.sendAt, shown.sendError, shown.sendWaiting], ['string', undefined, 'organization_unconfirmed']);
    assert.notEqual(shown.sendAt, sendAt, 'the time it became due');
    const [listed] = (await (await h.req('/api/envelopes?status=DRAFT', h.ana)).json() as { envelopes: { sendWaiting?: string }[] }).envelopes;
    assert.equal(listed!.sendWaiting, 'organization_unconfirmed');
    // Someone opens Esign there, so the platform confirms it: the next try sends it.
    confirmed = true;
    await h.retry(id);
    assert.equal((await h.tick()).scheduledSent, 1);
    assert.equal((await h.row(id))?.status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});

test('a waiting draft that then fails says why it failed, not that it waits', async () => {
  let answer: () => Response = () => Response.json({ error: 'unknown_organization' }, { status: 404 });
  const h = await setup({ status: () => answer() });
  try {
    const r = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': 'waits-then-fails' });
    const { id } = await r.json() as { id: string };
    await h.due(id);
    await h.tick();
    assert.equal(JSON.parse((await h.row(id))!.draft_json!).schedule.waiting, 'organization_unconfirmed');
    answer = status({ type: 'person', status: 'left' });
    await h.retry(id);
    await h.tick();
    const schedule = JSON.parse((await h.row(id))!.draft_json!).schedule;
    assert.deepEqual([schedule.at, schedule.error, schedule.waiting, schedule.retryAt], [null, 'not_allowed', undefined, undefined]);
    const shown = await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { sendError?: string; sendWaiting?: string };
    assert.deepEqual([shown.sendError, shown.sendWaiting], ['not_allowed', undefined]);
  } finally { await h.mf.dispose(); }
});

test("75 waiting drafts of one organization never hold up another's: one question a run, all resting together, over several rests", async () => {
  const asked: { org: string; ids: string[] }[] = [];
  const h = await setup({
    status: (body) => {
      asked.push(body);
      return body.org === 'tenant' ? Response.json({ error: 'unknown_organization' }, { status: 404 })
        : Response.json({ org: body.org, standing: 'active', owners: [], members: body.ids.map((id) => ({ ...editor, id })) });
    },
  });
  try {
    // 75 due drafts where the platform can't vouch for the organization yet: three runs' worth, all older than the rest.
    for (let i = 0; i < 75; i += 1) {
      const r = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': `crowd-${i}` });
      assert.equal(r.status, 201, await r.clone().text());
      await h.due((await r.json() as { id: string }).id);
    }
    const cy = identity('other', { userId: 'user-cy', email: 'cy@example.test', role: 'EDITOR' });
    const created = await h.req('/api/templates', cy, { method: 'POST', body: h.form });
    assert.equal(created.status, 201, await created.clone().text());
    const otherTemplate = (await created.json() as { id: string }).id;
    const waiting = async () => (await h.db.prepare(`SELECT COUNT(*) AS n FROM envelopes WHERE tenant_id = 'tenant' AND status = 'DRAFT'
        AND json_extract(draft_json, '$.schedule.waiting') = 'organization_unconfirmed' AND json_extract(draft_json, '$.schedule.retryAt') > ?`).bind(Date.now()).first<{ n: number }>())!.n;
    // Four rests over: each time the 75 are tried again, and each time another organization's draft, due after them,
    // goes out at its first tick.
    for (let rest = 1; rest <= 4; rest += 1) {
      if (rest > 1) await h.db.prepare("UPDATE envelopes SET draft_json = json_set(draft_json, '$.schedule.retryAt', ?) WHERE tenant_id = 'tenant' AND status = 'DRAFT'").bind(Date.now() - 1000).run();
      const r = await h.post('/api/envelopes', cy, { ...whole(otherTemplate), sendAt: later() }, { 'idempotency-key': `other-${rest}` });
      const { id } = await r.json() as { id: string };
      await h.due(id);
      asked.length = 0;
      const ran = await h.tick();
      assert.deepEqual([ran.scheduledSent, ran.scheduledFailed], [1, 0], `rest ${rest}`);
      assert.equal((await h.row(id))?.status, 'IN_PROGRESS', `rest ${rest}: sent at its first tick`);
      assert.deepEqual(asked.map((call) => call.org).sort(), ['other', 'tenant'], `rest ${rest}: one question for each organization`);
      assert.deepEqual(asked.find((call) => call.org === 'tenant')!.ids, ['user-ana'], 'for every scheduler of its drafts at once');
      assert.equal(await waiting(), 75, `rest ${rest}: all 75 rest again, still scheduled`);
    }
  } finally { await h.mf.dispose(); }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * A run of these tests: a 1 s budget and a 0.5 s question, scaled down from the real 10 s and 5 s. Asked one after
 * another, two answers of 0.4 s would leave a third 0.2 s: too little, every run (F228); asked together, all fit.
 */
const TIMING = { budgetMs: 1000, statusTimeoutMs: 500 };

/**
 * A platform whose organizations answer as `answers` says (after `ms`; `kind` member, suspended or unconfirmed),
 * recording each question; and, per organization, a template and a draft due now to schedule with.
 */
async function slowPlatform(answers: Record<string, { ms: number; kind: 'member' | 'suspended' | 'unconfirmed' }>, timing = TIMING) {
  const asked: string[] = [];
  const h = await setup({
    timing,
    status: async (body) => {
      asked.push(body.org);
      const answer = answers[body.org] ?? { ms: 0, kind: 'member' };
      await sleep(answer.ms);
      if (answer.kind === 'unconfirmed') return Response.json({ error: 'unknown_organization' }, { status: 404 });
      return Response.json({ org: body.org, standing: answer.kind === 'suspended' ? 'suspended' : 'active', owners: [], members: body.ids.map((id) => ({ ...editor, id })) });
    },
  });
  const templates = new Map<string, string>();
  const draft = async (org: string, key: string) => {
    const who = org === 'tenant' ? h.ana : identity(org, { userId: `user-${org}`, email: `${org}@example.test`, role: 'EDITOR' });
    if (!templates.has(org)) {
      if (org === 'tenant') templates.set(org, h.templateId);
      else {
        const created = await h.req('/api/templates', who, { method: 'POST', body: h.form });
        assert.equal(created.status, 201, await created.clone().text());
        templates.set(org, (await created.json() as { id: string }).id);
      }
    }
    const r = await h.post('/api/envelopes', who, { ...whole(templates.get(org)!), sendAt: later() }, { 'idempotency-key': key });
    assert.equal(r.status, 201, await r.clone().text());
    const { id } = await r.json() as { id: string };
    await h.due(id);
    return id;
  };
  const statuses = async (ids: string[]) => Promise.all(ids.map(async (id) => (await h.row(id))!.status));
  return { h, asked, draft, statuses };
}

test('two slow suspended organizations ahead of a slow healthy one: it sends at its first tick, every time', async () => {
  const { h, draft, statuses } = await slowPlatform({ 'org-a': { ms: 400, kind: 'suspended' }, 'org-b': { ms: 400, kind: 'suspended' }, 'org-c': { ms: 400, kind: 'member' } });
  try {
    const held = [await draft('org-a', 'a'), await draft('org-b', 'b')];
    for (let tick = 1; tick <= 6; tick += 1) {
      // The suspended ones' step back is over by each tick, as five minutes on: they come first again.
      await h.db.prepare("UPDATE envelopes SET draft_json = json_remove(draft_json, '$.schedule.retryAt') WHERE status = 'DRAFT'").run();
      const c = await draft('org-c', `c-${tick}`);
      assert.equal((await h.tick()).scheduledSent, 1, `tick ${tick}`);
      assert.deepEqual(await statuses([...held, c]), ['DRAFT', 'DRAFT', 'IN_PROGRESS'], `tick ${tick}: the suspended ones wait`);
    }
  } finally { await h.mf.dispose(); }
});

test('several organizations slow to answer, beside 75 waiting drafts: asked together, every one sends at the first tick', async () => {
  // Room for the four sends after the answers, even on a busy machine.
  const { h, asked, draft, statuses } = await slowPlatform({
    tenant: { ms: 400, kind: 'unconfirmed' }, 'org-b': { ms: 400, kind: 'member' }, 'org-c': { ms: 450, kind: 'member' }, 'org-d': { ms: 350, kind: 'member' }, 'org-e': { ms: 400, kind: 'member' },
  }, { budgetMs: 3000, statusTimeoutMs: 500 });
  try {
    for (let i = 0; i < 75; i += 1) await draft('tenant', `crowd-${i}`);
    const others = [await draft('org-b', 'b'), await draft('org-c', 'c'), await draft('org-d', 'd'), await draft('org-e', 'e')];
    const started = Date.now();
    const ran = await h.tick();
    assert.ok(Date.now() - started < 3000, 'the slowest answer, not their sum');
    assert.deepEqual([ran.scheduledSent, ran.scheduledFailed], [4, 0]);
    assert.deepEqual(await statuses(others), ['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS']);
    assert.deepEqual([...asked].sort(), ['org-b', 'org-c', 'org-d', 'org-e', 'tenant'], 'one question for each organization');
    const resting = (await h.db.prepare(`SELECT COUNT(*) AS n FROM envelopes WHERE tenant_id = 'tenant' AND status = 'DRAFT' AND json_extract(draft_json, '$.schedule.waiting') = 'organization_unconfirmed'`).first<{ n: number }>())!.n;
    assert.equal(resting, 75, 'all 75 rest, in one go, still scheduled');
  } finally { await h.mf.dispose(); }
});

test('an organization that never answers in time holds no one up, gets no step back, and is asked again at its next turn', async () => {
  const { h, asked, draft, statuses } = await slowPlatform({ 'org-x': { ms: 900, kind: 'member' }, 'org-y': { ms: 100, kind: 'member' } });
  try {
    const stuck = [];
    for (let i = 0; i < 30; i += 1) stuck.push(await draft('org-x', `x-${i}`));
    const y = await draft('org-y', 'y');
    assert.equal((await h.tick()).scheduledSent, 1);
    assert.deepEqual(await statuses([y]), ['IN_PROGRESS']);
    const kept = await h.db.prepare("SELECT COUNT(*) AS n FROM envelopes WHERE tenant_id = 'org-x' AND status = 'DRAFT' AND json_extract(draft_json, '$.schedule.retryAt') IS NULL AND json_extract(draft_json, '$.schedule.waiting') IS NULL").first<{ n: number }>();
    assert.equal(kept!.n, 30, 'left as they were: no step back, no note');
    assert.deepEqual(asked.filter((org) => org === 'org-x').length, 1, 'asked once a run');
    // The next tick: round again, it is asked once more beside org-y.
    asked.length = 0;
    const y2 = await draft('org-y', 'y2');
    assert.equal((await h.tick()).scheduledSent, 1);
    assert.deepEqual(await statuses([y2]), ['IN_PROGRESS']);
    assert.deepEqual([...asked].sort(), ['org-x', 'org-y'], 'asked at its turn');
  } finally { await h.mf.dispose(); }
});

const pad = (n: number) => String(n).padStart(2, '0');

test('twenty organizations that never answer in time ahead of a healthy one: it is asked and sends within ceil(21 / 10) ticks', async () => {
  const answers: Record<string, { ms: number; kind: 'member' }> = {};
  for (let i = 1; i <= 20; i += 1) answers[`org-${pad(i)}`] = { ms: 900, kind: 'member' };
  const { h, asked, draft, statuses } = await slowPlatform(answers);
  try {
    for (let i = 1; i <= 20; i += 1) await draft(`org-${pad(i)}`, `late-${i}`);
    // Last in id order, and its draft the newest.
    const healthy = await draft('org-21', 'healthy');
    let sentAt = 0;
    for (let tick = 1; tick <= 3 && !sentAt; tick += 1) {
      asked.length = 0;
      await h.tick();
      if ((await statuses([healthy]))[0] === 'IN_PROGRESS') sentAt = tick;
    }
    assert.ok(sentAt >= 1 && sentAt <= Math.ceil(21 / 10), `sent at tick ${sentAt}`);
    assert.ok(asked.includes('org-21'), 'asked at the tick that sent it');
  } finally { await h.mf.dispose(); }
});

test('ten organizations with more drafts than a run has places ahead of an eleventh: it sends within ceil(11 / 10) ticks, the ten in turns', async () => {
  // A budget that holds a run's 25 sends even on a busy machine: the places, not the time, end the first run.
  const { h, draft, statuses } = await slowPlatform({}, { budgetMs: 8000, statusTimeoutMs: 500 });
  try {
    const crowd: string[][] = [];
    for (let i = 1; i <= 10; i += 1) {
      const ids = [];
      for (let k = 0; k < 5; k += 1) ids.push(await draft(`org-${pad(i)}`, `full-${i}-${k}`));
      crowd.push(ids);
    }
    const eleventh = await draft('org-11', 'eleventh');
    const first = await h.tick();
    assert.deepEqual([first.scheduledSent, first.scheduledFailed], [25, 0]);
    // In passes: every one of the ten sent two or three, none five.
    const sentEach = await Promise.all(crowd.map(async (ids) => (await statuses(ids)).filter((s) => s === 'IN_PROGRESS').length));
    assert.ok(sentEach.every((n) => n === 2 || n === 3), JSON.stringify(sentEach));
    assert.deepEqual(await statuses([eleventh]), ['DRAFT'], 'the ten took the places');
    await h.tick();
    assert.deepEqual(await statuses([eleventh]), ['IN_PROGRESS'], 'its turn came at the next tick');
  } finally { await h.mf.dispose(); }
});

test("one organization's 75 drafts beside another's one: sends take turns, so the other's goes at the first tick", async () => {
  // A budget that holds a few sends, not 25, as slow sends would: one org-a send must leave org-b its turn.
  const { h, draft, statuses } = await slowPlatform({}, { budgetMs: 600, statusTimeoutMs: 100 });
  try {
    for (let i = 0; i < 75; i += 1) await draft('org-a', `a-${i}`);
    const b = await draft('org-b', 'b');
    const ran = await h.tick();
    assert.ok(ran.scheduledSent >= 2, JSON.stringify(ran));
    assert.deepEqual(await statuses([b]), ['IN_PROGRESS'], "the second send of the run is org-b's");
  } finally { await h.mf.dispose(); }
});

test('two runs at once never send a draft twice', async () => {
  const { h, draft, statuses } = await slowPlatform({ 'org-b': { ms: 200, kind: 'member' } });
  try {
    const id = await draft('org-b', 'once');
    const runs = await Promise.all([h.tick(), h.tick(), h.tick()]);
    assert.equal(runs.reduce((sum, run) => sum + run.scheduledSent, 0), 1, 'sent by one run only');
    assert.equal(runs.reduce((sum, run) => sum + run.scheduledFailed, 0), 0, 'the others leave it, not refuse it');
    assert.deepEqual(await statuses([id]), ['IN_PROGRESS']);
    assert.equal((await h.tasks(id)).length, 2, 'one task for each of its two roles, once');
  } finally { await h.mf.dispose(); }
});

test("an API client's scheduled send is checked too: revoking the client stops it", async () => {
  let now: () => Response = () => new Response('unavailable', { status: 503 });
  const h = await setup({ status: () => now() }, (_url, body) => JSON.stringify(body) === JSON.stringify({ org: 'tenant', ids: ['sa-host'] }));
  try {
    const client = identity('tenant', { userId: 'sa-host', role: 'EDITOR', via: 'api' });
    const pdf = await PDFDocument.create(); pdf.addPage();
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(['partner', 'seller']));
    const created = await h.req('/api/templates', client, { method: 'POST', body: form });
    assert.equal(created.status, 201, await created.clone().text());
    const templateId = (await created.json() as { id: string }).id;
    const schedule = async (key: string) => {
      const r = await h.post('/api/envelopes', client, { ...whole(templateId), sendAt: later() }, { 'idempotency-key': key });
      assert.equal(r.status, 201, await r.clone().text());
      const { id } = await r.json() as { id: string };
      await h.due(id);
      return id;
    };
    now = () => Response.json({ org: 'tenant', standing: 'active', owners: [], members: [{ id: 'sa-host', type: 'client', status: 'revoked' }] });
    const revoked = await schedule('client-revoked');
    await h.tick();
    assert.equal(JSON.parse((await h.row(revoked))!.draft_json!).schedule.error, 'not_allowed');
    now = () => Response.json({ org: 'tenant', standing: 'active', owners: [], members: [{ id: 'sa-host', type: 'client', status: 'member', appRole: 'EDITOR', permissions: ['esign.manage', 'esign.view'] }] });
    const live = await schedule('client-live');
    await h.tick();
    assert.equal((await h.row(live))?.status, 'IN_PROGRESS', 'a live client with Manage: sent');
  } finally { await h.mf.dispose(); }
});

test('whoever scheduled it is asked for by id, whatever their address', async () => {
  const long = `${'a'.repeat(110)}@example.test`;
  const h = await setup({ status: () => Response.json({ org: 'tenant', standing: 'active', owners: [], members: [{ ...editor, id: 'user-long' }] }) }, (_url, body) => JSON.stringify(body) === JSON.stringify({ org: 'tenant', ids: ['user-long'] }));
  try {
    const who = identity('tenant', { userId: 'user-long', email: long, role: 'EDITOR' });
    await h.req('/api/templates/' + h.templateId + '/shares', h.ana, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: long, role: 'viewer' }) });
    const r = await h.post('/api/envelopes', who, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': 'long-email' });
    assert.equal(r.status, 201, await r.clone().text());
    const { id } = await r.json() as { id: string };
    await h.due(id);
    await h.tick();
    assert.equal((await h.row(id))?.status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});

test('sent when due, it is shared as the draft is then: a share removed after scheduling stays removed', async () => {
  const h = await setup();
  try {
    const r = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), share: [{ email: 'bo@example.test', role: 'viewer' }], sendAt: later() }, { 'idempotency-key': 'unshared' });
    assert.equal(r.status, 201, await r.clone().text());
    const { id } = await r.json() as { id: string };
    assert.equal((await h.req(`/api/envelopes/${id}`, h.bo)).status, 200, 'shared when scheduled');
    assert.equal((await h.post(`/api/envelopes/${id}/shares/delete`, h.ana, { email: 'bo@example.test' })).status, 200);
    await h.due(id);
    await h.tick();
    assert.equal((await h.row(id))?.status, 'IN_PROGRESS');
    assert.equal((await h.req(`/api/envelopes/${id}`, h.bo)).status, 404, 'still not shared with them');
  } finally { await h.mf.dispose(); }
});

test('the tick finds the drafts due through the partial index on schedule.at', async () => {
  const h = await setup();
  try {
    for (const [sql, binds] of [[DUE_ORGANIZATIONS_SQL, [Date.now(), null, '', '[]']], [DUE_DRAFTS_SQL, [Date.now(), '["tenant"]']]] as const) {
      const plan = await h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      assert.ok(plan.results.some((row) => /USING INDEX envelopes_scheduled/.test(row.detail)), JSON.stringify(plan.results));
    }
  } finally { await h.mf.dispose(); }
});
