// Signing authority, declining and the audit read (in-process, synthetic data): the host names
// each signer's title and the company they bind; the signer confirms both; a signer may decline
// instead, with a reason; the host reads the audit trail back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { unstable_splitSqlQuery } from 'wrangler';
import app from '../src/worker.ts';
import { AUDIT, auditTrail } from '../src/audit.ts';
import { consentDisclosure } from '../src/disclosure.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const SIGNER = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Synthetic signer)' };
const keyHash = async (key: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('hex');

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS', 'TEST_MAIL'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`, 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant'),('other')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant'),(?,'other')").bind(await keyHash(KEY), await keyHash(OTHER_KEY)).run();
  const env = { DB: db, ARTIFACTS: await mf.getR2Bucket('ARTIFACTS'), TEST_MAIL: await mf.getR2Bucket('TEST_MAIL'), OTP_KEY: 'signer-authority-otp-pepper-at-least-32-bytes' };
  const auth = { authorization: `Bearer ${KEY}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
  const template = await (await req('/v1/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
  /** A prepared envelope whose signer has opened the page; `verify` also passes the code. */
  const open = async (key: string, recipient: Record<string, string>, extra: Record<string, unknown> = {}, verify = true) => {
    const res = await req('/v1/envelopes', json({ templateId: template.id, recipients: [{ role: 'partner', name: 'Ana Partner', email: 'ana@partner.test', ...recipient }], ...extra }, { ...auth, 'idempotency-key': key }));
    const created = await res.json() as { id?: string; error?: string };
    if (!created.id) return { status: res.status, error: created.error } as const;
    const id = created.id;
    await req(`/v1/envelopes/${id}/prepare`, { method: 'POST', headers: auth });
    const task = (await (await req(`/v1/envelopes/${id}`, { headers: auth })).json() as { tasks: { id: string }[] }).tasks[0];
    const { code } = await (await req(`/v1/envelopes/${id}/tasks/${task.id}/recipient-view`, json({ origin: ORIGIN }, auth))).json() as { code: string };
    const { token } = await (await req('/v1/page-sessions/exchange', json({ code }, { origin: ORIGIN, ...SIGNER }))).json() as { token: string };
    const headers = { origin: ORIGIN, authorization: `Bearer ${token}`, ...SIGNER };
    if (verify) {
      const { messageId } = await (await req('/v1/signing/otp', json({}, headers))).json() as { messageId: string };
      const { otp } = await (await req(`/v1/test-mail/${messageId}`, { headers: auth })).json() as { otp: string };
      assert.equal((await req('/v1/signing/otp/verify', json({ otp }, headers))).status, 204);
    }
    return { status: res.status, id, taskId: task.id, headers } as const;
  };
  return { mf, db, auth, req, json, open };
}

const NAMED = { title: 'Partner Manager', onBehalfOf: 'Northbeam Consulting' };

test("the page shows the signer's title and company and the intent naming the document and the company", async () => {
  const h = await harness();
  try {
    const s = await h.open('k1', NAMED, { documentName: 'Mutual NDA' });
    assert.equal(s.status, 201);
    const current = await (await h.req('/v1/signing/current', { headers: s.headers! })).json() as { signer?: unknown; intent?: string };
    assert.deepEqual(current.signer, { title: 'Partner Manager', onBehalfOf: 'Northbeam Consulting' });
    assert.equal(current.intent, 'I intend this to be my signature on Mutual NDA on behalf of Northbeam Consulting.');
  } finally { await h.mf.dispose(); }
});

test("the host's title, company and document name are bounded", async () => {
  const h = await harness();
  try {
    assert.equal((await h.open('b1', { title: 'x'.repeat(129) }, {}, false)).status, 422);
    assert.equal((await h.open('b2', { onBehalfOf: 'x'.repeat(201) }, {}, false)).status, 422);
    assert.equal((await h.open('b3', {}, { documentName: 7 }, false)).status, 422);
  } finally { await h.mf.dispose(); }
});

test('signing for a company needs a title and the authority confirmed, and records both', async () => {
  const h = await harness();
  try {
    const s = await h.open('k2', NAMED, { documentName: 'Mutual NDA' });
    const current = await (await h.req('/v1/signing/current', { headers: s.headers! })).json() as { id: string; sha256: string; intent: string };
    const disclosure = await consentDisclosure();
    const base = { artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: disclosure.version };
    const noAuthority = await h.req('/v1/signing/sign', h.json({ ...base, title: 'Partner Manager' }, s.headers!));
    assert.equal(noAuthority.status, 422);
    assert.deepEqual(await noAuthority.json(), { error: 'authority_required' });
    const noTitle = await h.req('/v1/signing/sign', h.json({ ...base, title: ' ', authorityConfirmed: true }, s.headers!));
    assert.deepEqual(await noTitle.json(), { error: 'title_required' });
    const signed = await h.req('/v1/signing/sign', h.json({ ...base, title: 'Head of Partnerships', authorityConfirmed: true }, s.headers!));
    assert.equal(signed.status, 202);
    const event = (await auditTrail(h.db, s.id!)).find(e => e.type === AUDIT.signed);
    const intentSha256 = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.intent))).toString('hex');
    assert.deepEqual({ ...event?.detail, signatureId: undefined, artifactId: undefined, artifactSha256: undefined }, {
      signatureId: undefined, artifactId: undefined, artifactSha256: undefined,
      consentDisclosureVersion: disclosure.version,
      consentDisclosureSha256: disclosure.sha256,
      title: 'Head of Partnerships',
      onBehalfOf: 'Northbeam Consulting',
      authorityConfirmed: true,
      intentSha256,
    });
  } finally { await h.mf.dispose(); }
});

test('a signer without a company signs as before', async () => {
  const h = await harness();
  try {
    const s = await h.open('k3', {});
    const current = await (await h.req('/v1/signing/current', { headers: s.headers! })).json() as { id: string; sha256: string; signer?: unknown; intent: string };
    assert.equal(current.signer, undefined);
    assert.equal(current.intent, 'I intend this to be my signature on this document.');
    const disclosure = await consentDisclosure();
    assert.equal((await h.req('/v1/signing/sign', h.json({ artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: disclosure.version }, s.headers!))).status, 202);
  } finally { await h.mf.dispose(); }
});

test('a verified signer may decline with a reason: the envelope is DECLINED for everyone', async () => {
  const h = await harness();
  try {
    const unverified = await h.open('d0', {}, {}, false);
    assert.notEqual((await h.req('/v1/signing/decline', h.json({ reason: 'No' }, unverified.headers!))).status, 200, 'the code comes first');

    const s = await h.open('d1', NAMED);
    assert.deepEqual(await (await h.req('/v1/signing/decline', h.json({ reason: ' ' }, s.headers!))).json(), { error: 'reason_required' });
    const declined = await h.req('/v1/signing/decline', h.json({ reason: 'Our legal team needs changes to clause 4.' }, s.headers!));
    assert.equal(declined.status, 200);
    assert.deepEqual(await declined.json(), { status: 'DECLINED' });
    const envelope = await (await h.req(`/v1/envelopes/${s.id}`, { headers: h.auth })).json() as { status: string };
    assert.equal(envelope.status, 'DECLINED');
    const event = (await auditTrail(h.db, s.id!)).find(e => e.type === AUDIT.declined);
    assert.equal(event?.taskId, s.taskId);
    assert.deepEqual(event?.detail, { reason: 'Our legal team needs changes to clause 4.' });
    assert.equal(event?.ip, '203.0.113.9');
    assert.notEqual((await h.req('/v1/signing/current', { headers: s.headers! })).status, 200, 'nothing is signable after declining');
    assert.equal((await h.req(`/v1/envelopes/${s.id}/void`, h.json({}, h.auth))).status, 409);
  } finally { await h.mf.dispose(); }
});

test('the host reads the audit trail: each event with its signer, and no codes or message ids', async () => {
  const h = await harness();
  try {
    const s = await h.open('a1', NAMED);
    await h.req('/v1/signing/decline', h.json({ reason: 'Not now' }, s.headers!));
    const res = await h.req(`/v1/envelopes/${s.id}/audit`, { headers: h.auth });
    assert.equal(res.status, 200);
    const { events } = await res.json() as { events: { type: string; at: string; recipient?: { role: string; name: string; email: string }; ip?: string; userAgent?: string; detail?: Record<string, unknown> }[] };
    assert.deepEqual(events.map(e => e.type), [AUDIT.viewIssued, AUDIT.sessionOpened, AUDIT.otpSent, AUDIT.otpVerified, AUDIT.declined]);
    assert.deepEqual(events[4].recipient, { role: 'partner', name: 'Ana Partner', email: 'ana@partner.test' });
    assert.deepEqual(events[4].detail, { reason: 'Not now' });
    assert.equal(events[2].detail?.messageId, undefined, 'no message id');
    assert.ok(events.every(e => !Number.isNaN(Date.parse(e.at))));
    assert.equal((await h.req(`/v1/envelopes/${s.id}/audit`, { headers: { authorization: `Bearer ${OTHER_KEY}` } })).status, 404);
  } finally { await h.mf.dispose(); }
});

test("the envelope read says when each recipient first opened the signing page", async () => {
  const h = await harness();
  try {
    const before = Date.now();
    const s = await h.open('o1', NAMED, {}, false);
    const read = async () => (await (await h.req(`/v1/envelopes/${s.id}`, { headers: h.auth })).json() as { tasks: { id: string; openedAt?: string }[] }).tasks[0];
    const opened = await read();
    assert.ok(opened.openedAt, 'opened once the page session started');
    assert.ok(Date.parse(opened.openedAt!) >= before - 1000);
    // A second session keeps the first time.
    const { code } = await (await h.req(`/v1/envelopes/${s.id}/tasks/${s.taskId}/recipient-view`, h.json({ origin: ORIGIN }, h.auth))).json() as { code: string };
    await h.req('/v1/page-sessions/exchange', h.json({ code }, { origin: ORIGIN, ...SIGNER }));
    assert.equal((await read()).openedAt, opened.openedAt);
  } finally { await h.mf.dispose(); }
});

test("a recipient who never opened the page has no openedAt", async () => {
  const h = await harness();
  try {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
    const template = await (await h.req('/v1/templates', { method: 'POST', headers: h.auth, body: form })).json() as { id: string };
    const created = await (await h.req('/v1/envelopes', h.json({ templateId: template.id, recipients: [{ role: 'partner', name: 'Ana Partner', email: 'ana@partner.test' }] }, { ...h.auth, 'idempotency-key': 'n1' }))).json() as { id: string };
    await h.req(`/v1/envelopes/${created.id}/prepare`, { method: 'POST', headers: h.auth });
    const env = await (await h.req(`/v1/envelopes/${created.id}`, { headers: h.auth })).json() as { tasks: Record<string, unknown>[] };
    assert.equal('openedAt' in env.tasks[0], false);
  } finally { await h.mf.dispose(); }
});
