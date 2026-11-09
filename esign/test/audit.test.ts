import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { AUDIT, auditTrail, recordAudit, requestFacts } from '../src/audit.ts';
import { CONSENT_DISCLOSURE, consentDisclosure } from '../src/disclosure.ts';

async function database() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`, 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('t')").run();
  await db.prepare("INSERT INTO templates(id,tenant_id,object_key,roles_json,created_at) VALUES ('tpl','t','k','[\"a\"]',0)").run();
  await db.prepare("INSERT INTO envelopes(id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('e1','t','tpl','IN_PROGRESS',0,'hash')").run();
  return { mf, db };
}

test('the audit trail records each event in order, with the IP and browser of the request', async () => {
  const { mf, db } = await database();
  try {
    const request = new Request('https://esign.example.test/v1/signing/sign', { headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (synthetic)' } });
    await recordAudit(db, { envelopeId: 'e1', type: AUDIT.sessionOpened, ...requestFacts(request), at: 1000 });
    await recordAudit(db, { envelopeId: 'e1', type: AUDIT.otpSent, detail: { to: 'ana@partner.test', delivery: 'email' }, at: 2000 });
    const trail = await auditTrail(db, 'e1');
    assert.deepEqual(trail.map(e => [e.type, e.occurredAt, e.ip, e.userAgent, e.detail]), [
      [AUDIT.sessionOpened, 1000, '203.0.113.7', 'Mozilla/5.0 (synthetic)', null],
      [AUDIT.otpSent, 2000, null, null, { to: 'ana@partner.test', delivery: 'email' }],
    ]);
    assert.deepEqual(await auditTrail(db, 'other'), []);
  } finally { await mf.dispose(); }
});

test('audit events cannot be changed or deleted', async () => {
  const { mf, db } = await database();
  try {
    await recordAudit(db, { envelopeId: 'e1', type: AUDIT.signed, at: 1 });
    await assert.rejects(db.prepare("UPDATE audit_events SET type='X'").run(), /append-only/);
    await assert.rejects(db.prepare('DELETE FROM audit_events').run(), /append-only/);
    assert.equal((await auditTrail(db, 'e1')).length, 1);
  } finally { await mf.dispose(); }
});

test('request facts keep only a plausible IP and a bounded user agent', () => {
  assert.deepEqual(requestFacts(new Request('https://x.test/', { headers: { 'cf-connecting-ip': '2001:db8::1', 'user-agent': 'x'.repeat(2000) } })), { ip: '2001:db8::1', userAgent: 'x'.repeat(512) });
  assert.deepEqual(requestFacts(new Request('https://x.test/', { headers: { 'cf-connecting-ip': '<script>' } })), { ip: null, userAgent: null });
});

test('the consent disclosure has a version and its text is identified by hash', async () => {
  const d = await consentDisclosure();
  assert.equal(d.version, CONSENT_DISCLOSURE.version);
  assert.equal(d.text, CONSENT_DISCLOSURE.text);
  assert.match(d.sha256, /^[0-9a-f]{64}$/);
  assert.match(d.text, /paper copy/);
  assert.match(d.text, /withdraw/);
});
