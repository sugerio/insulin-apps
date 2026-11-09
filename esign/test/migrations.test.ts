import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

test('migration persists scoped tenant credentials with globally unique hashes', async () => {
  const sql = await readFile(new URL('../migrations/0001_tenants.sql', import.meta.url), 'utf8').catch(() => '');
  assert.ok(sql, 'tenant migration is not implemented');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    await db.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
    await db.prepare("INSERT INTO tenants (id) VALUES ('tenant-a'), ('tenant-b')").run();
    await db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES ('hash-a', 'tenant-a')").run();
    await assert.rejects(() => db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES ('hash-a', 'tenant-b')").run());
    await assert.rejects(() => db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES ('hash-b', 'missing')").run());
    const key = await db.prepare("SELECT tenant_id, revoked_at FROM api_keys WHERE key_hash = ?").bind('hash-a').first();
    assert.equal(key!.tenant_id, 'tenant-a');
    assert.equal(key!.revoked_at, null);
    // Each tenant's editor origin list starts empty and must stay a JSON array.
    assert.equal((await db.prepare("SELECT editor_origins_json FROM tenants WHERE id = 'tenant-a'").first())!.editor_origins_json, '[]');
    await assert.rejects(() => db.prepare("UPDATE tenants SET editor_origins_json = 'not json' WHERE id = 'tenant-a'").run(), /CHECK/);
    await assert.rejects(() => db.prepare(`UPDATE tenants SET editor_origins_json = '{"origin":"https://a.example.test"}' WHERE id = 'tenant-a'`).run(), /CHECK/);
    await assert.rejects(() => db.prepare("UPDATE tenants SET editor_origins_json = NULL WHERE id = 'tenant-a'").run(), /NOT NULL/);
  } finally { await mf.dispose(); }
});
