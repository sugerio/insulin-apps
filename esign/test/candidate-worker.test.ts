import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import localWorker from '../src/worker.ts';

const secret = 'synthetic-management-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const headers = { authorization: `Bearer ${secret}` };

test('checked-in candidate configuration contains no public route, assets, secrets or resource bindings', async () => {
  const config=JSON.parse(await readFile(new URL('../wrangler.candidate.jsonc',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(config).sort(),['$schema','compatibility_date','compatibility_flags','main','name','preview_urls','workers_dev'].sort());
  assert.deepEqual(config.compatibility_flags,['formdata_parser_supports_files']);
  assert.equal(config.main,'src/candidate-worker.ts');assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
});

test('local worker keeps its existing health and test route gate', async () => {
  const health = await localWorker.fetch(new Request('https://local.test/health'));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, 'experimental');
  const disabled = await localWorker.fetch(new Request('https://local.test/v1/signing/otp', { method: 'POST' }), { LOCAL_TEST_MODE: 'false' } as never);
  assert.equal(disabled.status, 404);
  assert.equal((await disabled.json()).error, 'local_test_disabled');
});

test('candidate isolates public and authenticated service-binding entrypoints even with local-test bindings', async () => {
  const built = await build({ entryPoints: ['src/candidate-worker.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  const mf = new Miniflare({ workers: [
    { name: 'caller', modules: true, script: 'export default { fetch(request, env) { return (request.headers.has("x-test-no-db") ? env.NO_DB : env.MANAGEMENT).fetch(request) } }', serviceBindings: { MANAGEMENT: { name: 'candidate', entrypoint: 'PrivateManagement' }, NO_DB: { name: 'candidate-no-db', entrypoint: 'PrivateManagement' } } },
    { name: 'candidate', modules: true, script: built.outputFiles[0].text, d1Databases: ['DB'], r2Buckets: ['TEST_MAIL'], bindings: { LOCAL_TEST_MODE: 'true', LOCAL_TEST_OTP_KEY: 'synthetic-otp-key-at-least-32-bytes', LOCAL_TEST_SEAL_KEY: 'synthetic-seal-key-at-least-32-bytes' }, serviceBindings: { ASSETS: 'trap' } },
    { name: 'candidate-no-db', modules: true, script: built.outputFiles[0].text },
    { name: 'trap', modules: true, script: 'export default {fetch(){return new Response("SENSITIVE-ASSET-LEAK")}}' }
  ] });
  try {
    const db = await mf.getD1Database('DB', 'candidate');
    await db.exec('CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, revoked_at INTEGER); CREATE TABLE recipient_page_sessions (token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at INTEGER NOT NULL); CREATE TABLE editor_sessions (token_hash TEXT PRIMARY KEY); CREATE TABLE editor_page_tokens (token_hash TEXT PRIMARY KEY); CREATE TABLE recipient_page_codes (code_hash TEXT PRIMARY KEY); CREATE TABLE editor_codes (code_hash TEXT PRIMARY KEY); CREATE TABLE editor_page_entries (code_hash TEXT PRIMARY KEY)');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), n => n.toString(16).padStart(2, '0')).join('');
    await db.prepare('INSERT INTO api_keys VALUES (?, ?, NULL)').bind(hash, 'synthetic-tenant').run();
    const publicWorker = await mf.getWorker('candidate');
    const publicRequest = (path: string, method = 'GET') => publicWorker.fetch(`https://candidate.test${path}`, { method, headers });
    const privateRequest = (path: string, method = 'GET', auth = true) => mf.dispatchFetch(`https://private.test${path}`, { method, headers: auth ? headers : {} });
    const health = await publicRequest('/health');
    assert.equal(health.status, 200); assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { status: 'ok', service: 'esign', mode: 'candidate' });
    const blocked: [string, string][] = [
      ['/v1/me', 'GET'], ['/v1/templates', 'GET'], ['/v1/templates', 'POST'], ['/v1/envelopes', 'POST'], ['/v1/envelopes/e/prepare', 'POST'],
      ['/v1/envelopes/e/tasks/t/recipient-view', 'POST'], ['/v1/page-sessions/exchange', 'POST'], ['/v1/signing/otp', 'POST'], ['/v1/signing/otp/verify', 'POST'], ['/v1/signing/sign', 'POST'],
      ['/v1/envelopes/e/process', 'POST'], ['/v1/envelopes/e/finalize', 'POST'], ['/v1/envelopes/e/certificate', 'GET'], ['/v1/envelopes/e/delivery-pdf', 'GET'],
      ['/assets/sample.js', 'GET'], ['/host.html', 'GET'], ['/editor-host.html', 'GET'], ['/v1/editor/exchange', 'POST']
    ];
    for (const [path, method] of blocked) {
      const response = await publicRequest(path, method);
      assert.equal(response.status, 404, `${method} ${path}`);
      const body = await response.text();
      assert.ok(!body.includes('synthetic-tenant') && !body.includes('SENSITIVE-ASSET-LEAK') && !body.includes('testOtp') && !body.includes(secret) && !body.includes('synthetic-otp-key') && !body.includes('synthetic-seal-key'));
      if (!(path === '/v1/templates' && method === 'POST') && path !== '/v1/me' && path !== '/v1/envelopes' && path !== '/v1/envelopes/e/prepare' && !path.endsWith('/recipient-view')) assert.equal((await privateRequest(path, method)).status, 404, `private ${method} ${path}`);
    }
    assert.equal((await privateRequest('/v1/templates','POST')).status,503); // Missing candidate storage and policy fail closed.
    assert.equal((await publicRequest('/health', 'POST')).status, 404);
    const spoofed = await publicWorker.fetch('https://candidate.test/v1/me', { headers: { ...headers, 'cf-worker': 'trusted.example.com', 'x-service-binding': 'PrivateManagement' } });
    assert.equal(spoofed.status, 404);
    assert.equal((await privateRequest('/v1/me', 'GET', false)).status, 401);
    const noDb = await mf.dispatchFetch('https://private.test/v1/me', { headers: { ...headers, 'x-test-no-db': '1' } });
    assert.equal(noDb.status, 503); assert.ok(!(await noDb.text()).includes(secret));
    const me = await privateRequest('/v1/me');
    assert.equal(me.status, 200); assert.equal(me.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await me.json(), { tenantId: 'synthetic-tenant' });
    await db.prepare('INSERT INTO recipient_page_sessions VALUES (?, ?, ?)').bind(hash, 'other-synthetic-tenant', 0).run();
    const collision = await privateRequest('/v1/me');assert.equal(collision.status,401,'even an expired session in another tenant must not be a management credential');assert.ok(!(await collision.text()).includes(secret));
    await db.prepare('DELETE FROM recipient_page_sessions WHERE token_hash=?').bind(hash).run();assert.equal((await privateRequest('/v1/me')).status,200);
    for(const [table,column] of [['editor_sessions','token_hash'],['editor_page_tokens','token_hash'],['recipient_page_codes','code_hash'],['editor_codes','code_hash'],['editor_page_entries','code_hash']] as const){
      await db.prepare(`INSERT INTO ${table} VALUES (?)`).bind(hash).run();assert.equal((await privateRequest('/v1/me')).status,401,`${table} credentials must not be management keys`);await db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).bind(hash).run();
    }
    assert.equal((await privateRequest('/v1/me')).status,200);
    for(const [table,column] of [['editor_sessions','token_hash'],['editor_page_tokens','token_hash'],['recipient_page_codes','code_hash'],['editor_codes','code_hash'],['editor_page_entries','code_hash']] as const){
      await db.exec(`DROP TABLE ${table}`);assert.equal((await privateRequest('/v1/me')).status,503,`missing ${table} must fail closed`);await db.exec(`CREATE TABLE ${table} (${column} TEXT PRIMARY KEY)`);
    }
    await db.exec('DROP TABLE recipient_page_sessions');const missingSessions=await privateRequest('/v1/me');assert.equal(missingSessions.status,503,'missing credential separation table must fail closed');
    await db.exec('CREATE TABLE recipient_page_sessions (token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(hash).run();
    assert.equal((await privateRequest('/v1/me')).status, 401);
    await db.exec('DROP TABLE api_keys');
    const failed = await privateRequest('/v1/me'); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes(secret));
    const mail = await mf.getR2Bucket('TEST_MAIL', 'candidate'); assert.equal((await mail.list()).objects.length, 0);
  } finally { await mf.dispose(); }
});
