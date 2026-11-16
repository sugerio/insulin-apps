// Template drafts (editor-routes.ts, app.ts): the field editor saves a template as a draft, which needn't be ready yet,
// starts no envelope and is saved again in place, by the session that saved it or by one opened to replace it; saved
// as active, it is ready, and from then on never a draft again. Lists show active templates unless asked for drafts.
// Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { setEditorOrigins } from './helpers/editor-origins.ts';

const KEY = 'local-test-key-' + 'd'.repeat(32);
const HOST = 'https://host.example.com';
const signature = (id: string, role: string, x: number) => ({ id, type: 'Signature', role, page: 1, required: true, rect: { x, y: 0.2, width: 0.2, height: 0.1 } });

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))), (n) => n.toString(16).padStart(2, '0')).join('');
  await db.prepare("INSERT INTO tenants(id) VALUES ('t')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?, 't')").bind(hash).run();
  await setEditorOrigins(db, 't', [HOST]);
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), ASSETS: { fetch: async () => new Response('<html>editor</html>', { headers: { 'content-type': 'text/html' } }) } };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('https://esign.example.com' + path, init), env);
  const auth = { authorization: `Bearer ${KEY}` };
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = await pdf.save();
  /** An editor session (a new PDF staged as its source, or one replacing a template), opened: its editor headers. */
  async function session(body: Record<string, unknown>) {
    const created = await req('/api/template-editing-sessions', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ allowedParentOrigin: HOST, ...body }) });
    assert.equal(created.status, 201, await created.clone().text());
    const { sessionId, url } = await created.json() as { sessionId: string; url: string };
    if (!body.sourceTemplateId) assert.equal((await req(`/api/template-editing-sessions/${sessionId}/source`, { method: 'POST', headers: { ...auth, 'content-type': 'application/pdf' }, body: bytes })).status, 201);
    const exchanged = await req('/api/public/editor/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://esign.example.com' }, body: JSON.stringify({ pageId: sessionId, code: new URL(url).hash.slice(1), embedded: true, embedder: HOST }) });
    const { token } = await exchanged.json() as { token: string };
    const headers = { 'x-esign-session': token, origin: 'https://esign.example.com' };
    const save = (roles: string[], fields: unknown[], draft?: string, extra: Record<string, Blob> = {}) => {
      const form = new FormData(); form.set('roles', JSON.stringify(roles)); form.set('fields', JSON.stringify(fields));
      if (draft !== undefined) form.set('draft', draft);
      for (const [k, v] of Object.entries(extra)) form.set(k, v);
      return req('/api/public/editor/save', { method: 'POST', headers, body: form });
    };
    return { sessionId, save };
  }
  const template = async (id: string) => await (await req(`/api/templates/${id}`, { headers: auth })).json() as { status: string; roles: string[]; fields: { type: string; role: string }[]; defaultSigners: Record<string, unknown> };
  const listed = async (status?: string) => { const r = await req(`/api/templates${status ? `?status=${status}` : ''}`, { headers: auth }); assert.equal(r.status, 200); return (await r.json() as { templates: { id: string; status: string }[] }).templates; };
  const send = (templateId: string) => req('/api/envelopes', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ templateId, recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }, { role: 'seller', name: 'Sam Seller', email: 'sam@seller.example' }] }) });
  return { mf, req, auth, bytes, session, template, listed, send };
}

test('a draft needn\'t be ready, starts no envelope, is listed only when asked for, and is saved again in place until it is ready', async () => {
  const h = await setup();
  try {
    const editing = await h.session({ roles: ['partner', 'seller'], name: 'Reseller agreement' });
    // Not ready: no Signature for seller. As a draft, saved.
    const refused = await editing.save(['partner', 'seller'], [signature('a', 'partner', 0.1)]);
    assert.equal(refused.status, 422, 'saved as ready, it must be');
    for (const bad of ['yes', '1']) assert.equal((await editing.save(['partner', 'seller'], [], bad)).status, 422, bad);
    const first = await editing.save(['partner', 'seller'], [signature('a', 'partner', 0.1)], 'true');
    assert.equal(first.status, 201, await first.clone().text());
    const { id, status } = await first.json() as { id: string; status: string };
    assert.equal(status, 'draft');
    assert.equal((await h.template(id)).status, 'draft');
    // Lists: active ones by default; drafts when asked for, or all.
    assert.deepEqual(await h.listed(), []);
    assert.deepEqual((await h.listed('draft')).map((t) => [t.id, t.status]), [[id, 'draft']]);
    assert.deepEqual((await h.listed('all')).map((t) => t.id), [id]);
    assert.equal((await h.req('/api/templates?status=archived', { headers: h.auth })).status, 400);
    // It starts no envelope.
    const sent = await h.send(id);
    assert.equal(sent.status, 409);
    assert.deepEqual(await sent.json(), { error: 'template_draft' });
    // Saved again, by the same session: in place, a draft still, with no field at all even.
    const again = await editing.save(['partner', 'seller'], [], 'true');
    assert.equal(again.status, 200, await again.clone().text());
    assert.deepEqual(await again.json(), { id, status: 'draft' });
    assert.deepEqual((await h.template(id)).fields, []);
    // A new PDF isn't taken in place: the draft keeps its own.
    assert.equal((await editing.save(['partner', 'seller'], [], 'true', { file: new File([h.bytes], 'other.pdf', { type: 'application/pdf' }) })).status, 422);
    // Ready: saved as active, in place; the session's work is then done.
    const ready = await editing.save(['partner', 'seller'], [signature('a', 'partner', 0.1), signature('b', 'seller', 0.5)]);
    assert.equal(ready.status, 200, await ready.clone().text());
    assert.deepEqual(await ready.json(), { id, status: 'active' });
    assert.equal((await h.req(`/api/template-editing-sessions/${editing.sessionId}`, { headers: h.auth }).then((r) => r.json()) as { templateId: string }).templateId, id);
    assert.equal((await editing.save(['partner', 'seller'], [], 'true')).status, 409, 'never a draft again');
    assert.equal((await h.send(id)).status, 201, 'now it sends');
    assert.deepEqual((await h.listed()).map((t) => [t.id, t.status]), [[id, 'active']]);
    assert.deepEqual(await h.listed('draft'), []);
  } finally { await h.mf.dispose(); }
});

test('a draft is opened again to replace itself: saved in place, its roles\' default signers kept; a template in use is never saved as a draft', async () => {
  const h = await setup();
  try {
    const first = await (await h.session({ roles: ['partner', 'seller'] })).save(['partner', 'seller'], [signature('a', 'partner', 0.1)], 'true');
    const { id } = await first.json() as { id: string };
    await h.req(`/api/templates/${id}/default-signers`, { method: 'POST', headers: { ...h.auth, 'content-type': 'application/json' }, body: JSON.stringify({ defaultSigners: { partner: { name: 'Pat Partner' }, seller: { name: 'Sam Seller' } } }) });
    // Reopened, as its new version: saved in place, a draft still; a role dropped takes its default signer with it.
    const reopened = await h.session({ sourceTemplateId: id, replace: true });
    const saved = await reopened.save(['partner'], [signature('a', 'partner', 0.2)], 'true');
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(await saved.json(), { id, status: 'draft' });
    const draft = await h.template(id);
    assert.deepEqual([draft.status, draft.roles, Object.keys(draft.defaultSigners)], ['draft', ['partner'], ['partner']]);
    assert.deepEqual(await h.listed('all').then((all) => all.map((t) => t.id)), [id], 'nothing archived, no new template');
    // Saved as ready from there: in place too.
    const ready = await reopened.save(['partner'], [signature('a', 'partner', 0.2)]);
    assert.deepEqual(await ready.json(), { id, status: 'active' });
    // In use, a template's new version is saved as active only, and replaces it as before.
    const next = await h.session({ sourceTemplateId: id, replace: true });
    const asDraft = await next.save(['partner'], [signature('a', 'partner', 0.3)], 'true');
    assert.equal(asDraft.status, 422);
    assert.deepEqual(await asDraft.json(), { error: 'draft_not_allowed' });
    const version = await next.save(['partner'], [signature('a', 'partner', 0.3)]);
    assert.equal(version.status, 201);
    const { id: newer, status } = await version.json() as { id: string; status: string };
    assert.notEqual(newer, id);
    assert.equal(status, 'active');
    assert.deepEqual((await h.listed()).map((t) => t.id), [newer], 'the earlier version is archived');
    // A copy of a template (not replacing it) is a new template: a draft, if asked.
    const copy = await (await h.session({ sourceTemplateId: newer })).save(['partner'], [], 'true');
    assert.equal(copy.status, 201);
    assert.notEqual((await copy.json() as { id: string }).id, newer);
  } finally { await h.mf.dispose(); }
});
