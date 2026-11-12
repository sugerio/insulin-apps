import {blobStore} from './helpers/platform.ts';
// A host's labels: a template's name and metadata, and an envelope's metadata (metadata.ts). They are
// validated, kept as given and returned, carried into the template an editing session saves, and part
// of an envelope's idempotent request; a create request with a field Esign doesn't know is refused.
// Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import { setEditorOrigins } from './helpers/editor-origins.ts';
import app from './helpers/gateway.ts';
import { parseMetadata, parseTemplateName, storedMetadata } from '../src/app/server/esign/metadata.ts';

const HOST = 'https://host.example.com';
const SECRET = 'test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const LABELS = { 'host.organizationId': 'org-1', 'host.agreementId': 'agreement-1' };

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) {
    await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  }
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET))).toString('hex');
  await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();
  await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(hash).run();
  await setEditorOrigins(db, 'a', [HOST]);
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), ASSETS: { fetch: async () => new Response('<html>editor</html>', { headers: { 'content-type': 'text/html' } }) } };
  const auth = { authorization: `Bearer ${SECRET}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('https://esign.example.com' + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...auth, ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = await pdf.save();
  const upload = (fields: Record<string, string>) => {
    const form = new FormData(); form.set('file', new File([bytes], 'sample.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return req('/api/templates', { method: 'POST', headers: auth, body: form });
  };
  return { mf, db, auth, req, json, upload, bytes };
}

test('names and metadata parse strictly: bounded, plain text, and string values only', () => {
  assert.equal(parseTemplateName(undefined), null);
  assert.equal(parseTemplateName('  '), null);
  assert.equal(parseTemplateName(' Mutual NDA (v3) '), 'Mutual NDA (v3)');
  for (const bad of ['x'.repeat(201), 'line\nbreak', 7]) assert.equal(parseTemplateName(bad), 'invalid');
  assert.equal(parseMetadata(undefined), null);
  assert.equal(parseMetadata({}), null);
  assert.deepEqual(parseMetadata({ b: '2', 'a.b_c-d': '1' }), { 'a.b_c-d': '1', b: '2' });
  for (const bad of [[], 'text', { 'a b': '1' }, { ['k'.repeat(41)]: '1' }, { a: 1 }, { a: null }, { a: 'x'.repeat(501) }, { a: 'tab\t' }, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']))]) {
    assert.equal(parseMetadata(bad), 'invalid', JSON.stringify(bad));
  }
  assert.deepEqual(storedMetadata('{"a":"1","b":2}'), { a: '1' });
  assert.deepEqual(storedMetadata('not json'), {});
  // A key named __proto__ fits the pattern and is kept like any other, not swallowed by the prototype setter.
  const proto = parseMetadata(JSON.parse('{"__proto__":"host-1","a":"b"}'));
  assert.equal(JSON.stringify(proto), '{"__proto__":"host-1","a":"b"}');
  assert.deepEqual(Object.entries(storedMetadata(JSON.stringify(proto))), [['__proto__', 'host-1'], ['a', 'b']]);
});

test('a template keeps the name and metadata it was uploaded with, and lists them', async () => {
  const h = await harness();
  try {
    const created = await h.upload({ name: 'Mutual NDA (v3)', metadata: JSON.stringify(LABELS) });
    assert.equal(created.status, 201, await created.clone().text());
    const { id, ...rest } = await created.json() as { id: string; name: string; metadata: Record<string, string> };
    assert.deepEqual(rest, { name: 'Mutual NDA (v3)', metadata: LABELS, roles: ['partner'], defaultSigners: {} });
    const one = await (await h.req(`/api/templates/${id}`, { headers: h.auth })).json() as { name: string; metadata: Record<string, string> };
    assert.equal(one.name, 'Mutual NDA (v3)');
    assert.deepEqual(one.metadata, LABELS);
    const plain = await (await h.upload({})).json() as { id: string };
    const { templates } = await (await h.req('/api/templates', { headers: h.auth })).json() as { templates: { id: string; name?: string; metadata: Record<string, string> }[] };
    const listed = (templateId: string) => templates.find(t => t.id === templateId);
    assert.deepEqual([listed(id)?.name, listed(id)?.metadata], ['Mutual NDA (v3)', LABELS]);
    assert.deepEqual([listed(plain.id)?.name, listed(plain.id)?.metadata], [undefined, {}]);
    // Malformed labels, and a form field Esign doesn't know, are refused.
    for (const fields of [{ name: 'x'.repeat(201) }, { metadata: '{"a":1}' }, { metadata: 'not json' }]) assert.equal((await h.upload(fields)).status, 422, JSON.stringify(fields));
    const unknown = await h.upload({ title: 'NDA' });
    assert.equal(unknown.status, 422);
    assert.deepEqual(await unknown.json(), { error: 'unknown_field', fields: ['title'] });
  } finally { await h.mf.dispose(); }
});

test('an editing session gives the saved template its name and metadata, or the source template\'s', async () => {
  const h = await harness();
  try {
    const save = async (session: { sessionId: string; url: string }, newFile = true) => {
      const code = new URL(session.url).hash.slice(1);
      const exchanged = await h.req('/api/public/editor/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://esign.example.com' }, body: JSON.stringify({ pageId: session.sessionId, code, embedded: true, embedder: HOST }) });
      const { token } = await exchanged.json() as { token: string };
      const form = new FormData();
      if (newFile) form.set('file', new File([h.bytes], 'sample.pdf', { type: 'application/pdf' }));
      form.set('roles', '["partner"]');
      form.set('fields', JSON.stringify([{ id: 'f1', type: 'Signature', role: 'partner', page: 1, required: true, rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } }]));
      const saved = await h.req('/api/public/editor/save', { method: 'POST', headers: { 'x-esign-session': token, origin: 'https://esign.example.com' }, body: form });
      assert.equal(saved.status, 201, await saved.clone().text());
      const { id } = await saved.json() as { id: string };
      return await (await h.req(`/api/templates/${id}`, { headers: h.auth })).json() as { id: string; name?: string; metadata: Record<string, string> };
    };
    const open = async (body: Record<string, unknown>) => {
      const res = await h.req('/api/template-editing-sessions', h.json({ allowedParentOrigin: HOST, ...body }));
      assert.equal(res.status, 201, await res.clone().text());
      return res.json() as Promise<{ sessionId: string; url: string }>;
    };
    const first = await save(await open({ roles: ['partner'], name: 'Reseller Agreement (v1)', metadata: LABELS }));
    assert.equal(first.name, 'Reseller Agreement (v1)');
    assert.deepEqual(first.metadata, LABELS);
    // Editing it again without labels: the copy keeps them.
    const copy = await save(await open({ sourceTemplateId: first.id }), false);
    assert.equal(copy.name, 'Reseller Agreement (v1)');
    assert.deepEqual(copy.metadata, LABELS);
    // A new name only: the metadata is still the source's.
    const renamed = await save(await open({ sourceTemplateId: first.id, name: 'Reseller Agreement (v2)' }), false);
    assert.equal(renamed.name, 'Reseller Agreement (v2)');
    assert.deepEqual(renamed.metadata, LABELS);
    assert.equal((await h.req('/api/template-editing-sessions', h.json({ allowedParentOrigin: HOST, metadata: { a: 1 } }))).status, 422);
    const unknown = await h.req('/api/template-editing-sessions', h.json({ allowedParentOrigin: HOST, label: 'x' }));
    assert.equal(unknown.status, 422);
    assert.deepEqual(await unknown.json(), { error: 'unknown_field', fields: ['label'] });
    // The largest labels the catalog allows (a 200-character name, 20 keys of 40 characters with 500-character values) fit the request.
    const largest = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`.padEnd(40, '-'), 'v'.repeat(500)]));
    const big = await h.req('/api/template-editing-sessions', h.json({ allowedParentOrigin: HOST, roles: ['partner'], name: 'n'.repeat(200), metadata: largest }));
    assert.equal(big.status, 201, await big.clone().text());
  } finally { await h.mf.dispose(); }
});

test('an envelope keeps its metadata as part of the idempotent request, and refuses fields Esign doesn\'t know', async () => {
  const h = await harness();
  try {
    const { id: templateId } = await (await h.upload({})).json() as { id: string };
    const body = (extra: Record<string, unknown> = {}, recipient: Record<string, unknown> = {}) => ({ templateId, documentName: 'Mutual NDA', recipients: [{ role: 'partner', name: 'Ana Ribeiro', email: 'ana@northbeam.test', ...recipient }], ...extra });
    const send = (key: string, payload: unknown) => h.req('/api/envelopes', h.json(payload, { 'idempotency-key': key }));
    const created = await send('k1', body({ metadata: LABELS }));
    assert.equal(created.status, 201, await created.clone().text());
    const { id } = await created.json() as { id: string };
    const read = await (await h.req(`/api/envelopes/${id}`, { headers: h.auth })).json() as { documentName: string; metadata: Record<string, string> };
    assert.equal(read.documentName, 'Mutual NDA');
    assert.deepEqual(read.metadata, LABELS);
    const { envelopes } = await (await h.req('/api/envelopes', { headers: h.auth })).json() as { envelopes: { id: string; metadata: Record<string, string> }[] };
    assert.deepEqual(envelopes.find(e => e.id === id)?.metadata, LABELS);
    // The same key: the same metadata replays, other metadata is another request.
    assert.equal((await send('k1', body({ metadata: LABELS }))).status, 201);
    assert.equal((await send('k1', body({ metadata: { ...LABELS, 'host.agreementId': 'agreement-2' } }))).status, 409);
    // Without metadata it reads back empty.
    const { id: plain } = await (await send('k2', body())).json() as { id: string };
    assert.deepEqual((await (await h.req(`/api/envelopes/${plain}`, { headers: h.auth })).json() as { metadata: unknown }).metadata, {});
    assert.equal((await send('k3', body({ metadata: { a: 1 } }))).status, 422);
    const unknown = await send('k4', body({ externalId: 'x' }));
    assert.equal(unknown.status, 422);
    assert.deepEqual(await unknown.json(), { error: 'unknown_field', fields: ['externalId'] });
    const unknownRecipient = await send('k5', body({}, { phone: '+1 555 0100' }));
    assert.equal(unknownRecipient.status, 422);
    assert.deepEqual(await unknownRecipient.json(), { error: 'unknown_field', fields: ['recipients[].phone'] });
    // Inside the document version and the sender too: a misspelled field is refused, not dropped.
    const unknownNested = await send('k8', body({ documentVersion: { label: 'v1', externalId: 'a' }, sender: { name: 'Dana Seller', organisation: 'Harness' } }));
    assert.equal(unknownNested.status, 422);
    assert.deepEqual(await unknownNested.json(), { error: 'unknown_field', fields: ['documentVersion.externalId', 'sender.organisation'] });
    // The API catalog states the version label's real limit, 16 characters.
    const catalog = await (await h.req('/api/catalog', { headers: h.auth })).json() as { endpoints: { method: string; path: string; body: { properties: { documentVersion: { properties: { label: { maxLength: number } } } } } }[] };
    const envelopeBody = catalog.endpoints.find(e => e.method === 'POST' && e.path === '/api/envelopes')?.body.properties as unknown as Record<string, { additionalProperties?: boolean; properties: Record<string, { maxLength?: number }> }>;
    assert.equal(envelopeBody.documentVersion.properties.label.maxLength, 16);
    assert.deepEqual([envelopeBody.documentVersion.additionalProperties, envelopeBody.sender.additionalProperties], [false, false]);
    assert.equal((await send('k6', body({ documentVersion: { label: 'x'.repeat(16) } }))).status, 201);
    assert.equal((await send('k7', body({ documentVersion: { label: 'x'.repeat(17) } }))).status, 422);
  } finally { await h.mf.dispose(); }
});
