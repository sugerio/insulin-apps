// The field editor's uploads, for a session bound to the parent origin its host named (editor-routes.ts): a staged
// source and a file sent with a save are prepared for signing as any upload is (pdf-upload.ts). What was changed is
// answered and recorded, on the session and on the template it saves, which a new version of that template keeps, as
// does a template saved from an envelope whose fields its own editor placed. A PDF Esign can't prepare is refused with
// the reason, and nothing is stored. A page framed by any origin but the session's parent gets no editor, and the
// editor's API answers only the editor page's own origin. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { degrees, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const KEY = 'local-test-key-' + 'd'.repeat(32), SELF = 'https://esign.example.com', HOST = 'https://host.example.com', OTHER = 'https://other.example.com';
const CHANGES = { formFields: 1, annotations: 1, links: 0, pages: 1 };
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), (n) => n.toString(16).padStart(2, '0')).join('');
const signature = (id: string, role: string, page: number, x = 0.1) => ({ id, type: 'Signature', role, page, required: true, rect: { x, y: 0.2, width: 0.25, height: 0.08 } });

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB'), bucket = await blobStore(mf, 'artifacts');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  await db.batch([db.prepare("INSERT INTO tenants (id) VALUES ('t')"), db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 't')").bind(await sha256(new TextEncoder().encode(KEY)))]);
  const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: await blobStore(mf, 'test-mail'), OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(SELF + path, init), env);
  const auth = { authorization: `Bearer ${KEY}` };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  /** An editing session the host starts for its page at HOST: `{sessionId, code}`. */
  const start = async (body: Record<string, unknown>) => {
    const created = await post('/api/template-editing-sessions', { allowedParentOrigin: HOST, ...body });
    assert.equal(created.status, 201, await created.clone().text());
    const { sessionId, url } = await created.json() as { sessionId: string; url: string };
    return { sessionId, code: new URL(url).hash.slice(1) };
  };
  /** The editor page's code exchange, framed by `embedders` (the nearest first), as the page reports them. */
  const exchange = (session: { sessionId: string; code: string }, embedders: string[] = [HOST]) => req('/api/public/editor/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: SELF },
    body: JSON.stringify({ pageId: session.sessionId, code: session.code, embedded: true, embedder: embedders[0], embedders }),
  });
  /** The editor, opened inside its parent: the headers of its API calls. */
  const open = async (session: { sessionId: string; code: string }) => {
    const exchanged = await exchange(session);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    return { 'x-esign-session': (await exchanged.json() as { token: string }).token, origin: SELF };
  };
  const save = (headers: Record<string, string>, roles: string[], fields: unknown[], file?: Uint8Array) => {
    const form = new FormData();
    form.set('roles', JSON.stringify(roles));
    form.set('fields', JSON.stringify(fields));
    if (file) form.set('file', new File([Uint8Array.from(file)], 'synthetic.pdf', { type: 'application/pdf' }));
    return req('/api/public/editor/save', { method: 'POST', headers, body: form });
  };
  const stage = (sessionId: string, bytes: Uint8Array) => req(`/api/template-editing-sessions/${sessionId}/source`, { method: 'POST', headers: { ...auth, 'content-type': 'application/pdf' }, body: Uint8Array.from(bytes) });
  const stored = async (key: string) => new Uint8Array(await (await bucket.get(key))!.arrayBuffer());
  const template = (id: string) => db.prepare('SELECT object_key, uploaded_sha256, upload_changes_json FROM templates WHERE id = ?').bind(id).first<{ object_key: string; uploaded_sha256: string | null; upload_changes_json: string | null }>();
  const count = async (table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  return { mf, db, bucket, req, post, start, exchange, open, save, stage, stored, template, count };
}

/** Runs `fn` without the upload's log lines (pdf-upload.ts logs every rewrite and refusal). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const info = console.info, warn = console.warn;
  console.info = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.info = info; console.warn = warn; }
}

/** A two-page PDF Esign prepares: page 1 has a filled form field and a stamp with its own look; page 2 is cropped and turned a quarter turn. */
async function needsPreparing() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([400, 500]);
  first.drawText('Supply agreement', { x: 40, y: 450, size: 14, font });
  const field = pdf.getForm().createTextField('supplier');
  field.setText('Example Supplies');
  field.addToPage(first, { x: 40, y: 400, width: 200, height: 24 });
  const look = pdf.context.register(pdf.context.stream('BT /F1 12 Tf 4 4 Td (RECEIVED) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F1: font.ref } } }));
  first.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [250, 300, 350, 320], AP: { N: look } })));
  const second = pdf.addPage([400, 500]);
  second.drawText('Schedule A', { x: 40, y: 450, size: 14, font });
  // Cropped to 360 by 460 and turned a quarter turn: shown 460 by 360.
  second.setCropBox(20, 20, 360, 460);
  second.setRotation(degrees(90));
  return pdf.save();
}

/** A PDF that says it is encrypted, which Esign can't open. */
async function encrypted() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 2, R: 3, Length: 128 }));
  return pdf.save({ useObjectStreams: false });
}

/** What preparing must leave: no form, no annotations, every page upright at the size shown. */
async function assertPrepared(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.catalog.get(PDFName.of('AcroForm')), undefined, 'the form is flattened');
  assert.deepEqual(pdf.getPages().map((p) => [p.getRotation().angle, p.getWidth(), p.getHeight(), p.node.get(PDFName.of('Annots'))]), [[0, 400, 500, undefined], [0, 460, 360, undefined]], 'the cropped, turned page is upright at the size shown');
}

test('a staged source that needs preparing is stored prepared: the answer says what changed, the session and the template it saves keep the record', async () => {
  const h = await setup();
  try {
    const original = await needsPreparing();
    const session = await h.start({ roles: ['client'] });
    const staged = await quietly(() => h.stage(session.sessionId, original));
    assert.equal(staged.status, 201, await staged.clone().text());
    assert.deepEqual(await staged.json(), { ok: true, changes: CHANGES });
    // The session keeps the stored PDF's hash, and the file's own with what was changed.
    const row = await h.db.prepare('SELECT staged_object_key, staged_sha256, staged_uploaded_sha256, staged_changes_json FROM editor_sessions WHERE id = ?').bind(session.sessionId).first<{ staged_object_key: string; staged_sha256: string; staged_uploaded_sha256: string; staged_changes_json: string }>();
    assert.equal(row!.staged_uploaded_sha256, await sha256(original));
    assert.deepEqual(JSON.parse(row!.staged_changes_json), CHANGES);
    const source = await h.stored(row!.staged_object_key);
    assert.equal(await sha256(source), row!.staged_sha256);
    assert.notEqual(row!.staged_sha256, row!.staged_uploaded_sha256, 'the stored source is not the file as uploaded');
    await assertPrepared(source);
    // The editor, opened inside its parent, shows the prepared PDF; its save keeps the record.
    const headers = await h.open(session);
    assert.deepEqual(new Uint8Array(await (await h.req('/api/public/editor/pdf', { headers })).arrayBuffer()), source);
    const saved = await h.save(headers, ['client'], [signature('sig', 'client', 2)]);
    assert.equal(saved.status, 201, await saved.clone().text());
    const { id } = await saved.json() as { id: string };
    const kept = await h.template(id);
    assert.deepEqual([kept!.uploaded_sha256, JSON.parse(kept!.upload_changes_json!)], [await sha256(original), CHANGES]);
    assert.deepEqual(await h.stored(kept!.object_key), source);
    // Its new version, made in the editor from it, keeps the record too, with the same PDF.
    const version = await h.start({ sourceTemplateId: id, replace: true });
    const next = await h.save(await h.open(version), ['client'], [signature('sig', 'client', 2, 0.5)]);
    assert.equal(next.status, 201, await next.clone().text());
    const nextRow = await h.template((await next.json() as { id: string }).id);
    assert.deepEqual([nextRow!.uploaded_sha256, JSON.parse(nextRow!.upload_changes_json!)], [await sha256(original), CHANGES]);
    assert.deepEqual(await h.stored(nextRow!.object_key), source);
  } finally { await h.mf.dispose(); }
});

test('a file sent with an editor save that needs preparing is stored prepared, and the template keeps the record; so does one saved from an envelope its editor placed', async () => {
  const h = await setup();
  try {
    const original = await needsPreparing();
    const session = await h.start({ roles: ['client'] });
    const saved = await quietly(async () => h.save(await h.open(session), ['client'], [signature('sig', 'client', 2)], original));
    assert.equal(saved.status, 201, await saved.clone().text());
    const row = await h.template((await saved.json() as { id: string }).id);
    assert.deepEqual([row!.uploaded_sha256, JSON.parse(row!.upload_changes_json!)], [await sha256(original), CHANGES]);
    await assertPrepared(await h.stored(row!.object_key));

    // An envelope draft's document, prepared on upload; its own editor, inside its parent, places its fields on it.
    const recipients = [{ role: 'client', name: 'Casey Client', email: 'casey@example.com' }];
    const draft = await h.post('/api/envelopes', { recipients, documentName: 'Supply agreement', draft: true }, { 'idempotency-key': 'prepared-draft' });
    assert.equal(draft.status, 201, await draft.clone().text());
    const { id: envelopeId } = await draft.json() as { id: string };
    const uploaded = await quietly(() => h.req(`/api/envelopes/${envelopeId}/document`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/pdf' }, body: Uint8Array.from(original) }));
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const document = await uploaded.json() as { sha256: string; changes: unknown };
    assert.deepEqual(document.changes, CHANGES);
    const editor = await h.start({ envelopeId });
    // The session keeps the hash of the document it opened on (editor_sessions.source_sha256).
    assert.equal((await h.db.prepare('SELECT source_sha256 FROM editor_sessions WHERE id = ?').bind(editor.sessionId).first<{ source_sha256: string }>())!.source_sha256, document.sha256);
    const placed = await h.save(await h.open(editor), ['client'], [signature('sig', 'client', 2)]);
    assert.deepEqual([placed.status, await placed.json()], [200, { id: envelopeId, status: 'ready' }]);
    assert.equal((await h.post(`/api/envelopes/${envelopeId}`, { recipients, documentName: 'Supply agreement' })).status, 200);
    // Saved as a template: the envelope's document, with the record of what was changed when it was uploaded.
    const fromEnvelope = await h.post('/api/templates', { fromEnvelope: envelopeId });
    assert.equal(fromEnvelope.status, 201, await fromEnvelope.clone().text());
    const copy = await h.template((await fromEnvelope.json() as { id: string }).id);
    assert.deepEqual([copy!.uploaded_sha256, JSON.parse(copy!.upload_changes_json!)], [await sha256(original), CHANGES]);
    assert.equal(await sha256(await h.stored(copy!.object_key)), document.sha256);
  } finally { await h.mf.dispose(); }
});

test('a staged source or a save\'s file Esign can\'t prepare is refused with the reason, and nothing is stored', async () => {
  const h = await setup();
  try {
    const locked = await encrypted();
    const staging = await h.start({ roles: ['client'] });
    const refused = await quietly(() => h.stage(staging.sessionId, locked));
    assert.deepEqual([refused.status, await refused.json()], [422, { error: 'invalid_file', reason: 'pdf_encrypted' }]);
    assert.deepEqual(await h.db.prepare('SELECT staged_object_key, staged_sha256, staged_uploaded_sha256, staged_changes_json FROM editor_sessions WHERE id = ?').bind(staging.sessionId).first(), { staged_object_key: null, staged_sha256: null, staged_uploaded_sha256: null, staged_changes_json: null });
    assert.equal((await h.bucket.list()).objects.length, 0, 'no staged object');

    const saving = await h.start({ roles: ['client'] });
    const headers = await h.open(saving);
    const failed = await quietly(() => h.save(headers, ['client'], [signature('sig', 'client', 1)], locked));
    assert.deepEqual([failed.status, await failed.json()], [422, { error: 'invalid_pdf_or_fields', reason: 'pdf_encrypted' }]);
    assert.deepEqual([await h.count('templates'), (await h.bucket.list()).objects.length], [0, 0], 'no template, no object');
    assert.equal((await h.db.prepare('SELECT result_template_id FROM editor_sessions WHERE id = ?').bind(saving.sessionId).first<{ result_template_id: string | null }>())!.result_template_id, null);
    // The session is still unsaved: a PDF Esign can prepare saves.
    const retried = await quietly(async () => h.save(headers, ['client'], [signature('sig', 'client', 2)], await needsPreparing()));
    assert.equal(retried.status, 201, await retried.clone().text());
  } finally { await h.mf.dispose(); }
});

test('the staged source and a save\'s file reach only the editor its parent frames: another origin gets no editor, and the editor\'s API answers only its own page', async () => {
  const h = await setup();
  try {
    const original = await needsPreparing();
    const staged = await h.start({ roles: ['client'] });
    assert.equal((await quietly(() => h.stage(staged.sessionId, original))).status, 201);
    const withFile = await h.start({ roles: ['client'] });
    for (const session of [staged, withFile]) {
      // Framed by another origin, or by the parent inside another: refused, and the code is left for the parent.
      for (const embedders of [[OTHER], [HOST, OTHER]]) {
        const exchanged = await h.exchange(session, embedders);
        assert.deepEqual([exchanged.status, await exchanged.json()], [403, { error: 'embedder_not_allowed' }], embedders.join(' in '));
      }
      const headers = await h.open(session);
      const send = (from: Record<string, string>) => quietly(() => h.save(from, ['client'], [signature('sig', 'client', 2)], session === withFile ? original : undefined));
      // The editor's token, used from any page but the editor's own (its parent's included): refused.
      for (const origin of [OTHER, HOST]) {
        const elsewhere = { ...headers, origin };
        assert.deepEqual([(await h.req('/api/public/editor/pdf', { headers: elsewhere })).status, (await h.req('/api/public/editor/current', { headers: elsewhere })).status], [403, 403], origin);
        const sent = await send(elsewhere);
        assert.deepEqual([sent.status, await sent.json()], [403, { error: 'origin' }], origin);
      }
      assert.equal((await h.db.prepare('SELECT result_template_id FROM editor_sessions WHERE id = ?').bind(session.sessionId).first<{ result_template_id: string | null }>())!.result_template_id, null, 'nothing saved from elsewhere');
      // From the editor's own page, the same save is taken.
      assert.equal((await send(headers)).status, 201);
    }
    assert.deepEqual([await h.count('templates'), (await h.bucket.list({ prefix: 'templates/' })).objects.length], [2, 2], 'one template each, none from elsewhere');
  } finally { await h.mf.dispose(); }
});
