// Who sees and changes a template or an envelope (ownership.ts, tags.ts, members.ts): its owner, and those it is
// shared with, by email, as admin, editor or viewer; never anyone else, the organization's owners and admins
// included. A role is capped by the caller's role in Esign. Tags are each person's own. An API client's documents are
// shared with the person Esign's settings name for it, if any; an organization owner takes over someone's documents.
// Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, identity, MIGRATIONS_DIR, splitSql, type Identity } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { setEditorOrigins } from './helpers/editor-origins.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'k'.repeat(64);
const CLIENT = 'service-account-tenant';
const HOST = 'https://host.example.com';

type Listed = { id: string; owner: { id: string; kind: string; name?: string; email?: string }; myRole: string; tags: string[] };

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))).toString('hex');
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(hash).run();
  await setEditorOrigins(db, 'tenant', [HOST]);
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts') };
  // People of the organization, in the browser; and the host's API client, by its key.
  const person = (name: string, options: Identity = {}) => identity('tenant', { userId: `user-${name}`, email: `${name}@example.test`, role: 'EDITOR', ...options });
  const ana = person('ana'), bo = person('bo'), cy = person('cy'), owner = person('olga', { role: 'OWNER' }), viewer = person('vic', { role: 'VIEWER' });
  const host = { authorization: `Bearer ${KEY}` };
  const req = (path: string, headers: Record<string, string>, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } }), env);
  const post = (path: string, headers: Record<string, string>, body: unknown, extra: Record<string, string> = {}) => req(path, headers, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const get = async <T>(path: string, headers: Record<string, string>) => { const r = await req(path, headers); assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`); return await r.json() as T; };
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = await pdf.save();
  async function template(headers: Record<string, string>, fields: Record<string, unknown> = {}) {
    const form = new FormData(); form.set('file', new File([bytes], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(['partner']));
    for (const [key, value] of Object.entries(fields)) form.set(key, JSON.stringify(value));
    const created = await req('/api/templates', headers, { method: 'POST', body: form });
    assert.equal(created.status, 201, await created.clone().text());
    return (await created.json() as { id: string }).id;
  }
  const send = (headers: Record<string, string>, templateId: string, extra: Record<string, unknown> = {}) =>
    post('/api/envelopes', headers, { templateId, recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }], ...extra }, { 'idempotency-key': crypto.randomUUID() });
  async function envelope(headers: Record<string, string>, templateId: string, extra: Record<string, unknown> = {}) {
    const sent = await send(headers, templateId, extra);
    assert.equal(sent.status, 201, await sent.clone().text());
    return (await sent.json() as { id: string }).id;
  }
  const templates = async (headers: Record<string, string>, query = '') => (await get<{ templates: Listed[] }>(`/api/templates${query}`, headers)).templates;
  const envelopes = async (headers: Record<string, string>, query = '') => (await get<{ envelopes: Listed[] }>(`/api/envelopes${query}`, headers)).envelopes;
  return { mf, db, req, post, get, template, send, envelope, templates, envelopes, ana, bo, cy, owner, viewer, host };
}

test('a document is its owner\'s alone until shared, the organization\'s owners and admins included', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana);
    const [mine] = await h.templates(h.ana);
    assert.deepEqual([mine.id, mine.owner, mine.myRole], [id, { id: 'user-ana', kind: 'person', name: 'Synthetic Member', email: 'ana@example.test' }, 'owner']);
    for (const other of [h.bo, h.owner, identity('tenant', { userId: 'user-admin', email: 'admin@example.test', role: 'ADMIN' })]) {
      assert.deepEqual(await h.templates(other), []);
      assert.equal((await h.req(`/api/templates/${id}`, other)).status, 404, 'not found, as one that does not exist');
      assert.equal((await h.send(other, id)).status, 404);
      assert.equal((await h.post(`/api/templates/${id}/default-signers`, other, { defaultSigners: {} })).status, 404);
    }
    const envelope = await h.envelope(h.ana, id);
    for (const path of [`/api/envelopes/${envelope}`, `/api/envelopes/${envelope}/audit`, `/api/envelopes/${envelope}/shares`]) assert.equal((await h.req(path, h.bo)).status, 404, path);
    assert.equal((await h.post(`/api/envelopes/${envelope}/void`, h.bo, {})).status, 404);
    assert.deepEqual(await h.envelopes(h.bo), []);
  } finally { await h.mf.dispose(); }
});

test('shared as viewer, editor or admin: each role does what it allows, capped by the caller\'s role in Esign', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana);
    const share = (by: Record<string, string>, email: string, role: string) => h.post(`/api/templates/${id}/shares`, by, { email, role });
    assert.equal((await share(h.ana, 'BO@example.test', 'viewer')).status, 200);
    const seen = (await h.templates(h.bo))[0];
    assert.deepEqual([seen.id, seen.myRole, seen.owner.id], [id, 'viewer', 'user-ana']);
    assert.deepEqual((await h.templates(h.bo, '?scope=mine')).length, 0);
    assert.deepEqual((await h.templates(h.bo, '?scope=shared')).map(t => t.id), [id]);
    // A viewer sends from it; the envelope is theirs, not shared with the template's owner.
    const envelope = await h.envelope(h.bo, id);
    assert.deepEqual((await h.envelopes(h.bo))[0].myRole, 'owner');
    assert.deepEqual(await h.envelopes(h.ana), []);
    // ...but changes and shares nothing.
    assert.deepEqual([(await h.post(`/api/templates/${id}/default-signers`, h.bo, { defaultSigners: {} })).status, (await share(h.bo, 'cy@example.test', 'viewer')).status], [403, 403]);
    await share(h.ana, 'bo@example.test', 'editor');
    assert.equal((await h.post(`/api/templates/${id}/default-signers`, h.bo, { defaultSigners: {} })).status, 200);
    assert.equal((await share(h.bo, 'cy@example.test', 'viewer')).status, 403);
    await share(h.ana, 'bo@example.test', 'admin');
    assert.equal((await share(h.bo, 'cy@example.test', 'admin')).status, 200);
    const sharing = await h.get<{ owner: { id: string }; myRole: string; shares: { email: string; role: string; name?: string }[] }>(`/api/templates/${id}/shares`, h.cy);
    assert.deepEqual([sharing.owner.id, sharing.myRole, sharing.shares.map(s => [s.email, s.role])], ['user-ana', 'admin', [['bo@example.test', 'admin'], ['cy@example.test', 'admin']]]);
    assert.equal(sharing.shares[0].name, 'Synthetic Member', 'known members are named');
    // Someone who may only view Esign is a viewer at most, whatever they are given.
    assert.equal((await share(h.ana, 'vic@example.test', 'admin')).status, 200);
    assert.equal((await h.templates(h.viewer))[0].myRole, 'viewer');
    assert.equal((await h.post(`/api/templates/${id}/shares`, h.viewer, { email: 'dee@example.test', role: 'viewer' })).status, 403);
    assert.equal((await h.post(`/api/templates/${id}/shares/delete`, h.viewer, { email: 'bo@example.test' })).status, 403, 'a viewer removes only themselves');
    assert.deepEqual(await (await h.post(`/api/templates/${id}/shares/delete`, h.viewer, { email: 'vic@example.test' })).json(), { id, removed: true });
    // Refused: an API client's address, the owner's own, an unknown role or field.
    for (const bad of [{ email: `${CLIENT}@service-accounts.invalid`, role: 'viewer' }, { email: 'x@example.test', role: 'owner' }, { email: 'x@example.test', role: 'viewer', note: 1 }]) assert.equal((await h.post(`/api/templates/${id}/shares`, h.ana, bad)).status, 422, JSON.stringify(bad));
    assert.deepEqual(await (await share(h.ana, 'ana@example.test', 'viewer')).json(), { error: 'owner_not_shared' });
    // Unsharing: an admin removes anyone; anyone removes themselves, and no longer sees it.
    assert.equal((await h.post(`/api/templates/${id}/shares/delete`, h.cy, { email: 'bo@example.test' })).status, 200);
    assert.deepEqual(await (await h.post(`/api/templates/${id}/shares/delete`, h.cy, { email: 'cy@example.test' })).json(), { id, removed: true });
    assert.equal((await h.req(`/api/templates/${id}`, h.cy)).status, 404);
    assert.equal((await h.post(`/api/templates/${id}/shares/delete`, h.ana, { email: 'nobody@example.test' })).status, 404);
    // An envelope's editor voids it; its viewer can't.
    await h.post(`/api/envelopes/${envelope}/shares`, h.bo, { email: 'ana@example.test', role: 'viewer' });
    assert.equal((await h.post(`/api/envelopes/${envelope}/void`, h.ana, {})).status, 403);
    assert.equal((await h.req(`/api/envelopes/${envelope}/audit`, h.ana)).status, 200);
    await h.post(`/api/envelopes/${envelope}/shares`, h.bo, { email: 'ana@example.test', role: 'editor' });
    assert.equal((await h.post(`/api/envelopes/${envelope}/void`, h.ana, {})).status, 200);
  } finally { await h.mf.dispose(); }
});

test('a new document is shared with whom its request names, the owner left out and each person once, at their highest role', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana, { share: [{ email: 'bo@example.test', role: 'viewer' }, { email: 'Bo@example.test', role: 'editor' }, { email: 'ana@example.test', role: 'admin' }] });
    const sharing = await h.get<{ shares: { email: string; role: string }[] }>(`/api/templates/${id}/shares`, h.ana);
    assert.deepEqual(sharing.shares.map(s => [s.email, s.role]), [['bo@example.test', 'editor']]);
    const envelope = await h.envelope(h.ana, id, { share: [{ email: 'cy@example.test', role: 'viewer' }] });
    assert.deepEqual((await h.get<{ shares: { email: string }[] }>(`/api/envelopes/${envelope}/shares`, h.cy)).shares.map(s => s.email), ['cy@example.test']);
    for (const share of [[{ email: 'x' }], [{ email: 'x@example.test', role: 'owner' }], 'nope']) assert.equal((await h.send(h.ana, id, { share })).status, 422, JSON.stringify(share));
  } finally { await h.mf.dispose(); }
});

test('tags are each person\'s own: set on anything they see, filtered by, suggested, and carried from a template to an envelope', async () => {
  const h = await setup();
  try {
    const nda = await h.template(h.ana, { tags: ['NDA', 'partners', 'nda'] });
    const msa = await h.template(h.ana, { tags: ['MSA', 'Partners'] });
    await h.post(`/api/templates/${nda}/shares`, h.ana, { email: 'bo@example.test', role: 'viewer' });
    assert.deepEqual((await h.templates(h.ana)).map(t => [t.id, t.tags]), [[msa, ['MSA', 'Partners']], [nda, ['NDA', 'partners']]]);
    // Bo sees the template, not Ana's tags; a viewer tags for themselves, even one who may only view Esign.
    assert.deepEqual((await h.templates(h.bo))[0].tags, []);
    assert.deepEqual(await (await h.post(`/api/templates/${nda}/tags`, h.bo, { tags: ['legal'] })).json(), { id: nda, tags: ['legal'] });
    assert.deepEqual((await h.templates(h.ana)).find(t => t.id === nda)!.tags, ['NDA', 'partners']);
    await h.post(`/api/templates/${nda}/shares`, h.ana, { email: 'vic@example.test', role: 'viewer' });
    assert.equal((await h.post(`/api/templates/${nda}/tags`, h.viewer, { tags: ['mine'] })).status, 200);
    // Filtering: every tag asked for, compared case-insensitively.
    assert.deepEqual((await h.templates(h.ana, '?tag=partners')).map(t => t.id), [msa, nda]);
    assert.deepEqual((await h.templates(h.ana, '?tag=PARTNERS&tag=nda')).map(t => t.id), [nda]);
    assert.deepEqual(await h.templates(h.bo, '?tag=nda'), []);
    assert.equal((await h.req('/api/templates?tag=a&tag=b&tag=c&tag=d&tag=e&tag=f', h.ana)).status, 400);
    // An envelope gets the request's tags and the sender's on the template.
    const envelope = await h.envelope(h.ana, nda, { tags: ['Q3'] });
    assert.deepEqual((await h.envelopes(h.ana, '?tag=nda'))[0].tags, ['NDA', 'partners', 'Q3']);
    assert.equal((await h.envelopes(h.ana, '?tag=q3'))[0].id, envelope);
    // Suggestions: the caller's own tags, most used first.
    assert.deepEqual((await h.get<{ tags: { tag: string; uses: number }[] }>('/api/tags', h.ana)).tags.slice(0, 2), [{ tag: 'Partners', uses: 3 }, { tag: 'NDA', uses: 2 }]);
    assert.deepEqual((await h.get<{ tags: { tag: string }[] }>('/api/tags?q=q', h.ana)).tags.map(t => t.tag), ['Q3']);
    assert.deepEqual((await h.get<{ tags: { tag: string }[] }>('/api/tags', h.bo)).tags.map(t => t.tag), ['legal']);
    // Refused: too many, too long, not strings; on a document the caller can't see.
    for (const tags of [Array.from({ length: 21 }, (_, i) => `t${i}`), ['x'.repeat(51)], [1], 'nda']) assert.equal((await h.post(`/api/templates/${nda}/tags`, h.ana, { tags })).status, 422, JSON.stringify(tags));
    assert.equal((await h.post(`/api/templates/${msa}/tags`, h.bo, { tags: ['x'] })).status, 404);
  } finally { await h.mf.dispose(); }
});

test('an API client\'s documents are its own until Esign\'s settings name someone, who is then given them as admin', async () => {
  const h = await setup();
  try {
    const early = await h.template(h.host);
    assert.deepEqual((await h.templates(h.host))[0].owner, { id: CLIENT, kind: 'client', name: 'Host product' });
    assert.deepEqual(await h.templates(h.ana), []);
    // The client shows up in the settings once it has called; organization owners and admins choose its person.
    assert.equal((await h.req('/api/api-clients', h.ana)).status, 403);
    const listed = await h.get<{ clients: { id: string; name: string; shareWith?: unknown }[] }>('/api/api-clients', h.owner);
    assert.deepEqual(listed.clients.map(c => [c.id, c.name, c.shareWith]), [[CLIENT, 'Host product', undefined]]);
    assert.equal((await h.post(`/api/api-clients/${CLIENT}`, h.ana, { shareEmail: 'ana@example.test' })).status, 403);
    assert.equal((await h.post('/api/api-clients/user-ana', h.owner, { shareEmail: 'ana@example.test' })).status, 404, 'a person is not an API client');
    assert.equal((await h.post(`/api/api-clients/${CLIENT}`, h.owner, { shareEmail: `${CLIENT}@service-accounts.invalid` })).status, 422);
    const set = await h.post(`/api/api-clients/${CLIENT}`, h.owner, { shareEmail: 'ana@example.test' });
    assert.deepEqual(await set.json(), { id: CLIENT, shareWith: { email: 'ana@example.test' }, shared: 0 });
    // New documents are shared with Ana as admin; the earlier one only once asked to.
    const later = await h.template(h.host);
    const envelope = await h.envelope(h.host, later, { share: [{ email: 'bo@example.test', role: 'viewer' }] });
    assert.deepEqual((await h.templates(h.ana)).map(t => [t.id, t.myRole]), [[later, 'admin']]);
    assert.deepEqual((await h.get<{ shares: { email: string; role: string }[] }>(`/api/envelopes/${envelope}/shares`, h.ana)).shares.map(s => [s.email, s.role]), [['ana@example.test', 'admin'], ['bo@example.test', 'viewer']]);
    const again = await h.post(`/api/api-clients/${CLIENT}`, h.owner, { shareEmail: 'ana@example.test', shareExisting: true });
    assert.deepEqual((await again.json() as { shared: number }).shared, 3);
    assert.deepEqual((await h.templates(h.ana)).map(t => t.id).sort(), [early, later].sort());
    const client = (await h.get<{ clients: { shareWith?: { email: string; name?: string } }[] }>('/api/api-clients', h.owner)).clients[0];
    assert.deepEqual([client.shareWith?.email, client.shareWith?.name], ['ana@example.test', 'Synthetic Member']);
    // Nobody: new documents are the client's alone again.
    await h.post(`/api/api-clients/${CLIENT}`, h.owner, { shareEmail: null });
    const alone = await h.template(h.host);
    assert.equal((await h.templates(h.ana)).some(t => t.id === alone), false);
  } finally { await h.mf.dispose(); }
});

test('an organization owner takes over everything someone owns; shares stay', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana, { share: [{ email: 'bo@example.test', role: 'editor' }, { email: 'olga@example.test', role: 'viewer' }] });
    const envelope = await h.envelope(h.ana, id);
    await h.template(h.host);
    assert.equal((await h.req('/api/owners', h.ana)).status, 403);
    const owners = (await h.get<{ owners: { id: string; kind: string; templates: number; envelopes: number }[] }>('/api/owners', h.owner)).owners;
    assert.deepEqual(owners.map(o => [o.id, o.kind, o.templates, o.envelopes]).sort(), [[CLIENT, 'client', 1, 0], ['user-ana', 'person', 1, 1]]);
    assert.equal((await h.post('/api/owners/user-ana/transfer', h.bo, {})).status, 403);
    assert.equal((await h.post('/api/owners/user-olga/transfer', h.owner, {})).status, 422);
    assert.equal((await h.post('/api/owners/nobody/transfer', h.owner, {})).status, 404);
    assert.deepEqual(await (await h.post('/api/owners/user-ana/transfer', h.owner, {})).json(), { from: 'user-ana', to: 'user-olga', templates: 1, envelopes: 1 });
    assert.deepEqual((await h.templates(h.owner)).map(t => [t.id, t.myRole]), [[id, 'owner']]);
    assert.equal((await h.envelopes(h.owner))[0].id, envelope);
    assert.deepEqual(await h.templates(h.ana), [], 'the former owner keeps nothing');
    const sharing = await h.get<{ owner: { id: string }; shares: { email: string; role: string }[] }>(`/api/templates/${id}/shares`, h.bo);
    assert.deepEqual([sharing.owner.id, sharing.shares.map(s => [s.email, s.role])], ['user-olga', [['bo@example.test', 'editor']]], 'the new owner\'s own share is gone');
  } finally { await h.mf.dispose(); }
});

test('a contact\'s envelopes are those the caller sees', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana);
    await h.envelope(h.ana, id);
    const [contact] = (await h.get<{ contacts: { id: string }[] }>('/api/contacts', h.bo)).contacts;
    assert.deepEqual((await h.get<{ envelopes: unknown[] }>(`/api/contacts/${contact.id}`, h.ana)).envelopes.length, 1);
    assert.deepEqual((await h.get<{ envelopes: unknown[] }>(`/api/contacts/${contact.id}`, h.bo)).envelopes, []);
  } finally { await h.mf.dispose(); }
});

test('the catalog lists the settings endpoints only to the organization roles that may call them', async () => {
  const h = await setup();
  try {
    const paths = async (headers: Record<string, string>) => (await h.get<{ endpoints: { method: string; path: string }[] }>('/api/catalog', headers)).endpoints.map(e => `${e.method} ${e.path}`);
    const owner = await paths(h.owner), editor = await paths(h.ana), admin = await paths(h.host);
    assert.ok(owner.includes('POST /api/owners/{id}/transfer') && owner.includes('POST /api/api-clients/{id}'));
    assert.ok(!editor.includes('GET /api/owners') && !editor.includes('GET /api/api-clients') && editor.includes('POST /api/templates/{id}/shares'));
    assert.ok(admin.includes('GET /api/api-clients') && !admin.includes('GET /api/owners'));
  } finally { await h.mf.dispose(); }
});

test('an edited copy is of a template the caller sees, and is theirs, with the shares they ask for and their tags', async () => {
  const h = await setup();
  try {
    const source = await h.template(h.ana, { tags: ['NDA'] });
    const open = (headers: Record<string, string>, extra: Record<string, unknown> = {}) => h.post('/api/template-editing-sessions', headers, { allowedParentOrigin: HOST, sourceTemplateId: source, ...extra });
    assert.equal((await open(h.bo)).status, 404, 'a template Bo can\'t see');
    assert.equal((await open(h.ana, { share: [{ email: 'bo@example.test', role: 'boss' }] })).status, 422);
    const session = await (await open(h.ana, { tags: ['v2'], share: [{ email: 'bo@example.test', role: 'viewer' }] })).json() as { sessionId: string; url: string };
    // Only whoever opened it reads it.
    assert.equal((await h.req(`/api/template-editing-sessions/${session.sessionId}`, h.bo)).status, 404);
    const exchanged = await h.req('/api/public/editor/exchange', {}, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ pageId: session.sessionId, code: new URL(session.url).hash.slice(1), embedded: true, embedder: HOST }) });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const form = new FormData(); form.set('roles', JSON.stringify(['partner']));
    form.set('fields', JSON.stringify([{ id: 'f1', type: 'Signature', role: 'partner', page: 1, required: true, rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } }]));
    const saved = await h.req('/api/public/editor/save', { 'x-esign-session': (await exchanged.json() as { token: string }).token, origin: ORIGIN }, { method: 'POST', body: form });
    assert.equal(saved.status, 201, await saved.clone().text());
    const { id } = await saved.json() as { id: string };
    const copy = (await h.templates(h.ana)).find(t => t.id === id)!;
    assert.deepEqual([copy.myRole, copy.tags], ['owner', ['NDA', 'v2']]);
    assert.deepEqual((await h.templates(h.bo)).map(t => [t.id, t.myRole]), [[id, 'viewer']], 'the copy is shared as asked; the source is not');
    assert.equal((await h.get<{ templateId: string }>(`/api/template-editing-sessions/${session.sessionId}`, h.ana)).templateId, id);
  } finally { await h.mf.dispose(); }
});
