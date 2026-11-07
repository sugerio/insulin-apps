import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import app from '../src/worker.ts';

test('envelope creation is tenant-isolated, role-bound, and idempotent', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql', '0002_templates.sql', '0003_envelopes.sql', '0004_artifacts.sql', '0005_preparation_assertions.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8').catch(() => '');
      assert.ok(sql, `missing migration ${name}`);
      await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    }
    const secret = 'test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), (n) => n.toString(16).padStart(2, '0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('tenant-a'),('tenant-b')").run();
    await db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 'tenant-a')").bind(hash).run();
    await db.prepare("INSERT INTO templates VALUES ('template-a', 'tenant-a', 'object-a', '[\"ana\",\"marcus\"]', 1), ('template-b', 'tenant-b', 'object-b', '[\"ana\"]', 1)").run();
    const env = { DB: db, ARTIFACTS: await mf.getR2Bucket('ARTIFACTS') };
    const body = { templateId: 'template-a', recipients: [{ role: 'ana', name: 'Ana', email: 'ana@example.com' }, { role: 'marcus', name: 'Marcus', email: 'marcus@example.com' }] };
    const create = (data: unknown, key = 'request-1') => app.fetch(new Request('http://localhost/v1/envelopes', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(data) }), env);
    assert.equal((await create({ ...body, templateId: 'template-b' }, 'other')).status, 404);
    assert.equal((await create({ ...body, recipients: body.recipients.slice(0, 1) }, 'bad')).status, 422);
    const unsupported = await create({ ...body, recipients: [body.recipients[0], {...body.recipients[1], name: '李雷'}] }, 'unicode');
    assert.equal(unsupported.status, 422);
    assert.deepEqual(await unsupported.json(), { error: 'unsupported_recipient_name' });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM idempotency_keys').first())!.n, 0);
    const tooWide = await create({ ...body, recipients: [body.recipients[0], {...body.recipients[1], name: 'W'.repeat(200)}] }, 'too-wide');
    assert.equal(tooWide.status, 422);
    assert.deepEqual(await tooWide.json(), { error: 'unsupported_recipient_name' });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM idempotency_keys').first())!.n, 0);
    const kernedOverflow = await create({ ...body, recipients: [body.recipients[0], {...body.recipients[1], name: 'AV'.repeat(29)}] }, 'kerning');
    assert.equal(kernedOverflow.status, 422);
    assert.deepEqual(await kernedOverflow.json(), { error: 'unsupported_recipient_name' });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 0);
    const first = await create(body); assert.equal(first.status, 201, await first.clone().text());
    const result = await first.json(); assert.ok(result.id);
    const second = await create(body); assert.equal(second.status, 201); assert.deepEqual(await second.json(), result);
    assert.equal((await create({ ...body, recipients: [...body.recipients].reverse() })).status, 409);
    const fetched = await app.fetch(new Request(`http://localhost/v1/envelopes/${result.id}`, { headers: { authorization: `Bearer ${secret}` } }), env);
    assert.equal(fetched.status, 200);
    const details = await fetched.json();
    assert.equal(details.id, result.id);
    assert.equal(details.status, 'PROCESSING');
    assert.deepEqual(details.tasks.map((task: { role: string }) => task.role), ['ana', 'marcus']);
    assert.equal((await app.fetch(new Request('http://localhost/v1/envelopes/missing', { headers: { authorization: `Bearer ${secret}` } }), env)).status, 404);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM tasks WHERE envelope_id = ?').bind(result.id).first())!.n, 2);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM tasks WHERE envelope_id = ? AND status = ?').bind(result.id, 'PENDING').first())!.n, 2);
    await env.ARTIFACTS.put('object-a', 'document');
    const prepare = () => app.fetch(new Request(`http://localhost/v1/envelopes/${result.id}/prepare`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } }), env);
    assert.equal((await prepare()).status, 204);
    assert.equal((await prepare()).status, 204);
    assert.equal((await db.prepare('SELECT status FROM envelopes WHERE id = ?').bind(result.id).first())!.status, 'IN_PROGRESS');
  } finally { await mf.dispose(); }
});
