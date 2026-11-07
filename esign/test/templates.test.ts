import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import app from '../src/worker.ts';

test('template upload stores an immutable PDF and isolates tenants', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'] });
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('ARTIFACTS');
    for (const name of ['0001_tenants.sql', '0002_templates.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8').catch(() => '');
      assert.ok(sql, `missing migration ${name}`);
      await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    }
    const keys = ['test-key-0123456789-abcdefghijklmnopqrstuvwxyz', 'test-key-1234567890-abcdefghijklmnopqrstuvwxyz'];
    for (const [i, key] of keys.entries()) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), (n) => n.toString(16).padStart(2, '0')).join('');
      await db.prepare('INSERT INTO tenants(id) VALUES (?)').bind(`tenant-${i}`).run();
      await db.prepare('INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, ?)').bind(hash, `tenant-${i}`).run();
    }
    const pdf = await PDFDocument.create(); pdf.addPage();
    const form = new FormData();
    form.set('file', new File([await pdf.save()], 'contract.pdf', { type: 'application/pdf' }));
    form.set('roles', JSON.stringify(['signer']));
    const env = { DB: db, ARTIFACTS: bucket };
    const response = await app.fetch(new Request('http://localhost/v1/templates', { method: 'POST', headers: { authorization: `Bearer ${keys[0]}` }, body: form }), env);
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json();
    assert.ok(result.id);
    const get = (key: string) => app.fetch(new Request(`http://localhost/v1/templates/${result.id}`, { headers: { authorization: `Bearer ${key}` } }), env);
    assert.equal((await get(keys[0])).status, 200);
    assert.equal((await get(keys[1])).status, 404);
    assert.equal((await app.fetch(new Request(`http://localhost/v1/templates/${result.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${keys[0]}` } }), env)).status, 404);
    const row = await db.prepare('SELECT object_key FROM templates WHERE id = ?').bind(result.id).first();
    assert.ok(await bucket.get(row!.object_key as string));
    const invalid = new FormData(); invalid.set('file', new File(['bad'], 'bad.pdf', { type: 'application/pdf' })); invalid.set('roles', '["signer"]');
    assert.equal((await app.fetch(new Request('http://localhost/v1/templates', { method: 'POST', headers: { authorization: `Bearer ${keys[0]}` }, body: invalid }), env)).status, 422);
  } finally { await mf.dispose(); }
});
