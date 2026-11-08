// The certificate names who sent the envelope, who named each signer, how each was identified
// (the host's sign-in and the emailed code), their IP and device, and a summary of the events
// (synthetic data, in-process). Envelopes made before keep their original layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { unstable_splitSqlQuery } from 'wrangler';
import app from '../src/worker.ts';
import { auditTrail } from '../src/audit.ts';
import { describeHostAuthentication, parseHostAuthentication, parseSender } from '../src/signer-facts.ts';

const ORIGIN = 'https://host.example.com';
const SECRET = 'test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const SIGNER = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Synthetic signer)' };
const AUTH = { method: 'SSO', provider: 'Google Workspace', domain: 'northbeam.test', signedInAt: '2026-11-08T09:30:00Z' };

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS', 'TEST_MAIL'] });
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('ARTIFACTS'), mail = await mf.getR2Bucket('TEST_MAIL');
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).map(s => db.prepare(s)));
  }
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET))).toString('hex');
  await db.prepare("INSERT INTO tenants VALUES ('a')").run();
  await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(hash).run();
  await db.prepare("INSERT INTO tenant_page_origins VALUES ('a',?)").bind(ORIGIN).run();
  const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: mail, LOCAL_TEST_MODE: 'true', LOCAL_TEST_OTP_KEY: 'local-test-pepper-at-least-32-bytes', LOCAL_TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
  const auth = { authorization: `Bearer ${SECRET}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://localhost' + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData(); form.set('file', new File([await pdf.save()], 'sample.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
  const template = await (await req('/v1/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
  const create = (key: string, extra: Record<string, unknown> = {}, recipient: Record<string, unknown> = {}) =>
    req('/v1/envelopes', json({ templateId: template.id, documentName: 'Mutual NDA', recipients: [{ role: 'partner', name: 'Ana Ribeiro', email: 'ana@northbeam.test', title: 'Partner Manager', onBehalfOf: 'Northbeam', ...recipient }], ...extra }, { ...auth, 'idempotency-key': key }));
  /** Signs the envelope's only task through the page, the link carrying the host's sign-in; completes it. */
  const signAll = async (envelopeId: string, hostAuthentication?: unknown, views?: (headers: Record<string, string>) => Promise<void>) => {
    await req(`/v1/envelopes/${envelopeId}/prepare`, { method: 'POST', headers: auth });
    const task = (await (await req(`/v1/envelopes/${envelopeId}`, { headers: auth })).json() as { tasks: { id: string }[] }).tasks[0];
    const view = await req(`/v1/envelopes/${envelopeId}/tasks/${task.id}/recipient-view`, json({ origin: ORIGIN, ...(hostAuthentication ? { hostAuthentication } : {}) }, auth));
    assert.equal(view.status, 201);
    const { code } = await view.json() as { code: string };
    const { token } = await (await req('/v1/page-sessions/exchange', json({ code }, { origin: ORIGIN, ...SIGNER }))).json() as { token: string };
    const headers = { origin: ORIGIN, authorization: `Bearer ${token}`, ...SIGNER };
    if (views) await views(headers);
    const { messageId } = await (await req('/v1/signing/otp', json({}, headers))).json() as { messageId: string };
    const { otp } = await (await req(`/v1/test-mail/${messageId}`, { headers: auth })).json() as { otp: string };
    assert.equal((await req('/v1/signing/otp/verify', json({ otp }, headers))).status, 204);
    const current = await (await req('/v1/signing/current', { headers })).json() as { id: string; sha256: string; disclosure: { version: string } };
    assert.equal((await req('/v1/signing/sign', json({ artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: current.disclosure.version, title: 'Partner Manager', authorityConfirmed: true }, headers))).status, 202);
    assert.equal((await req(`/v1/envelopes/${envelopeId}/process`, { method: 'POST', headers: auth })).status, 204);
    assert.equal((await req(`/v1/envelopes/${envelopeId}/finalize`, { method: 'POST', headers: auth })).status, 204);
    return task.id;
  };
  const certificateText = async (envelopeId: string) => {
    const res = await req(`/v1/envelopes/${envelopeId}/delivery-pdf`, { headers: auth });
    assert.equal(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true }).promise;
    let text = '';
    for (let n = 1; n <= doc.numPages; n++) text += ((await (await doc.getPage(n)).getTextContent()).items as { str?: string }[]).map(i => i.str ?? '').join(' ') + '\n';
    return { text, bytes };
  };
  return { mf, db, auth, req, json, create, signAll, certificateText };
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
    await h.req(`/v1/envelopes/${created.id}/prepare`, { method: 'POST', headers: h.auth });
    const task = (await (await h.req(`/v1/envelopes/${created.id}`, { headers: h.auth })).json() as { tasks: { id: string }[] }).tasks[0];
    const bad = await h.req(`/v1/envelopes/${created.id}/tasks/${task.id}/recipient-view`, h.json({ origin: ORIGIN, hostAuthentication: { method: 'sso' } }, h.auth));
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
    const { events } = await (await h.req(`/v1/envelopes/${id}/audit`, { headers: h.auth })).json() as { events: { type: string; detail?: Record<string, unknown> }[] };
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
      'IP 203.0.113.9',
      'Events summary (UTC)',
      'Sent by Dana Seller',
      'Opened by Ana Ribeiro',
      'Identity confirmed: Ana Ribeiro',
      'Signed by Ana Ribeiro as Partner Manager, on behalf of Northbeam',
      // Long values wrap mid-word on the page: compare without whitespace.
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
        const res = await h.req('/v1/signing/page-views', h.json(body, headers));
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
    const { events } = await (await h.req(`/v1/envelopes/${id}/audit`, { headers: h.auth })).json() as { events: { type: string; detail?: Record<string, unknown> }[] };
    assert.deepEqual(events.find(e => e.type === 'PAGES_VIEWED')?.detail, { pages: [1], total: 1 });
    const { text } = await h.certificateText(id);
    assert.ok(text.replace(/\s+/g, '').includes('Viewed1of1pages:AnaRibeiro'));
  } finally { await h.mf.dispose(); }
});

test('page views need a live page session', async () => {
  const h = await harness();
  try {
    const res = await h.req('/v1/signing/page-views', h.json({ pages: [1], total: 1 }, { origin: ORIGIN, authorization: `Bearer ${'a'.repeat(64)}` }));
    assert.equal(res.status, 401);
  } finally { await h.mf.dispose(); }
});

test('an envelope made before keeps its original certificate layout', async () => {
  const h = await harness();
  try {
    const { id } = await (await h.create('o1', { sender: { name: 'Dana Seller' } })).json() as { id: string };
    // As an envelope created before certificate versions existed.
    await h.db.prepare('DELETE FROM envelope_certificate_versions WHERE envelope_id = ?').bind(id).run();
    await h.signAll(id, AUTH);
    const { text } = await h.certificateText(id);
    assert.ok(!text.includes('Events summary'), 'no version-2 sections');
    assert.ok(!text.includes('Dana Seller'));
  } finally { await h.mf.dispose(); }
});

test('sign-in and sender facts parse strictly and read plainly', () => {
  assert.deepEqual(parseHostAuthentication({ method: 'PASSWORD' }), { method: 'PASSWORD' });
  assert.equal(parseHostAuthentication({ method: 'SSO', signedInAt: 'yesterday' }), 'invalid');
  assert.equal(parseHostAuthentication(null), null);
  assert.equal(describeHostAuthentication({ method: 'ONE_TIME_LINK' }), "one time link sign-in, stated by the sender's system");
  assert.equal(parseSender({ name: 'Dana', email: 'not-an-email' }), 'invalid');
});
