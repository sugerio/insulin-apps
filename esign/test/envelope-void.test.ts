import {blobStore} from './helpers/platform.ts';
// Voiding an envelope: the sender withdraws it before everyone has signed (in-process, synthetic data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { MIGRATIONS_DIR, splitSql as unstable_splitSqlQuery } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { AUDIT, auditTrail } from '../src/app/server/esign/audit.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const SIGNER = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Synthetic signer)' };

const keyHash = async (key: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('hex');

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(new URL(name,MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant'),('other')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant'),(?,'other')").bind(await keyHash(KEY), await keyHash(OTHER_KEY)).run();
  const env = { DB: db, ARTIFACTS: await blobStore(mf,'artifacts'), TEST_MAIL: await blobStore(mf,'test-mail'), OTP_KEY: 'envelope-void-otp-pepper-at-least-32-bytes' };
  const auth = { authorization: `Bearer ${KEY}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** A prepared one-signer envelope, and a signing session its signer has already opened. */
  const openEnvelope = async (idempotencyKey: string) => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
    const template = await (await req('/api/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
    const { id } = await (await req('/api/envelopes', json({ templateId: template.id, recipients: [{ role: 'partner', name: 'Ana Partner', email: 'ana@partner.test' }] }, { ...auth, 'idempotency-key': idempotencyKey }))).json() as { id: string };
    await req(`/api/envelopes/${id}/prepare`, { method: 'POST', headers: auth });
    const task = (await (await req(`/api/envelopes/${id}`, { headers: auth })).json() as { tasks: { id: string }[] }).tasks[0];
    const { code } = await (await req(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`, json({ origin: ORIGIN }, auth))).json() as { code: string };
    const { token } = await (await req('/api/public/page-sessions/exchange', json({ code }, { origin: ORIGIN, ...SIGNER }))).json() as { token: string };
    return { id, taskId: task.id, signer: { origin: ORIGIN, 'x-esign-session': token, ...SIGNER } };
  };
  return { mf, db, auth, req, json, openEnvelope };
}

test('voiding an envelope in progress ends it for everyone and records who asked and why', async () => {
  const h = await harness();
  try {
    const { id, taskId, signer } = await h.openEnvelope('void-1');
    const voided = await h.req(`/api/envelopes/${id}/void`, h.json({ reason: 'Wrong version of the amendment' }, h.auth));
    assert.equal(voided.status, 200);
    assert.deepEqual(await voided.json(), { id, status: 'VOIDED' });
    const envelope = await (await h.req(`/api/envelopes/${id}`, { headers: h.auth })).json() as { status: string };
    assert.equal(envelope.status, 'VOIDED');

    assert.notEqual((await h.req(`/api/envelopes/${id}/tasks/${taskId}/recipient-view`, h.json({ origin: ORIGIN }, h.auth))).status, 201, 'no new signing link');
    assert.notEqual((await h.req('/api/public/signing/current', { headers: signer })).status, 200, 'an open signing page can no longer load the document to sign');
    assert.notEqual((await h.req('/api/public/signing/otp', h.json({}, signer))).status, 200, 'nor ask for a code');

    const trail = await auditTrail(h.db, id);
    const events = trail.filter(e => e.type === AUDIT.voided);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].detail, { reason: 'Wrong version of the amendment' });
    assert.equal(events[0].taskId, null);
  } finally { await h.mf.dispose(); }
});

test('voiding again is a no-op, so a retried request is safe', async () => {
  const h = await harness();
  try {
    const { id } = await h.openEnvelope('void-2');
    assert.equal((await h.req(`/api/envelopes/${id}/void`, h.json({}, h.auth))).status, 200);
    const again = await h.req(`/api/envelopes/${id}/void`, h.json({ reason: 'again' }, h.auth));
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { id, status: 'VOIDED' });
    assert.equal((await auditTrail(h.db, id)).filter(e => e.type === AUDIT.voided).length, 1);
  } finally { await h.mf.dispose(); }
});

test('an envelope that is finishing or completed cannot be voided', async () => {
  const h = await harness();
  try {
    for (const status of ['FINALIZING', 'COMPLETED']) {
      const { id } = await h.openEnvelope(`void-${status}`);
      await h.db.prepare('UPDATE envelopes SET status=? WHERE id=?').bind(status, id).run();
      const refused = await h.req(`/api/envelopes/${id}/void`, h.json({}, h.auth));
      assert.equal(refused.status, 409, status);
      assert.deepEqual(await refused.json(), { error: 'envelope_not_voidable' });
      const envelope = await (await h.req(`/api/envelopes/${id}`, { headers: h.auth })).json() as { status: string };
      assert.equal(envelope.status, status);
    }
  } finally { await h.mf.dispose(); }
});

test('only the envelope\'s own tenant can void it, and the reason is bounded', async () => {
  const h = await harness();
  try {
    const { id } = await h.openEnvelope('void-3');
    assert.equal((await h.req(`/api/envelopes/${id}/void`, h.json({}, { authorization: `Bearer ${OTHER_KEY}` }))).status, 404);
    assert.equal((await h.req(`/api/envelopes/${id}/void`, h.json({ reason: 'x'.repeat(501) }, h.auth))).status, 422);
    assert.equal((await h.req(`/api/envelopes/${id}/void`, h.json({ reason: 42 }, h.auth))).status, 422);
    const envelope = await (await h.req(`/api/envelopes/${id}`, { headers: h.auth })).json() as { status: string };
    assert.equal(envelope.status, 'IN_PROGRESS');
  } finally { await h.mf.dispose(); }
});
