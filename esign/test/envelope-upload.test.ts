// Upload and send (envelope-documents.ts, editor-routes.ts, app.ts): an envelope draft with no template names its
// signers and their roles, gets its PDF uploaded, has its fields placed by the field editor on that document (into the
// draft's own roles and fields), and is sent with them, checked as a template's would be. Its signers sign those fields.
// Discarding the draft deletes its document. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { setEditorOrigins } from './helpers/editor-origins.ts';

const KEY = 'local-test-key-' + 'f'.repeat(32), HOST = 'https://host.example.com', ORIGIN = 'http://localhost';
const signature = (id: string, role: string, x: number, required = true) => ({ id, type: 'Signature', role, page: 1, required, rect: { x, y: 0.2, width: 0.25, height: 0.06 } });
const RECIPIENTS = [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }, { role: 'seller', name: 'Sam Seller', email: 'sam@seller.example' }];

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))).toString('hex');
  await db.batch([db.prepare("INSERT INTO tenants (id) VALUES ('t')"), db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 't')").bind(hash)]);
  await setEditorOrigins(db, 't', [HOST]);
  const bucket = await blobStore(mf, 'artifacts');
  const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: await blobStore(mf, 'test-mail'), SIGNING_PAGE_ORIGINS: HOST, OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes', ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) } };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const auth = { authorization: `Bearer ${KEY}` };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const bytes = await pdf.save();
  const upload = (id: string, body: BodyInit = bytes, type = 'application/pdf') => req(`/api/envelopes/${id}/document`, { method: 'POST', headers: { ...auth, 'content-type': type }, body });
  const draft = async (key: string, extra: Record<string, unknown> = {}) => {
    const r = await post('/api/envelopes', { recipients: RECIPIENTS, documentName: 'Uploaded agreement', draft: true, ...extra }, { 'idempotency-key': key });
    assert.equal(r.status, 201, await r.clone().text());
    return (await r.json() as { id: string }).id;
  };
  /** An editing session for the draft's fields, opened as the host's page would: its save. */
  const editor = async (envelopeId: string) => {
    const created = await post('/api/template-editing-sessions', { allowedParentOrigin: HOST, envelopeId });
    if (created.status !== 201) return { status: created.status, body: await created.json() };
    const { sessionId, url } = await created.json() as { sessionId: string; url: string };
    const exchanged = await req('/api/public/editor/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ pageId: sessionId, code: new URL(url).hash.slice(1), embedded: true, embedder: HOST }) });
    const headers = { 'x-esign-session': (await exchanged.json() as { token: string }).token, origin: ORIGIN };
    const save = (roles: string[], fields: unknown[], asDraft = false) => {
      const form = new FormData(); form.set('roles', JSON.stringify(roles)); form.set('fields', JSON.stringify(fields));
      if (asDraft) form.set('draft', 'true');
      return req('/api/public/editor/save', { method: 'POST', headers, body: form });
    };
    return { status: 201, sessionId, headers, save };
  };
  const shown = async (id: string) => await (await req(`/api/envelopes/${id}`, { headers: auth })).json() as { status: string; templateId: string | null; upload?: { document: boolean; roles: string[]; fields: { role: string }[] }; tasks: { id: string; recipientName: string; status: string }[] };
  return { mf, db, bucket, req, post, auth, upload, draft, editor, shown, bytes };
}

test('an uploaded document is placed on and sent: the draft\'s signers and roles, its PDF, its fields, checked when sent', async () => {
  const h = await setup();
  try {
    const id = await h.draft('upload-1');
    assert.deepEqual([(await h.shown(id)).templateId, (await h.shown(id)).upload], [null, { document: false, roles: [], fields: [] }]);
    // No document yet: no editor, nothing to send.
    assert.equal((await h.editor(id)).status, 409);
    assert.deepEqual(await (await h.post(`/api/envelopes/${id}`, { recipients: RECIPIENTS })).json(), { error: 'document_required' });
    // The document: a PDF, and one fields can be placed on.
    assert.equal((await h.upload(id, 'not a pdf', 'text/plain')).status, 422);
    assert.equal((await h.upload(id, '%PDF-broken')).status, 422);
    const uploaded = await h.upload(id);
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    assert.equal((await uploaded.json() as { pages: number }).pages, 1);
    assert.equal((await h.shown(id)).upload!.document, true);
    // Its fields, in the editor: the roles are its signers', with their names; the document is the one uploaded.
    const session = await h.editor(id);
    assert.equal(session.status, 201);
    const current = await (await h.req('/api/public/editor/current', { headers: session.headers! })).json() as { roles: string[]; roleLabels: Record<string, string>; fields: unknown[] };
    assert.deepEqual([current.roles, current.roleLabels, current.fields], [['partner', 'seller'], { partner: 'Pat Partner', seller: 'Sam Seller' }, []]);
    const document = await h.req('/api/public/editor/pdf', { headers: session.headers! });
    assert.deepEqual(new Uint8Array(await document.arrayBuffer()), h.bytes);
    // Placed so far, as a draft: saved, not ready.
    const partial = await session.save!(['partner', 'seller'], [signature('a', 'partner', 0.1)], true);
    assert.deepEqual([partial.status, await partial.json()], [200, { id, status: 'draft' }]);
    assert.deepEqual((await h.shown(id)).upload!.fields.map((f) => f.role), ['partner']);
    assert.deepEqual(await (await h.post(`/api/envelopes/${id}`, { recipients: RECIPIENTS })).json(), { error: 'fields_not_ready' }, 'every role signs somewhere');
    // Ready: every role has a required Signature, with these roles only.
    assert.equal((await session.save!(['partner', 'seller'], [signature('a', 'partner', 0.1)])).status, 422);
    assert.equal((await session.save!(['seller', 'partner'], [signature('a', 'partner', 0.1), signature('b', 'seller', 0.5)])).status, 422, 'its roles, in order');
    const ready = await session.save!(['partner', 'seller'], [signature('a', 'partner', 0.1), signature('b', 'seller', 0.5)]);
    assert.deepEqual([ready.status, await ready.json()], [200, { id, status: 'ready' }]);
    // Sent: out for signature, with no template, the uploaded document as its initial document, these fields.
    const sent = await h.post(`/api/envelopes/${id}`, { recipients: RECIPIENTS, documentName: 'Uploaded agreement' });
    assert.deepEqual([sent.status, await sent.json()], [200, { id, status: 'IN_PROGRESS' }]);
    const envelope = await h.shown(id);
    assert.deepEqual([envelope.status, envelope.templateId, envelope.upload, envelope.tasks.map((t) => [t.recipientName, t.status])], ['IN_PROGRESS', null, undefined, [['Pat Partner', 'ACTIVE'], ['Sam Seller', 'PENDING']]]);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?').bind(id).first<{ n: number }>())!.n, 1, 'one initial document');
    // Its first signer signs those fields.
    const view = await (await h.post(`/api/envelopes/${id}/tasks/${envelope.tasks[0]!.id}/recipient-view`, { signedInEmail: 'pat@partner.example', origin: HOST })).json() as { code: string };
    const page = await (await h.req('/api/public/page-sessions/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: HOST }, body: JSON.stringify({ code: view.code }) })).json() as { token: string };
    const signing = await (await h.req('/api/public/signing/current', { headers: { origin: HOST, 'x-esign-session': page.token } })).json() as { fields: { id: string }[] };
    assert.deepEqual(signing.fields.map((f) => f.id), ['a']);
    // Sent, it changes no more: no document, no fields.
    assert.equal((await h.upload(id)).status, 409);
    assert.equal((await session.save!(['partner', 'seller'], [signature('a', 'partner', 0.2), signature('b', 'seller', 0.5)])).status, 409);
    assert.equal((await h.editor(id)).status, 409);
  } finally { await h.mf.dispose(); }
});

test('only an upload draft takes a document; a new envelope needs a template; replacing the document clears its fields; discarding deletes it', async () => {
  const h = await setup();
  try {
    assert.equal((await h.post('/api/envelopes', { recipients: RECIPIENTS }, { 'idempotency-key': 'no-template' })).status, 422, 'sent at once, an envelope needs a template');
    // A draft from a template takes no document, nor its kind changes.
    const form = new FormData(); form.set('file', new File([h.bytes], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(['partner', 'seller']));
    const template = await (await h.req('/api/templates', { method: 'POST', headers: h.auth, body: form })).json() as { id: string };
    const fromTemplate = await h.draft('from-template', { templateId: template.id });
    assert.equal((await h.upload(fromTemplate)).status, 409);
    assert.equal((await h.post('/api/template-editing-sessions', { allowedParentOrigin: HOST, envelopeId: fromTemplate })).status, 409);
    const id = await h.draft('upload-2');
    assert.equal((await h.post(`/api/envelopes/${id}`, { recipients: RECIPIENTS, templateId: template.id, draft: true })).status, 409, 'an upload draft stays one');
    // Replacing the document clears the fields placed on the one before.
    await h.upload(id);
    const session = await h.editor(id);
    await session.save!(['partner', 'seller'], [signature('a', 'partner', 0.1), signature('b', 'seller', 0.5)]);
    assert.equal((await h.shown(id)).upload!.fields.length, 2);
    const two = await PDFDocument.create(); two.addPage(); two.addPage();
    assert.equal((await h.upload(id, await two.save())).status, 201);
    assert.deepEqual((await h.shown(id)).upload!.fields, []);
    assert.equal((await h.bucket.list({ prefix: `envelopes/${id}/` })).objects.length, 1);
    // Discarded: the draft, its document's record and its stored file.
    assert.deepEqual(await (await h.post(`/api/envelopes/${id}/void`, {})).json(), { id, status: 'DISCARDED' });
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?').bind(id).first<{ n: number }>())!.n, 0);
    assert.equal((await h.bucket.list({ prefix: `envelopes/${id}/` })).objects.length, 0);
  } finally { await h.mf.dispose(); }
});
