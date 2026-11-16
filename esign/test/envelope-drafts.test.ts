// Envelope drafts (app.ts: saveDraft, sendEnvelope): `POST /api/envelopes` with `draft: true` saves a request as it is,
// unchecked but for its shape, with no tasks: nobody is invited and no contact is added. `POST /api/envelopes/:id`
// changes it (`draft: true`) or sends it, checked as a new envelope is, once. Lists show drafts when asked for; voiding
// one discards it. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, identity, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const ORIGIN = 'https://esign.example.test';

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts') };
  const person = (name: string, role = 'EDITOR') => identity('tenant', { userId: `user-${name}`, email: `${name}@example.test`, role });
  const ana = person('ana'), bo = person('bo'), cy = person('cy');
  const req = (path: string, headers: Record<string, string>, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } }), env);
  const post = (path: string, headers: Record<string, string>, body: unknown, extra: Record<string, string> = {}) => req(path, headers, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(['partner', 'seller']));
  const created = await req('/api/templates', ana, { method: 'POST', body: form });
  assert.equal(created.status, 201, await created.clone().text());
  const templateId = (await created.json() as { id: string }).id;
  const count = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
  return { mf, db, req, post, ana, bo, cy, templateId, count };
}

const half = (templateId: string) => ({ templateId, recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@' }, { role: 'seller', name: '', email: '' }], documentName: 'Reseller agreement', message: { body: 'Work in progress' } });
const whole = (templateId: string) => ({ templateId, recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example', delivery: 'email' }, { role: 'seller', name: 'Sam Seller', email: 'sam@seller.example', delivery: 'email' }], documentName: 'Reseller agreement' });

test('a draft is saved as it is, with no tasks, invitations or contacts; lists show it only when asked for', async () => {
  const h = await setup();
  try {
    const key = { 'idempotency-key': 'draft-1' };
    const saved = await h.post('/api/envelopes', h.ana, { ...half(h.templateId), draft: true }, key);
    assert.equal(saved.status, 201, await saved.clone().text());
    const { id, status } = await saved.json() as { id: string; status: string };
    assert.equal(status, 'DRAFT');
    // Idempotent by its key, as a new envelope is.
    assert.deepEqual(await (await h.post('/api/envelopes', h.ana, { ...half(h.templateId), draft: true }, key)).json(), { id, status: 'DRAFT' });
    assert.equal((await h.post('/api/envelopes', h.ana, { ...whole(h.templateId), draft: true }, key)).status, 409);
    assert.equal((await h.post('/api/envelopes', h.ana, whole(h.templateId), key)).status, 409, 'nor sent with the draft\'s key');
    // Nothing to sign yet.
    assert.equal(await h.count('SELECT count(*) AS n FROM tasks WHERE envelope_id = ?', id), 0);
    assert.equal(await h.count('SELECT count(*) AS n FROM contacts'), 0);
    assert.equal(await h.count('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?', id), 0);
    // Its page: its request as saved.
    const shown = await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { status: string; documentName: string; tasks: unknown[]; draft: unknown };
    assert.deepEqual([shown.status, shown.documentName, shown.tasks], ['DRAFT', 'Reseller agreement', []]);
    assert.deepEqual(shown.draft, half(h.templateId));
    // Lists: envelopes sent, unless drafts are asked for.
    const list = async (query = '') => (await (await h.req(`/api/envelopes${query}`, h.ana)).json() as { envelopes: { id: string; status: string; signers: { name: string; status: string }[]; progress: { total: number } }[] }).envelopes;
    assert.deepEqual(await list(), []);
    const [draft] = await list('?status=DRAFT');
    assert.deepEqual([draft!.id, draft!.status, draft!.signers.map((s) => [s.name, s.status]), draft!.progress.total], [id, 'DRAFT', [['Pat Partner', 'DRAFT'], ['', 'DRAFT']], 2]);
    // Its shape is checked: fields Esign knows, a template the caller sees.
    for (const bad of [{ ...half(h.templateId), note: 1 }, { ...half(h.templateId), recipients: [{ role: 'partner', pet: 'cat' }] }, { recipients: [] }, { ...half(h.templateId), draft: 'yes' }])
      assert.equal((await h.post('/api/envelopes', h.ana, { draft: true, ...bad }, { 'idempotency-key': crypto.randomUUID() })).status, 422, JSON.stringify(bad));
    assert.equal((await h.post('/api/envelopes', h.bo, { ...half(h.templateId), draft: true }, { 'idempotency-key': crypto.randomUUID() })).status, 404, 'a template bo doesn\'t see');
  } finally { await h.mf.dispose(); }
});

test('a draft is changed and then sent, checked as a new envelope, once; by its editors; voiding one discards it', async () => {
  const h = await setup();
  try {
    const { id } = await (await h.post('/api/envelopes', h.ana, { ...half(h.templateId), draft: true, tags: ['q4'] }, { 'idempotency-key': 'draft-2' })).json() as { id: string };
    // Changed: its request is replaced.
    const changed = await h.post(`/api/envelopes/${id}`, h.ana, { ...half(h.templateId), documentName: 'Reseller agreement v2', draft: true });
    assert.deepEqual([changed.status, await changed.json()], [200, { id, status: 'DRAFT' }]);
    assert.equal((await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { documentName: string }).documentName, 'Reseller agreement v2');
    // Its editors only: a viewer it is shared with can't; someone it isn't shared with doesn't see it.
    await h.post(`/api/envelopes/${id}/shares`, h.ana, { email: 'bo@example.test', role: 'viewer' });
    assert.equal((await h.post(`/api/envelopes/${id}`, h.bo, { ...half(h.templateId), draft: true })).status, 403);
    assert.equal((await h.post(`/api/envelopes/${id}`, h.cy, { ...half(h.templateId), draft: true })).status, 404);
    // Sent unfinished: refused as a new envelope would be, and still a draft.
    assert.equal((await h.post(`/api/envelopes/${id}`, h.ana, half(h.templateId))).status, 422);
    assert.equal((await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { status: string }).status, 'DRAFT');
    // Sent: it is this envelope, out for signature, with its tasks, its signers' contacts and its tags.
    const sent = await h.post(`/api/envelopes/${id}`, h.ana, whole(h.templateId));
    assert.deepEqual([sent.status, await sent.json()], [200, { id, status: 'IN_PROGRESS' }]);
    const envelope = await (await h.req(`/api/envelopes/${id}`, h.ana)).json() as { status: string; tasks: { recipientName: string; status: string }[]; draft?: unknown; tags: string[] };
    assert.deepEqual([envelope.status, envelope.tasks.map((t) => [t.recipientName, t.status]), envelope.draft], ['IN_PROGRESS', [['Pat Partner', 'ACTIVE'], ['Sam Seller', 'PENDING']], undefined]);
    assert.equal(await h.count('SELECT count(*) AS n FROM contacts'), 2);
    assert.equal(await h.count('SELECT count(*) AS n FROM envelopes WHERE id = ? AND draft_json IS NULL', id), 1);
    assert.equal((await (await h.req('/api/envelopes', h.ana)).json() as { envelopes: { id: string }[] }).envelopes[0]!.id, id, 'listed as sent');
    // Once: it is no longer a draft.
    assert.deepEqual(await (await h.post(`/api/envelopes/${id}`, h.ana, whole(h.templateId))).json(), { error: 'not_draft' });
    assert.equal((await h.post(`/api/envelopes/${id}`, h.ana, { ...whole(h.templateId), draft: true })).status, 409);
    // Sent at once from two places: one of them sends it.
    const other = await (await h.post('/api/envelopes', h.ana, { ...half(h.templateId), draft: true }, { 'idempotency-key': 'draft-3' })).json() as { id: string };
    const race = await Promise.all([h.post(`/api/envelopes/${other.id}`, h.ana, whole(h.templateId)), h.post(`/api/envelopes/${other.id}`, h.ana, whole(h.templateId))]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await h.count('SELECT count(*) AS n FROM tasks WHERE envelope_id = ?', other.id), 2, 'its tasks, once');
    // Voiding a draft discards it, with its shares and tags; one sent is voided as before.
    const third = await (await h.post('/api/envelopes', h.ana, { ...half(h.templateId), draft: true, share: [{ email: 'bo@example.test', role: 'viewer' }] }, { 'idempotency-key': 'draft-4' })).json() as { id: string };
    assert.deepEqual(await (await h.post(`/api/envelopes/${third.id}/void`, h.ana, {})).json(), { id: third.id, status: 'DISCARDED' });
    assert.equal((await h.req(`/api/envelopes/${third.id}`, h.ana)).status, 404);
    assert.equal(await h.count("SELECT count(*) AS n FROM document_shares WHERE resource_id = ?", third.id), 0);
    assert.equal(await h.count("SELECT count(*) AS n FROM document_tags WHERE resource_id = ?", third.id), 0);
    assert.deepEqual(await (await h.post(`/api/envelopes/${id}/void`, h.ana, {})).json(), { id, status: 'VOIDED' });
  } finally { await h.mf.dispose(); }
});

test('a draft of a draft template is saved, and isn\'t sent until the template is ready', async () => {
  const h = await setup();
  try {
    await h.db.prepare("UPDATE templates SET status = 'draft' WHERE id = ?").bind(h.templateId).run();
    const { id } = await (await h.post('/api/envelopes', h.ana, { ...half(h.templateId), draft: true }, { 'idempotency-key': 'draft-5' })).json() as { id: string };
    const refused = await h.post(`/api/envelopes/${id}`, h.ana, whole(h.templateId));
    assert.deepEqual([refused.status, await refused.json()], [409, { error: 'template_draft' }]);
    await h.db.prepare("UPDATE templates SET status = 'active' WHERE id = ?").bind(h.templateId).run();
    assert.equal((await h.post(`/api/envelopes/${id}`, h.ana, whole(h.templateId))).status, 200);
  } finally { await h.mf.dispose(); }
});
