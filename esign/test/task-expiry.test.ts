import {blobStore} from './helpers/platform.ts';
// A recipient's sign-by deadline: past it, while that recipient has not signed, the envelope expires
// for everyone (in-process, synthetic data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { MIGRATIONS_DIR, splitSql as unstable_splitSqlQuery } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { AUDIT, auditTrail } from '../src/app/server/esign/audit.ts';
import { expireDueEnvelopes } from '../src/app/server/esign/task-expiry.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'a'.repeat(64);
const SIGNER = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Synthetic signer)' };
const DAY = 86_400_000;

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(new URL(name,MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))).toString('hex')).run();
  const env = { DB: db, ARTIFACTS: await blobStore(mf,'artifacts'), TEST_MAIL: await blobStore(mf,'test-mail'), OTP_KEY: 'task-expiry-otp-pepper-at-least-32-bytes' };
  const auth = { authorization: `Bearer ${KEY}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner","isv"]');
  const template = await (await req('/api/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
  /** A prepared envelope: the partner signs by `partnerExpiresAt`, the countersigner has no deadline. */
  const envelope = async (key: string, partnerExpiresAt?: string) => {
    const partner: Record<string, string> = { role: 'partner', name: 'Ana Partner', email: 'ana@partner.test' };
    if (partnerExpiresAt !== undefined) partner.expiresAt = partnerExpiresAt;
    const res = await req('/api/envelopes', json({ templateId: template.id, recipients: [partner, { role: 'isv', name: 'Marcus Seller', email: 'marcus@seller.test' }] }, { ...auth, 'idempotency-key': key }));
    const body = await res.json() as { id?: string; error?: string };
    if (body.id) await req(`/api/envelopes/${body.id}/prepare`, { method: 'POST', headers: auth });
    return { status: res.status, ...body };
  };
  const read = async (id: string) => (await req(`/api/envelopes/${id}`, { headers: auth })).json() as Promise<{ status: string; tasks: { id: string; status: string; expiresAt?: string }[] }>;
  return { mf, db, auth, req, json, envelope, read };
}

test('an envelope keeps each recipient\'s sign-by deadline and shows it on the task', async () => {
  const h = await harness();
  try {
    const due = new Date(Date.now() + 30 * DAY).toISOString();
    const { id } = await h.envelope('k1', due);
    const env = await h.read(id!);
    assert.equal(env.status, 'IN_PROGRESS');
    assert.equal(env.tasks[0].expiresAt, due);
    assert.equal(env.tasks[1].expiresAt, undefined, 'the countersigner has no deadline');
  } finally { await h.mf.dispose(); }
});

test('a deadline must be a future time within 400 days', async () => {
  const h = await harness();
  try {
    const bads = ['tomorrow', new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 401 * DAY).toISOString()];
    for (const [i, bad] of bads.entries()) {
      const res = await h.envelope(`bad-${i}`, bad);
      assert.equal(res.status, 422, bad);
      assert.equal(res.error, 'invalid_recipient');
    }
  } finally { await h.mf.dispose(); }
});

test('past the deadline the envelope expires: no link, no code, and one EXPIRED audit event', async () => {
  const h = await harness();
  try {
    const { id } = await h.envelope('k2', new Date(Date.now() + DAY).toISOString());
    const task = (await h.read(id!)).tasks[0];
    const { code } = await (await h.req(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`, h.json({ origin: ORIGIN }, h.auth))).json() as { code: string };
    const { token } = await (await h.req('/api/public/page-sessions/exchange', h.json({ code }, { origin: ORIGIN, ...SIGNER }))).json() as { token: string };
    const signer = { origin: ORIGIN, 'x-esign-session': token, ...SIGNER };

    // The deadline passes while the signing page is open.
    await h.db.prepare('UPDATE tasks SET expires_at=? WHERE id=?').bind(Date.now() - 1000, task.id).run();
    assert.notEqual((await h.req('/api/public/signing/otp', h.json({}, signer))).status, 200, 'no code after the deadline');
    assert.equal((await h.read(id!)).status, 'EXPIRED');
    assert.notEqual((await h.req(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`, h.json({ origin: ORIGIN }, h.auth))).status, 201, 'no new link');
    assert.equal((await h.req(`/api/envelopes/${id}/void`, h.json({}, h.auth))).status, 409, 'an expired envelope is not voided');
    const events = (await auditTrail(h.db, id!)).filter(e => e.type === AUDIT.expired);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].detail, { taskId: task.id });
  } finally { await h.mf.dispose(); }
});

test('reading the envelope expires it too, and the sweep expires every due one once', async () => {
  const h = await harness();
  try {
    const a = await h.envelope('k3', new Date(Date.now() + DAY).toISOString());
    const b = await h.envelope('k4', new Date(Date.now() + DAY).toISOString());
    const c = await h.envelope('k5');
    await h.db.prepare("UPDATE tasks SET expires_at=? WHERE envelope_id IN (?,?) AND role='partner'").bind(Date.now() - 1000, a.id, b.id).run();
    assert.equal((await h.read(a.id!)).status, 'EXPIRED');
    assert.equal(await expireDueEnvelopes(h.db), 1, 'only b was still open');
    assert.equal(await expireDueEnvelopes(h.db), 0);
    assert.equal((await h.read(b.id!)).status, 'EXPIRED');
    assert.equal((await h.read(c.id!)).status, 'IN_PROGRESS', 'no deadline, no expiry');
  } finally { await h.mf.dispose(); }
});

test('once the partner has signed, their deadline no longer applies (countersigning never expires)', async () => {
  const h = await harness();
  try {
    const { id } = await h.envelope('k6', new Date(Date.now() + DAY).toISOString());
    const [partner, isv] = (await h.read(id!)).tasks;
    await h.db.batch([
      h.db.prepare("UPDATE tasks SET status='SIGNED' WHERE id=?").bind(partner.id),
      h.db.prepare('UPDATE tasks SET expires_at=? WHERE id=?').bind(Date.now() - 1000, partner.id),
      h.db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id=?").bind(isv.id),
    ]);
    assert.equal(await expireDueEnvelopes(h.db), 0);
    assert.equal((await h.read(id!)).status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});
