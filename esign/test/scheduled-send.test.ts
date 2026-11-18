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
import { parseSendAt } from '../src/app/server/esign/scheduled-send.ts';

const ORIGIN = 'https://esign.example.test';
const TICK = { 'x-suger-app-id': 'insulin-apps-esign', 'x-suger-access-via': 'schedule' };
const HOUR = 60 * 60 * 1000;

async function setup(platform: { members?: () => Response } = {}, accepts: (url: URL) => boolean = () => true) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  const env = {
    DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), TEST_MAIL: await blobStore(mf, 'test-mail'), OTP_KEY: 'scheduled-pepper-at-least-32-bytes-long', TEST_SEAL_KEY: 'scheduled-seal-key-at-least-32-bytes-long',
    // Who can use Esign now, as the platform's members endpoint answers (directory.ts); without it, as they scheduled.
    ...(platform.members ? { SUGER_MEMBERS_URL: 'https://apps.example.test/__insulin/members', SUGER_APP_TOKEN: 'app-token-for-esign', MEMBERS_FETCH: (async (input: string) => accepts(new URL(input)) ? platform.members!() : Response.json({ error: 'invalid_request' }, { status: 400 })) as unknown as typeof fetch } : {}),
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
  return { mf, db, req, post, ana, bo, templateId, row, due, tick, tasks };
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

test('when due, it is sent only while whoever scheduled it can still send: the platform says who can use Esign now', async () => {
  let members: () => Response = () => Response.json({ members: [{ id: 'user-ana', name: 'Ana', email: 'ana@example.test', role: 'EDITOR', permissions: ['esign.manage', 'esign.view'] }] });
  const h = await setup({ members: () => members() });
  try {
    const schedule = async (key: string) => {
      const r = await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), sendAt: later() }, { 'idempotency-key': key });
      assert.equal(r.status, 201, await r.clone().text());
      const { id } = await r.json() as { id: string };
      await h.due(id);
      return id;
    };
    // Gone from the organization, or from Esign.
    members = () => Response.json({ members: [] });
    const removed = await schedule('removed');
    const ran = await h.tick();
    assert.deepEqual([ran.scheduledSent, ran.scheduledFailed], [0, 1]);
    assert.deepEqual([(await h.row(removed))?.status, JSON.parse((await h.row(removed))!.draft_json!).schedule.error], ['DRAFT', 'not_allowed']);
    // Made a Viewer, or given a custom role that only views.
    for (const now of [{ role: 'VIEWER', permissions: ['esign.view'] }, { role: 'EDITOR', permissions: ['esign.view'] }]) {
      members = () => Response.json({ members: [{ id: 'user-ana', name: 'Ana', email: 'ana@example.test', ...now }] });
      const demoted = await schedule(`demoted-${now.role}-${now.permissions.length}`);
      await h.tick();
      assert.equal(JSON.parse((await h.row(demoted))!.draft_json!).schedule.error, 'not_allowed', JSON.stringify(now));
    }
    // The platform can't be asked: it waits for the next tick, unchanged, and is sent once it can.
    members = () => new Response('unavailable', { status: 503 });
    const waiting = await schedule('waiting');
    await h.tick();
    assert.deepEqual([(await h.row(waiting))?.status, JSON.parse((await h.row(waiting))!.draft_json!).schedule.error], ['DRAFT', undefined]);
    members = () => Response.json({ members: [{ id: 'user-ana', name: 'Ana', email: 'ana@example.test', role: 'EDITOR', permissions: ['esign.manage', 'esign.view'] }] });
    await h.tick();
    assert.equal((await h.row(waiting))?.status, 'IN_PROGRESS', 'still an editor: sent');
    // A platform that lists people without their roles (one deployed before this): still a member, sent as scheduled.
    members = () => Response.json({ members: [{ id: 'user-ana', name: 'Ana', email: 'ana@example.test' }] });
    const older = await schedule('older-platform');
    await h.tick();
    assert.equal((await h.row(older))?.status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});

test('a scheduler with a long email address is looked up within the platform\'s query limit', async () => {
  const long = `${'a'.repeat(110)}@example.test`;
  // As the platform answers: a query over 100 characters is refused.
  const h = await setup({ members: () => Response.json({ members: [{ id: 'user-long', name: 'Long', email: long, role: 'EDITOR', permissions: ['esign.manage', 'esign.view'] }] }) }, (url) => (url.searchParams.get('q') ?? '').length <= 100);
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
    const plan = await h.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM envelopes WHERE status = 'DRAFT' AND json_extract(draft_json, '$.schedule.at') <= ?1 AND (?2 IS NULL OR tenant_id = ?2) ORDER BY json_extract(draft_json, '$.schedule.at') LIMIT 25").bind(Date.now(), null).all<{ detail: string }>();
    assert.ok(plan.results.some((row) => /USING INDEX envelopes_scheduled/.test(row.detail)), JSON.stringify(plan.results));
  } finally { await h.mf.dispose(); }
});
