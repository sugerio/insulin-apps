// Who sees and changes a template or an envelope (ownership.ts, tags.ts, members.ts): its owner, and those it is
// shared with, by email, as admin, editor or viewer, or with everyone in the organization; never anyone else, the organization's owners and admins
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
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), TRUST_ORG_ROLE: true };
  // People of the organization, in the browser; and the host's API client, by its key.
  const person = (name: string, options: Identity = {}) => identity('tenant', { userId: `user-${name}`, email: `${name}@example.test`, role: 'EDITOR', ...options });
  // As the gateway sends them: an organization owner or admin is an Admin in every app, and says so in x-suger-org-role.
  const ana = person('ana', { orgRole: 'EDITOR' }), bo = person('bo', { orgRole: 'EDITOR' }), cy = person('cy', { orgRole: 'EDITOR' }), viewer = person('vic', { role: 'VIEWER', orgRole: 'VIEWER' });
  const owner = person('olga', { role: 'ADMIN', orgRole: 'OWNER' }), admin = person('ada', { role: 'ADMIN', orgRole: 'ADMIN' });
  // An Admin of Esign by a specific-apps grant: an admin in the app, not of the organization.
  const appAdmin = person('gus', { role: 'ADMIN', orgRole: 'APPS' });
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
  return { mf, db, env, req, post, get, template, send, envelope, templates, envelopes, ana, bo, cy, owner, admin, appAdmin, viewer, host };
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

test('shared with everyone in the organization: every person of it sees it at that role, or higher by email; API clients don\'t', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana);
    const everyone = (by: Record<string, string>, role: string) => h.post(`/api/templates/${id}/shares`, by, { organization: true, role });
    type Sharing = { organization?: { role: string; sharedAt: number }; shares: { email: string }[] };
    const answer = await everyone(h.ana, 'viewer');
    assert.equal(answer.status, 200, await answer.clone().text());
    const shared = await answer.json() as Sharing;
    assert.deepEqual([shared.organization?.role, shared.shares], ['viewer', []], 'everyone is not one of the people');
    // Every person of the organization, its owners and those who may only view Esign too, sees it as a viewer.
    for (const person of [h.bo, h.cy, h.owner, h.viewer]) {
      const [seen] = await h.templates(person);
      assert.deepEqual([seen?.id, seen?.myRole], [id, 'viewer']);
      assert.deepEqual((await h.templates(person, '?scope=shared')).map(t => t.id), [id]);
    }
    assert.deepEqual((await h.templates(h.ana, '?scope=shared')).map(t => t.id), [], 'not shared with its owner');
    assert.deepEqual((await h.templates(h.ana, '?scope=mine')).map(t => t.id), [id]);
    // An API client sees what it owns or is shared by email, never what is shared with everyone; another organization neither.
    assert.deepEqual(await h.templates(h.host), []);
    assert.equal((await h.req(`/api/templates/${id}`, h.host)).status, 404);
    assert.deepEqual(await h.templates(identity('other', { userId: 'user-zed', email: 'zed@example.test', role: 'EDITOR' })), []);
    // A viewer sends from it, and changes nothing; as editor, everyone changes it; someone shared by email keeps a higher role.
    await h.envelope(h.bo, id);
    assert.equal((await h.post(`/api/templates/${id}/default-signers`, h.cy, { defaultSigners: {} })).status, 403);
    await h.post(`/api/templates/${id}/shares`, h.ana, { email: 'bo@example.test', role: 'admin' });
    assert.equal((await everyone(h.ana, 'editor')).status, 200);
    assert.equal((await h.post(`/api/templates/${id}/default-signers`, h.cy, { defaultSigners: {} })).status, 200);
    assert.deepEqual([(await h.templates(h.bo))[0].myRole, (await h.templates(h.cy))[0].myRole, (await h.templates(h.viewer))[0].myRole], ['admin', 'editor', 'viewer']);
    // Only admins share with everyone or stop, and never as admin.
    assert.equal((await everyone(h.cy, 'viewer')).status, 403);
    assert.equal((await h.post(`/api/templates/${id}/shares/delete`, h.cy, { organization: true })).status, 403);
    for (const bad of [{ organization: true, role: 'admin' }, { organization: false, role: 'viewer' }, { organization: true, email: 'x@example.test', role: 'viewer' }]) assert.equal((await h.post(`/api/templates/${id}/shares`, h.ana, bad)).status, 422, JSON.stringify(bad));
    assert.equal((await h.post(`/api/templates/${id}/shares/delete`, h.ana, { organization: true, email: 'bo@example.test' })).status, 422);
    const stopped = await (await h.post(`/api/templates/${id}/shares/delete`, h.bo, { organization: true })).json() as Sharing;
    assert.deepEqual([stopped.organization, stopped.shares.map(s => s.email)], [undefined, ['bo@example.test']]);
    assert.equal((await h.req(`/api/templates/${id}`, h.cy)).status, 404, 'no longer seen');
    assert.equal((await h.post(`/api/templates/${id}/shares/delete`, h.ana, { organization: true })).status, 404);
    // On a new document's request: once, at the highest role asked; never as admin.
    const asked = await h.template(h.ana, { share: [{ organization: true, role: 'viewer' }, { organization: true, role: 'editor' }] });
    assert.equal((await h.get<Sharing>(`/api/templates/${asked}/shares`, h.cy)).organization?.role, 'editor');
    const sent = await h.envelope(h.ana, asked, { share: [{ organization: true, role: 'viewer' }] });
    assert.deepEqual((await h.envelopes(h.cy)).map(e => [e.id, e.myRole]), [[sent, 'viewer']]);
    assert.equal((await h.send(h.ana, asked, { share: [{ organization: true, role: 'admin' }] })).status, 422);
  } finally { await h.mf.dispose(); }
});

test('a template\'s PDF and details are read by those who see it, for its page', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana);
    await h.db.prepare('UPDATE templates SET fields_json = ? WHERE id = ?').bind(JSON.stringify([
      { id: 'sig', type: 'Signature', role: 'partner', page: 1, required: true, rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.05 } },
      { id: 'title', type: 'Title', role: 'partner', page: 1, required: false, rect: { x: 0.1, y: 0.8, width: 0.3, height: 0.04 } },
    ]), id).run();
    const details = await h.get<{ createdAt: number; fields: { type: string; required: boolean; rect: unknown }[] }>(`/api/templates/${id}`, h.ana);
    assert.ok(details.createdAt > 0);
    assert.deepEqual(details.fields.map(f => [f.type, f.required]), [['Signature', true], ['Title', false]], 'whether each must be filled');
    assert.equal(Object.hasOwn((await h.templates(h.ana))[0].fields[0] as object, 'required'), false, 'lists keep their fields as before');
    const pdf = await h.req(`/api/templates/${id}/pdf`, h.ana);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('cache-control'), 'no-store');
    assert.equal(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5)), '%PDF-', 'the PDF as uploaded');
    // Not seen: as one that doesn't exist. Shared, even with everyone: read.
    assert.equal((await h.req(`/api/templates/${id}/pdf`, h.bo)).status, 404);
    assert.equal((await h.req(`/api/templates/${id}/pdf`, h.host)).status, 404);
    await h.post(`/api/templates/${id}/shares`, h.ana, { organization: true, role: 'viewer' });
    assert.equal((await h.req(`/api/templates/${id}/pdf`, h.viewer)).status, 200);
    assert.equal((await h.req('/api/templates/00000000-0000-4000-8000-000000000000/pdf', h.ana)).status, 404);
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

test('an API client\'s documents are seen, as admins, by the people its settings name, for as long as they are named', async () => {
  const h = await setup();
  try {
    const early = await h.template(h.host);
    assert.deepEqual((await h.templates(h.host))[0].owner, { id: CLIENT, kind: 'client', name: 'Host product' });
    assert.deepEqual(await h.templates(h.ana), []);
    // Esign's page for the client (linked from the platform's API access page) reads and saves them: organization
    // owners and admins, in the browser only.
    type Settings = { id: string; name?: string; people: { email: string; name?: string }[] };
    const settings = (headers: Record<string, string>, id = CLIENT, name = 'Host product') => h.req(`/api/client-settings/${id}?name=${encodeURIComponent(name)}`, headers);
    const save = (headers: Record<string, string>, people: unknown, id = CLIENT) => h.post(`/api/client-settings/${id}`, headers, { people });
    for (const who of [h.ana, h.host, h.appAdmin]) assert.equal((await settings(who)).status, 403);
    assert.equal((await save(h.appAdmin, ['gus@example.test'])).status, 403, 'an Admin of Esign by grant is no organization admin');
    // The organization role counts only when the deploy says the gateway sends it, and never an API client's.
    const untrusted = (path: string, headers: Record<string, string>) => app.fetch(new Request(ORIGIN + path, { headers }), { ...h.env, TRUST_ORG_ROLE: false });
    assert.equal((await untrusted(`/api/client-settings/${CLIENT}`, h.owner)).status, 403);
    assert.equal((await settings(identity('tenant', { userId: 'sa-forged', role: 'ADMIN', orgRole: 'OWNER', via: 'api' }))).status, 403);
    assert.equal((await settings(h.admin)).status, 200, 'an organization admin');
    assert.deepEqual(await (await settings(h.owner)).json(), { id: CLIENT, name: 'Host product', people: [] });
    assert.equal((await settings(h.owner, 'user-ana')).status, 404, 'a person is not an API client');
    for (const bad of [[`${CLIENT}@service-accounts.invalid`], ['not an email'], Array.from({ length: 51 }, (_, i) => `p${i}@example.test`), 'ana@example.test']) assert.equal((await save(h.owner, bad)).status, 422);
    assert.equal((await h.post(`/api/client-settings/${CLIENT}`, h.owner, { people: [], extra: 1 })).status, 422);
    assert.equal((await save(h.ana, ['ana@example.test'])).status, 403);
    // Named: everything it owns, before and after, is theirs to see as admins, at once. Without the platform to ask
    // (directory.ts), only people Esign has seen can be named.
    assert.deepEqual([(await save(h.owner, ['vic@example.test'])).status], [422], 'never seen');
    await h.req('/api/me', h.viewer);
    const saved = await (await save(h.owner, ['Ana@example.test', 'vic@example.test', 'ana@example.test'])).json() as Settings;
    assert.deepEqual(saved.people, [{ email: 'Ana@example.test', name: 'Synthetic Member' }, { email: 'vic@example.test', name: 'Synthetic Member' }], 'each person once, as first spelled, with the name Esign knows');
    const later = await h.template(h.host);
    const envelope = await h.envelope(h.host, later, { share: [{ email: 'bo@example.test', role: 'viewer' }] });
    assert.deepEqual((await h.templates(h.ana)).map(t => [t.id, t.myRole]).sort(), [[early, 'admin'], [later, 'admin']].sort());
    assert.deepEqual((await h.templates(h.ana, '?scope=shared')).map(t => t.id).sort(), [early, later].sort());
    assert.deepEqual((await h.envelopes(h.ana)).map(e => [e.id, e.myRole]), [[envelope, 'admin']]);
    assert.equal((await h.post(`/api/envelopes/${envelope}/shares`, h.ana, { email: 'cy@example.test', role: 'viewer' })).status, 200, 'an admin shares it');
    assert.equal((await h.templates(h.viewer)).every(t => t.myRole === 'viewer'), true, 'capped for someone who may only view');
    // Who sees it says so; the client itself sees only what it owns.
    const sharing = await h.get<{ client?: { people: { email: string; name?: string }[] }; shares: { email: string }[] }>(`/api/envelopes/${envelope}/shares`, h.ana);
    assert.deepEqual([sharing.client?.people.map(p => [p.email, p.name]), sharing.shares.map(s => s.email)], [[['Ana@example.test', 'Synthetic Member'], ['vic@example.test', 'Synthetic Member']], ['bo@example.test', 'cy@example.test']]);
    assert.deepEqual((await (await settings(h.owner)).json() as Settings).people.map(p => p.email), ['Ana@example.test', 'vic@example.test']);
    // Not named any more: no longer seen, at once; documents shared by hand stay so.
    await save(h.owner, ['vic@example.test']);
    assert.deepEqual(await h.templates(h.ana), []);
    assert.equal((await h.req(`/api/envelopes/${envelope}`, h.cy)).status, 200);
    await save(h.owner, []);
    assert.deepEqual(await h.templates(h.viewer), []);
    // A client that hasn't called Esign yet is named as the page gives it, and can be set ahead.
    assert.deepEqual(await (await settings(h.owner, 'sa-new', 'New program')).json(), { id: 'sa-new', name: 'New program', people: [] });
    assert.equal((await save(h.owner, ['ana@example.test'], 'sa-new')).status, 200);
    // An id that turns out to be a person's (they hadn't used Esign yet) never shows that person's documents to the list.
    assert.equal((await settings(h.owner, 'user-dee', 'Not a client')).status, 200);
    assert.equal((await save(h.owner, ['olga@example.test'], 'user-dee')).status, 200);
    const dee = identity('tenant', { userId: 'user-dee', email: 'dee@example.test', role: 'EDITOR' });
    const own = await h.template(dee);
    assert.ok(!(await h.templates(h.owner)).some(t => t.id === own), "the person's template stays theirs");
    assert.equal((await h.req(`/api/templates/${own}`, h.owner)).status, 404);
    assert.equal((await settings(h.owner, 'user-dee')).status, 404, 'a person now');
  } finally { await h.mf.dispose(); }
});

test('an editor of a draft saves and sends it as it is shared: sharing it more is for its admins and owner', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana, { share: [{ email: 'bo@example.test', role: 'viewer' }] });
    const created = await h.post('/api/envelopes', h.ana, { draft: true, templateId: id, share: [{ email: 'bo@example.test', role: 'editor' }] }, { 'idempotency-key': crypto.randomUUID() });
    assert.equal(created.status, 201, await created.clone().text());
    const draft = (await created.json() as { id: string }).id;
    const recipients = [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }];
    for (const share of [[{ email: 'cy@example.test', role: 'admin' }], [{ organization: true, role: 'editor' }]]) {
      assert.equal((await h.post(`/api/envelopes/${draft}`, h.bo, { draft: true, templateId: id, recipients, share })).status, 403, 'saving it');
      assert.equal((await h.post(`/api/envelopes/${draft}`, h.bo, { templateId: id, recipients, share })).status, 403, 'sending it');
    }
    assert.equal((await h.req(`/api/envelopes/${draft}`, h.cy)).status, 404, 'nobody else sees it');
    assert.equal((await h.post(`/api/envelopes/${draft}`, h.bo, { draft: true, templateId: id, recipients })).status, 200, 'saved as it is shared');
    assert.equal((await h.post(`/api/envelopes/${draft}`, h.ana, { draft: true, templateId: id, recipients, share: [{ email: 'cy@example.test', role: 'viewer' }] })).status, 200, 'its owner shares it');
    assert.equal((await h.req(`/api/envelopes/${draft}`, h.cy)).status, 200);
  } finally { await h.mf.dispose(); }
});

test('a draft save that is refused shares nothing and tags nothing', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana);
    const recipients = [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }];
    // A draft begun as an upload stays one: saved with a template, it is refused.
    const created = await h.post('/api/envelopes', h.ana, { draft: true, recipients, tags: ['kept'] }, { 'idempotency-key': crypto.randomUUID() });
    const draft = (await created.json() as { id: string }).id;
    const refused = await h.post(`/api/envelopes/${draft}`, h.ana, { draft: true, templateId: id, recipients, tags: ['replaced'], share: [{ email: 'cy@example.test', role: 'viewer' }] });
    assert.equal(refused.status, 409);
    assert.equal((await h.req(`/api/envelopes/${draft}`, h.cy)).status, 404, 'not shared');
    assert.deepEqual((await h.envelopes(h.ana, '?status=DRAFT')).find(e => e.id === draft)?.tags, ['kept'], 'its tags as they were');
  } finally { await h.mf.dispose(); }
});

test('a draft sent without tags keeps the sender\'s tags on it', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana);
    const recipients = [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }];
    const created = await h.post('/api/envelopes', h.ana, { draft: true, templateId: id, recipients }, { 'idempotency-key': crypto.randomUUID() });
    const draft = (await created.json() as { id: string }).id;
    assert.equal((await h.post(`/api/envelopes/${draft}/tags`, h.ana, { tags: ['From the menu'] })).status, 200);
    assert.equal((await h.post(`/api/envelopes/${draft}`, h.ana, { templateId: id, recipients })).status, 200);
    assert.deepEqual((await h.envelopes(h.ana)).find(e => e.id === draft)?.tags, ['From the menu']);
  } finally { await h.mf.dispose(); }
});

test('pages follow `next` to the end: documents made in the same millisecond are each listed once', async () => {
  const h = await setup();
  try {
    const templates = [await h.template(h.ana), await h.template(h.ana), await h.template(h.ana)];
    const envelopes = [await h.envelope(h.ana, templates[0]), await h.envelope(h.ana, templates[0]), await h.envelope(h.ana, templates[0])];
    await h.db.batch([h.db.prepare('UPDATE templates SET created_at = 1700000000000'), h.db.prepare('UPDATE envelopes SET created_at = 1700000000000')]);
    for (const [kind, made] of [['templates', templates], ['envelopes', envelopes]] as const) {
      const seen: string[] = [];
      let next: string | undefined, pages = 0;
      do {
        const page = await h.get<Record<string, Listed[]> & { next?: string }>(`/api/${kind}?limit=1${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, h.ana);
        seen.push(...page[kind]!.map((d) => d.id));
        next = page.next;
      } while (next && ++pages < 10);
      assert.deepEqual(seen.sort(), [...made].sort(), kind);
    }
    assert.equal((await h.req('/api/templates?cursor=nonsense', h.ana)).status, 400);
  } finally { await h.mf.dispose(); }
});

test('an organization owner takes over everything someone owns; shares stay', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana, { share: [{ email: 'bo@example.test', role: 'editor' }, { email: 'olga@example.test', role: 'viewer' }] });
    const envelope = await h.envelope(h.ana, id);
    await h.template(h.host);
    for (const who of [h.ana, h.admin, h.appAdmin]) assert.equal((await h.req('/api/owners', who)).status, 403, 'organization owners only');
    const owners = (await h.get<{ owners: { id: string; kind: string; templates: number; envelopes: number }[] }>('/api/owners', h.owner)).owners;
    assert.deepEqual(owners.map(o => [o.id, o.kind, o.templates, o.envelopes]).sort(), [[CLIENT, 'client', 1, 0], ['user-ana', 'person', 1, 1]]);
    for (const who of [h.bo, h.admin, h.appAdmin]) assert.equal((await h.post('/api/owners/user-ana/transfer', who, {})).status, 403);
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
    assert.ok(owner.includes('POST /api/owners/{id}/transfer'));
    assert.ok(!editor.includes('GET /api/owners') && editor.includes('POST /api/templates/{id}/shares'));
    assert.ok(!admin.includes('GET /api/owners'));
    assert.ok(![...owner, ...admin].some(p => p.includes('/api/client-settings')), 'the platform\'s, not in the catalog');
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

test('a template is renamed by its editors and deleted by its admins; envelopes sent from it keep it', async () => {
  const h = await setup();
  try {
    const id = await h.template(h.ana, { share: [{ email: 'bo@example.test', role: 'editor' }, { email: 'cy@example.test', role: 'viewer' }] });
    const envelope = await h.envelope(h.ana, id);
    assert.equal((await h.post(`/api/templates/${id}`, h.cy, { name: 'Renamed' })).status, 403, 'a viewer doesn\'t rename');
    assert.deepEqual(await (await h.post(`/api/templates/${id}`, h.bo, { name: ' Mutual NDA v2 ' })).json(), { id, name: 'Mutual NDA v2' });
    assert.equal((await h.templates(h.cy))[0].id, id);
    for (const bad of [{}, { name: 'x'.repeat(201) }, { name: 'N', extra: 1 }]) assert.equal((await h.post(`/api/templates/${id}`, h.bo, bad)).status, 422, JSON.stringify(bad));
    assert.equal((await h.post(`/api/templates/${id}/delete`, h.bo, {})).status, 403, 'an editor doesn\'t delete');
    assert.deepEqual(await (await h.post(`/api/templates/${id}/delete`, h.ana, {})).json(), { id, deleted: true });
    for (const who of [h.ana, h.bo, h.cy]) assert.deepEqual(await h.templates(who), []);
    // Archived: off the lists only. By its id, as a host that keeps it uses it, it is read, sent from and renamed as before.
    assert.equal(typeof (await h.get<{ archivedAt?: number }>(`/api/templates/${id}`, h.cy)).archivedAt, 'number');
    assert.equal((await h.send(h.ana, id)).status, 201, 'sent from by its id');
    assert.equal((await h.post(`/api/templates/${id}`, h.ana, { name: 'Again' })).status, 200);
    assert.deepEqual(await h.envelopes(h.cy), [], 'the envelopes are its sender\'s, as ever');
    assert.equal((await h.req(`/api/envelopes/${envelope}`, h.ana)).status, 200, 'the envelope sent from it is kept');
  } finally { await h.mf.dispose(); }
});

test('editing a template\'s fields saves a new version that replaces it, with its owner, name, shares and everyone\'s tags', async () => {
  const h = await setup();
  try {
    const source = await h.template(h.ana, { tags: ['NDA'], share: [{ email: 'bo@example.test', role: 'editor' }, { email: 'cy@example.test', role: 'viewer' }] });
    await h.post(`/api/templates/${source}`, h.ana, { name: 'Mutual NDA' });
    await h.post(`/api/templates/${source}/tags`, h.bo, { tags: ['legal'] });
    const sent = await h.envelope(h.ana, source);
    const open = (who: Record<string, string>, extra: Record<string, unknown> = {}, from = source) => h.post('/api/template-editing-sessions', who, { allowedParentOrigin: HOST, sourceTemplateId: from, replace: true, ...extra });
    assert.equal((await open(h.cy)).status, 403, 'a viewer copies, but doesn\'t replace');
    assert.equal((await h.post('/api/template-editing-sessions', h.bo, { allowedParentOrigin: HOST, replace: true })).status, 422, 'replace needs a source');
    /** A session opened to replace `from`: its save. */
    const opened = async (who: Record<string, string>, from = source) => {
      const session = await (await open(who, {}, from)).json() as { sessionId: string; url: string };
      const exchanged = await h.req('/api/public/editor/exchange', {}, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ pageId: session.sessionId, code: new URL(session.url).hash.slice(1), embedded: true, embedder: HOST }) });
      const token = (await exchanged.json() as { token: string }).token;
      return () => {
        const form = new FormData(); form.set('roles', JSON.stringify(['partner']));
        form.set('fields', JSON.stringify([{ id: 'f1', type: 'Signature', role: 'partner', page: 1, required: true, rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } }]));
        return h.req('/api/public/editor/save', { 'x-esign-session': token, origin: ORIGIN }, { method: 'POST', body: form });
      };
    };
    const saved = await (await opened(h.bo))();
    assert.equal(saved.status, 201, await saved.clone().text());
    const { id } = await saved.json() as { id: string };
    // Listed in its place, Ana's still, with the same name, people and tags.
    const [current] = await h.templates(h.ana);
    assert.deepEqual([(await h.templates(h.ana)).length, current.id, current.owner.id, current.myRole, current.tags, (current as unknown as { name: string }).name], [1, id, 'user-ana', 'owner', ['NDA'], 'Mutual NDA']);
    assert.deepEqual((await h.templates(h.bo)).map(t => [t.id, t.myRole, t.tags]), [[id, 'editor', ['legal']]]);
    assert.deepEqual((await h.get<{ shares: { email: string; role: string }[] }>(`/api/templates/${id}/shares`, h.ana)).shares.map(s => [s.email, s.role]), [['bo@example.test', 'editor'], ['cy@example.test', 'viewer']]);
    // The earlier version is archived: off the lists, but by its id still read and sent from, for a host that keeps it.
    assert.equal(typeof (await h.get<{ archivedAt?: number }>(`/api/templates/${source}`, h.cy)).archivedAt, 'number');
    assert.equal((await h.req(`/api/envelopes/${sent}`, h.ana)).status, 200);
    assert.equal((await h.send(h.ana, source)).status, 201);
    // Only the current version is replaced: not an earlier one, nor one another session replaced meanwhile.
    assert.equal((await open(h.bo)).status, 409, 'the earlier version');
    const first = await opened(h.bo, id), second = await opened(h.ana, id);
    assert.equal((await first()).status, 201);
    assert.equal((await second()).status, 409, 'replaced meanwhile');
    assert.equal((await h.templates(h.ana)).length, 1, 'one current version');
  } finally { await h.mf.dispose(); }
});

test('the envelope list searches, filters by date, statuses and quick views, and says who signs, how far along and when it changed', async () => {
  const h = await setup();
  try {
    const template = await h.template(h.ana);
    await h.post(`/api/templates/${template}/shares`, h.ana, { email: 'bo@example.test', role: 'viewer' });
    const sendAs = async (who: Record<string, string>, documentName: string, name: string, email: string, expiresAt?: string) => {
      const sent = await h.post('/api/envelopes', who, { templateId: template, documentName, recipients: [{ role: 'partner', name, email, delivery: 'email', ...(expiresAt ? { expiresAt } : {}) }] }, { 'idempotency-key': crypto.randomUUID() });
      assert.equal(sent.status, 201, await sent.clone().text());
      return (await sent.json() as { id: string }).id;
    };
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const nda = await sendAs(h.ana, 'Mutual NDA', 'Pat Partner', 'pat@partner.example');
    const msa = await sendAs(h.ana, 'Master services', 'Quinn Buyer', 'quinn@buyer.example', soon);
    const bos = await sendAs(h.bo, 'Reseller agreement', 'Rae Reseller', 'rae@reseller.example');
    await h.post(`/api/envelopes/${bos}/shares`, h.bo, { email: 'ana@example.test', role: 'viewer' });
    await h.post(`/api/envelopes/${msa}/void`, h.ana, {});
    type Row = { id: string; status: string; signers: { name: string; status: string }[]; progress: { signed: number; total: number }; current?: { taskId: string; name: string; delivery: string }; lastChangeAt: number; createdAt: number };
    const list = async (query = '') => (await h.get<{ envelopes: Row[]; next?: string }>(`/api/envelopes${query}`, h.ana));
    const ids = async (query = '') => (await list(query)).envelopes.map((e) => e.id);
    // Each row: its signers, progress, whose turn it is and how they are invited, and its last change.
    const row = (await list()).envelopes.find((e) => e.id === nda)!;
    assert.deepEqual([row.signers.map((s) => [s.name, s.status]), row.progress, row.current?.name, row.current?.delivery], [[['Pat Partner', 'ACTIVE']], { signed: 0, total: 1 }, 'Pat Partner', 'email']);
    assert.ok(row.lastChangeAt >= row.createdAt);
    assert.equal((await list()).envelopes.find((e) => e.id === msa)!.current, undefined, 'a voided envelope waits for nobody');
    // Search: the document's name, a signer's name or email, or the envelope's id; % and _ are literal.
    assert.deepEqual(await ids('?q=mutual'), [nda]);
    assert.deepEqual(await ids('?q=QUINN%40buyer'), [msa]);
    assert.deepEqual(await ids('?q=Rae'), [bos], 'shared with Ana');
    assert.deepEqual(await ids(`?q=${bos}`), [bos]);
    assert.deepEqual(await ids('?q=%25'), []);
    // Statuses, one or several.
    assert.deepEqual(await ids('?status=VOIDED'), [msa]);
    assert.deepEqual((await ids('?status=IN_PROGRESS,FINALIZING')).sort(), [nda, bos].sort());
    assert.deepEqual((await ids('?status=IN_PROGRESS&status=VOIDED')).length, 3);
    // Since, and the quick views: waiting for others (hers, out for signature), expiring soon.
    assert.deepEqual(await ids(`?since=${Date.now() + 60_000}`), []);
    assert.deepEqual(await ids('?view=waiting'), [nda]);
    const expiring = await sendAs(h.ana, 'Order form', 'Sol Signer', 'sol@buyer.example', soon);
    assert.deepEqual(await ids('?view=expiring'), [expiring]);
    // Pages: `next` is the following page's `cursor`.
    const first = await list('?limit=2');
    assert.equal(first.envelopes.length, 2);
    const second = await list(`?limit=2&cursor=${first.next}`);
    assert.deepEqual([...first.envelopes, ...second.envelopes].map((e) => e.id).length, 4);
    for (const bad of ['?status=DONE', `?q=${'x'.repeat(101)}`, '?since=-1', '?view=mine']) assert.equal((await h.req(`/api/envelopes${bad}`, h.ana)).status, 400, bad);
  } finally { await h.mf.dispose(); }
});

test('the template list searches names and ids, filters by date, and pages', async () => {
  const h = await setup();
  try {
    const nda = await h.template(h.ana);
    await h.post(`/api/templates/${nda}`, h.ana, { name: 'Mutual NDA' });
    const msa = await h.template(h.ana);
    await h.post(`/api/templates/${msa}`, h.ana, { name: 'Master 100% services' });
    const ids = async (query: string) => (await h.templates(h.ana, query)).map((t) => t.id);
    assert.deepEqual(await ids('?q=nda'), [nda]);
    assert.deepEqual(await ids(`?q=${msa}`), [msa]);
    assert.deepEqual(await ids('?q=100%25'), [msa], '% is literal');
    assert.deepEqual(await ids(`?since=${Date.now() + 60_000}`), []);
    const first = await h.get<{ templates: { id: string }[]; next?: string }>('/api/templates?limit=1', h.ana);
    const second = await h.get<{ templates: { id: string }[]; next?: string }>(`/api/templates?limit=1&cursor=${first.next}`, h.ana);
    assert.deepEqual([...first.templates, ...second.templates].map((t) => t.id).sort(), [nda, msa].sort());
    for (const bad of [`?q=${'x'.repeat(101)}`, '?since=x']) assert.equal((await h.req(`/api/templates${bad}`, h.ana)).status, 400, bad);
  } finally { await h.mf.dispose(); }
});
