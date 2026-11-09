import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import app from '../src/worker.ts';
import { unstable_splitSqlQuery } from 'wrangler';
import { envelopeIdFor } from '../src/prepare.ts';

test('envelope creation is tenant-isolated, role-bound, idempotent and prepares the envelope', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql', '0002_templates.sql', '0003_envelopes.sql', '0004_artifacts.sql', '0007_signatures.sql', '0049_audit_trail.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8').catch(() => '');
      assert.ok(sql, `missing migration ${name}`);
      await db.batch(unstable_splitSqlQuery(sql).map((s) => db.prepare(s)));
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
    // Preparation is part of creation: without the template's source nothing is created.
    const unprepared = await create(body);
    assert.equal(unprepared.status, 503);
    assert.deepEqual(await unprepared.json(), { error: 'preparation_failed' });
    for (const table of ['envelopes', 'tasks', 'artifacts', 'idempotency_keys']) assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first())!.n, 0, table);
    await env.ARTIFACTS.put('object-a', 'document');
    const first = await create(body); assert.equal(first.status, 201, await first.clone().text());
    const result = await first.json();
    assert.deepEqual(result, { id: await envelopeIdFor('tenant-a', 'request-1'), status: 'IN_PROGRESS' });
    assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const second = await create(body); assert.equal(second.status, 201); assert.deepEqual(await second.json(), result);
    assert.equal((await create({ ...body, recipients: [...body.recipients].reverse() })).status, 409);
    const fetched = await app.fetch(new Request(`http://localhost/v1/envelopes/${result.id}`, { headers: { authorization: `Bearer ${secret}` } }), env);
    assert.equal(fetched.status, 200);
    const details = await fetched.json();
    assert.equal(details.id, result.id);
    assert.equal(details.status, 'IN_PROGRESS');
    assert.deepEqual(details.tasks.map((task: { role: string }) => task.role), ['ana', 'marcus']);
    assert.equal((await app.fetch(new Request('http://localhost/v1/envelopes/missing', { headers: { authorization: `Bearer ${secret}` } }), env)).status, 404);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM tasks WHERE envelope_id = ?').bind(result.id).first())!.n, 2);
    // The first signer's task is active, the others wait; the initial document is the template's source.
    assert.deepEqual(details.tasks.map((task: { status: string }) => task.status), ['ACTIVE', 'PENDING']);
    const d0 = await db.prepare('SELECT id, object_key, sha256 FROM artifacts WHERE envelope_id = ?').bind(result.id).first();
    assert.deepEqual(d0, { id: `d0:${result.id}`, object_key: `envelopes/${result.id}/d0.pdf`, sha256: '43cc23fa52b87b4cc1d02b5b114154151d6adddb17c9fddc06b027fa99e24008' });
    assert.equal(await (await env.ARTIFACTS.get(d0!.object_key as string))!.text(), 'document');
    // Deprecated preparation is a no-op for this tenant's envelopes, and not found otherwise.
    const prepare = (id: string) => app.fetch(new Request(`http://localhost/v1/envelopes/${id}/prepare`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } }), env);
    assert.equal((await prepare(result.id)).status, 204);
    assert.equal((await prepare(result.id)).status, 204);
    assert.equal((await prepare('missing')).status, 404);
    await db.prepare("INSERT INTO envelopes (id, tenant_id, template_id, status, created_at) VALUES ('other-envelope', 'tenant-b', 'template-b', 'IN_PROGRESS', 1)").run();
    await db.prepare("INSERT INTO artifacts VALUES ('d0:other-envelope', 'other-envelope', 'envelopes/other-envelope/d0.pdf', 'hash')").run();
    assert.equal((await prepare('other-envelope')).status, 404);
    assert.equal((await db.prepare('SELECT status FROM envelopes WHERE id = ?').bind(result.id).first())!.status, 'IN_PROGRESS');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?').bind(result.id).first())!.n, 1);

    // A creation whose database write fails leaves nothing behind but its D0 object, which the retry reuses.
    const failingDb = new Proxy(db, { get(target, prop) { if (prop === 'batch') return async () => { throw new Error('simulated D1 outage'); }; const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v; } });
    const failed = await app.fetch(new Request('http://localhost/v1/envelopes', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': 'request-2' }, body: JSON.stringify(body) }), { ...env, DB: failingDb });
    assert.equal(failed.status, 500);
    const retriedId = await envelopeIdFor('tenant-a', 'request-2');
    assert.equal(await db.prepare('SELECT 1 FROM envelopes WHERE id = ?').bind(retriedId).first(), null);
    assert.equal((await env.ARTIFACTS.list({ prefix: `envelopes/${retriedId}/` })).objects.length, 1);
    const retried = await create(body, 'request-2');
    assert.equal(retried.status, 201);
    assert.deepEqual(await retried.json(), { id: retriedId, status: 'IN_PROGRESS' });
    assert.equal((await env.ARTIFACTS.list({ prefix: `envelopes/${retriedId}/` })).objects.length, 1, 'no second D0 object');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?').bind(retriedId).first())!.n, 1);
    // The same key in another tenant names another envelope.
    assert.notEqual(await envelopeIdFor('tenant-b', 'request-1'), result.id);
  } finally { await mf.dispose(); }
});
