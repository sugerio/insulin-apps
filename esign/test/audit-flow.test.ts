// The audit trail and consent disclosure through a real signing (in-process, synthetic data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { unstable_splitSqlQuery } from 'wrangler';
import app from '../src/worker.ts';
import { AUDIT, auditTrail } from '../src/audit.ts';
import { consentDisclosure } from '../src/disclosure.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'a'.repeat(64);
const SIGNER = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Synthetic signer)' };

test('a signing leaves an ordered audit trail with the signer\'s IP and browser, and the consent they agreed to', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS', 'TEST_MAIL'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`, 'utf8')).map(s => db.prepare(s)));
    await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
    await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))).toString('hex')).run();
    const env = { DB: db, ARTIFACTS: await mf.getR2Bucket('ARTIFACTS'), TEST_MAIL: await mf.getR2Bucket('TEST_MAIL'), LOCAL_TEST_MODE: 'true', LOCAL_TEST_OTP_KEY: 'audit-flow-otp-pepper-at-least-32-bytes' };
    const auth = { authorization: `Bearer ${KEY}` };
    const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
    const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const pdf = await PDFDocument.create(); pdf.addPage();
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
    const template = await (await req('/v1/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
    const { id } = await (await req('/v1/envelopes', json({ templateId: template.id, recipients: [{ role: 'partner', name: 'Ana Partner', email: 'ana@partner.test' }] }, { ...auth, 'idempotency-key': 'k1' }))).json() as { id: string };
    await req(`/v1/envelopes/${id}/prepare`, { method: 'POST', headers: auth });
    const task = (await (await req(`/v1/envelopes/${id}`, { headers: auth })).json() as { tasks: { id: string }[] }).tasks[0];
    const { code } = await (await req(`/v1/envelopes/${id}/tasks/${task.id}/recipient-view`, json({ origin: ORIGIN }, auth))).json() as { code: string };
    const { token } = await (await req('/v1/page-sessions/exchange', json({ code }, { origin: ORIGIN, ...SIGNER }))).json() as { token: string };
    const headers = { origin: ORIGIN, authorization: `Bearer ${token}`, ...SIGNER };
    const { messageId } = await (await req('/v1/signing/otp', json({}, headers))).json() as { messageId: string };
    const { otp } = await (await req(`/v1/test-mail/${messageId}`, { headers: auth })).json() as { otp: string };
    assert.equal((await req('/v1/signing/otp/verify', json({ otp }, headers))).status, 204);
    const current = await (await req('/v1/signing/current', { headers })).json() as { id: string; sha256: string; disclosure: { version: string; text: string } };
    const disclosure = await consentDisclosure();
    assert.deepEqual(current.disclosure, { version: disclosure.version, text: disclosure.text }, 'the page shows the server\'s consent text');
    assert.equal((await req('/v1/signing/pdf', { headers })).status, 200);
    const stale = await req('/v1/signing/sign', json({ artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: '1999-01-01' }, headers));
    assert.equal(stale.status, 409, 'consent to an older disclosure is refused');
    assert.deepEqual(await stale.json(), { error: 'disclosure_changed' });
    const signed = await req('/v1/signing/sign', json({ artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: disclosure.version }, headers));
    assert.equal(signed.status, 202);
    const { id: signatureId } = await signed.json() as { id: string };
    assert.equal((await req('/v1/signing/sign', json({ artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: disclosure.version }, headers))).status, 202, 'a replay');

    const trail = await auditTrail(db, id);
    assert.deepEqual(trail.map(e => e.type), [AUDIT.viewIssued, AUDIT.sessionOpened, AUDIT.otpSent, AUDIT.otpVerified, AUDIT.documentViewed, AUDIT.signed], 'one event per step; the replay adds none');
    assert.ok(trail.every(e => e.taskId === task.id));
    for (const e of trail.slice(1)) assert.deepEqual([e.ip, e.userAgent], ['203.0.113.9', 'Mozilla/5.0 (Synthetic signer)'], e.type);
    assert.deepEqual(trail.find(e => e.type === AUDIT.otpSent)?.detail, { to: 'ana@partner.test', delivery: 'test-mailbox', messageId });
    assert.deepEqual(trail.find(e => e.type === AUDIT.signed)?.detail, { signatureId, artifactId: current.id, artifactSha256: current.sha256, consentDisclosureVersion: disclosure.version, consentDisclosureSha256: disclosure.sha256 });
  } finally { await mf.dispose(); }
});
