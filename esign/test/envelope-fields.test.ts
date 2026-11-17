// The roles and fields an envelope is signed with are its own (envelope-fields.ts): copied from its template when it is
// sent, byte for byte, so the template changing afterwards changes nothing for its signers. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';

test('an envelope is signed with the roles and fields it was sent with, whatever its template becomes', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
    const key = 'local-test-key-' + 'e'.repeat(32), origin = 'https://host.example.com';
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('hex');
    await db.batch([db.prepare("INSERT INTO tenants (id) VALUES ('a')"), db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a')").bind(hash)]);
    const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), TEST_MAIL: await blobStore(mf, 'test-mail'), SIGNING_PAGE_ORIGINS: origin, OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
    const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://localhost' + path, init), env), mgmt = { authorization: `Bearer ${key}` };
    const post = (body: unknown, headers: Record<string, string>) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf')); form.set('roles', '["ana"]');
    const template = await (await req('/api/templates', { method: 'POST', headers: mgmt, body: form })).json() as { id: string };
    const sent = [{ id: 'a', type: 'Signature', role: 'ana', page: 1, required: true, rect: { x: 0.05, y: 0.1, width: 0.25, height: 0.08 } }];
    // Stored as a template's fields are: the envelope keeps this exact text.
    const stored = JSON.stringify(sent);
    await db.prepare('UPDATE templates SET fields_json = ? WHERE id = ?').bind(stored, template.id).run();
    const send = async (idempotencyKey: string) => {
      const created = await req('/api/envelopes', post({ templateId: template.id, recipients: [{ role: 'ana', name: 'Ana', email: 'ana@example.com' }] }, { ...mgmt, 'idempotency-key': idempotencyKey }));
      assert.equal(created.status, 201, await created.clone().text());
      return (await created.json() as { id: string }).id;
    };
    const fieldsOnPage = async (envelopeId: string) => {
      const [task] = (await (await req(`/api/envelopes/${envelopeId}`, { headers: mgmt })).json() as { tasks: { id: string; recipientEmail: string }[] }).tasks;
      const view = await (await req(`/api/envelopes/${envelopeId}/tasks/${task!.id}/recipient-view`, post({ signedInEmail: task!.recipientEmail, origin }, mgmt))).json() as { code: string };
      const session = await (await req('/api/public/page-sessions/exchange', post({ code: view.code }, { origin }))).json() as { token: string };
      return (await (await req('/api/public/signing/current', { headers: { origin, 'x-esign-session': session.token } })).json() as { fields: unknown }).fields;
    };
    const kept = await send('kept');
    const row = await db.prepare('SELECT roles_json, fields_json FROM envelopes WHERE id = ?').bind(kept).first<{ roles_json: string; fields_json: string }>();
    assert.deepEqual(row, { roles_json: '["ana"]', fields_json: stored }, 'its template\'s, byte for byte');
    // The template changing afterwards (as only a draft's may) changes nothing for the envelope.
    const moved = [{ ...sent[0]!, rect: { ...sent[0]!.rect, x: 0.5 } }];
    await db.prepare('UPDATE templates SET fields_json = ? WHERE id = ?').bind(JSON.stringify(moved), template.id).run();
    assert.deepEqual(await fieldsOnPage(kept), sent);
  } finally { await mf.dispose(); }
});
