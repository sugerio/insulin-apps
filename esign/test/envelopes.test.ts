import {applyMigrations} from './helpers/platform.ts';
import {blobStore} from './helpers/platform.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import app from './helpers/gateway.ts';
import { MIGRATIONS_DIR, splitSql as unstable_splitSqlQuery } from './helpers/platform.ts';
import { envelopeIdFor } from '../src/app/server/esign/prepare.ts';

test('envelope creation is tenant-isolated, role-bound, idempotent and prepares the envelope', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    const secret = 'test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), (n) => n.toString(16).padStart(2, '0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('tenant-a'),('tenant-b')").run();
    await db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 'tenant-a')").bind(hash).run();
    await db.prepare("INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at,owner_user_id) VALUES ('template-a', 'tenant-a', 'object-a', '[\"ana\",\"marcus\"]', 1, 'service-account-tenant-a'), ('template-b', 'tenant-b', 'object-b', '[\"ana\"]', 1, 'service-account-tenant-b')").run();
    const env = { DB: db, ARTIFACTS: await blobStore(mf,'artifacts') };
    const body = { templateId: 'template-a', recipients: [{ role: 'ana', name: 'Ana', email: 'ana@example.com' }, { role: 'marcus', name: 'Marcus', email: 'marcus@example.com' }] };
    const create = (data: unknown, key = 'request-1') => app.fetch(new Request('http://localhost/api/envelopes', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(data) }), env);
    assert.equal((await create({ ...body, templateId: 'template-b' }, 'other')).status, 404);
    assert.equal((await create({ ...body, recipients: body.recipients.slice(0, 1) }, 'bad')).status, 422);
    const unsupported = await create({ ...body, recipients: [body.recipients[0], {...body.recipients[1], name: '李雷'}] }, 'unicode');
    assert.equal(unsupported.status, 422);
    assert.deepEqual(await unsupported.json(), { error: 'unsupported_recipient_name' });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 0);
    const tooWide = await create({ ...body, recipients: [body.recipients[0], {...body.recipients[1], name: 'W'.repeat(200)}] }, 'too-wide');
    assert.equal(tooWide.status, 422);
    assert.deepEqual(await tooWide.json(), { error: 'unsupported_recipient_name' });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 0);
    const kernedOverflow = await create({ ...body, recipients: [body.recipients[0], {...body.recipients[1], name: 'AV'.repeat(29)}] }, 'kerning');
    assert.equal(kernedOverflow.status, 422);
    assert.deepEqual(await kernedOverflow.json(), { error: 'unsupported_recipient_name' });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 0);
    // Preparation is part of creation: without the template's source nothing is created.
    const unprepared = await create(body);
    assert.equal(unprepared.status, 503);
    assert.deepEqual(await unprepared.json(), { error: 'preparation_failed' });
    for (const table of ['envelopes', 'tasks', 'artifacts']) assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first())!.n, 0, table);
    await env.ARTIFACTS.put('object-a', 'document');
    const first = await create(body); assert.equal(first.status, 201, await first.clone().text());
    const result = await first.json();
    assert.deepEqual(result, { id: await envelopeIdFor('tenant-a', 'request-1'), status: 'IN_PROGRESS' });
    assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const second = await create(body); assert.equal(second.status, 201); assert.deepEqual(await second.json(), result);
    // The envelope keeps the hash of the request that created it: there is no separate idempotency record.
    const requestSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)))), (n) => n.toString(16).padStart(2, '0')).join('');
    assert.equal((await db.prepare('SELECT request_sha256 FROM envelopes WHERE id = ?').bind(result.id).first())!.request_sha256, requestSha256);
    const conflict = await create({ ...body, recipients: [...body.recipients].reverse() });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
    // A retry gets what the first creation returned, whatever the envelope's status is now.
    await db.prepare("UPDATE envelopes SET status = 'VOIDED' WHERE id = ?").bind(result.id).run();
    const afterVoid = await create(body); assert.equal(afterVoid.status, 201); assert.deepEqual(await afterVoid.json(), result);
    await db.prepare("UPDATE envelopes SET status = 'IN_PROGRESS' WHERE id = ?").bind(result.id).run();
    const fetched = await app.fetch(new Request(`http://localhost/api/envelopes/${result.id}`, { headers: { authorization: `Bearer ${secret}` } }), env);
    assert.equal(fetched.status, 200);
    const details = await fetched.json();
    assert.equal(details.id, result.id);
    assert.equal(details.status, 'IN_PROGRESS');
    assert.deepEqual(details.tasks.map((task: { role: string }) => task.role), ['ana', 'marcus']);
    assert.equal((await app.fetch(new Request('http://localhost/api/envelopes/missing', { headers: { authorization: `Bearer ${secret}` } }), env)).status, 404);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM tasks WHERE envelope_id = ?').bind(result.id).first())!.n, 2);
    // The first signer's task is active, the others wait; the initial document is the template's source.
    assert.deepEqual(details.tasks.map((task: { status: string }) => task.status), ['ACTIVE', 'PENDING']);
    const d0 = await db.prepare('SELECT id, object_key, sha256 FROM artifacts WHERE envelope_id = ?').bind(result.id).first();
    assert.deepEqual(d0, { id: `d0:${result.id}`, object_key: `envelopes/${result.id}/d0.pdf`, sha256: '43cc23fa52b87b4cc1d02b5b114154151d6adddb17c9fddc06b027fa99e24008' });
    assert.equal(await (await env.ARTIFACTS.get(d0!.object_key as string))!.text(), 'document');
    // Deprecated preparation is a no-op for this tenant's envelopes, and not found otherwise.
    const prepare = (id: string) => app.fetch(new Request(`http://localhost/api/envelopes/${id}/prepare`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } }), env);
    assert.equal((await prepare(result.id)).status, 204);
    assert.equal((await prepare(result.id)).status, 204);
    assert.equal((await prepare('missing')).status, 404);
    await db.prepare("INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256) VALUES ('other-envelope', 'tenant-b', 'template-b', 'IN_PROGRESS', 1, 'hash')").run();
    await db.prepare("INSERT INTO artifacts VALUES ('d0:other-envelope', 'other-envelope', 'envelopes/other-envelope/d0.pdf', 'hash')").run();
    assert.equal((await prepare('other-envelope')).status, 404);
    assert.equal((await db.prepare('SELECT status FROM envelopes WHERE id = ?').bind(result.id).first())!.status, 'IN_PROGRESS');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?').bind(result.id).first())!.n, 1);

    // A creation whose database write fails leaves nothing behind but its D0 object, which the retry reuses.
    const failingDb = new Proxy(db, { get(target, prop) { if (prop === 'batch') return async () => { throw new Error('simulated D1 outage'); }; const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v; } });
    const failed = await app.fetch(new Request('http://localhost/api/envelopes', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': 'request-2' }, body: JSON.stringify(body) }), { ...env, DB: failingDb });
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

test('concurrent creations with one Idempotency-Key make one envelope, and a lost race applies the same rules', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    const secret = 'test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), (n) => n.toString(16).padStart(2, '0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('tenant-a')").run();
    await db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 'tenant-a')").bind(hash).run();
    await db.prepare("INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at,owner_user_id) VALUES ('template-a', 'tenant-a', 'object-a', '[\"ana\",\"marcus\"]', 1, 'service-account-tenant-a')").run();
    const env = { DB: db, ARTIFACTS: await blobStore(mf,'artifacts') };
    await env.ARTIFACTS.put('object-a', 'document');
    const body = { templateId: 'template-a', recipients: [{ role: 'ana', name: 'Ana', email: 'ana@example.com' }, { role: 'marcus', name: 'Marcus', email: 'marcus@example.com' }] };
    const other = { ...body, recipients: [...body.recipients].reverse() };
    const create = (data: unknown, key: string, target = env) => app.fetch(new Request('http://localhost/api/envelopes', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(data) }), target);
    const count = async (id: string) => ({
      envelopes: (await db.prepare('SELECT count(*) AS n FROM envelopes WHERE id = ?').bind(id).first())!.n,
      tasks: (await db.prepare('SELECT count(*) AS n FROM tasks WHERE envelope_id = ?').bind(id).first())!.n,
      artifacts: (await db.prepare('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?').bind(id).first())!.n,
      objects: (await env.ARTIFACTS.list({ prefix: `envelopes/${id}/` })).objects.length,
    });
    const one = { envelopes: 1, tasks: 2, artifacts: 1, objects: 1 };

    // The same request sent three times at once: one envelope, and every caller gets its response.
    const sameId = await envelopeIdFor('tenant-a', 'concurrent-same');
    const same = await Promise.all([0, 1, 2].map(() => create(body, 'concurrent-same')));
    assert.deepEqual(same.map((r) => r.status), [201, 201, 201]);
    for (const response of same) assert.deepEqual(await response.json(), { id: sameId, status: 'IN_PROGRESS' });
    assert.deepEqual(await count(sameId), one);

    // Two different requests with one key at once: one is created, the other is a conflict.
    const mixedId = await envelopeIdFor('tenant-a', 'concurrent-mixed');
    const mixed = await Promise.all([create(body, 'concurrent-mixed'), create(other, 'concurrent-mixed')]);
    assert.deepEqual(mixed.map((r) => r.status).sort(), [201, 409]);
    for (const response of mixed) assert.deepEqual(await response.json(), response.status === 201 ? { id: mixedId, status: 'IN_PROGRESS' } : { error: 'idempotency_conflict' });
    assert.deepEqual(await count(mixedId), one);

    // A request that looked before the winner committed loses on the envelope's primary key, reads
    // the winner and answers by the same rules. The first lookup is hidden to force that order.
    const losing = () => {
      let hidden = false;
      return new Proxy(db, { get(target, prop) {
        if (prop === 'prepare') return (sql: string) => {
          if (!hidden && sql.startsWith('SELECT request_sha256 FROM envelopes')) { hidden = true; return { bind: () => ({ first: async () => null }) }; }
          return target.prepare(sql);
        };
        const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v;
      } });
    };
    const racedId = await envelopeIdFor('tenant-a', 'raced');
    assert.equal((await create(body, 'raced')).status, 201);
    const sameLoser = await create(body, 'raced', { ...env, DB: losing() });
    assert.equal(sameLoser.status, 201);
    assert.deepEqual(await sameLoser.json(), { id: racedId, status: 'IN_PROGRESS' });
    // A different request reaches the D0 copy with the same bytes, so it also fails on the primary key.
    const otherLoser = await create(other, 'raced', { ...env, DB: losing() });
    assert.equal(otherLoser.status, 409);
    assert.deepEqual(await otherLoser.json(), { error: 'idempotency_conflict' });
    assert.deepEqual(await count(racedId), one);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n, 3);
  } finally { await mf.dispose(); }
});
