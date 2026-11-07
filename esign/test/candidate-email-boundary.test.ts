import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { issueRecipientCode, exchangeRecipientCode, authorizeRecipientSession } from '../src/page-authorization.ts';

test('candidate cannot send email or accept OTP with even a valid local persisted recipient session', async () => {
  const built = await build({ entryPoints: ['src/candidate-worker.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  const email = { send_email: [{ name: 'SEND_EMAIL', allowed_sender_addresses: ['sign@example.com'], allowed_destination_addresses: ['ana@example.com'] }] };
  const mf = new Miniflare({ workers: [
    { name: 'caller', modules: true, script: 'export default {fetch(req,env){const h=new Headers(req.headers);h.set("origin",h.get("x-test-origin"));h.delete("x-test-origin");return (h.get("x-test-entry")==="public"?env.PUBLIC:env.MANAGEMENT).fetch(new Request(req,{headers:h}))}}', serviceBindings: { PUBLIC: 'candidate', MANAGEMENT: { name: 'candidate', entrypoint: 'PrivateManagement' } } },
    { name: 'candidate', modules: true, compatibilityDate: '2026-01-01', script: built.outputFiles[0].text, d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'], email, bindings: { OTP_EMAIL_ENABLED: 'true', OTP_EMAIL_FROM: 'sign@example.com', OTP_PEPPER: 'synthetic-secret-not-a-production-key', LOCAL_TEST_MODE: 'true', LOCAL_TEST_OTP_KEY: 'synthetic-local-key-not-for-production' } },
    { name: 'binding-probe', modules: true, compatibilityDate: '2026-01-01', script: 'export default {fetch(req,env){return new Response(typeof env.SEND_EMAIL?.send)}}', email }
  ] });
  try {
    const probe = await mf.getWorker('binding-probe');
    assert.equal(await (await probe.fetch('https://local.test/')).text(), 'function');
    const db = await mf.getD1Database('DB', 'candidate'), bucket = await mf.getR2Bucket('ARTIFACTS', 'candidate');
    await bucket.put('synthetic/sentinel', 'unchanged');
    for (const name of ['0001_tenants.sql', '0002_templates.sql', '0003_envelopes.sql', '0006_page_authorization.sql', '0009_otp_lifecycle.sql', '0029_recipient_session_revocations.sql', '0030_recipient_code_revocations.sql', '0050_task_expiry.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    await db.exec(`INSERT INTO tenants VALUES ('tenant');
INSERT INTO templates VALUES ('template','tenant','source','["ana"]',1);
INSERT INTO envelopes VALUES ('envelope','tenant','template','IN_PROGRESS',1);
INSERT INTO tasks VALUES ('task','envelope','ana','Ana','ana@example.com',1,'ACTIVE');
INSERT INTO tenant_page_origins VALUES ('tenant','https://host.example.com');`);
    const now = Date.now(), origin = 'https://host.example.com';
    const code = await issueRecipientCode(db, { tenantId: 'tenant', envelopeId: 'envelope', taskId: 'task', origin, now });
    const token = await exchangeRecipientCode(db, code, origin, now + 1);
    assert.equal(await authorizeRecipientSession(db, token, origin, now + 2), 'task');
    const headers = { authorization: `Bearer ${token}`, 'x-test-origin': origin, 'content-type': 'application/json' };
    for (const path of ['/v1/signing/otp', '/v1/signing/otp/verify', '/v1/page-sessions/exchange', '/v1/signing/sign', '/v1/envelopes/envelope/process', '/v1/envelopes/envelope/finalize']) {
      for (const label of ['public', 'private']) {
        const response = await mf.dispatchFetch(`https://local.test${path}`, { method: 'POST', headers: { ...headers, 'x-test-entry': label }, body: '{}' });
        assert.equal(response.status, 404, `${label} ${path}`); assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.text();
        for (const secret of [token, code, 'ana@example.com', 'testOtp', 'synthetic-secret-not-a-production-key']) assert.equal(body.includes(secret), false);
      }
    }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_otp_challenges').first())?.n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_otp_verifications').first())?.n, 0);
    assert.deepEqual((await bucket.list()).objects.map(o => o.key), ['synthetic/sentinel']);assert.equal(await (await bucket.get('synthetic/sentinel'))!.text(), 'unchanged');
    assert.equal(await authorizeRecipientSession(db, token, origin, now + 3), 'task');
  } finally { await mf.dispose(); }
});
