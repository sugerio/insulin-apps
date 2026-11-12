// A template's default signers (default-signers.ts): who usually signs as some of its roles, given with the upload or
// set later, returned with the template, kept by an edited copy for the roles it keeps, and used for a recipient of a
// new envelope that leaves out its name or email. Envelopes already sent keep whom they were sent to. Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import { setEditorOrigins } from './helpers/editor-origins.ts';
import app from './helpers/gateway.ts';
import { parseDefaultSigners, storedDefaultSigners } from '../src/app/server/esign/default-signers.ts';

const ORIGIN = 'https://esign.example.test';
const HOST = 'https://host.example.com';
const KEY = 'e'.repeat(64);
const OTHER = 'f'.repeat(64);

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant'),('other')").run();
  const hash = async (key: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('hex');
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant'),(?,'other')").bind(await hash(KEY), await hash(OTHER)).run();
  await setEditorOrigins(db, 'tenant', [HOST]);
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), ASSETS: { fetch: async () => new Response('<html>editor</html>', { headers: { 'content-type': 'text/html' } }) } };
  const as = (key: string) => ({ authorization: `Bearer ${key}` });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const post = (path: string, body: unknown, key = KEY, headers: Record<string, string> = {}) => req(path, { method: 'POST', headers: { ...as(key), ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = await pdf.save();
  const upload = (roles: string[], defaultSigners?: unknown) => {
    const form = new FormData(); form.set('file', new File([bytes], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(roles));
    if (defaultSigners !== undefined) form.set('defaultSigners', typeof defaultSigners === 'string' ? defaultSigners : JSON.stringify(defaultSigners));
    return req('/api/templates', { method: 'POST', headers: as(KEY), body: form });
  };
  const send = (templateId: string, recipients: unknown[]) => post('/api/envelopes', { templateId, recipients }, KEY, { 'idempotency-key': crypto.randomUUID() });
  const signers = async (envelopeId: string) => ((await (await req(`/api/envelopes/${envelopeId}`, { headers: as(KEY) })).json()) as { tasks: { role: string; recipientName: string; recipientEmail: string }[] }).tasks.map(t => [t.role, t.recipientName, t.recipientEmail]);
  return { mf, db, req, post, upload, send, signers, as, bytes };
}

test('default signers: parsed per role, empty ones left out, anything else refused', () => {
  assert.equal(parseDefaultSigners(undefined, ['a']), null);
  assert.equal(parseDefaultSigners({ a: { name: ' ', email: '' } }, ['a']), null);
  assert.deepEqual(parseDefaultSigners({ a: { name: ' Ana ' }, b: { email: 'bo@example.com' } }, ['a', 'b']), { a: { name: 'Ana' }, b: { email: 'bo@example.com' } });
  for (const bad of [[], 'a', { c: { name: 'X' } }, { a: { name: 'X', title: 'T' } }, { a: { email: 'nope' } }, { a: { name: 'N'.repeat(201) } }, { a: 'Ana' }]) assert.equal(parseDefaultSigners(bad, ['a', 'b']), 'invalid', JSON.stringify(bad));
  assert.deepEqual(parseDefaultSigners(JSON.parse('{"__proto__":{"name":"Proto"}}'), ['__proto__']), JSON.parse('{"__proto__":{"name":"Proto"}}'), 'a role named __proto__ is a role');
  assert.deepEqual(storedDefaultSigners('{"a":{"name":"Ana"},"gone":{"name":"Old"}}', ['a']), { a: { name: 'Ana' } }, 'a role the template no longer has is dropped');
  assert.deepEqual(storedDefaultSigners('not json', ['a']), {});
});

test('a template uploaded with default signers returns them, and a recipient that leaves out a name or email gets its role\'s', async () => {
  const { mf, req, upload, send, signers, as } = await setup();
  try {
    // Refused: a role the template hasn't, a bad email, a name the signature font can't draw, malformed JSON.
    for (const bad of [{ legal: { name: 'X' } }, { seller: { email: 'not-an-email' } }, '{']) assert.equal((await upload(['partner', 'seller'], bad)).status, 422, JSON.stringify(bad));
    const unsupported = await upload(['partner', 'seller'], { seller: { name: '李雷' } });
    assert.equal(unsupported.status, 422);
    assert.deepEqual(await unsupported.json(), { error: 'unsupported_recipient_name' });
    const created = await upload(['partner', 'seller', 'witness'], { seller: { name: 'Sam Seller', email: 'sam@seller.example' }, witness: { email: 'witness@seller.example' } });
    assert.equal(created.status, 201);
    const template = await created.json() as { id: string; defaultSigners: unknown };
    const expected = { seller: { name: 'Sam Seller', email: 'sam@seller.example' }, witness: { email: 'witness@seller.example' } };
    assert.deepEqual(template.defaultSigners, expected);
    assert.deepEqual(((await (await req(`/api/templates/${template.id}`, { headers: as(KEY) })).json()) as { defaultSigners: unknown }).defaultSigners, expected);
    assert.deepEqual(((await (await req('/api/templates', { headers: as(KEY) })).json()) as { templates: { defaultSigners: unknown }[] }).templates[0].defaultSigners, expected);
    // Left out: the default's name and email; given: the request's, whatever the default; a default with an email only
    // still needs the name.
    const sent = await send(template.id, [{ role: 'partner', name: 'Ana', email: 'ana@partner.example' }, { role: 'seller' }, { role: 'witness', name: 'Wes Witness' }]);
    assert.equal(sent.status, 201, await sent.clone().text());
    const { id } = await sent.json() as { id: string };
    assert.deepEqual(await signers(id), [['partner', 'Ana', 'ana@partner.example'], ['seller', 'Sam Seller', 'sam@seller.example'], ['witness', 'Wes Witness', 'witness@seller.example']]);
    const overridden = await send(template.id, [{ role: 'partner', name: 'Ana', email: 'ana@partner.example' }, { role: 'seller', name: 'Other Seller', email: 'other@seller.example' }, { role: 'witness', name: 'W', email: 'w@example.com' }]);
    assert.deepEqual((await signers((await overridden.json() as { id: string }).id))[1], ['seller', 'Other Seller', 'other@seller.example']);
    for (const missing of [[{ role: 'partner', name: 'Ana' }, { role: 'seller' }, { role: 'witness', name: 'W' }], [{ role: 'partner', name: 'Ana', email: 'ana@partner.example' }, { role: 'seller' }, { role: 'witness' }]]) {
      const refused = await send(template.id, missing);
      assert.equal(refused.status, 422);
      assert.deepEqual(await refused.json(), { error: 'invalid_recipient' });
    }
  } finally { await mf.dispose(); }
});

test('default signers can be replaced or cleared later; envelopes already sent keep their signers', async () => {
  const { mf, post, upload, send, signers } = await setup();
  try {
    const { id } = await (await upload(['partner', 'seller'])).json() as { id: string };
    assert.equal((await send(id, [{ role: 'partner', name: 'Ana', email: 'ana@partner.example' }, { role: 'seller' }])).status, 422, 'no default yet');
    const set = await post(`/api/templates/${id}/default-signers`, { defaultSigners: { seller: { name: 'Sam Seller', email: 'sam@seller.example' } } });
    assert.equal(set.status, 200);
    assert.deepEqual(await set.json(), { id, defaultSigners: { seller: { name: 'Sam Seller', email: 'sam@seller.example' } } });
    const first = (await (await send(id, [{ role: 'partner', name: 'Ana', email: 'ana@partner.example' }, { role: 'seller' }])).json() as { id: string }).id;
    await post(`/api/templates/${id}/default-signers`, { defaultSigners: { seller: { name: 'Nia New', email: 'nia@seller.example' } } });
    const second = (await (await send(id, [{ role: 'partner', name: 'Ana', email: 'ana@partner.example' }, { role: 'seller' }])).json() as { id: string }).id;
    assert.deepEqual((await signers(first))[1], ['seller', 'Sam Seller', 'sam@seller.example'], 'sent before the change');
    assert.deepEqual((await signers(second))[1], ['seller', 'Nia New', 'nia@seller.example']);
    // Refused: no field, an unknown one, a role the template hasn't, another organization's template.
    for (const bad of [{}, { defaultSigners: {}, extra: 1 }, { defaultSigners: { legal: { name: 'X' } } }]) assert.equal((await post(`/api/templates/${id}/default-signers`, bad)).status, 422, JSON.stringify(bad));
    assert.equal((await post(`/api/templates/${id}/default-signers`, { defaultSigners: {} }, OTHER)).status, 404);
    const cleared = await post(`/api/templates/${id}/default-signers`, { defaultSigners: {} });
    assert.deepEqual(await cleared.json(), { id, defaultSigners: {} });
  } finally { await mf.dispose(); }
});

test('a copy made in the field editor keeps its source\'s default signers, for the roles it keeps', async () => {
  const { mf, req, post, upload, as } = await setup();
  try {
    const { id: source } = await (await upload(['partner', 'seller', 'legal'], { seller: { name: 'Sam Seller' }, legal: { email: 'legal@seller.example' } })).json() as { id: string };
    const session = await (await post('/api/template-editing-sessions', { allowedParentOrigin: HOST, sourceTemplateId: source })).json() as { sessionId: string; url: string };
    const exchanged = await req('/api/public/editor/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ pageId: session.sessionId, code: new URL(session.url).hash.slice(1), embedded: true, embedder: HOST }) });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const headers = { 'x-esign-session': (await exchanged.json() as { token: string }).token, origin: ORIGIN };
    // The editor drops the legal role.
    const field = { id: 'f1', type: 'Signature', role: 'partner', page: 1, required: true, rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } };
    // A copy is of the source's PDF: the save sends roles and fields only.
    const form = new FormData(); form.set('roles', JSON.stringify(['partner', 'seller']));
    form.set('fields', JSON.stringify([field, { ...field, id: 'f2', role: 'seller', rect: { ...field.rect, x: 0.5 } }]));
    const saved = await req('/api/public/editor/save', { method: 'POST', headers, body: form });
    assert.equal(saved.status, 201, await saved.clone().text());
    const copy = await (await req(`/api/templates/${(await saved.json() as { id: string }).id}`, { headers: as(KEY) })).json() as { defaultSigners: unknown };
    assert.deepEqual(copy.defaultSigners, { seller: { name: 'Sam Seller' } });
  } finally { await mf.dispose(); }
});
