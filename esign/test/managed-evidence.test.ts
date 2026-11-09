// Completing envelopes with the managed seal: sealed once, stored, reused on retry, verified on
// every read, and refused when the stored records or files no longer match. Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { unstable_splitSqlQuery } from 'wrangler';
import app from '../src/worker.ts';
import { finalizeManagedEvidence, verifyManagedEvidence, managedDelivery, managedEvidenceKey, type ManagedEvidenceConfig } from '../src/managed-evidence.ts';
import { deliveryPdf } from '../src/delivery-pdf.ts';
import { evidenceMessage } from '../src/worker-kms-evidence.ts';
import { startOpensslTsa } from './helpers/openssl-tsa.ts';
import {processEnvelopeStep} from '../src/envelope-completion.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'm'.repeat(64);
const TSA_URL = 'http://tsa.example.test/';
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

async function sealing() {
  const tsa = await startOpensslTsa();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const counts = { sign: 0, tsa: 0 };
  const tsaTrust = { url: TSA_URL, roots: tsa.roots, policies: [tsa.policy], signerSpkiSha256: [tsa.signerSpkiSha256], missingAccuracyMs: 1000 };
  const config: ManagedEvidenceConfig = {
    sealer: {
      keyArn: 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000', publicKeySpki: spki,
      signEvidence: async input => { counts.sign++; return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Uint8Array.from(evidenceMessage(input)))); },
      tsa: tsaTrust,
      fetch: (async (request: Request) => { counts.tsa++; return new Response(await tsa.reply(new Uint8Array(await request.arrayBuffer())), { headers: { 'content-type': 'application/timestamp-reply' } }); }) as typeof fetch,
    },
    trust: { publicKeySha256: [hex(await crypto.subtle.digest('SHA-256', spki))], tsa: tsaTrust },
  };
  return { tsa, config, counts };
}

/** A two-signer envelope signed through the API and processed, left FINALIZING. */
async function finishedEnvelope() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS', 'TEST_MAIL'] });
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('ARTIFACTS'), mail = await mf.getR2Bucket('TEST_MAIL');
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`, 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))).toString('hex')).run();
  const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: mail, LOCAL_TEST_MODE: 'true', LOCAL_TEST_OTP_KEY: 'managed-evidence-otp-pepper-32-bytes-long' };
  const auth = { authorization: `Bearer ${KEY}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner","isv"]');
  const template = await (await req('/v1/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
  const { id } = await (await req('/v1/envelopes', json({ templateId: template.id, recipients: [{ role: 'partner', name: 'Ana Partner', email: 'ana@partner.test' }, { role: 'isv', name: 'Marcus Seller', email: 'marcus@seller.test' }] }, { ...auth, 'idempotency-key': crypto.randomUUID() }))).json() as { id: string };
  await req(`/v1/envelopes/${id}/prepare`, { method: 'POST', headers: auth });
  for (const index of [0, 1]) {
    const task = (await (await req(`/v1/envelopes/${id}`, { headers: auth })).json() as { tasks: { id: string }[] }).tasks[index];
    const { code } = await (await req(`/v1/envelopes/${id}/tasks/${task.id}/recipient-view`, json({ origin: ORIGIN }, auth))).json() as { code: string };
    const { token } = await (await req('/v1/page-sessions/exchange', json({ code }, { origin: ORIGIN }))).json() as { token: string };
    const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
    const { messageId } = await (await req('/v1/signing/otp', json({}, headers))).json() as { messageId: string };
    const { otp } = await (await req(`/v1/test-mail/${messageId}`, { headers: auth })).json() as { otp: string };
    await req('/v1/signing/otp/verify', json({ otp }, headers));
    const current = await (await req('/v1/signing/current', { headers })).json() as { id: string; sha256: string };
    assert.equal((await req('/v1/signing/sign', json({ artifactId: current.id, artifactHash: current.sha256, consent: true }, headers))).status, 202);
    assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'tenant',id,true), 'processed');
  }
  const status = async () => ((await (await req(`/v1/envelopes/${id}`, { headers: auth })).json()) as { status: string }).status;
  assert.equal(await status(), 'FINALIZING');
  return { mf, db, bucket, id, status };
}

test('a finished envelope is sealed once, completed, and verified on every read', async () => {
  const { tsa, config, counts } = await sealing();
  const e = await finishedEnvelope();
  try {
    const sealed = await finalizeManagedEvidence(e.db, e.bucket, 'tenant', e.id, config);
    assert.equal(await e.status(), 'COMPLETED');
    assert.deepEqual(counts, { sign: 1, tsa: 1 });
    assert.equal(sealed.keyArn, config.sealer.keyArn);
    const row = await e.db.prepare("SELECT object_key,key_arn,timestamp_time FROM seals WHERE envelope_id=? AND mode='KMS_TSA'").bind(e.id).first();
    assert.deepEqual(row, { object_key: managedEvidenceKey(e.id), key_arn: config.sealer.keyArn, timestamp_time: sealed.timestampTime });
    const verified = await verifyManagedEvidence(e.db, e.bucket, 'tenant', e.id, config.trust);
    assert.equal(verified.signatures.length, 2);
    assert.equal(verified.seal.timestampTime, sealed.timestampTime);
    // Finalizing again changes nothing and makes no new signature or timestamp.
    await finalizeManagedEvidence(e.db, e.bucket, 'tenant', e.id, config);
    assert.deepEqual(counts, { sign: 1, tsa: 1 });
    await assert.rejects(verifyManagedEvidence(e.db, e.bucket, 'other-tenant', e.id, config.trust));
  } finally { await e.mf.dispose(); await tsa.dispose(); }
});

test('a retry after a stored seal but before completion reuses the seal', async () => {
  const { tsa, config, counts } = await sealing();
  const e = await finishedEnvelope();
  try {
    const failingDb = new Proxy(e.db, { get(target, prop) { if (prop === 'batch') return async () => { throw new Error('simulated D1 outage'); }; const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v; } });
    await assert.rejects(finalizeManagedEvidence(failingDb, e.bucket, 'tenant', e.id, config), /simulated D1 outage/);
    assert.equal(await e.status(), 'FINALIZING');
    assert.ok(await e.bucket.get(managedEvidenceKey(e.id)), 'the seal was stored before the outage');
    await finalizeManagedEvidence(e.db, e.bucket, 'tenant', e.id, config);
    assert.equal(await e.status(), 'COMPLETED');
    assert.deepEqual(counts, { sign: 1, tsa: 1 }, 'the stored seal is reused');
  } finally { await e.mf.dispose(); await tsa.dispose(); }
});

test('verification fails when the signed PDF or the stored seal changes, and the delivery PDF says how it was sealed', async () => {
  const { tsa, config } = await sealing();
  const e = await finishedEnvelope();
  try {
    await finalizeManagedEvidence(e.db, e.bucket, 'tenant', e.id, config);
    const verified = await verifyManagedEvidence(e.db, e.bucket, 'tenant', e.id, config.trust);
    const delivery = await deliveryPdf(e.db, e.bucket, 'tenant', e.id, managedDelivery(e.db, e.bucket, 'tenant', e.id, config.trust));
    assert.equal(delivery.metadata.format, 'esign-delivery-v1');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(delivery.bytes), useSystemFonts: true }).promise;
    const pageText = (await (await loaded.getPage(loaded.numPages)).getTextContent()).items.map((i: any) => i.str ?? '').join(' ');
    assert.match(pageText, /AWS KMS/);
    assert.doesNotMatch(pageText, /LOCAL TEST ONLY/);
    const allText = (await Promise.all(Array.from({ length: loaded.numPages }, async (_, i) => (await (await loaded.getPage(i + 1)).getTextContent()).items.map((x: any) => x.str ?? '').join(' ')))).join(' ');
    assert.match(allText, /Audit trail \(UTC\)/);
    assert.match(allText, /otp verified/);
    assert.match(allText, /signed · Ana Partner/);
    const finalKey = verified.signatures[verified.signatures.length - 1].object_key;
    const original = await (await e.bucket.get(finalKey))!.arrayBuffer();
    await e.bucket.put(finalKey, 'tampered');
    await assert.rejects(verifyManagedEvidence(e.db, e.bucket, 'tenant', e.id, config.trust));
    await e.bucket.put(finalKey, original);
    const seal = await (await e.bucket.get(managedEvidenceKey(e.id)))!.text();
    await e.bucket.put(managedEvidenceKey(e.id), seal.replace('"time":', '"time": '));
    await assert.rejects(verifyManagedEvidence(e.db, e.bucket, 'tenant', e.id, config.trust), /Evidence integrity failure/);
  } finally { await e.mf.dispose(); await tsa.dispose(); }
});

test('the seal covers the audit trail up to sealing; later events are reported apart, and an inserted event is detected', async () => {
  const { tsa, config } = await sealing();
  const e = await finishedEnvelope();
  try {
    const { auditTrail, recordAudit, AUDIT } = await import('../src/audit.ts');
    const before = await auditTrail(e.db, e.id);
    assert.ok(before.length >= 10, 'two signers left their events');
    await finalizeManagedEvidence(e.db, e.bucket, 'tenant', e.id, config);
    const sealedContent = JSON.parse(JSON.parse(await (await e.bucket.get(managedEvidenceKey(e.id)))!.text()).manifest);
    assert.equal(sealedContent.format, 'esign-sealed-evidence-v2');
    assert.deepEqual(sealedContent.audit.map((a: { id: number }) => a.id), before.map(a => a.id));
    await recordAudit(e.db, { envelopeId: e.id, type: AUDIT.copySent, detail: { to: 'ana@partner.test' } });
    const verified = await verifyManagedEvidence(e.db, e.bucket, 'tenant', e.id, config.trust);
    assert.deepEqual(verified.audit.sealed.map(a => a.id), before.map(a => a.id));
    assert.deepEqual(verified.audit.afterSeal.map(a => a.type), [AUDIT.completed, AUDIT.copySent]);
    // An event slipped in among the sealed ones (ids are otherwise only ever increasing).
    await e.db.prepare("INSERT INTO audit_events (id,envelope_id,type,occurred_at) VALUES (0,?,'SIGNED',1)").bind(e.id).run();
    await assert.rejects(verifyManagedEvidence(e.db, e.bucket, 'tenant', e.id, config.trust), /Seal does not match/);
  } finally { await e.mf.dispose(); await tsa.dispose(); }
});

test('once completed, each signer is sent one copy: the signed PDF with its certificate, recorded in the audit trail', async () => {
  const { tsa, config } = await sealing();
  const e = await finishedEnvelope();
  try {
    const { sendSignedCopies } = await import('../src/signed-copies.ts');
    const { sinkMailer } = await import('../src/otp-mail-sink.ts');
    const { auditTrail, AUDIT } = await import('../src/audit.ts');
    const sent: { to: string; subject: string; text: string; attachments?: { filename: string; type: string; content: Uint8Array }[] }[] = [];
    const mailer = sinkMailer({ SEND_EMAIL: { send: async (m: (typeof sent)[number]) => { sent.push(m); } }, OTP_MAIL_FROM: 'esign-dev@sender.example.test', OTP_MAIL_SINK: 'inbox@sink.example.test' })!;
    await assert.rejects(sendSignedCopies(e.db, e.bucket, 'tenant', e.id, managedDelivery(e.db, e.bucket, 'tenant', e.id, config.trust), mailer), /not completed/);
    await finalizeManagedEvidence(e.db, e.bucket, 'tenant', e.id, config);
    const result = await sendSignedCopies(e.db, e.bucket, 'tenant', e.id, managedDelivery(e.db, e.bucket, 'tenant', e.id, config.trust), mailer);
    assert.deepEqual(result, { sent: 2, skipped: 0 });
    assert.deepEqual(sent.map(m => m.to), ['inbox@sink.example.test', 'inbox@sink.example.test']);
    assert.match(sent[0].subject, /for ana@partner\.test/);
    assert.match(sent[1].subject, /for marcus@seller\.test/);
    const attachment = sent[0].attachments?.[0];
    assert.equal(attachment?.type, 'application/pdf');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: Uint8Array.from(attachment!.content), useSystemFonts: true }).promise;
    const lastPage = (await (await pdf.getPage(pdf.numPages)).getTextContent()).items.map((i: any) => i.str ?? '').join(' ');
    assert.match(lastPage, /AWS KMS/, 'the attachment carries the certificate pages');
    // Running again (the cron, a retry) sends nothing more.
    assert.deepEqual(await sendSignedCopies(e.db, e.bucket, 'tenant', e.id, managedDelivery(e.db, e.bucket, 'tenant', e.id, config.trust), mailer), { sent: 0, skipped: 2 });
    assert.equal(sent.length, 2);
    const copies = (await auditTrail(e.db, e.id)).filter(a => a.type === AUDIT.copySent);
    assert.deepEqual(copies.map(c => c.detail?.to), ['ana@partner.test', 'marcus@seller.test']);
    assert.match(String(copies[0].detail?.attachmentSha256), /^[0-9a-f]{64}$/);
    // The delivery PDF stays the one that was sent, although events (the copies) were recorded since.
    const again = await deliveryPdf(e.db, e.bucket, 'tenant', e.id, managedDelivery(e.db, e.bucket, 'tenant', e.id, config.trust));
    assert.deepEqual(Uint8Array.from(again.bytes), Uint8Array.from(attachment!.content));
  } finally { await e.mf.dispose(); await tsa.dispose(); }
});

test('a copy that could not be sent is tried again later, not lost', async () => {
  const { tsa, config } = await sealing();
  const e = await finishedEnvelope();
  try {
    const { sendSignedCopies } = await import('../src/signed-copies.ts');
    const { sinkMailer } = await import('../src/otp-mail-sink.ts');
    await finalizeManagedEvidence(e.db, e.bucket, 'tenant', e.id, config);
    let fail = true, sent = 0;
    const mailer = sinkMailer({ SEND_EMAIL: { send: async () => { if (fail) throw new Error('mail outage'); sent++; } }, OTP_MAIL_FROM: 'esign-dev@sender.example.test', OTP_MAIL_SINK: 'inbox@sink.example.test' })!;
    const delivery = () => managedDelivery(e.db, e.bucket, 'tenant', e.id, config.trust);
    assert.deepEqual(await sendSignedCopies(e.db, e.bucket, 'tenant', e.id, delivery(), mailer), { sent: 0, skipped: 0 });
    fail = false;
    // A reservation left by a failed attempt is retried once it is old enough.
    assert.deepEqual(await sendSignedCopies(e.db, e.bucket, 'tenant', e.id, delivery(), mailer, Date.now() + 16 * 60 * 1000), { sent: 2, skipped: 0 });
    assert.equal(sent, 2);
  } finally { await e.mf.dispose(); await tsa.dispose(); }
});
