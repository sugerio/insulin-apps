import {blobStore} from './helpers/platform.ts';
// The certificate names who sent the envelope, who named each signer, how each was identified
// (the host's sign-in and the emailed code), their IP and device, and a summary of the events
// (synthetic data, in-process). Envelopes made before keep their original layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { MIGRATIONS_DIR, splitSql as unstable_splitSqlQuery } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { auditTrail } from '../src/app/server/esign/audit.ts';
import { describeHostAuthentication, parseHostAuthentication, parseSender } from '../src/app/server/esign/signer-facts.ts';
import {processEnvelopeStep,finalizeEnvelopeStep} from '../src/app/server/esign/envelope-completion.ts';

const ORIGIN = 'https://host.example.com';
const SECRET = 'test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const SIGNER = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Synthetic signer)' };
const AUTH = { method: 'SSO', provider: 'Google Workspace', domain: 'northbeam.test', signedInAt: '2026-11-08T09:30:00Z' };

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB'), bucket = await blobStore(mf,'artifacts'), mail = await blobStore(mf,'test-mail');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(new URL(name,MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  }
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET))).toString('hex');
  await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();
  await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(hash).run();
  const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: mail, SIGNING_PAGE_ORIGINS: ORIGIN, OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
  const auth = { authorization: `Bearer ${SECRET}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://localhost' + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData(); form.set('file', new File([await pdf.save()], 'sample.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
  const template = await (await req('/api/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
  const create = (key: string, extra: Record<string, unknown> = {}, recipient: Record<string, unknown> = {}) =>
    req('/api/envelopes', json({ templateId: template.id, documentName: 'Mutual NDA', recipients: [{ role: 'partner', name: 'Ana Ribeiro', email: 'ana@northbeam.test', title: 'Partner Manager', onBehalfOf: 'Northbeam', ...recipient }], ...extra }, { ...auth, 'idempotency-key': key }));
  /** Signs the envelope's only task through the page, the link carrying the host's sign-in; completes it. */
  const signAll = async (envelopeId: string, hostAuthentication?: unknown, views?: (headers: Record<string, string>) => Promise<void>) => {
    await req(`/api/envelopes/${envelopeId}/prepare`, { method: 'POST', headers: auth });
    const task = (await (await req(`/api/envelopes/${envelopeId}`, { headers: auth })).json() as { tasks: { id: string }[] }).tasks[0];
    const view = await req(`/api/envelopes/${envelopeId}/tasks/${task.id}/recipient-view`, json({ origin: ORIGIN, ...(hostAuthentication ? { hostAuthentication } : {}) }, auth));
    assert.equal(view.status, 201);
    const { code } = await view.json() as { code: string };
    const { token } = await (await req('/api/public/page-sessions/exchange', json({ code }, { origin: ORIGIN, ...SIGNER }))).json() as { token: string };
    const headers = { origin: ORIGIN, 'x-esign-session': token, ...SIGNER };
    if (views) await views(headers);
    const { messageId } = await (await req('/api/public/signing/otp', json({}, headers))).json() as { messageId: string };
    const { otp } = await (await req(`/api/test-mail/${messageId}`, { headers: auth })).json() as { otp: string };
    assert.equal((await req('/api/public/signing/otp/verify', json({ otp }, headers))).status, 204);
    const current = await (await req('/api/public/signing/current', { headers })).json() as { id: string; sha256: string; disclosure: { version: string } };
    assert.equal((await req('/api/public/signing/sign', json({ artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: current.disclosure.version, title: 'Partner Manager', authorityConfirmed: true }, headers))).status, 202);
    assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'a',envelopeId,true), 'processed');
    assert.equal(await finalizeEnvelopeStep(env,'a',envelopeId), 'finalized');
    return task.id;
  };
  const certificateText = async (envelopeId: string) => {
    const res = await req(`/api/envelopes/${envelopeId}/delivery-pdf`, { headers: auth });
    assert.equal(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true }).promise;
    let text = '';
    for (let n = 1; n <= doc.numPages; n++) text += ((await (await doc.getPage(n)).getTextContent()).items as { str?: string }[]).map(i => i.str ?? '').join(' ') + '\n';
    return { text, bytes };
  };
  return { mf, db, env, auth, req, json, create, signAll, certificateText };
}

test('the sender, who named the signer and the host sign-in are validated and part of the idempotent request', async () => {
  const h = await harness();
  try {
    assert.equal((await h.create('bad-sender', { sender: { email: 'dana@harness.test' } })).status, 422, 'a sender needs a name');
    assert.equal((await h.create('bad-named', {}, { namedBy: 'x'.repeat(301) })).status, 422);
    const sender = { name: 'Dana Seller', email: 'dana@harness.test', organization: 'Harness' };
    assert.equal((await h.create('k1', { sender }, { namedBy: 'Pedro Alves (applicant)' })).status, 201);
    assert.equal((await h.create('k1', { sender: { ...sender, name: 'Someone Else' } }, { namedBy: 'Pedro Alves (applicant)' })).status, 409);
    const created = await (await h.create('k2', {})).json() as { id: string };
    await h.req(`/api/envelopes/${created.id}/prepare`, { method: 'POST', headers: h.auth });
    const task = (await (await h.req(`/api/envelopes/${created.id}`, { headers: h.auth })).json() as { tasks: { id: string }[] }).tasks[0];
    const bad = await h.req(`/api/envelopes/${created.id}/tasks/${task.id}/recipient-view`, h.json({ origin: ORIGIN, hostAuthentication: { method: 'sso' } }, h.auth));
    assert.equal(bad.status, 400, 'the method is an upper-case word');
  } finally { await h.mf.dispose(); }
});

test("identity confirmed records the host's sign-in with the code, and the audit read shows it", async () => {
  const h = await harness();
  try {
    const { id } = await (await h.create('a1', { sender: { name: 'Dana Seller' } })).json() as { id: string };
    const taskId = await h.signAll(id, AUTH);
    const verified = (await auditTrail(h.db, id)).find(e => e.type === 'OTP_VERIFIED' && e.taskId === taskId);
    const stored = { ...AUTH, signedInAt: '2026-11-08T09:30:00.000Z' };
    assert.deepEqual(verified?.detail, { hostAuthentication: stored });
    const { events } = await (await h.req(`/api/envelopes/${id}/audit`, { headers: h.auth })).json() as { events: { type: string; detail?: Record<string, unknown> }[] };
    assert.deepEqual(events.find(e => e.type === 'OTP_VERIFIED')?.detail, { hostAuthentication: stored });
  } finally { await h.mf.dispose(); }
});

test('the certificate names the sender, who named the signer, how they were identified, their device and the events', async () => {
  const h = await harness();
  try {
    const { id } = await (await h.create('c1', { sender: { name: 'Dana Seller', email: 'dana@harness.test', organization: 'Harness' } }, { namedBy: 'Pedro Alves (applicant), accepted by Harness' })).json() as { id: string };
    await h.signAll(id, AUTH);
    const { text, bytes } = await h.certificateText(id);
    for (const expected of [
      'Mutual NDA',
      'Dana Seller (dana@harness.test), Harness',
      'Pedro Alves (applicant), accepted by Harness',
      'Google Workspace sign-in (northbeam.test) at 2026-11-08T09:30:00Z, stated by the sender',
      'email one-time code',
      'ana@northbeam.test',
      'as Partner Manager, on behalf of Northbeam (authority confirmed)',
      'Agreed to the electronic records disclosure, version',
      '203.0.113.9 - Mozilla/5.0 (Synthetic signer)',
      'Sent for signature Dana Seller',
      'Signing link issued to Ana Ribeiro Sender',
      'Opened the document Ana Ribeiro 203.0.113.9',
      'Confirmed the emailed code Ana Ribeiro 203.0.113.9',
      'Signed Ana Ribeiro 203.0.113.9',
      // Long values wrap between words on the page: compare without whitespace.
    ]) assert.ok(text.replace(/\s+/g, '').includes(expected.replace(/\s+/g, '')), `missing ${expected}`);
    // Rebuilt on every read: the same bytes again.
    assert.deepEqual((await h.certificateText(id)).bytes, bytes);
  } finally { await h.mf.dispose(); }
});

test('page views are recorded once per page before the code, and the certificate says how many were viewed', async () => {
  const h = await harness();
  try {
    const { id } = await (await h.create('v1', {})).json() as { id: string };
    const results: unknown[] = [];
    const taskId = await h.signAll(id, undefined, async (headers) => {
      const view = async (body: unknown) => {
        const res = await h.req('/api/public/signing/page-views', h.json(body, headers));
        results.push(res.status === 200 ? await res.json() : res.status);
      };
      await view({ pages: [1], total: 1 });
      await view({ pages: [1, 1], total: 1 });
      await view({ pages: [2], total: 1 });
      await view({ pages: [], total: 0 });
    });
    assert.deepEqual(results, [{ viewed: 1, total: 1 }, { viewed: 1, total: 1 }, 400, 400]);
    const views = (await auditTrail(h.db, id)).filter(e => e.type === 'PAGES_VIEWED');
    assert.equal(views.length, 1, 'a page already viewed is not recorded again');
    assert.deepEqual(views[0]?.detail, { pages: [1], total: 1 });
    assert.equal(views[0]?.taskId, taskId);
    const { events } = await (await h.req(`/api/envelopes/${id}/audit`, { headers: h.auth })).json() as { events: { type: string; detail?: Record<string, unknown> }[] };
    assert.deepEqual(events.find(e => e.type === 'PAGES_VIEWED')?.detail, { pages: [1], total: 1 });
    const { text } = await h.certificateText(id);
    assert.ok(text.replace(/\s+/g, '').includes('Viewed1of1pagesAnaRibeiro'));
  } finally { await h.mf.dispose(); }
});

test('a completed envelope stays readable while signing is off: its certificate, delivery PDF and copy', async () => {
  const h = await harness();
  try {
    const { id } = await (await h.create('read-while-off')).json() as { id: string };
    await h.signAll(id);
    // Without its test mailbox the local deployment signs nothing more; verifying what it completed needs only the seal's trust.
    const off = { ...h.env, TEST_MAIL: undefined };
    const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://localhost' + path, init), off);
    assert.equal((await (await req('/api/public/signing-page')).json() as { signingEnabled: boolean }).signingEnabled, false);
    for (const path of [`/api/envelopes/${id}/certificate`, `/api/envelopes/${id}/delivery-pdf`]) {
      const read = await req(path, { headers: h.auth });
      assert.equal(read.status, 200, path);
      assert.equal(read.headers.get('cache-control'), 'no-store', path);
    }
    const copy = await req('/api/public/copies/open', h.json({ token: 'f'.repeat(64) }, { origin: 'http://localhost' }));
    assert.deepEqual([copy.status, await copy.json()], [410, { error: 'link_unavailable' }], 'an unknown link, not signing_disabled');
  } finally { await h.mf.dispose(); }
});

test('page views need a live page session', async () => {
  const h = await harness();
  try {
    const res = await h.req('/api/public/signing/page-views', h.json({ pages: [1], total: 1 }, { origin: ORIGIN, 'x-esign-session': 'a'.repeat(64) }));
    assert.equal(res.status, 401);
  } finally { await h.mf.dispose(); }
});

test('sign-in and sender facts parse strictly and read plainly', () => {
  assert.deepEqual(parseHostAuthentication({ method: 'PASSWORD' }), { method: 'PASSWORD' });
  assert.equal(parseHostAuthentication({ method: 'SSO', signedInAt: 'yesterday' }), 'invalid');
  assert.equal(parseHostAuthentication(null), null);
  assert.equal(describeHostAuthentication({ method: 'ONE_TIME_LINK' }), "one time link sign-in, stated by the sender's system");
  assert.equal(parseSender({ name: 'Dana', email: 'not-an-email' }), 'invalid');
});
