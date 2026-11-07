import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import app from '../src/worker.ts';

test('management key resolves its tenant and revoked or invalid keys are rejected', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    const sql = await readFile(new URL('../migrations/0001_tenants.sql', import.meta.url), 'utf8');
    await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    const secret = 'test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), (n) => n.toString(16).padStart(2, '0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('tenant-a')").run();
    await db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 'tenant-a')").bind(hash).run();
    const call = (authorization?: string) => app.fetch(new Request('http://localhost/v1/me', { headers: authorization ? { authorization } : {} }), { DB: db });
    assert.equal((await call()).status, 401);
    assert.equal((await call('Bearer wrong')).status, 401);
    const good = await call(`Bearer ${secret}`);
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { tenantId: 'tenant-a' });
    await db.prepare('UPDATE api_keys SET revoked_at = 1 WHERE key_hash = ?').bind(hash).run();
    assert.equal((await call(`Bearer ${secret}`)).status, 401);
  } finally { await mf.dispose(); }
});
