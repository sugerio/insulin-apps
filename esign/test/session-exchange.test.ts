import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
const exchange = await import('../src/session-exchange.ts').catch(() => ({ exchangeCode: undefined }));

test('code consumption and session creation are atomic', async () => {
  assert.equal(typeof exchange.exchangeCode, 'function', 'session exchange is not implemented');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE page_codes (code_hash TEXT PRIMARY KEY, origin TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, tenant_id TEXT NOT NULL, resource_id TEXT NOT NULL, purpose TEXT NOT NULL);
CREATE TABLE page_sessions (token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_id TEXT NOT NULL, purpose TEXT NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE assertions (ok INTEGER NOT NULL CHECK (ok = 1));`);
    await db.prepare("INSERT INTO page_codes VALUES ('code-hash', 'https://host.example.com', 200, NULL, 'tenant', 'resource', 'sign')").run();
    const cmd = { codeHash: 'code-hash', tokenHash: 'token-hash', origin: 'https://host.example.com', now: 100, sessionExpiresAt: 150 };
    await assert.rejects(() => exchange.exchangeCode!(db, { ...cmd, origin: 'https://wrong.example.com' }));
    await db.prepare("INSERT INTO page_sessions VALUES ('token-hash','other','other','sign','https://host.example.com',150)").run();
    await assert.rejects(() => exchange.exchangeCode!(db, cmd));
    assert.equal((await db.prepare('SELECT used_at FROM page_codes').first())!.used_at, null);
    await db.prepare('DELETE FROM page_sessions').run();
    const race = await Promise.allSettled([exchange.exchangeCode!(db, cmd), exchange.exchangeCode!(db, { ...cmd, tokenHash: 'token-2' })]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM page_sessions').first())!.n, 1);
    assert.equal((await db.prepare('SELECT used_at FROM page_codes').first())!.used_at, 100);
  } finally { await mf.dispose(); }
});
