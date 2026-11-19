// An uploaded PDF that Esign had to prepare for signing (pdf-upload.ts), through the HTTP routes: a template whose PDF
// has a filled form field and a rotated page is stored flattened and upright, with the record of what changed; an
// envelope sent from it is signed on that PDF; the certificate (JSON and the delivery PDF's page) shows the file as
// uploaded and what changed. A refused upload says why. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { degrees, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { finalizeEnvelopeStep, processEnvelopeStep } from '../src/app/server/esign/envelope-completion.ts';

const KEY = 'local-test-key-' + 'e'.repeat(32), ORIGIN = 'https://host.example.com';
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), (n) => n.toString(16).padStart(2, '0')).join('');

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB'), bucket = await blobStore(mf, 'artifacts');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  await db.batch([db.prepare("INSERT INTO tenants (id) VALUES ('t')"), db.prepare("INSERT INTO api_keys (key_hash, tenant_id) VALUES (?, 't')").bind(await sha256(new TextEncoder().encode(KEY)))]);
  const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: await blobStore(mf, 'test-mail'), SIGNING_PAGE_ORIGINS: ORIGIN, OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://localhost' + path, init), env);
  const auth = { authorization: `Bearer ${KEY}` };
  const post = (body: unknown, headers: Record<string, string>) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { mf, db, bucket, env, req, auth, post };
}

/** A two-page PDF: a filled form field on the first page, the second page rotated a quarter turn. */
async function preparedLater() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([400, 500]);
  first.drawText('Services agreement', { x: 40, y: 450, size: 14, font });
  const field = pdf.getForm().createTextField('company');
  field.setText('Example Industries');
  field.addToPage(first, { x: 40, y: 400, width: 200, height: 24 });
  const second = pdf.addPage([400, 500]);
  second.drawText('Schedule A', { x: 40, y: 450, size: 14, font });
  second.setRotation(degrees(90));
  return pdf.save();
}

async function pageText(bytes: Uint8Array) {
  const doc = await getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false }).promise;
  try {
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) out.push((await (await doc.getPage(n)).getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join(' '));
    return out;
  } finally { await doc.destroy(); }
}

test('a template PDF Esign prepared is signed as stored, and the certificate shows the file as uploaded and what changed', async () => {
  const h = await setup();
  const info = console.info;
  console.info = () => {};
  try {
    const original = await preparedLater();
    const form = new FormData();
    form.set('file', new File([original], 'synthetic.pdf', { type: 'application/pdf' }));
    form.set('roles', '["client"]');
    const created = await h.req('/api/templates', { method: 'POST', headers: h.auth, body: form });
    assert.equal(created.status, 201, await created.clone().text());
    const template = await created.json() as { id: string; changes: unknown };
    assert.deepEqual(template.changes, { formFields: 1, annotations: 0, links: 0, pages: 1 });
    const row = await h.db.prepare('SELECT object_key, uploaded_sha256, upload_changes_json FROM templates WHERE id = ?').bind(template.id).first<{ object_key: string; uploaded_sha256: string; upload_changes_json: string }>();
    assert.equal(row!.uploaded_sha256, await sha256(original));
    assert.deepEqual(JSON.parse(row!.upload_changes_json), template.changes);
    const stored = new Uint8Array(await (await h.bucket.get(row!.object_key))!.arrayBuffer());
    const storedPdf = await PDFDocument.load(stored);
    assert.equal(storedPdf.catalog.get(PDFName.of('AcroForm')), undefined, 'the form is flattened');
    assert.deepEqual(storedPdf.getPages().map((p) => [p.getRotation().angle, p.getWidth(), p.getHeight()]), [[0, 400, 500], [0, 500, 400]], 'the rotated page is upright, as it was shown');
    assert.match((await pageText(stored))[0]!, /Example Industries/, 'the field\'s value is in the page');

    // Fields on the second page, where the page is shown in landscape; one signer signs.
    const fields = [{ id: 'sig', type: 'Signature', role: 'client', page: 2, required: true, rect: { x: 0.1, y: 0.6, width: 0.4, height: 0.12 } }];
    await h.db.prepare('UPDATE templates SET fields_json = ? WHERE id = ?').bind(JSON.stringify(fields), template.id).run();
    const sent = await h.req('/api/envelopes', h.post({ templateId: template.id, recipients: [{ role: 'client', name: 'Casey Client', email: 'casey@example.com' }] }, { ...h.auth, 'idempotency-key': 'prepared-pdf' }));
    assert.equal(sent.status, 201, await sent.clone().text());
    const envelope = await sent.json() as { id: string };
    assert.equal((await h.req(`/api/envelopes/${envelope.id}/prepare`, { method: 'POST', headers: h.auth })).status, 204);
    const task = (await (await h.req(`/api/envelopes/${envelope.id}`, { headers: h.auth })).json() as { tasks: { id: string }[] }).tasks[0]!;
    const view = await (await h.req(`/api/envelopes/${envelope.id}/tasks/${task.id}/recipient-view`, h.post({ signedInEmail: 'casey@example.com', origin: ORIGIN }, h.auth))).json() as { code: string };
    const session = await (await h.req('/api/public/page-sessions/exchange', h.post({ code: view.code }, { origin: ORIGIN }))).json() as { token: string };
    const headers = { origin: ORIGIN, 'x-esign-session': session.token };
    const otpResponse = await h.req('/api/public/signing/otp', h.post({}, headers));
    assert.equal(otpResponse.status, 202, await otpResponse.clone().text());
    const otp = await otpResponse.json() as { messageId: string };
    const code = await (await h.env.TEST_MAIL.get(`test-mail/${otp.messageId}.json`))!.json() as { otp: string };
    assert.equal((await h.req('/api/public/signing/otp/verify', h.post({ otp: code.otp }, headers))).status, 204);
    const current = await (await h.req('/api/public/signing/current', { headers })).json() as { id: string; sha256: string };
    assert.equal(current.sha256, await sha256(stored), 'the signer signs the stored, prepared PDF');
    const preview = await h.req('/api/public/signing/preview', h.post({ fieldId: 'sig', text: 'Casey Client' }, headers));
    assert.equal(preview.status, 200);
    const signed = await h.req('/api/public/signing/sign', h.post({ artifactId: current.id, artifactHash: current.sha256, consent: true, signatures: { sig: 'Casey Client' }, signaturePreviews: { sig: preview.headers.get('X-Signature-Preview') } }, headers));
    assert.equal(signed.status, 202, await signed.clone().text());
    assert.equal(await processEnvelopeStep(h.env.DB, h.env.ARTIFACTS, 't', envelope.id), 'processed');
    assert.equal(await finalizeEnvelopeStep(h.env as never, 't', envelope.id), 'finalized');

    const certificate = await (await h.req(`/api/envelopes/${envelope.id}/certificate`, { headers: h.auth })).json() as { source: { sha256: string }; upload: unknown };
    assert.equal(certificate.source.sha256, await sha256(stored), 'the seal binds the prepared PDF');
    assert.deepEqual(certificate.upload, { uploadedSha256: await sha256(original), changes: { formFields: 1, annotations: 0, links: 0, pages: 1 }, fromTemplate: true });
    const delivery = await h.req(`/api/envelopes/${envelope.id}/delivery-pdf`, { headers: h.auth });
    assert.equal(delivery.status, 200);
    const text = (await pageText(new Uint8Array(await delivery.arrayBuffer()))).join(' ');
    assert.match(text, /Uploaded SHA-256/);
    assert.match(text, /Changed on upload/);
    assert.match(text, /1 form field flattened into the page/);
  } finally { console.info = info; await h.mf.dispose(); }
});

test('an API template Esign can\'t prepare is kept as uploaded, for a signature page; an envelope upload says why and stores nothing', async () => {
  const h = await setup();
  const warn = console.warn, info = console.info, logged: { level: string; args: unknown[] }[] = [];
  console.warn = (...args: unknown[]) => { logged.push({ level: 'warn', args }); };
  console.info = (...args: unknown[]) => { logged.push({ level: 'info', args }); };
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 500]);
    const page = pdf.addPage([400, 500]);
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30] })]));
    const bytes = await pdf.save();
    // A template uploaded through the API is signed on a page Esign adds, as before: it is kept as it came.
    const form = new FormData();
    form.set('file', new File([bytes], 'synthetic.pdf', { type: 'application/pdf' }));
    form.set('roles', '["client"]');
    const kept = await h.req('/api/templates', { method: 'POST', headers: h.auth, body: form });
    assert.equal(kept.status, 201, await kept.clone().text());
    const template = await kept.json() as { id: string; changes: unknown };
    assert.equal(template.changes, null);
    const row = await h.db.prepare('SELECT object_key, uploaded_sha256 FROM templates WHERE id = ?').bind(template.id).first<{ object_key: string; uploaded_sha256: string | null }>();
    assert.deepEqual(new Uint8Array(await (await h.bucket.get(row!.object_key))!.arrayBuffer()), Uint8Array.from(bytes));
    assert.equal(row!.uploaded_sha256, null);
    assert.deepEqual(logged.map((log) => [log.level, (log.args[1] as { route: string; code: string }).route, (log.args[1] as { code: string }).code]), [['info', 'template', 'pdf_annotation_without_appearance']]);
    // An envelope's upload takes placed fields: refused, with the reason and the page, and nothing stored.
    logged.length = 0;
    const draft = await h.req('/api/envelopes', h.post({ recipients: [{ role: 'client', name: 'Casey Client', email: 'casey@example.com' }], documentName: 'Synthetic', draft: true }, { ...h.auth, 'idempotency-key': 'refused-upload' }));
    assert.equal(draft.status, 201, await draft.clone().text());
    const { id } = await draft.json() as { id: string };
    const refused = await h.req(`/api/envelopes/${id}/document`, { method: 'POST', headers: { ...h.auth, 'content-type': 'application/pdf' }, body: bytes });
    assert.equal(refused.status, 422);
    assert.deepEqual(await refused.json(), { error: 'unsupported_pdf', reason: 'pdf_annotation_without_appearance', page: 2 });
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM artifacts WHERE envelope_id = ?').bind(id).first<{ n: number }>())!.n, 0);
    assert.equal((await h.bucket.list({ prefix: `envelopes/${id}/` })).objects.length, 0);
    assert.deepEqual(logged.map((log) => [log.level, (log.args[1] as { route: string }).route]), [['warn', 'envelope-document']]);
  } finally { console.warn = warn; console.info = info; await h.mf.dispose(); }
});
