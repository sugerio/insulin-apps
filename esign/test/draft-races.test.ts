// A draft changed while it is being sent (app.ts, envelope-documents.ts, editor-routes.ts): a send commits only the
// draft, the document and the fields it read, an upload never touches the document a sent envelope was sent with, and
// a send that failed halfway leaves the draft sendable. Each test runs one request in the middle of another, at the
// moment the first has read what it acts on. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const KEY = 'local-test-key-' + 'r'.repeat(32), HOST = 'https://host.example.com', ORIGIN = 'http://localhost';
const TICK = { 'x-suger-app-id': 'insulin-apps-esign', 'x-suger-access-via': 'schedule' };
const RECIPIENTS = [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }];
const FIELDS = [{ id: 's1', type: 'Signature', role: 'partner', page: 1, required: true, rect: { x: 0.1, y: 0.2, width: 0.25, height: 0.06 } }];
const sha = async (bytes: ArrayBuffer | Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const real = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await real.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => real.prepare(s)));
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))).toString('hex');
  await real.batch([real.prepare("INSERT INTO tenants (id) VALUES ('t')"), real.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 't')").bind(hash)]);
  // The database as the app sees it: once a statement starting with a hook's text has read its row, the hook's
  // request runs, before the first request goes on; `failBatch` makes the next batch fail, as a D1 error would.
  const hooks: { match: string; run: () => Promise<void> }[] = [];
  const faults = { failBatch: false };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (faults.failBatch) { faults.failBatch = false; throw new Error('D1 unavailable'); }
        return target.batch(statements);
      };
      if (prop === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        const hook = hooks.find((h) => sql.startsWith(h.match));
        if (!hook) return statement;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
          get(inner, name) {
            if (name === 'bind') return (...values: unknown[]) => wrap(inner.bind(...values));
            if (name === 'first') return async (...args: []) => {
              const row = await inner.first(...args);
              const at = hooks.indexOf(hook);
              if (at >= 0) { hooks.splice(at, 1); await hook.run(); }
              return row;
            };
            const value = (inner as unknown as Record<string | symbol, unknown>)[name];
            return typeof value === 'function' ? value.bind(inner) : value;
          },
        });
        return wrap(statement);
      };
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const bucket = await blobStore(mf, 'artifacts');
  const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: await blobStore(mf, 'test-mail'), SIGNING_PAGE_ORIGINS: HOST, OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
  const auth = { authorization: `Bearer ${KEY}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env as never);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const pdf = async (pages: number) => { const doc = await PDFDocument.create(); for (let i = 0; i < pages; i++) doc.addPage([600, 800]); return doc.save(); };
  const upload = (id: string, bytes: Uint8Array) => req(`/api/envelopes/${id}/document`, { method: 'POST', headers: { ...auth, 'content-type': 'application/pdf' }, body: bytes });
  const template = async (pages: number) => {
    const form = new FormData(); form.set('file', new File([await pdf(pages)], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(['partner']));
    const created = await req('/api/templates', { method: 'POST', headers: auth, body: form });
    assert.equal(created.status, 201, await created.clone().text());
    return (await created.json() as { id: string }).id;
  };
  /** An upload draft with its first document and its fields placed. */
  const uploadDraft = async (key: string, first: Uint8Array) => {
    const created = await post('/api/envelopes', { recipients: RECIPIENTS, documentName: 'Uploaded agreement', draft: true }, { 'idempotency-key': key });
    const { id } = await created.json() as { id: string };
    assert.equal((await upload(id, first)).status, 201);
    await real.prepare('UPDATE envelopes SET roles_json = ?, fields_json = ? WHERE id = ?').bind(JSON.stringify(['partner']), JSON.stringify(FIELDS), id).run();
    return id;
  };
  const row = (id: string) => real.prepare('SELECT e.status, e.fields_json, e.draft_json, a.object_key, a.sha256 FROM envelopes e LEFT JOIN artifacts a ON a.envelope_id = e.id AND a.id = ? WHERE e.id = ?')
    .bind(`d0:${id}`, id).first<{ status: string; fields_json: string | null; draft_json: string | null; object_key: string | null; sha256: string | null }>();
  return { mf, real, hooks, faults, bucket, req, post, pdf, upload, template, uploadDraft, row };
}

test('a scheduled send whose draft was saved meanwhile is not sent: the saved draft stands, unscheduled', async () => {
  const h = await setup();
  try {
    const templateId = await h.template(1);
    const body = (email: string) => ({ templateId, recipients: [{ role: 'partner', name: 'Pat Partner', email }], documentName: 'Scheduled' });
    const scheduled = await h.post('/api/envelopes', { ...body('old@partner.example'), sendAt: new Date(Date.now() + 3_600_000).toISOString() }, { 'idempotency-key': 'scheduled-1' });
    assert.equal(scheduled.status, 201, await scheduled.clone().text());
    const { id } = await scheduled.json() as { id: string };
    await h.real.prepare("UPDATE envelopes SET draft_json = json_set(draft_json, '$.schedule.at', ?) WHERE id = ?").bind(Date.now() - 1000, id).run();
    // The sender corrects the address and saves the draft (which cancels the schedule) while the tick sends it.
    let saved = 0;
    h.hooks.push({ match: 'SELECT * FROM templates WHERE id = ?', run: async () => { saved = (await h.post(`/api/envelopes/${id}`, { ...body('new@partner.example'), draft: true })).status; } });
    const tick = await h.req('/api/scheduled', { method: 'POST', headers: TICK });
    assert.equal(tick.status, 200, await tick.clone().text());
    assert.equal(saved, 200);
    const after = await h.row(id);
    assert.equal(after?.status, 'DRAFT', 'not sent');
    assert.equal(JSON.parse(after!.draft_json!).recipients[0].email, 'new@partner.example', 'the draft as saved');
    assert.equal(JSON.parse(after!.draft_json!).schedule, undefined, 'and no longer scheduled');
    assert.equal(await h.real.prepare('SELECT COUNT(*) AS n FROM tasks WHERE envelope_id = ?').bind(id).first('n'), 0, 'nobody invited');
  } finally { await h.mf.dispose(); }
});

test('a document replaced while its draft is sent stops the send: the draft keeps the new document, without fields', async () => {
  const h = await setup();
  try {
    const id = await h.uploadDraft('upload-race-1', await h.pdf(1));
    const second = await h.pdf(2);
    let uploaded = 0;
    h.hooks.push({ match: 'SELECT e.template_id, e.roles_json, e.fields_json, a.object_key', run: async () => { uploaded = (await h.upload(id, second)).status; } });
    const sent = await h.post(`/api/envelopes/${id}`, { recipients: RECIPIENTS, documentName: 'Uploaded agreement' });
    assert.equal(uploaded, 201);
    assert.equal(sent.status, 409, await sent.clone().text());
    const after = await h.row(id);
    assert.deepEqual([after?.status, after?.fields_json, after?.sha256], ['DRAFT', null, await sha(second)], 'the fields placed on the old document are not brought back');
  } finally { await h.mf.dispose(); }
});

test('an upload that started before its draft was sent never replaces the document the envelope was sent with', async () => {
  const h = await setup();
  try {
    const first = await h.pdf(1);
    const id = await h.uploadDraft('upload-race-2', first);
    let sent = 0;
    h.hooks.push({ match: 'SELECT status, template_id FROM envelopes WHERE id = ? AND tenant_id = ?', run: async () => { sent = (await h.post(`/api/envelopes/${id}`, { recipients: RECIPIENTS, documentName: 'Uploaded agreement' })).status; } });
    const late = await h.upload(id, await h.pdf(2));
    assert.equal(sent, 200);
    assert.equal(late.status, 409);
    const after = await h.row(id);
    assert.deepEqual([after?.status, after?.sha256], ['IN_PROGRESS', await sha(first)]);
    const stored = await h.bucket.get(after!.object_key!);
    assert.equal(await sha(await stored!.arrayBuffer()), await sha(first), 'the stored document is still the one it was sent with');
  } finally { await h.mf.dispose(); }
});

test('fields placed on a document that an upload replaced meanwhile are not saved on the new one', async () => {
  const h = await setup();
  try {
    const id = await h.uploadDraft('upload-race-3', await h.pdf(1));
    await h.real.prepare('UPDATE envelopes SET roles_json = NULL, fields_json = NULL WHERE id = ?').bind(id).run();
    const created = await h.post('/api/template-editing-sessions', { allowedParentOrigin: HOST, envelopeId: id });
    assert.equal(created.status, 201, await created.clone().text());
    const { sessionId, url } = await created.json() as { sessionId: string; url: string };
    const exchanged = await h.req('/api/public/editor/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ pageId: sessionId, code: new URL(url).hash.slice(1), embedded: true, embedder: HOST }) });
    const headers = { 'x-esign-session': (await exchanged.json() as { token: string }).token, origin: ORIGIN };
    const second = await h.pdf(2);
    let uploaded = 0;
    h.hooks.push({ match: 'SELECT object_key FROM artifacts WHERE id = ? AND envelope_id = ?', run: async () => { uploaded = (await h.upload(id, second)).status; } });
    const form = new FormData(); form.set('roles', JSON.stringify(['partner'])); form.set('fields', JSON.stringify(FIELDS));
    const saved = await h.req('/api/public/editor/save', { method: 'POST', headers, body: form });
    assert.equal(uploaded, 201);
    assert.equal(saved.status, 409, await saved.clone().text());
    assert.deepEqual([(await h.row(id))?.fields_json, (await h.row(id))?.sha256], [null, await sha(second)]);
  } finally { await h.mf.dispose(); }
});

test('a draft whose send failed halfway is sent later with another document', async () => {
  const h = await setup();
  try {
    const one = await h.template(1), two = await h.template(2);
    const created = await h.post('/api/envelopes', { templateId: one, recipients: RECIPIENTS, draft: true }, { 'idempotency-key': 'halfway-1' });
    const { id } = await created.json() as { id: string };
    // The first try stores its initial document, then its batch fails.
    h.faults.failBatch = true;
    assert.ok((await h.post(`/api/envelopes/${id}`, { templateId: one, recipients: RECIPIENTS })).status >= 500);
    assert.equal((await h.row(id))?.status, 'DRAFT');
    const sent = await h.post(`/api/envelopes/${id}`, { templateId: two, recipients: RECIPIENTS });
    assert.equal(sent.status, 200, await sent.clone().text());
    const after = await h.row(id);
    const stored = await h.bucket.get(after!.object_key!);
    assert.equal((await PDFDocument.load(new Uint8Array(await stored!.arrayBuffer()))).getPageCount(), 2, 'sent with the second template\'s document');
    assert.equal(await sha(await stored!.arrayBuffer()), after?.sha256);
    assert.deepEqual((await h.bucket.list({ prefix: `envelopes/${id}/` })).objects.map((o) => o.key), [after!.object_key], 'the failed try\'s document is deleted once it is sent');
  } finally { await h.mf.dispose(); }
});

test('the tick stops sending scheduled drafts once its time is used, leaving the rest due for the next one', async () => {
  const h = await setup();
  const realNow = Date.now;
  try {
    const templateId = await h.template(1);
    const ids: string[] = [];
    for (const key of ['budget-1', 'budget-2', 'budget-3']) {
      const r = await h.post('/api/envelopes', { templateId, recipients: RECIPIENTS, sendAt: new Date(realNow() + 3_600_000).toISOString() }, { 'idempotency-key': key });
      ids.push((await r.json() as { id: string }).id);
    }
    await h.real.prepare("UPDATE envelopes SET draft_json = json_set(draft_json, '$.schedule.at', ?)").bind(realNow() - 1000).run();
    // The first send takes the tick's whole budget.
    h.hooks.push({ match: 'SELECT * FROM templates WHERE id = ?', run: async () => { Date.now = () => realNow() + 60_000; } });
    const tick = await h.req('/api/scheduled', { method: 'POST', headers: TICK });
    assert.equal(tick.status, 200, await tick.clone().text());
    const answer = await tick.json() as { scheduledSent: number; scheduledFailed: number };
    assert.deepEqual([answer.scheduledSent, answer.scheduledFailed], [1, 0]);
    const statuses = await Promise.all(ids.map(async (id) => (await h.row(id))?.status));
    assert.deepEqual(statuses.filter((s) => s === 'DRAFT').length, 2, 'the rest wait, still scheduled');
  } finally { Date.now = realNow; await h.mf.dispose(); }
});

test('a draft saved while it is discarded is refused, and leaves no shares or tags behind', async () => {
  const h = await setup();
  try {
    const templateId = await h.template(1);
    const created = await h.post('/api/envelopes', { templateId, recipients: RECIPIENTS, draft: true }, { 'idempotency-key': 'discarded-1' });
    const { id } = await created.json() as { id: string };
    let discarded = 0;
    h.hooks.push({ match: 'SELECT status FROM envelopes WHERE id = ? AND tenant_id = ?', run: async () => { discarded = (await h.post(`/api/envelopes/${id}/void`, {})).status; } });
    const saved = await h.post(`/api/envelopes/${id}`, { templateId, recipients: RECIPIENTS, draft: true, tags: ['late'], share: [{ email: 'cy@example.test', role: 'viewer' }] });
    assert.equal(discarded, 200);
    assert.equal(saved.status, 409, await saved.clone().text());
    for (const table of ['document_shares', 'document_tags']) assert.equal(await h.real.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE resource_id = ?`).bind(id).first('n'), 0, table);
  } finally { await h.mf.dispose(); }
});
