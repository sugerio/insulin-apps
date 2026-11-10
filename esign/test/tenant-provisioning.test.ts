// Tenant provisioning (src/tenant-provisioning.ts), in-process with synthetic data: the host's
// provisioning key creates a tenant and returns its key once; a tenant with no data may be asked
// for again (earlier keys revoked); a tenant in use is never handed a new key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { unstable_splitSqlQuery } from 'wrangler';
import app from '../src/worker.ts';

const ORIGIN = 'https://esign.example.test';
const PROVISIONING_KEY = 'p'.repeat(48);

async function harness(env: Record<string, string> = { PROVISIONING_KEY, SIGNING_PAGE_FRAME_ANCESTORS: 'https://console.example.test http://localhost:3000 not-an-origin' }) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`, 'utf8')).map(s => db.prepare(s)));
  const bindings = { DB: db, ARTIFACTS: await mf.getR2Bucket('ARTIFACTS'), ...env };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), bindings);
  const provision = (tenantId: unknown, key = PROVISIONING_KEY) =>
    req('/v1/tenants', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ tenantId }) });
  const me = async (apiKey: string) => { const r = await req('/v1/me', { headers: { authorization: `Bearer ${apiKey}` } }); return r.status === 200 ? (await r.json() as { tenantId: string }).tenantId : r.status; };
  return { mf, db, req, provision, me };
}

test('the provisioning key creates a tenant named by the host and returns its key once', async () => {
  const h = await harness();
  try {
    const res = await h.provision('csprm041A');
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json() as { tenantId: string; apiKey: string };
    assert.equal(body.tenantId, 'csprm041A');
    assert.match(body.apiKey, /^[0-9a-f]{64}$/);
    assert.equal(await h.me(body.apiKey), 'csprm041A', 'the key is that tenant\'s management key');
    // Only its SHA-256 is kept.
    const stored = await h.db.prepare('SELECT key_hash FROM api_keys WHERE tenant_id=?').bind('csprm041A').all<{ key_hash: string }>();
    assert.equal(stored.results.length, 1);
    assert.notEqual(stored.results[0].key_hash, body.apiKey);
    // The editor may be embedded by the consoles that may embed the signing page.
    const tenant = await h.db.prepare('SELECT editor_origins_json FROM tenants WHERE id=?').bind('csprm041A').first<{ editor_origins_json: string }>();
    assert.deepEqual(JSON.parse(tenant!.editor_origins_json), ['https://console.example.test', 'http://localhost:3000']);
  } finally { await h.mf.dispose(); }
});

test('a tenant with no data may be asked for again: the earlier key stops working', async () => {
  const h = await harness();
  try {
    const first = (await (await h.provision('org-1')).json() as { apiKey: string }).apiKey;
    const again = await h.provision('org-1');
    assert.equal(again.status, 201);
    const second = (await again.json() as { apiKey: string }).apiKey;
    assert.notEqual(second, first);
    assert.equal(await h.me(first), 401, 'the lost key is revoked');
    assert.equal(await h.me(second), 'org-1');
  } finally { await h.mf.dispose(); }
});

test('a tenant in use is never handed a new key, and its key keeps working', async () => {
  const h = await harness();
  try {
    const key = (await (await h.provision('org-2')).json() as { apiKey: string }).apiKey;
    const pdf = await PDFDocument.create(); pdf.addPage();
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
    assert.equal((await h.req('/v1/templates', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form })).status, 201);
    const refused = await h.provision('org-2');
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'tenant_in_use' });
    assert.equal(await h.me(key), 'org-2');
  } finally { await h.mf.dispose(); }
});

test('a tenant provisioned by hand that is in use keeps its editor origins', async () => {
  const h = await harness();
  try {
    await h.db.prepare("INSERT INTO tenants (id, editor_origins_json) VALUES ('manual', '[\"https://other.example.test\"]')").run();
    await h.db.prepare("INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) VALUES ('t1', 'manual', 'templates/t1.pdf', '[\"partner\"]', 1)").run();
    assert.equal((await h.provision('manual')).status, 409);
    const tenant = await h.db.prepare("SELECT editor_origins_json FROM tenants WHERE id='manual'").first<{ editor_origins_json: string }>();
    assert.deepEqual(JSON.parse(tenant!.editor_origins_json), ['https://other.example.test']);
  } finally { await h.mf.dispose(); }
});

test('only the provisioning key provisions, only valid tenant ids, and nothing without the secret', async () => {
  const h = await harness();
  try {
    assert.equal((await h.provision('org-3', 'x'.repeat(48))).status, 401);
    assert.equal((await h.req('/v1/tenants', { method: 'POST', body: '{"tenantId":"org-3"}' })).status, 401);
    // A tenant's own management key is not the provisioning key.
    const key = (await (await h.provision('org-4')).json() as { apiKey: string }).apiKey;
    assert.equal((await h.provision('org-5', key)).status, 401);
    for (const bad of ['', 'a'.repeat(65), 'org 1', "o'rg", 7, null]) assert.equal((await h.provision(bad)).status, 400, String(bad));
    assert.equal((await h.req('/v1/tenants', { method: 'POST', headers: { authorization: `Bearer ${PROVISIONING_KEY}` }, body: 'not json' })).status, 400);
  } finally { await h.mf.dispose(); }
  for (const env of [{}, { PROVISIONING_KEY: 'short' }]) {
    const off = await harness(env);
    try { assert.equal((await off.provision('org-6', env.PROVISIONING_KEY ?? PROVISIONING_KEY)).status, 404, JSON.stringify(env)); }
    finally { await off.mf.dispose(); }
  }
});
